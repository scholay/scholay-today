//! Explicit, bounded multi-article export. Reads snapshots; never changes RSS
//! records, read/star flags or AI drafts. Reuses the single-article package.
use crate::{article_document::{self, Document}, article_export, db, extraction, hot_board, public_fetch, state::AppState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, io::Write, path::{Path, PathBuf}, time::Duration};
use tauri::{ipc::Channel, AppHandle, Manager, State, Webview};

const MAX_ARTICLES: usize = 200;
const IMAGE_BUDGET: usize = 256 * 1024 * 1024;

fn validate_ids(ids: Vec<i64>) -> Result<Vec<i64>, String> {
    if ids.is_empty() || ids.len() > MAX_ARTICLES || ids.iter().any(|id| *id <= 0) {
        return Err(format!("请选择 1–{MAX_ARTICLES} 篇文章"));
    }
    let mut seen = HashSet::new();
    Ok(ids.into_iter().filter(|id| seen.insert(*id)).collect())
}

/// Prefer the evidence paired with the cached Markdown, then a web snapshot,
/// then extracted/RSS HTML. Never attach Markdown from a different snapshot.
fn load(c: &Connection, id: i64) -> Result<(Document, Option<String>, bool), String> {
    let article = db::get_article(c, id).map_err(|_| "文章已不存在")?;
    if let Some(draft) = papr_core::ai_formatted::get(c, id).map_err(|e| e.to_string())? {
        if let Some(doc) = article_export::saved(c, id, Some(&draft.capture_id))? {
            if !doc.blocks.is_empty() {
                return Ok((doc, Some(draft.markdown), false));
            }
        }
    }
    if let Some(doc) = article_export::saved(c, id, None)? {
        if !doc.blocks.is_empty() && doc.source_kind != "cached_article" {
            return Ok((doc, None, false));
        }
    }
    let needs_fetch = article.extracted_html.as_deref().is_none_or(|s| s.trim().is_empty());
    let mut doc = article_export::cached_document(c, id)?;
    if !needs_fetch {
        doc.source_kind = "extracted_cache".into();
        doc.warnings = vec!["来自已保存的全文提取缓存，未重新访问网页。".into()];
    }
    Ok((doc, None, needs_fetch))
}

#[tauri::command]
pub async fn preview_article_bundles(state: State<'_, AppState>, webview: Webview, article_ids: Vec<i64>) -> Result<Vec<Value>, String> {
    hot_board::require_main(&webview)?;
    let ids = validate_ids(article_ids)?;
    // saved() may lazily initialize the capture table, so use the write-capable
    // connection, only for these quick local reads, never across a network wait.
    let c = state.db.lock().await;
    Ok(ids.into_iter().map(|id| match load(&c, id) {
        Ok((doc, ai, needs_fetch)) => json!({"articleId":id,"title":doc.title,"sourceKind":doc.source_kind,"hasMarkdown":ai.is_some(),"images":doc.assets.len(),"needsFetch":needs_fetch,"empty":doc.blocks.is_empty(),"error":null}),
        Err(error) => json!({"articleId":id,"error":error}),
    }).collect())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub include_images: bool,
    pub fetch_missing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    article_id: i64,
    title: String,
    folder: Option<String>,
    images: usize,
    missing_images: usize,
    warnings: Vec<String>,
    error: Option<String>,
    retryable: bool,
}

fn folder_name(id: i64, title: &str) -> String {
    let name: String = title.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_')).take(45).collect();
    format!("articles/{id}-{}", if name.is_empty() { "article" } else { &name })
}

fn index_markdown(items: &[ItemResult]) -> String {
    let mut out = String::from("# 图文资料包目录\n\n每篇独立保存 Markdown、JSON 和图片；AI 整理稿仅在存在对应缓存时附带，导出不调用 AI。\n\n");
    for item in items {
        let title = item.title.replace(['\r', '\n'], " ").replace('&', "&amp;").replace('<', "&lt;").replace('[', "\\[").replace(']', "\\]");
        if let Some(folder) = &item.folder {
            // URL serialization escapes spaces/parentheses in imported titles.
            let relative = url::Url::parse(&format!("https://export.invalid/{folder}/article.md")).unwrap().path().trim_start_matches('/').to_string();
            out.push_str(&format!("- [{title}]({relative}) · {} 张图片{}\n", item.images, if item.retryable { " · 有未完成项，见 manifest.json" } else { "" }));
        } else {
            out.push_str(&format!("- {title} · 导出失败，见 manifest.json\n"));
        }
    }
    out
}

