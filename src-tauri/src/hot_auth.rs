//! Optional Product Hunt public API authorization. Secrets go only to a single
//! OS credential-store item and the fixed provider endpoint, never SQLite or logs.

use crate::{
    db,
    hot_board::{self, HotItem},
    hot_sources,
    state::AppState,
};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::{
    header::{HeaderValue, AUTHORIZATION},
    Client, RequestBuilder,
};
use serde::Serialize;
use std::time::Duration;
use tauri::Webview;

pub(crate) const SOURCE_ID: &str = "producthunt-ranking";
pub(crate) const NOT_CONFIGURED: &str = "尚未配置 Product Hunt 接口授权。";
const NOT_SUPPORTED: &str =
    "API Token authorization is supported for Product Hunt on macOS and Windows.";
const KEYCHAIN_ERROR: &str = "Could not access the Product Hunt token in the system credential store.";
const KEYCHAIN_SAVE_ERROR: &str = "Could not save the Product Hunt token to the system credential store (Windows: maximum 2560 bytes).";
const KEYCHAIN_SERVICE: &str = "com.thomas.papr.hot-board.producthunt";
const KEYCHAIN_ACCOUNT: &str = "producthunt-ranking";
const ENDPOINT: &str = "https://api.producthunt.com/v2/api/graphql";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const QUERY: &str = "query($postedAfter: DateTime!) { posts(first: 30, order: RANKING, postedAfter: $postedAfter) { edges { node { id name tagline votesCount url slug } } } }";

#[derive(Clone, Debug, Serialize)]
pub struct HotAuthStatus {
    pub configured: bool,
    pub supported: bool,
}

// Deliberately neither Debug nor Serialize. Minimize the original buffer's
// lifetime; reqwest necessarily owns its sensitive HTTP header until completion.
struct ApiToken(Vec<u8>);
impl Drop for ApiToken {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

fn validate_token(raw: String) -> Result<ApiToken, String> {
    let mut bytes = raw.into_bytes();
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |i| i + 1);
    let token = &bytes[start..end];
    // RFC 6750 bearer-token characters; reject spaces, controls and header
    // injection. This validates input shape, not provider authorization.
    if token.is_empty()
        || token.len() > 4096
        || !token
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(b))
    {
        bytes.fill(0);
        return Err("Enter only the API token (no Bearer prefix), without spaces or control characters; maximum 4096 characters.".into());
    }
    let len = end - start;
    bytes.copy_within(start..end, 0);
    bytes[len..].fill(0);
    bytes.truncate(len);
    Ok(ApiToken(bytes))
}

trait TokenStore {
    fn configured(&self) -> Result<bool, ()>;
    fn read(&self) -> Result<Option<ApiToken>, ()>;
    fn save(&self, token: &ApiToken) -> Result<(), ()>;
}

struct NativeTokenStore;

#[cfg(target_os = "macos")]
impl TokenStore for NativeTokenStore {
    fn configured(&self) -> Result<bool, ()> {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        // Existence query only: status does not request the token bytes.
        let result = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(KEYCHAIN_SERVICE)
            .account(KEYCHAIN_ACCOUNT)
            .load_attributes(true)
            .load_data(false)
            .limit(1)
            .search();
        match result {
            Ok(items) => Ok(!items.is_empty()),
            Err(error) if error.code() == -25300 => Ok(false), // errSecItemNotFound
            Err(_) => Err(()),
        }
    }

    fn read(&self) -> Result<Option<ApiToken>, ()> {
        match security_framework::passwords::get_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT,
        ) {
            Ok(bytes) => {
                let mut token = ApiToken(bytes);
                let raw = String::from_utf8(std::mem::take(&mut token.0)).map_err(|_| ())?;
                validate_token(raw).map(Some).map_err(|_| ())
            }
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn save(&self, token: &ApiToken) -> Result<(), ()> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT,
            &token.0,
        )
        .map_err(|_| ())
    }
}

