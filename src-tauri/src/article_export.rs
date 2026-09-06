//! Offline article packages; captured evidence and AI prose remain separate.
use crate::{
    article_document::{self, Document},
    db, hot_board, page_view, public_fetch,
    state::AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, Webview};
static RUNNING: Mutex<bool> = Mutex::new(false);
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}
pub fn ensure_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS article_captures (capture_id TEXT PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, document_json TEXT NOT NULL, captured_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS article_captures_article ON article_captures(article_id,captured_at);").map_err(|_|"无法初始化结构化资料库")?;
    Ok(())
}
fn store(c: &Connection, doc: &Document) -> Result<(), String> {
    ensure_schema(c)?;
    c.execute("INSERT INTO article_captures(capture_id,article_id,document_json,captured_at) VALUES(?1,?2,?3,?4)",params![doc.capture_id,doc.article_id,serde_json::to_string(doc).map_err(|_|"无法编码页面快照")?,doc.captured_at]).map_err(|_|"无法保存结构化快照")?;
    Ok(())
}
pub fn save_capture(
    c: &Connection,
    article_id: i64,
    capture_id: &str,
    dom: &page_view::CapturedDom,
) -> Result<Document, String> {
    let (author, published_at) = c
        .query_row(
            "SELECT author,published_at FROM articles WHERE id=?1",
            [article_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|_| "原文章已经不存在")?;
    let mut warnings =
        vec!["仅保存当前主页面可见正文；隐藏内容、后续分页、附件及嵌入页面不在本次范围内。".into()];
    if dom.truncated {
        warnings.push("页面达到抓取上限，内容可能不完整。".into());
    }
    if dom.body_fallback {
        warnings.push("未识别到独立正文容器，可能包含页面周边内容。".into());
    }
    let doc = article_document::parse(
        Document {
            schema_version: 1,
            capture_id: capture_id.into(),
            article_id,
            title: dom.title.clone(),
            source_url: dom.url.clone(),
            captured_at: chrono::Utc::now().to_rfc3339(),
            source_kind: "rendered_webpage".into(),
            author,
            published_at,
            truncated: dom.truncated,
            blocks: vec![],
            assets: vec![],
            warnings,
        },
        &dom.html,
    );
    store(c, &doc)?;
    Ok(doc)
}
fn saved(
    c: &Connection,
    article_id: i64,
    capture_id: Option<&str>,
) -> Result<Option<Document>, String> {
    ensure_schema(c)?;
    let row=c.query_row("SELECT document_json FROM article_captures WHERE article_id=?1 AND (?2 IS NULL OR capture_id=?2) ORDER BY captured_at DESC LIMIT 1",params![article_id,capture_id],|r|r.get::<_,String>(0)).optional().map_err(|_|"无法读取页面快照")?;
    row.map(|v| serde_json::from_str(&v).map_err(|_| "保存的页面快照损坏".to_string()))
        .transpose()
}
fn cached(c: &Connection, article_id: i64) -> Result<Document, String> {
    let article = db::get_article(c, article_id).map_err(|_| "无法读取文章")?;
    let html = article
        .extracted_html
        .as_deref()
        .or(article.content_html.as_deref())
        .unwrap_or("");
    let doc=article_document::parse(Document{schema_version:1,capture_id:format!("cached-{}",uuid::Uuid::new_v4()),article_id,title:article.title,source_url:article.url.unwrap_or_default(),captured_at:chrono::Utc::now().to_rfc3339(),source_kind:"cached_article".into(),author:article.author,published_at:article.published_at,truncated:false,blocks:vec![],assets:vec![],warnings:vec!["本包来自本地文章缓存，不代表网页全文。若内容只有摘要，请在 Web 模式加载原文后重新导出。".into()]},html);
    store(c, &doc)?;
    Ok(doc)
}
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() > 16
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        Some("avif")
    } else {
        None
    }
}
pub(crate) fn package(
    doc: &Document,
    ai: Option<&str>,
    files: &[(String, Vec<u8>)],
    path: &Path,
) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    let mut output = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut output);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o600);
        let mut write = |name: &str, bytes: &[u8]| -> Result<(), String> {
            zip.start_file(name, opts)
                .map_err(|_| "无法创建压缩包条目")?;
            zip.write_all(bytes).map_err(|_| "无法写入压缩包")?;
            Ok(())
        };
        write("article.md", article_document::markdown(doc).as_bytes())?;
        write(
            "article.json",
            serde_json::to_string_pretty(doc)
                .map_err(|_| "无法编码文章")?
                .as_bytes(),
        )?;
        let manifest = json!({"schemaVersion":1,"product":"scholay tody","sourceUrl":doc.source_url,"captureId":doc.capture_id,"capturedAt":doc.captured_at,"sourceKind":doc.source_kind,"truncated":doc.truncated,"assets":doc.assets,"warnings":doc.warnings,"aiIncluded":ai.is_some(),"offlineImages":true});
        write(
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap().as_bytes(),
        )?;
        if let Some(ai) = ai {
            let mut text = ai.to_owned();
            text.push_str("\n\n## 原文图片索引\n\n> 图片按原文顺序列出，不代表 AI 已分析图片。正文中的准确位置请参照 article.md。\n\n");
            for asset in &doc.assets {
                if let Some(path) = &asset.path {
                    text.push_str(&format!("![{}]({path})\n\n", asset.id));
                }
            }
            write("ai-formatted.md", text.as_bytes())?;
        }
        for (name, bytes) in files {
            write(name, bytes)?;
        }
        zip.finish().map_err(|_| "无法完成压缩包")?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "无法新建导出文件")?;
    file.write_all(output.get_ref())
        .map_err(|_| "无法写入导出文件")?;
    Ok(())
}