/// Only publicly reachable HTML. No cookie/token reuse or background AI.
async fn fetch_missing(mut doc: Document) -> Result<Document, String> {
    let (bytes, mime, final_url) = tokio::time::timeout(Duration::from_secs(45), public_fetch::fetch(&doc.source_url, None, 4 * 1024 * 1024)).await.map_err(|_| "补抓取超时")??;
    if !mime.contains("text/html") && !mime.contains("application/xhtml") {
        return Err("原网页未返回 HTML；请先在网页视图中打开后导出".into());
    }
    let charset = mime.split(';').find_map(|part| part.trim().strip_prefix("charset=")).unwrap_or("utf-8").trim_matches(['\'', '"']);
    let encoding = encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let html = encoding.decode(&bytes).0.into_owned();
    let extracted_url = final_url.clone();
    let html = tokio::task::spawn_blocking(move || extraction::extract_article(&html, &extracted_url)).await.map_err(|_| "全文提取任务异常")?.map_err(|_| "未识别到正文；可能需要登录或执行网页脚本")?;
    doc.capture_id = format!("batch-{}", uuid::Uuid::new_v4());
    doc.captured_at = chrono::Utc::now().to_rfc3339();
    doc.source_url = final_url;
    doc.source_kind = "public_webpage".into();
    doc.blocks.clear(); doc.assets.clear();
    doc.warnings = vec!["来自公开网页的正文提取；未使用登录态，未执行网页脚本，不保证包含隐藏、分页或附件内容。".into()];
    let doc = article_document::parse(doc, &html);
    if doc.blocks.is_empty() { return Err("补抓取没有获得正文".into()); }
    Ok(doc)
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        // These two generated files and this freshly-created directory are the
        // entire cleanup scope. Never traverse user directories recursively.
        let _ = std::fs::remove_file(self.0.join("article.zip"));
        let _ = std::fs::remove_file(self.0.join("bundle.zip"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn append_article(zip: &mut zip::ZipWriter<std::fs::File>, folder: &str, doc: &Document, ai: Option<&str>, files: &[(String, Vec<u8>)], staging: &Path) -> Result<(), String> {
    let package_path = staging.join("article.zip");
    article_export::package(doc, ai, files, &package_path)?;
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&package_path).map_err(|_| "无法读取图文包")?).map_err(|_| "图文包不完整")?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|_| "无法读取图文包条目")?;
        // Entries come exclusively from our single-package writer, not from an
        // imported ZIP; still reject unsafe entry names defensively.
        if file.enclosed_name().is_none() { return Err("非法资料包路径".into()); }
        zip.start_file(format!("{folder}/{}", file.name()), zip::write::SimpleFileOptions::default().unix_permissions(0o600)).map_err(|_| "无法写入资料包")?;
        std::io::copy(&mut file, zip).map_err(|_| "无法写入资料包；请检查磁盘空间")?;
    }
    drop(archive);
    std::fs::remove_file(&package_path).map_err(|_| "无法清理导出暂存文件")?;
    Ok(())
}