#[cfg(windows)]
impl TokenStore for NativeTokenStore {
    fn configured(&self) -> Result<bool, ()> { Ok(self.read()?.is_some()) }
    fn read(&self) -> Result<Option<ApiToken>, ()> {
        crate::windows_credentials::read(KEYCHAIN_SERVICE)?.map(|bytes| {
            String::from_utf8(bytes).map_err(|_| ()).and_then(|raw| validate_token(raw).map_err(|_| ()))
        }).transpose()
    }
    fn save(&self, token: &ApiToken) -> Result<(), ()> { crate::windows_credentials::save(KEYCHAIN_SERVICE, &token.0) }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl TokenStore for NativeTokenStore {
    fn configured(&self) -> Result<bool, ()> {
        Err(())
    }
    fn read(&self) -> Result<Option<ApiToken>, ()> {
        Err(())
    }
    fn save(&self, _token: &ApiToken) -> Result<(), ()> {
        Err(())
    }
}

fn status_with(
    store: &impl TokenStore,
    source_id: &str,
    platform_supported: bool,
) -> Result<HotAuthStatus, String> {
    if source_id != SOURCE_ID || !platform_supported {
        return Ok(HotAuthStatus {
            configured: false,
            supported: false,
        });
    }
    let configured = store.configured().map_err(|_| KEYCHAIN_ERROR.to_string())?;
    Ok(HotAuthStatus {
        configured,
        supported: true,
    })
}

fn save_with(
    store: &impl TokenStore,
    source_id: &str,
    raw: String,
    platform_supported: bool,
) -> Result<(), String> {
    if source_id != SOURCE_ID || !platform_supported {
        return Err(NOT_SUPPORTED.into());
    }
    let token = validate_token(raw)?;
    store
        .save(&token)
        .map_err(|_| KEYCHAIN_SAVE_ERROR.to_string())
}

#[tauri::command]
pub async fn get_hot_auth_status(
    webview: Webview,
    source_id: String,
) -> Result<HotAuthStatus, String> {
    hot_board::require_main(&webview)?;
    // The UI invokes this only when the user opens the authorization panel.
    tokio::task::spawn_blocking(move || {
        status_with(&NativeTokenStore, &source_id, cfg!(any(target_os = "macos", windows)))
    })
    .await
    .map_err(|_| KEYCHAIN_ERROR.to_string())?
}

#[tauri::command]
pub async fn save_hot_api_token(
    webview: Webview,
    source_id: String,
    token: String,
) -> Result<(), String> {
    hot_board::require_main(&webview)?;
    // Save only. No status re-read, network test, or implicit list refresh.
    tokio::task::spawn_blocking(move || {
        save_with(
            &NativeTokenStore,
            &source_id,
            token,
            cfg!(any(target_os = "macos", windows)),
        )
    })
    .await
    .map_err(|_| KEYCHAIN_SAVE_ERROR.to_string())?
}

fn build_client(timeout_secs: u64, proxy: &str) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent("Papr/0.15 hot-board")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(timeout_secs.clamp(5, 20)))
        .connect_timeout(Duration::from_secs(10));
    match proxy {
        "system" | "" => {}
        "none" => builder = builder.no_proxy(),
        custom => {
            let configured = reqwest::Proxy::all(custom)
                .map_err(|_| "The configured network proxy could not be used.".to_string())?;
            builder = builder.proxy(configured);
        }
    }
    builder
        .build()
        .map_err(|_| "The Product Hunt network client could not be initialized.".into())
}

fn producthunt_request(
    client: &Client,
    token: &ApiToken,
    now: DateTime<Utc>,
) -> Result<RequestBuilder, String> {
    let mut bearer = ApiToken(b"Bearer ".to_vec());
    bearer.0.extend_from_slice(&token.0);
    let mut header = HeaderValue::from_bytes(&bearer.0)
        .map_err(|_| "The saved API token has an invalid format.".to_string())?;
    header.set_sensitive(true);
    let posted_after = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("UTC midnight")
        .and_utc()
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    Ok(client
        .post(ENDPOINT)
        .header(AUTHORIZATION, header)
        .json(&serde_json::json!({
            "query": QUERY, "variables": { "postedAfter": posted_after }
        })))
}

