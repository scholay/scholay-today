//! Optional labels workspace. Only verified DOM ranking fields leave the native
//! page; platform sessions stay in the OS webview store, outside RSS/AI/MCP.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

#[derive(Clone, Deserialize)]
pub(crate) struct Source {
    pub id: String,
    pub url: String,
    pub hosts: Vec<String>,
    pub cookie_domains: Vec<String>,
    pub adapter: bool,
}

pub(crate) fn source(id: &str) -> Result<Source, String> {
    serde_json::from_str::<Vec<Source>>(include_str!("../../src/labels/catalog.json"))
        .map_err(|_| "标签平台配置不可用".to_string())?
        .into_iter()
        .find(|source| source.id == id)
        .ok_or_else(|| "未知标签平台".into())
}

pub(crate) fn allowed(source: &Source, url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && source
            .hosts
            .iter()
            .any(|host| Some(host.as_str()) == url.host_str())
}

#[derive(Deserialize, Serialize)]
pub struct LabelRow {
    term: String,
    metric: String,
    kind: String,
    rank: u32,
}
#[derive(Deserialize, Serialize)]
pub struct LabelProbe {
    auth: String,
    rows: Vec<LabelRow>,
    period: String,
    clicked: bool,
}

pub(crate) fn decode(raw: &str) -> Result<LabelProbe, String> {
    if raw.len() > 64_000 {
        return Err("平台返回内容过大".into());
    }
    // eval_with_callback serializes the JS string once more.
    let decoded: String = serde_json::from_str(raw).map_err(|_| "等待平台页面就绪".to_string())?;
    let mut probe: LabelProbe =
        serde_json::from_str(&decoded).map_err(|_| "平台结构暂不支持".to_string())?;
    if !matches!(
        probe.auth.as_str(),
        "unknown" | "signed_in" | "signed_out" | "challenge"
    ) || probe.rows.len() > 200
        || probe.period.chars().count() > 80
    {
        return Err("平台返回内容无效".into());
    }
    probe.rows.retain(|row| {
        !row.term.is_empty()
            && row.term.chars().count() <= 100
            && !row.term.chars().any(char::is_control)
            && row.metric.len() <= 40
            && row
                .metric
                .chars()
                .all(|c| c.is_ascii_digit() || ",. WwKkMm%万亿".contains(c))
            && (1..=100).contains(&row.rank)
            && matches!(row.kind.as_str(), "热门关键词" | "飙升关键词")
    });
    Ok(probe)
}

#[tauri::command]
pub async fn probe_label_page(
    app: AppHandle,
    webview: Webview,
    request_id: String,
    source_id: String,
    action: String,
    term: Option<String>,
    kind: Option<String>,
) -> Result<LabelProbe, String> {
    crate::hot_board::require_main(&webview)?;
    let source = source(&source_id)?;
    if !matches!(action.as_str(), "inspect" | "login" | "keyword")
        || term
            .as_ref()
            .is_some_and(|value| value.chars().count() > 100)
        || kind
            .as_ref()
            .is_some_and(|value| !matches!(value.as_str(), "热门关键词" | "飙升关键词"))
    {
        return Err("标签操作无效".into());
    }
    let options = serde_json::json!({"id":source.id,"hosts":source.hosts,"action":action,"term":term,"kind":kind});
    let script =
        include_str!("label_probe.js").replace("__LABEL_PROBE_OPTIONS__", &options.to_string());
    let raw = crate::page_view::inspect_label_page(app, request_id, &source, script).await?;
    decode(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_and_origin_are_exact_and_https_only() {
        let s = source("bilibili").unwrap();
        assert!(allowed(&s, &url::Url::parse(&s.url).unwrap()));
        for url in [
            "http://trends.bilibili.com/",
            "https://trends.bilibili.com.evil.org/",
            "https://evil.bilibili.com/",
            "https://user:pass@trends.bilibili.com/",
            "https://trends.bilibili.com:444/",
        ] {
            assert!(!allowed(&s, &url::Url::parse(url).unwrap()));
        }
        assert!(source("../rss").is_err());
    }
    #[test]
    fn bounded_data_only_and_auth_not_inferred_from_rows() {
        let raw = serde_json::json!({"auth":"unknown","rows":[{"term":"知识","metric":"1.2W","kind":"热门关键词","rank":1},{"term":"invalid","metric":"javascript:alert(1)","kind":"热门关键词","rank":2}],"period":"日榜","clicked":false}).to_string();
        let result = decode(&serde_json::to_string(&raw).unwrap()).unwrap();
        assert_eq!(result.auth, "unknown");
        assert_eq!(result.rows.len(), 1);
        assert!(decode("null").is_err());
        assert!(decode(&"x".repeat(64_001)).is_err());
    }
}
