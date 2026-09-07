//! Public hot lists have their own lazy cache, never the RSS database or AI.
//! Only an explicit refresh can use the network; failed refreshes retain the
//! last successful list. The remote page-view has no access to these commands.

use crate::{hot_auth, hot_sources, state::AppState};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{State, Webview};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const MANUAL_INTERVAL_MS: i64 = 60_000;
const FAILURE_BACKOFF_MS: i64 = 120_000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_ERROR: &str = "The separate hot-board cache is unavailable. RSS is unaffected.";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HotSource {
    pub id: String,
    pub name: String,
    pub region: String,
    pub category: String,
    pub kind: String,
    pub homepage: String,
    pub description: String,
    pub project: String,
    pub project_url: String,
    pub refresh_secs: u64,
    pub auth_kind: Option<String>,
    pub auth_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct HotItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub description: Option<String>,
    pub heat: Option<String>,
    pub rank: usize,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HotSnapshot {
    pub source_id: String,
    pub items: Vec<HotItem>,
    pub fetched_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub stale: bool,
    pub cached: bool,
}

#[derive(Clone, Debug)]
struct StoredSnapshot {
    source_id: String,
    items: Vec<HotItem>,
    fetched_at: Option<i64>,
    last_attempt_at: Option<i64>,
    status: String,
    error: Option<String>,
}

impl StoredSnapshot {
    fn never(id: &str) -> Self {
        Self {
            source_id: id.into(),
            items: vec![],
            fetched_at: None,
            last_attempt_at: None,
            status: "never".into(),
            error: None,
        }
    }

    fn response(&self, source: &HotSource, now: i64, cached: bool) -> HotSnapshot {
        let ttl_ms = source
            .refresh_secs
            .saturating_mul(1000)
            .min(i64::MAX as u64) as i64;
        HotSnapshot {
            source_id: self.source_id.clone(),
            items: self.items.clone(),
            fetched_at: self.fetched_at.and_then(format_timestamp),
            last_attempt_at: self.last_attempt_at.and_then(format_timestamp),
            status: self.status.clone(),
            error: self.error.clone(),
            stale: self.status != "ok"
                || self
                    .fetched_at
                    .is_none_or(|at| now.saturating_sub(at) >= ttl_ms),
            cached,
        }
    }

    fn may_refresh(&self, now: i64) -> bool {
        let interval = if self.status == "error" {
            FAILURE_BACKOFF_MS
        } else {
            MANUAL_INTERVAL_MS
        };
        self.last_attempt_at
            .is_none_or(|at| now.saturating_sub(at) >= interval)
    }
}

fn format_timestamp(milliseconds: i64) -> Option<String> {
    DateTime::from_timestamp_millis(milliseconds)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Setup only records this path: a cache failure cannot prevent RSS startup.
pub struct HotBoardState {
    path: PathBuf,
    store_lock: AsyncMutex<()>,
    source_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    network_slots: Semaphore,
    fetch_timeout: Duration,
}

impl HotBoardState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            store_lock: AsyncMutex::new(()),
            source_locks: Mutex::new(HashMap::new()),
            network_slots: Semaphore::new(4),
            fetch_timeout: FETCH_TIMEOUT,
        }
    }

    fn source_lock(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.source_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id.into())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn load(&self, id: &str) -> Result<StoredSnapshot, String> {
        let _store = self.store_lock.lock().await;
        let path = self.path.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || read_snapshot(&open_cache(&path)?, &id))
            .await
            .map_err(|_| CACHE_ERROR.to_string())?
    }

    async fn save(&self, value: &StoredSnapshot) -> Result<(), String> {
        let _store = self.store_lock.lock().await;
        let path = self.path.clone();
        let value = value.clone();
        tokio::task::spawn_blocking(move || write_snapshot(&open_cache(&path)?, &value))
            .await
            .map_err(|_| CACHE_ERROR.to_string())?
    }

    async fn snapshot_with<F, Fut>(
        &self,
        source: &HotSource,
        refresh: bool,
        fetch: F,
    ) -> Result<HotSnapshot, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<HotItem>, String>>,
    {
        // Cache-only reads neither wait for a slow source nor initiate fetching.
        if !refresh {
            return Ok(self.load(&source.id).await?.response(
                source,
                Utc::now().timestamp_millis(),
                true,
            ));
        }

        // Waiting callers re-read after the first finishes; the persisted
        // cooldown makes a single upstream request serve every same-source call.
        let source_lock = self.source_lock(&source.id);
        let _singleflight = source_lock.lock().await;
        let mut previous = self.load(&source.id).await?;
        let now = Utc::now().timestamp_millis();
        if !previous.may_refresh(now) {
            return Ok(previous.response(source, now, true));
        }
        let _slot = self
            .network_slots
            .acquire()
            .await
            .map_err(|_| "Hot-board refresh is unavailable.".to_string())?;
        let attempted = Utc::now().timestamp_millis();
        previous.last_attempt_at = Some(attempted);
        // Persist the attempt before HTTP, including for a cancelled request or
        // an app restart. A storage failure never falls through into a fetch.
        self.save(&previous).await?;
        let result = match tokio::time::timeout(self.fetch_timeout, fetch()).await {
            Ok(Ok(items)) => validate_items(items),
            Ok(Err(error)) => Err(safe_source_error(&error)),
            Err(_) => Err("The source did not respond within 20 seconds. Try again later.".into()),
        };
        let finished = Utc::now().timestamp_millis();
        let (next, cached) = match result {
            Ok(items) => (
                StoredSnapshot {
                    source_id: source.id.clone(),
                    items,
                    fetched_at: Some(finished),
                    last_attempt_at: Some(attempted),
                    status: "ok".into(),
                    error: None,
                },
                false,
            ),
            Err(error) => {
                previous.status = "error".into();
                previous.error = Some(error);
                let cached = !previous.items.is_empty();
                (previous, cached)
            }
        };
        self.save(&next).await?;
        Ok(next.response(source, finished, cached))
    }
}