#[tauri::command]
pub async fn export_article_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
    webview: Webview,
    article_id: i64,
    request_id: Option<String>,
    capture_id: Option<String>,
    source: String,
    include_ai: bool,
) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if *running {
            return Err("已有图文导出任务，请等待完成".into());
        }
        *running = true;
    }
    let _guard = Guard;
    let mut doc = match source.as_str() {
        "web" => {
            let url = {
                let c = state.read().await;
                c.query_row("SELECT url FROM articles WHERE id=?1", [article_id], |r| {
                    r.get::<_, Option<String>>(0)
                })
                .map_err(|_| "无法读取原文地址")?
                .ok_or("文章没有原文地址")?
            };
            let dom = page_view::capture_loaded_page(
                &app,
                request_id.as_deref().ok_or("请先等待 Web 页面加载完成")?,
                &url,
            )
            .await?;
            let c = state.db.lock().await;
            save_capture(
                &c,
                article_id,
                &format!("export-{}", uuid::Uuid::new_v4()),
                &dom,
            )?
        }
        "formatted" => {
            let c = state.db.lock().await;
            if let Some(id) = capture_id.as_deref() {
                saved(&c, article_id, Some(id))?
                    .ok_or("这份旧 AI 稿件还没有带图快照，请在 Web 模式重新抓取导出")?
            } else {
                saved(&c, article_id, None)?.ok_or("还没有抓取快照，请先打开 Web 原文")?
            }
        }
        "reading" => {
            let c = state.db.lock().await;
            cached(&c, article_id)?
        }
        _ => return Err("未知导出来源".into()),
    };
    if doc.blocks.is_empty() {
        return Err("没有可导出的正文，请在 Web 模式加载原文后重试".into());
    }
    let ai = if include_ai {
        let c = state.read().await;
        papr_core::ai_formatted::get(&c, article_id)
            .ok()
            .flatten()
            .filter(|d| d.capture_id == doc.capture_id)
            .map(|d| d.markdown)
    } else {
        None
    };
    if include_ai && ai.is_none() {
        doc.warnings
            .push("没有与本次快照严格对应的 AI 整理稿；未混入其他版本。".into());
    }
    let limit = Arc::new(tokio::sync::Semaphore::new(4));
    let mut jobs = tokio::task::JoinSet::new();
    for (index, asset) in doc.assets.iter().enumerate() {
        let limit = limit.clone();
        let url = asset.original_url.clone();
        let referer = doc.source_url.clone();
        jobs.spawn(async move {
            let _permit = limit.acquire().await;
            let result = match public_fetch::fetch(&url, Some(&referer), 6 * 1024 * 1024).await {
                Ok(value) => Ok(value),
                Err(_) => public_fetch::fetch(&url, None, 6 * 1024 * 1024).await,
            };
            (index, result)
        });
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(80);
    let mut files: Vec<(String, Vec<u8>)> = vec![];
    let mut total = 0usize;
    while !jobs.is_empty() {
        match tokio::time::timeout_at(deadline, jobs.join_next()).await {
            Ok(Some(Ok((index, result)))) => {
                let asset = &mut doc.assets[index];
                match result {
                    Ok((bytes, _, _))
                        if image_extension(&bytes).is_some()
                            && total + bytes.len() <= 64 * 1024 * 1024 =>
                    {
                        total += bytes.len();
                        let hash = format!("{:x}", Sha256::digest(&bytes));
                        let path = format!("assets/{}.{}", hash, image_extension(&bytes).unwrap());
                        if !files.iter().any(|(name, _)| name == &path) {
                            files.push((path.clone(), bytes));
                        }
                        asset.status = "saved".into();
                        asset.path = Some(path);
                        asset.sha256 = Some(hash);
                    }
                    Ok(_) => {
                        asset.status = "failed".into();
                        asset.error =
                            Some("不是支持的图片格式，或达到导出体积上限（64 MB）".into());
                    }
                    Err(error) => {
                        asset.status = "failed".into();
                        asset.error = Some(error);
                    }
                }
            }
            Ok(Some(Err(_))) => {}
            Ok(None) => break,
            Err(_) => {
                jobs.abort_all();
                break;
            }
        }
    }
    for asset in &mut doc.assets {
        if asset.status == "pending" {
            asset.status = "failed".into();
            asset.error = Some("图片下载超时；可重新导出重试".into());
        }
    }
    let images = doc.assets.iter().filter(|a| a.status == "saved").count();
    let missing = doc.assets.len() - images;
    if missing > 0 {
        doc.warnings.push(format!(
            "{missing} 张图片未能保存，原始地址和失败原因保留在 manifest.json。"
        ));
    }
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "无法访问下载目录")?
        .join("scholay tody");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建图文导出目录")?;
    let title: String = doc
        .title
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .take(50)
        .collect();
    let path = directory.join(format!(
        "{}-{}.zip",
        if title.is_empty() { "article" } else { &title },
        uuid::Uuid::new_v4().simple()
    ));
    let count = doc.blocks.len();
    let warnings = doc.warnings.clone();
    let capture = doc.capture_id.clone();
    let saved_path = path.clone();
    tokio::task::spawn_blocking(move || package(&doc, ai.as_deref(), &files, &saved_path))
        .await
        .map_err(|_| "导出任务异常结束")??;
    Ok(
        json!({"path":path,"images":images,"missingImages":missing,"blocks":count,"warnings":warnings,"captureId":capture}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_active_content() {
        assert_eq!(image_extension(b"<svg onload='alert(1)'>"), None);
        assert_eq!(image_extension(b"<html>login</html>"), None);
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
    }
    #[test]
    fn relative_images_and_metadata() {
        let doc = Document {
            schema_version: 1,
            capture_id: "fixture".into(),
            article_id: 1,
            title: "图文".into(),
            source_url: "https://example.org".into(),
            captured_at: "now".into(),
            source_kind: "web".into(),
            author: None,
            published_at: None,
            truncated: false,
            blocks: vec![],
            assets: vec![],
            warnings: vec![],
        };
        let mut doc = article_document::parse(doc, "<p>正文</p><img src='/a.png'>");
        doc.assets[0].path = Some("assets/a.png".into());
        doc.assets[0].status = "saved".into();
        let path =
            std::env::temp_dir().join(format!("scholay-export-test-{}.zip", uuid::Uuid::new_v4()));
        package(
            &doc,
            None,
            &[("assets/a.png".into(), b"image".to_vec())],
            &path,
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(archive.len(), 4);
        use std::io::Read;
        let mut text = String::new();
        archive
            .by_name("article.md")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(text.contains("](assets/a.png)"));
        assert!(archive.by_name("manifest.json").is_ok());
        drop(archive);
        std::fs::remove_file(path).unwrap();
    }
}