#[tauri::command]
pub async fn export_article_bundles(app: AppHandle, state: State<'_, AppState>, webview: Webview, article_ids: Vec<i64>, options: Options, on_progress: Channel<Value>) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    let ids = validate_ids(article_ids)?;
    let _guard = article_export::acquire()?;
    let directory = app.path().download_dir().map_err(|_| "无法访问下载目录")?.join("scholay today");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建导出目录")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let staging_path = directory.join(format!(".batch-{token}"));
    std::fs::create_dir(&staging_path).map_err(|_| "无法创建暂存目录")?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&staging_path, std::fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护暂存目录")?; }
    let staging = Staging(staging_path);
    let mut zip = zip::ZipWriter::new(std::fs::OpenOptions::new().write(true).create_new(true).open(staging.0.join("bundle.zip")).map_err(|_| "无法新建资料包")?);
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(staging.0.join("bundle.zip"), std::fs::Permissions::from_mode(0o600)).map_err(|_| "无法保护资料包")?; }
    let mut remaining = IMAGE_BUDGET;
    let mut items = Vec::new();
    let total = ids.len();
    for (index, id) in ids.into_iter().enumerate() {
        let loaded = { let c = state.db.lock().await; load(&c, id) };
        let mut item = ItemResult { article_id: id, title: format!("文章 {id}"), folder: None, images: 0, missing_images: 0, warnings: vec![], error: None, retryable: false };
        match loaded {
            Err(error) => { item.error = Some(error); item.retryable = true; }
            Ok((mut doc, ai, needs_fetch)) => {
                item.title = doc.title.clone();
                let _ = on_progress.send(json!({"done":index,"total":total,"title":item.title,"phase":"article"}));
                if options.fetch_missing && needs_fetch {
                    match fetch_missing(doc.clone()).await {
                        Ok(fetched) => doc = fetched,
                        Err(error) => {
                            doc.warnings.push(format!("补抓取失败，保留本地缓存：{error}"));
                            item.retryable = true;
                        }
                    }
                }
                if doc.blocks.is_empty() {
                    item.error = Some("没有可导出的正文；请在网页视图中加载原文后重试".into()); item.retryable = true;
                } else {
                    let files = article_export::download_assets(&mut doc, options.include_images, remaining.min(64 * 1024 * 1024)).await;
                    remaining = remaining.saturating_sub(files.iter().map(|(_, b)| b.len()).sum());
                    item.images = doc.assets.iter().filter(|a| a.status == "saved").count();
                    item.missing_images = if options.include_images { doc.assets.len() - item.images } else { 0 };
                    item.retryable |= item.missing_images > 0;
                    item.warnings = doc.warnings.clone();
                    let folder = folder_name(id, &doc.title);
                    let package_folder = folder.clone();
                    let stage = staging.0.clone();
                    // Disk/ZIP work lives off the async runtime; only one article
                    // worth of image bytes is resident at a time.
                    zip = tokio::task::spawn_blocking(move || {
                        append_article(&mut zip, &package_folder, &doc, ai.as_deref(), &files, &stage)?;
                        Ok::<_, String>(zip)
                    }).await.map_err(|_| "资料包写入任务异常")??;
                    item.folder = Some(folder);
                }
            }
        }
        items.push(item);
        let _ = on_progress.send(json!({"done":index+1,"total":total,"title":items.last().unwrap().title,"phase":"article"}));
    }
    let successful = items.iter().filter(|i| i.folder.is_some()).count();
    let retry_ids: Vec<_> = items.iter().filter(|i| i.retryable).map(|i| i.article_id).collect();
    let path = directory.join(format!("图文资料包-{}-{token}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let manifest = json!({"schemaVersion":1,"product":"scholay today","exportedAt":chrono::Utc::now().to_rfc3339(),"options":options,"total":total,"successful":successful,"retryIds":retry_ids,"items":items,"aiInvoked":false});
    let index = index_markdown(&items);
    let final_path = path.clone();
    tokio::task::spawn_blocking(move || {
        let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o600);
        zip.start_file("index.md", opts).map_err(|_| "无法写入目录")?;
        zip.write_all(index.as_bytes()).map_err(|_| "无法写入目录")?;
        zip.start_file("manifest.json", opts).map_err(|_| "无法写入清单")?;
        zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes()).map_err(|_| "无法写入清单")?;
        let file = zip.finish().map_err(|_| "无法完成资料包")?;
        file.sync_all().map_err(|_| "无法保存资料包")?;
        drop(file);
        // Same filesystem, atomic publication and no replacement of an existing
        // user file. Drop removes only our two exact staging files afterwards.
        std::fs::hard_link(staging.0.join("bundle.zip"), &final_path).map_err(|_| "无法发布资料包；请检查下载目录权限或磁盘空间")?;
        Ok::<_, String>(())
    }).await.map_err(|_| "资料包收尾任务异常")??;
    Ok(json!({"path":path,"total":total,"successful":successful,"retryIds":retry_ids,"items":items}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn bounds_and_duplicates() {
        assert!(validate_ids(vec![]).is_err()); assert!(validate_ids(vec![0]).is_err());
        assert!(validate_ids((1..202).collect()).is_err());
        assert_eq!(validate_ids(vec![4, 2, 4]).unwrap(), vec![4, 2]);
    }
    #[test]
    fn folders_are_safe_and_identity_based() {
        assert_eq!(folder_name(8, "../../a:b\\c?"), "articles/8-abc");
        assert_ne!(folder_name(1, "同名"), folder_name(2, "同名"));
        assert_eq!(folder_name(7, "///"), "articles/7-article");
    }
    #[test]
    fn batch_reuses_single_package_and_local_image_references() {
        let path = std::env::temp_dir().join(format!("batch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let staging = Staging(path);
        let mut doc = article_document::parse(Document { schema_version:1,capture_id:"test".into(),article_id:7,title:"带图资料".into(),source_url:"https://example.org/post".into(),captured_at:"now".into(),source_kind:"rendered_webpage".into(),author:None,published_at:None,truncated:false,blocks:vec![],assets:vec![],warnings:vec![] }, "<p>正文</p><img src='/a.png'>");
        doc.assets[0].path = Some("assets/a.png".into()); doc.assets[0].status = "saved".into();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(staging.0.join("bundle.zip")).unwrap());
        append_article(&mut zip, "articles/7-test", &doc, Some("# 缓存整理稿"), &[("assets/a.png".into(), b"image".to_vec())], &staging.0).unwrap();
        zip.finish().unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(staging.0.join("bundle.zip")).unwrap()).unwrap();
        let mut text = String::new(); archive.by_name("articles/7-test/article.md").unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("](assets/a.png)"));
        assert!(archive.by_name("articles/7-test/assets/a.png").is_ok());
        assert!(archive.by_name("articles/7-test/ai-formatted.md").is_ok());
    }
}
