//! A labels-only background browser. No remote IPC, scripts from the frontend,
//! private backend scraping, or changes to the reader's single page-view.
use crate::label_board::{self, Source};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

static GENERATION: AtomicU64 = AtomicU64::new(0);
static COLLECTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    term: String,
    metric: String,
    kind: String,
    rank: u32,
    metric_label: String,
}
#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    rows: Vec<Row>,
    period: String,
    auth: String,
}

fn decode(raw: &str, id: &str) -> Result<Snapshot, String> {
    if raw.len() > 128_000 {
        return Err("标签数据超出安全限制".into());
    }
    let inner: String = serde_json::from_str(raw).map_err(|_| "等待平台页面就绪")?;
    let mut snapshot: Snapshot = serde_json::from_str(&inner).map_err(|_| "平台结构暂不支持")?;
    if snapshot.rows.len() > 200
        || snapshot.period.len() > 240
        || !matches!(
            snapshot.auth.as_str(),
            "unknown" | "signed_in" | "signed_out" | "challenge"
        )
    {
        return Err("平台数据格式无效".into());
    }
    snapshot.rows.retain(|row| {
        let kind_valid = match id {
            "bilibili" => {
                matches!(row.kind.as_str(), "热门关键词" | "飙升关键词")
                    && row.metric_label == "内容指数"
            }
            "douyin" => {
                matches!(row.kind.as_str(), "抖音实时热点" | "抖音飙升热点")
                    && row.metric_label == "热点指数"
            }
            "zhihu" => {
                matches!(row.kind.as_str(), "知乎热题" | "全网热点")
                    && row.metric_label.is_empty()
                    && row.metric.is_empty()
            }
            _ => false,
        };
        kind_valid
            && !row.term.is_empty()
            && row.term.chars().count() <= 200
            && !row.term.chars().any(char::is_control)
            && row.metric.len() <= 40
            && row
                .metric
                .chars()
                .all(|c| c.is_ascii_digit() || ",. WwKkMm%万亿".contains(c))
            && (1..=100).contains(&row.rank)
    });
    Ok(snapshot)
}

async fn inspect(view: &Webview, source: &Source) -> Result<Snapshot, String> {
    let expected = view.url().map_err(|_| "平台页面不可用")?;
    if !label_board::allowed(source, &expected) {
        return Err("等待官方页面就绪".into());
    }
    let options = serde_json::json!({"id":source.id,"hosts":source.hosts});
    let script =
        include_str!("label_extract.js").replace("__LABEL_EXTRACT_OPTIONS__", &options.to_string());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let target = view.clone();
    view.run_on_main_thread(move || {
        let _ = target.eval_with_callback(script, move |raw| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(raw);
            }
        });
    })
    .map_err(|_| "平台页面不可用")?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(3), rx)
        .await
        .map_err(|_| "平台响应超时")?
        .map_err(|_| "采集页面已关闭")?;
    if view.url().ok().as_ref() != Some(&expected) {
        return Err("平台页面正在跳转".into());
    }
    decode(&raw, &source.id)
}

struct OwnedCollector {
    app: AppHandle,
    label: String,
}
impl Drop for OwnedCollector {
    fn drop(&mut self) {
        if let Some(window) = self.app.get_webview_window(&self.label) {
            let _ = window.destroy();
        }
    }
}

#[tauri::command]
pub fn cancel_label_collection(webview: Webview) -> Result<(), String> {
    crate::hot_board::require_main(&webview)?;
    GENERATION.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

#[tauri::command]
pub async fn collect_label_source(
    app: AppHandle,
    webview: Webview,
    source_id: String,
) -> Result<Snapshot, String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    if !source.adapter {
        return Err("此平台的结构化适配尚待验证；可先保存授权".into());
    }
    let generation = GENERATION.load(Ordering::Acquire);
    let _serial = COLLECTION.lock().await;
    let cancelled = || GENERATION.load(Ordering::Acquire) != generation;
    if cancelled() {
        return Err("同步已取消".into());
    }
    let label = format!("label-collector-{}", uuid::Uuid::new_v4());
    let scoped = source.clone();
    let builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(url::Url::parse("about:blank").unwrap()),
    )
    .title("Scholay 标签后台采集")
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .inner_size(1280., 900.)
    .initialization_script("window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;")
    .on_navigation(move |url| url.as_str() == "about:blank" || label_board::allowed(&scoped, url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false);
    #[cfg(target_os = "macos")]
    let builder = if source.id == "bilibili" {
        builder.user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15")
    } else {
        builder
    };
    builder.build().map_err(|_| "后台采集窗口无法启动")?;
    let _owned = OwnedCollector {
        app: app.clone(),
        label: label.clone(),
    };
    let view = app.get_webview(&label).ok_or("后台采集窗口不可用")?;
    let restore_view = view.clone();
    let restore_source = source.clone();
    tokio::task::spawn_blocking(move || {
        crate::label_credentials::restore_to(&restore_source, &restore_view)
    })
    .await
    .map_err(|_| "恢复授权失败")??;
    if cancelled() {
        return Err("同步已取消".into());
    }
    view.navigate(url::Url::parse(&source.url).map_err(|_| "平台网址无效")?)
        .map_err(|_| "无法加载标签来源")?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut latest = None;
    while tokio::time::Instant::now() < deadline {
        if cancelled() {
            return Err("同步已取消".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        if let Ok(snapshot) = inspect(&view, &source).await {
            if cancelled() {
                return Err("同步已取消".into());
            }
            if !snapshot.rows.is_empty() {
                let renewed_source = source.clone();
                let renewed_view = view.clone();
                // A vault refresh failure must not discard successfully read data.
                let _ = tokio::task::spawn_blocking(move || {
                    crate::label_credentials::refresh_saved_from(&renewed_source, &renewed_view)
                })
                .await;
                if cancelled() {
                    return Err("同步已取消".into());
                }
                return Ok(snapshot);
            }
            // A challenge should be handled visibly by the user, never retried
            // or solved in the background. Normal login gates may be transient.
            if snapshot.auth == "challenge" {
                return Ok(snapshot);
            }
            latest = Some(snapshot);
        }
    }
    latest.ok_or_else(|| "平台连接超时，已保留上次标签；可稍后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validated_rows_are_platform_specific_and_bounded() {
        let payload=serde_json::json!({"rows":[{"term":"研究选题","metric":"","metricLabel":"","kind":"知乎热题","rank":1}],"auth":"unknown","period":"当前榜单"}).to_string();
        let raw = serde_json::to_string(&payload).unwrap();
        assert_eq!(decode(&raw, "zhihu").unwrap().rows.len(), 1);
        assert!(decode(&raw, "douyin").unwrap().rows.is_empty());
        assert!(decode(&"a".repeat(128_001), "zhihu").is_err());
    }
}