fn open_cache(path: &Path) -> Result<Connection, String> {
    // Never follow a substituted cache symlink into papr.db or another file.
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(CACHE_ERROR.into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| CACHE_ERROR.to_string())?;
    }
    // macOS temporary/application paths can contain legitimate parent aliases
    // (for example /var -> /private/var). Resolve only the existing directory;
    // keep the final filename unresolved so SQLite NOFOLLOW still protects it.
    let parent = path.parent().ok_or_else(|| CACHE_ERROR.to_string())?;
    let filename = path.file_name().ok_or_else(|| CACHE_ERROR.to_string())?;
    let resolved = std::fs::canonicalize(parent)
        .map_err(|_| CACHE_ERROR.to_string())?
        .join(filename);
    let path = resolved.as_path();
    if !path.exists() {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(CACHE_ERROR.into()),
        }
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| CACHE_ERROR.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|_| CACHE_ERROR.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS hot_snapshots (
           source_id TEXT PRIMARY KEY NOT NULL,
           items_json TEXT NOT NULL,
           fetched_at INTEGER,
           last_attempt_at INTEGER,
           status TEXT NOT NULL CHECK(status IN ('never','ok','error')),
           error TEXT
         );",
    )
    .map_err(|_| CACHE_ERROR.to_string())?;
    Ok(conn)
}