fn parse_producthunt(body: &[u8]) -> Result<Vec<HotItem>, String> {
    let data: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| "Product Hunt returned an unreadable JSON response.".to_string())?;
    if data.get("errors").is_some_and(|value| {
        !value.is_null() && value.as_array().is_none_or(|rows| !rows.is_empty())
    }) {
        return Err(
            "Product Hunt rejected the API query or authorization. No previous data was replaced."
                .into(),
        );
    }
    let edges = data
        .pointer("/data/posts/edges")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Product Hunt returned an unexpected response format.".to_string())?;
    let mut items = vec![];
    for edge in edges.iter().take(30) {
        let Some(node) = edge.get("node") else {
            continue;
        };
        let field = |key| node.get(key).and_then(|value| value.as_str()).unwrap_or("");
        let (id, title, link) = (field("id"), field("name"), field("url"));
        let valid_host = url::Url::parse(link).is_ok_and(|url| {
            matches!(
                url.host_str(),
                Some("producthunt.com" | "www.producthunt.com")
            )
        });
        if id.is_empty() || title.trim().is_empty() || !valid_host || !hot_sources::safe_url(link) {
            continue;
        }
        let tagline = field("tagline");
        items.push(HotItem {
            id: id.into(),
            title: title.into(),
            url: link.into(),
            description: (!tagline.is_empty()).then(|| tagline.into()),
            heat: node
                .get("votesCount")
                .and_then(|value| value.as_u64())
                .map(|votes| format!("{votes} votes")),
            rank: items.len() + 1,
            published_at: None,
        });
    }
    if items.is_empty() {
        return Err("Product Hunt returned no items for the current UTC day.".into());
    }
    Ok(items)
}