fn read_snapshot(conn: &Connection, id: &str) -> Result<StoredSnapshot, String> {
    let row = conn.query_row(
        "SELECT items_json, fetched_at, last_attempt_at, status, error FROM hot_snapshots WHERE source_id=?1",
        [id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
    ).optional().map_err(|_| CACHE_ERROR.to_string())?;
    match row {
        None => Ok(StoredSnapshot::never(id)),
        Some((json, fetched_at, last_attempt_at, status, error)) => {
            if json.len() > 4 * 1024 * 1024 {
                return Err(CACHE_ERROR.into());
            }
            let items: Vec<HotItem> =
                serde_json::from_str(&json).map_err(|_| CACHE_ERROR.to_string())?;
            // Recheck persisted links too; a corrupt/older cache must not make
            // file, internal-app, loopback, or private-address links clickable.
            let count = items.len();
            let items = if !items.is_empty() {
                let checked = validate_items(items).map_err(|_| CACHE_ERROR.to_string())?;
                if checked.len() != count {
                    return Err(CACHE_ERROR.into());
                }
                checked
            } else if status == "ok" {
                return Err(CACHE_ERROR.into());
            } else {
                items
            };
            Ok(StoredSnapshot {
                source_id: id.into(),
                items,
                fetched_at,
                last_attempt_at,
                status,
                error,
            })
        }
    }
}

fn write_snapshot(conn: &Connection, value: &StoredSnapshot) -> Result<(), String> {
    let json = serde_json::to_string(&value.items).map_err(|_| CACHE_ERROR.to_string())?;
    conn.execute(
        "INSERT INTO hot_snapshots(source_id,items_json,fetched_at,last_attempt_at,status,error)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(source_id) DO UPDATE SET items_json=excluded.items_json,
         fetched_at=excluded.fetched_at,last_attempt_at=excluded.last_attempt_at,
         status=excluded.status,error=excluded.error",
        params![
            value.source_id,
            json,
            value.fetched_at,
            value.last_attempt_at,
            value.status,
            value.error
        ],
    )
    .map_err(|_| CACHE_ERROR.to_string())?;
    Ok(())
}

fn public_web_url(raw: &str) -> bool {
    hot_sources::safe_url(raw)
}

fn validate_items(items: Vec<HotItem>) -> Result<Vec<HotItem>, String> {
    if items.len() > 250 {
        return Err(
            "The source returned an unexpectedly large list. Previous data was preserved.".into(),
        );
    }
    let valid: Vec<_> = items
        .into_iter()
        .filter(|item| {
            !item.id.trim().is_empty()
                && !item.title.trim().is_empty()
                && item.id.len() <= 8192
                && item.title.chars().count() <= 2000
                && item.url.len() <= 8192
                && public_web_url(&item.url)
                && item
                    .description
                    .as_ref()
                    .is_none_or(|text| text.len() <= 32_000)
                && item.heat.as_ref().is_none_or(|text| text.len() <= 1000)
                && item
                    .published_at
                    .as_ref()
                    .is_none_or(|text| text.len() <= 200)
        })
        .collect();
    if valid.is_empty() {
        Err("The source returned no usable public items. Previous data was preserved.".into())
    } else {
        Ok(valid)
    }
}

/// Adapter errors may contain arbitrary remote data. Return only fixed messages,
/// never a response body, URL query, header, cookie, credential, or exception dump.
fn safe_source_error(raw: &str) -> String {
    if raw == hot_auth::NOT_CONFIGURED {
        return hot_auth::NOT_CONFIGURED.into();
    }
    let lower = raw.to_ascii_lowercase();
    let message = if lower.contains("403") {
        "The source denied public access (HTTP 403)."
    } else if lower.contains("429") {
        "The source is rate-limiting requests (HTTP 429). Try again later."
    } else if lower.contains("401")
        || lower.contains("credential")
        || lower.contains("authentication")
    {
        "This source requires authorization and is unavailable without credentials."
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "The source timed out. Try again later."
    } else if lower.contains("empty") || lower.contains("no items") {
        "The source returned no usable public items. Previous data was preserved."
    } else if lower.contains("parse") || lower.contains("format") || lower.contains("json") {
        "The source response format could not be read. Previous data was preserved."
    } else {
        "This source could not be refreshed. Previous data was preserved."
    };
    message.into()
}

fn trusted_origin(label: &str, url: &url::Url) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))))
}

pub(crate) fn require_main(view: &Webview) -> Result<(), String> {
    if view
        .url()
        .ok()
        .as_ref()
        .is_some_and(|url| trusted_origin(view.label(), url))
    {
        Ok(())
    } else {
        Err("Hot-board access is available only from the local scholay today workspace.".into())
    }
}

#[tauri::command]
pub fn list_hot_sources(webview: Webview) -> Result<Vec<HotSource>, String> {
    require_main(&webview)?;
    Ok(hot_sources::sources())
}

#[tauri::command]
pub async fn get_hot_snapshot(
    webview: Webview,
    state: State<'_, AppState>,
    board: State<'_, HotBoardState>,
    source_id: String,
    refresh: bool,
) -> Result<HotSnapshot, String> {
    require_main(&webview)?;
    // An IPC caller can choose only a built-in source, never an arbitrary URL.
    let source = hot_sources::sources()
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| "Unknown hot-board source.".to_string())?;
    let client = state.http();
    board
        .snapshot_with(&source, refresh, || async {
            if source.id == hot_auth::SOURCE_ID {
                hot_auth::fetch_producthunt(&state).await
            } else {
                hot_sources::fetch(&client, &source).await
            }
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(1);

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let name = format!(
                "papr-hot-board-{}-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap(),
                NEXT_DIR.fetch_add(1, Ordering::SeqCst)
            );
            let path = std::env::temp_dir().join(name);
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn cache(&self) -> PathBuf {
            self.0.join("hot-board.db")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn source(id: &str) -> HotSource {
        HotSource {
            id: id.into(),
            name: "Fixture".into(),
            region: "global".into(),
            category: "tech".into(),
            kind: "hot".into(),
            homepage: "https://example.com".into(),
            description: "Public fixture".into(),
            project: "test".into(),
            project_url: "https://example.com".into(),
            refresh_secs: 600,
            auth_kind: None,
            auth_url: None,
        }
    }
    fn items() -> Vec<HotItem> {
        vec![HotItem {
            id: "1".into(),
            title: "Public fixture".into(),
            url: "https://example.com/story".into(),
            description: None,
            heat: Some("10".into()),
            rank: 1,
            published_at: None,
        }]
    }

    #[tokio::test]
    async fn lazy_cache_only_read_never_calls_network_or_creates_rss_tables() {
        let temp = TestDirectory::new();
        let board = HotBoardState::new(temp.cache());
        assert!(!temp.cache().exists());
        let snapshot = board
            .snapshot_with(&source("fixture"), false, || async {
                panic!("cache-only read must not fetch")
            })
            .await
            .unwrap();
        assert_eq!(snapshot.status, "never");
        assert!(snapshot.items.is_empty() && snapshot.stale && snapshot.cached);
        assert!(snapshot.fetched_at.is_none() && snapshot.last_attempt_at.is_none());
        let conn = Connection::open(temp.cache()).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["hot_snapshots"]);
        assert!(!temp.0.join("papr.db").exists());
        assert!(!temp.0.join("private-mail.db").exists());
    }

    #[tokio::test]
    async fn success_persists_and_read_from_new_state_is_exact() {
        let temp = TestDirectory::new();
        let board = HotBoardState::new(temp.cache());
        let first = board
            .snapshot_with(&source("fixture"), true, || async { Ok(items()) })
            .await
            .unwrap();
        assert_eq!(first.status, "ok");
        assert!(!first.stale && !first.cached);
        let reopened = HotBoardState::new(temp.cache())
            .snapshot_with(&source("fixture"), false, || async { panic!("no fetch") })
            .await
            .unwrap();
        assert_eq!(first.items, reopened.items);
        assert_eq!(first.fetched_at, reopened.fetched_at);
        assert_eq!(first.last_attempt_at, reopened.last_attempt_at);
        assert!(reopened.cached);
    }

    #[tokio::test]
    async fn authorization_source_cache_read_cannot_invoke_token_fetch() {
        let temp = TestDirectory::new();
        let board = HotBoardState::new(temp.cache());
        let response = board
            .snapshot_with(&source(hot_auth::SOURCE_ID), false, || async {
                panic!("cache reads must not read Keychain or make authenticated requests")
            })
            .await
            .unwrap();
        assert_eq!(response.status, "never");
        assert!(response.items.is_empty());
        assert_eq!(
            safe_source_error(hot_auth::NOT_CONFIGURED),
            hot_auth::NOT_CONFIGURED
        );
    }

    #[tokio::test]
    async fn concurrent_same_source_has_one_upstream_fetch() {
        let temp = TestDirectory::new();
        let board = Arc::new(HotBoardState::new(temp.cache()));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut jobs = vec![];
        for _ in 0..10 {
            let board = board.clone();
            let calls = calls.clone();
            jobs.push(tokio::spawn(async move {
                board
                    .snapshot_with(&source("fixture"), true, || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(items())
                    })
                    .await
                    .unwrap()
            }));
        }
        for job in jobs {
            assert_eq!(job.await.unwrap().items, items());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn at_most_four_distinct_sources_fetch_concurrently() {
        let temp = TestDirectory::new();
        let board = Arc::new(HotBoardState::new(temp.cache()));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut jobs = vec![];
        for index in 0..10 {
            let (board, active, maximum) = (board.clone(), active.clone(), maximum.clone());
            jobs.push(tokio::spawn(async move {
                board
                    .snapshot_with(&source(&format!("fixture-{index}")), true, || async {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(count, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(items())
                    })
                    .await
                    .unwrap()
            }));
        }
        for job in jobs {
            job.await.unwrap();
        }
        assert!(maximum.load(Ordering::SeqCst) <= 4);
        assert!(maximum.load(Ordering::SeqCst) > 1);
    }

    #[tokio::test]
    async fn failed_refresh_keeps_success_and_failure_backoff_prevents_retry() {
        let temp = TestDirectory::new();
        let board = HotBoardState::new(temp.cache());
        let first = board
            .snapshot_with(&source("fixture"), true, || async { Ok(items()) })
            .await
            .unwrap();
        let mut stored = board.load("fixture").await.unwrap();
        stored.last_attempt_at = Some(Utc::now().timestamp_millis() - MANUAL_INTERVAL_MS - 1);
        board.save(&stored).await.unwrap();
        let failed = board
            .snapshot_with(&source("fixture"), true, || async {
                Err("HTTP 403 private-token=do-not-echo".into())
            })
            .await
            .unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.items, first.items);
        assert_eq!(failed.fetched_at, first.fetched_at);
        assert!(failed.stale && failed.cached);
        assert!(!failed.error.as_deref().unwrap().contains("do-not-echo"));
        let throttled = board
            .snapshot_with(&source("fixture"), true, || async {
                panic!("failure backoff must suppress network")
            })
            .await
            .unwrap();
        assert_eq!(throttled.items, first.items);
        assert_eq!(throttled.status, "error");
    }

    #[test]
    fn cooldown_and_staleness_boundaries_are_independent() {
        let mut stored = StoredSnapshot::never("fixture");
        assert!(stored.may_refresh(1));
        stored.status = "ok".into();
        stored.last_attempt_at = Some(1000);
        stored.fetched_at = Some(1000);
        assert!(!stored.may_refresh(60_999));
        assert!(stored.may_refresh(61_000));
        assert!(!stored.response(&source("fixture"), 600_999, true).stale);
        assert!(stored.response(&source("fixture"), 601_000, true).stale);
        stored.status = "error".into();
        assert!(!stored.may_refresh(120_999));
        assert!(stored.may_refresh(121_000));
        assert!(!stored.may_refresh(0)); // clock moving backwards cannot bypass cooldown
    }

    #[tokio::test]
    async fn timeout_and_empty_list_return_errors_without_losing_existing_items() {
        let temp = TestDirectory::new();
        let mut board = HotBoardState::new(temp.cache());
        board.fetch_timeout = Duration::from_millis(10);
        let mut stored = StoredSnapshot::never("fixture");
        stored.items = items();
        stored.status = "ok".into();
        stored.fetched_at = Some(1000);
        board.save(&stored).await.unwrap();
        let timeout = board
            .snapshot_with(&source("fixture"), true, || async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(items())
            })
            .await
            .unwrap();
        assert_eq!(timeout.status, "error");
        assert_eq!(timeout.items, items());
        assert_eq!(timeout.fetched_at, format_timestamp(1000));
        assert!(timeout.error.unwrap().contains("20 seconds"));
        assert!(validate_items(vec![]).is_err());
    }

    #[test]
    fn unsafe_links_and_raw_errors_never_escape() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "tauri://localhost",
            "https://user:secret@example.com/",
            "http://127.0.0.1/",
            "http://192.168.1.10/",
            "http://localhost/",
        ] {
            let mut rows = items();
            rows[0].url = url.into();
            assert!(validate_items(rows).is_err(), "{url}");
        }
        assert!(validate_items(items()).is_ok());
        for raw in [
            "403 cookie=secret",
            "429 key=secret",
            "401 password=secret",
            "json secret",
            "unknown secret",
        ] {
            assert!(!safe_source_error(raw).contains("secret"));
        }
        for (label, raw, expected) in [
            ("main", "tauri://localhost", true),
            ("main", "https://tauri.localhost", true),
            ("page-view", "tauri://localhost", false),
            ("page-view", "https://example.com", false),
            ("main", "https://example.com", false),
        ] {
            assert_eq!(
                trusted_origin(label, &url::Url::parse(raw).unwrap()),
                expected
            );
        }
    }

    #[tokio::test]
    async fn cache_error_is_local_and_never_starts_network() {
        let temp = TestDirectory::new();
        std::fs::create_dir(temp.cache()).unwrap();
        let error = HotBoardState::new(temp.cache())
            .snapshot_with(&source("fixture"), true, || async {
                panic!("unavailable cache must not fetch")
            })
            .await
            .unwrap_err();
        assert_eq!(error, CACHE_ERROR);
        assert!(!temp.0.join("papr.db").exists());
    }

    #[test]
    fn unsafe_persisted_links_are_rejected_on_cache_read() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE hot_snapshots(source_id TEXT PRIMARY KEY,items_json TEXT,fetched_at INTEGER,last_attempt_at INTEGER,status TEXT,error TEXT);").unwrap();
        let mut stored = StoredSnapshot::never("fixture");
        stored.status = "ok".into();
        stored.items = items();
        stored.items[0].url = "http://127.0.0.1/admin".into();
        write_snapshot(&conn, &stored).unwrap();
        assert_eq!(read_snapshot(&conn, "fixture").unwrap_err(), CACHE_ERROR);
    }

    #[cfg(unix)]
    #[test]
    fn cache_symlink_is_rejected_without_opening_target() {
        let temp = TestDirectory::new();
        let target = temp.0.join("rss-sentinel.db");
        std::os::unix::fs::symlink(&target, temp.cache()).unwrap();
        assert!(open_cache(&temp.cache()).is_err());
        assert!(!target.exists());
    }
}