/// Called only inside the explicit refresh branch, after per-source cooldown
/// and the shared four-request limit. Cache reads never reach the Keychain.
pub async fn fetch_producthunt(state: &AppState) -> Result<Vec<HotItem>, String> {
    if !cfg!(any(target_os = "macos", windows)) {
        return Err(NOT_SUPPORTED.into());
    }
    let token = tokio::task::spawn_blocking(|| NativeTokenStore.read())
        .await
        .map_err(|_| KEYCHAIN_ERROR.to_string())?
        .map_err(|_| KEYCHAIN_ERROR.to_string())?
        .ok_or_else(|| NOT_CONFIGURED.to_string())?;
    let (timeout, proxy) = {
        let conn = state.read().await;
        (
            db::setting_parsed::<u64>(&conn, "net_timeout_sec", 30),
            db::get_setting(&conn, "net_proxy")
                .ok()
                .flatten()
                .unwrap_or_else(|| "system".into()),
        )
    };
    let client = build_client(timeout, &proxy)?;
    let mut response = producthunt_request(&client, &token, Utc::now())?
        .send()
        .await
        .map_err(|_| "Product Hunt could not be reached. Try again later.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => {
                "Product Hunt API authorization was rejected (HTTP 401/403). Check the token."
                    .into()
            }
            429 => "Product Hunt API rate limit reached (HTTP 429). Try again later.".into(),
            300..=399 => {
                "Product Hunt returned a redirect; authorization was not forwarded.".into()
            }
            _ => "Product Hunt API is temporarily unavailable.".into(),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err("Product Hunt response exceeded the size limit.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Product Hunt response could not be read.".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err("Product Hunt response exceeded the size limit.".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_producthunt(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct MockStore {
        bytes: RefCell<Option<Vec<u8>>>,
        existence_queries: Cell<usize>,
        reads: Cell<usize>,
        writes: Cell<usize>,
    }
    impl TokenStore for MockStore {
        fn configured(&self) -> Result<bool, ()> {
            self.existence_queries.set(self.existence_queries.get() + 1);
            Ok(self.bytes.borrow().is_some())
        }
        fn read(&self) -> Result<Option<ApiToken>, ()> {
            self.reads.set(self.reads.get() + 1);
            Ok(self.bytes.borrow().clone().map(ApiToken))
        }
        fn save(&self, token: &ApiToken) -> Result<(), ()> {
            self.writes.set(self.writes.get() + 1);
            *self.bytes.borrow_mut() = Some(token.0.clone());
            Ok(())
        }
    }

    #[test]
    fn saving_is_separate_from_status_secret_reads_and_validation() {
        let store = MockStore::default();
        save_with(&store, SOURCE_ID, "fixture-token-123456789".into(), true).unwrap();
        assert_eq!(store.writes.get(), 1);
        assert_eq!(store.reads.get(), 0);
        assert_eq!(store.existence_queries.get(), 0);
        let status = status_with(&store, SOURCE_ID, true).unwrap();
        assert_eq!(store.reads.get(), 0);
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            "{\"configured\":true,\"supported\":true}"
        );
    }

    #[test]
    fn unknown_sources_and_other_platforms_cannot_touch_store() {
        let store = MockStore::default();
        for (id, supported) in [("weibo", true), (SOURCE_ID, false)] {
            assert!(!status_with(&store, id, supported).unwrap().supported);
            assert!(save_with(&store, id, "fixture-token".into(), supported).is_err());
        }
        assert_eq!(
            store.existence_queries.get() + store.reads.get() + store.writes.get(),
            0
        );
    }

    #[test]
    fn token_input_rejects_header_injection_without_echoing_input() {
        for raw in [
            "",
            "Bearer secret-value",
            "token\r\nX-Leak: secret-value",
            "token secret-value",
            "密钥secret-value",
        ] {
            let error = validate_token(raw.into()).err().expect("invalid fixture");
            assert!(!error.contains("secret-value"));
        }
        assert!(validate_token("x".repeat(4097)).is_err());
        assert_eq!(
            validate_token("  fixture-token\n".into()).unwrap().0,
            b"fixture-token"
        );
    }

    #[test]
    fn request_has_fixed_destination_sensitive_header_and_public_query_only() {
        let client = build_client(30, "none").unwrap();
        let token = validate_token("fixture-token-123456789".into()).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-31T12:34:56Z")
            .unwrap()
            .with_timezone(&Utc);
        let request = producthunt_request(&client, &token, now)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.url().as_str(), ENDPOINT);
        assert_eq!(request.method(), reqwest::Method::POST);
        assert!(request.headers()[AUTHORIZATION].is_sensitive());
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["variables"]["postedAfter"], "2026-08-31T00:00:00Z");
        assert!(body["query"].as_str().unwrap().contains("order: RANKING"));
        assert!(!body.to_string().contains("fixture-token"));
        assert!(!format!("{request:?}").contains("fixture-token"));
    }

    #[tokio::test]
    async fn redirect_policy_does_not_forward_synthetic_bearer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let start = format!("http://{}/", first.local_addr().unwrap());
        let destination = format!("http://{}/", second.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut connection, _) = first.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let _ = connection.read(&mut buffer).await.unwrap();
            connection.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {destination}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        let response = build_client(5, "none")
            .unwrap()
            .get(start)
            .bearer_auth("synthetic-not-a-real-token")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), second.accept())
                .await
                .is_err()
        );
        server.await.unwrap();
    }

    #[test]
    fn parses_public_ranking_and_rejects_partial_graphql_errors_and_bad_links() {
        let valid = br#"{"data":{"posts":{"edges":[{"node":{"id":"1","name":"Fixture","tagline":"Public description","votesCount":35,"url":"https://www.producthunt.com/posts/fixture","slug":"fixture"}}]}}}"#;
        let items = parse_producthunt(valid).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].heat.as_deref(), Some("35 votes"));
        let error = parse_producthunt(
            br#"{"errors":[{"message":"secret-server-data"}],"data":{"posts":{"edges":[]}}}"#,
        )
        .unwrap_err();
        assert!(!error.contains("secret-server-data"));
        let unsafe_body = String::from_utf8(valid.to_vec()).unwrap().replace(
            "https://www.producthunt.com/posts/fixture",
            "http://127.0.0.1/admin",
        );
        assert!(parse_producthunt(unsafe_body.as_bytes()).is_err());
    }
}
