//! Headless feed refresh — the UI-free core of a refresh cycle.
//!
//! Selects the sources to touch, fetches them with bounded concurrency, ingests
//! new RSS articles, and runs retention cleanup. Legacy newsletter rows remain
//! readable, but this RSS-only build never reads their IMAP configuration or
//! polls mailboxes. Progress is reported through an `on_event` callback.
//!
//! The desktop app wraps [`refresh_core`] with a Tauri progress channel,
//! notifications, FreshRSS sync and tray updates (see `papr_lib::scheduler`);
//! the agent CLI drives it directly, forwarding events to stderr.

use crate::db;
use crate::error::AppResult;
use crate::ingestion::{fetch, parse};
use crate::models::{RefreshProgress, SourceType};
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;

/// Outcome of a [`refresh_core`] run.
#[derive(Clone, Copy, Debug)]
pub struct RefreshSummary {
    /// Number of newly inserted articles across all sources.
    pub new_articles: usize,
    /// `false` only when a `Due`-scoped run found nothing due and skipped the
    /// pipeline entirely. Lets the desktop scheduler keep idle ticks genuinely
    /// idle (no notifications / sync / tray refresh on an empty cycle).
    pub ran: bool,
}

/// Which feeds a refresh run should touch.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RefreshScope {
    /// Every non-newsletter feed — the manual refresh and OPML import.
    All,
    /// Only sources whose per-feed (or global) interval has elapsed — the
    /// background scheduler. An empty due-set skips the whole pipeline.
    Due,
    /// A single non-newsletter feed by id — the per-feed manual refresh
    /// (`refresh --feed <id>`). Always runs the pipeline.
    Feed(i64),
    /// Every feed in one folder by id — the per-folder manual refresh. Always
    /// runs the pipeline.
    Folder(i64),
}

/// Insert a batch of articles for one feed in bounded chunks, releasing the
/// shared DB lock between each so concurrent queries aren't starved while a
/// large feed (hundreds of items) is being ingested. Returns the count newly
/// inserted; `label` only identifies the warning text.
async fn upsert_articles(
    db: &Mutex<Connection>,
    feed_id: i64,
    articles: &[db::NewArticle],
    dedup: bool,
    rules: &[crate::models::Rule],
    label: &str,
) -> usize {
    let mut new_count = 0usize;
    for chunk in articles.chunks(64) {
        let conn = db.lock().await;
        for article in chunk {
            match db::upsert_article(&conn, feed_id, article, dedup, rules) {
                Ok(true) => new_count += 1,
                Ok(false) => {}
                Err(e) => log::warn!("{label} upsert failed (feed {feed_id}): {e}"),
            }
        }
    }
    new_count
}

/// Outcome of fetching one feed.
enum Outcome {
    NotModified,
    Updated {
        parsed: parse::ParsedFeed,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Failed(String),
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Outcome {
    match fetch::conditional_get(client, url, etag.as_deref(), last_modified.as_deref()).await {
        Ok(fetch::Fetched::NotModified) => Outcome::NotModified,
        Ok(fetch::Fetched::Body {
            bytes,
            etag,
            last_modified,
        }) => match parse::parse_feed(&bytes, url) {
            Ok(parsed) => Outcome::Updated {
                parsed,
                etag,
                last_modified,
            },
            Err(e) => Outcome::Failed(e.to_string()),
        },
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// Refresh the sources selected by `scope`: fetch with bounded concurrency,
/// ingest new RSS articles and run retention cleanup. Reports
/// progress through `on_event` and returns the new-article count.
///
/// UI-free and side-effect-light: it performs no cross-process locking (callers
/// serialize), no desktop notifications and no FreshRSS sync. `db` is the
/// writer connection behind an async mutex; `client` is a shared HTTP client
/// (cheap to clone per feed).
pub async fn refresh_core(
    db: &Mutex<Connection>,
    client: &reqwest::Client,
    scope: RefreshScope,
    mut on_event: impl FnMut(RefreshProgress),
) -> AppResult<RefreshSummary> {
    let (feeds, concurrency, dedup, rules) = {
        let conn = db.lock().await;
        // The global default interval for feeds without a per-feed override.
        let global_min = db::get_setting(&conn, "refresh_interval_min")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|m| *m >= 5)
            .map(|m| m.min(db::REFRESH_OFF_MINUTES))
            .unwrap_or(30);
        // These existing queries exclude only newsletter sources, retaining
        // RSS, podcasts and other supported feed kinds. Do not even select
        // legacy IMAP configuration: GUI and CLI share this RSS-only boundary.
        let feeds = match scope {
            RefreshScope::All => db::feeds_to_refresh(&conn)?,
            RefreshScope::Due => db::feeds_due_for_refresh(&conn, global_min)?,
            RefreshScope::Feed(id) => db::feeds_to_refresh_for_feed(&conn, id)?,
            RefreshScope::Folder(id) => db::feeds_to_refresh_in_folder(&conn, id)?,
        };
        let concurrency =
            db::setting_parsed::<i64>(&conn, "net_concurrency", 6).clamp(1, 16) as usize;
        let dedup = db::setting_flag(&conn, "dedup_enabled", false);
        let rules = db::active_rules(&conn).unwrap_or_default();
        (feeds, concurrency, dedup, rules)
    };

    // Nothing due this cycle: emit a no-op Started/Finished and bow out before
    // the heavier tail. The manual refresh (scope All) always runs the pipeline.
    if scope == RefreshScope::Due && feeds.is_empty() {
        on_event(RefreshProgress::Started { total: 0 });
        on_event(RefreshProgress::Finished { new_articles: 0 });
        return Ok(RefreshSummary {
            new_articles: 0,
            ran: false,
        });
    }

    on_event(RefreshProgress::Started { total: feeds.len() });

    let sem = Arc::new(Semaphore::new(concurrency));
    // The feed URL travels back out alongside the outcome — `refine_source_type`
    // needs it for the Mastodon `/@user.rss` pattern check below.
    let mut set: JoinSet<(i64, String, Outcome)> = JoinSet::new();
    for (id, url, etag, last_modified) in feeds {
        let client = client.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let outcome = fetch_one(&client, &url, etag, last_modified).await;
            (id, url, outcome)
        });
    }

    let mut total_new = 0usize;
    while let Some(joined) = set.join_next().await {
        let Ok((feed_id, feed_url, outcome)) = joined else {
            continue;
        };
        let mut new_here = 0usize;
        let mut error: Option<String> = None;

        match outcome {
            Outcome::NotModified => {
                let conn = db.lock().await;
                let _ = db::touch_feed(&conn, feed_id);
            }
            Outcome::Failed(e) => {
                let conn = db.lock().await;
                let _ = db::set_feed_error(&conn, feed_id, &e);
                error = Some(e);
            }
            Outcome::Updated {
                parsed,
                etag,
                last_modified,
            } => {
                new_here +=
                    upsert_articles(db, feed_id, &parsed.articles, dedup, &rules, "rss").await;
                let conn = db.lock().await;
                let _ = db::update_feed_meta(
                    &conn,
                    feed_id,
                    parsed.title.as_deref(),
                    parsed.site_url.as_deref(),
                    parsed.description.as_deref(),
                    parsed.icon.as_deref(),
                );
                let _ = db::set_feed_fetch_state(
                    &conn,
                    feed_id,
                    etag.as_deref(),
                    last_modified.as_deref(),
                    None,
                );
                // Promote a still-generic `'rss'` feed to its real kind now that
                // the parsed document reveals it (audio enclosures → podcast,
                // `/@user.rss` → mastodon). A no-op for an already classified feed.
                let refined = parse::refine_source_type(SourceType::Rss, &parsed, &feed_url);
                let _ = db::refine_feed_source_type(&conn, feed_id, refined);
            }
        }

        total_new += new_here;
        on_event(RefreshProgress::FeedDone {
            feed_id,
            new_articles: new_here,
            error,
        });
    }

    // Retention: drop old read articles when a finite window is configured. The
    // DELETE scans the whole table, so throttle it to once per day rather than
    // running on every refresh cycle.
    {
        let conn = db.lock().await;
        let retention = db::get_setting(&conn, "retention_days").ok().flatten();
        if let Some(days) = retention.and_then(|v| v.parse::<i64>().ok()) {
            let now = chrono::Utc::now().timestamp();
            let last_run = db::setting_parsed::<i64>(&conn, "retention_last_run", 0);
            if now - last_run >= 86_400 {
                match db::cleanup_old_articles(&conn, days) {
                    Ok(removed) => {
                        if removed > 0 {
                            log::info!("retention: removed {removed} old articles");
                        }
                        let _ = db::set_setting(&conn, "retention_last_run", &now.to_string());
                    }
                    Err(e) => log::warn!("retention cleanup failed: {e}"),
                }
            }
        }
    }

    on_event(RefreshProgress::Finished {
        new_articles: total_new,
    });
    Ok(RefreshSummary {
        new_articles: total_new,
        ran: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const RSS: &str = r#"<?xml version="1.0"?><rss version="2.0"><channel>
        <title>Local RSS fixture</title><link>https://example.invalid/</link>
        <description>Offline regression fixture</description><item>
        <title>New RSS item</title><guid isPermaLink="false">rss-only-new</guid>
        <link>https://example.invalid/new</link><description>Fixture body</description>
        </item></channel></rss>"#;

    struct LocalServer {
        address: SocketAddr,
        connections: Arc<AtomicUsize>,
        conditional: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl LocalServer {
        async fn start(serve_rss: bool) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let connections = Arc::new(AtomicUsize::new(0));
            let conditional = Arc::new(AtomicUsize::new(0));
            let hits = connections.clone();
            let revalidations = conditional.clone();
            let task = tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    hits.fetch_add(1, Ordering::SeqCst);
                    // IMAP tripwire: immediately close, without reading or
                    // exchanging credentials. A regression fails instead of
                    // hanging in the legacy blocking TLS handshake.
                    if !serve_rss {
                        continue;
                    }
                    let mut request = Vec::new();
                    while request.len() < 8192 && !request.ends_with(b"\r\n\r\n") {
                        let mut bytes = [0; 1024];
                        let Ok(Ok(size)) = tokio::time::timeout(
                            Duration::from_secs(2), stream.read(&mut bytes),
                        ).await else { break };
                        if size == 0 { break; }
                        request.extend_from_slice(&bytes[..size]);
                    }
                    let not_modified = String::from_utf8_lossy(&request)
                        .to_ascii_lowercase().contains("if-none-match: \"rss-only-test\"");
                    let response = if not_modified {
                        revalidations.fetch_add(1, Ordering::SeqCst);
                        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_string()
                    } else {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nETag: \"rss-only-test\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{RSS}", RSS.len())
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            });
            Self { address, connections, conditional, task }
        }
    }

    impl Drop for LocalServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn legacy_fixture(imap_port: u16) -> (Mutex<Connection>, i64, i64) {
        // SQLite's special :memory: path never opens a user's database/file.
        let conn = db::open(Path::new(":memory:")).unwrap();
        let folder = db::create_folder(&conn, "Synthetic legacy folder").unwrap();
        let legacy = db::insert_newsletter_source(
            &conn,
            "newsletter://synthetic@127.0.0.1/INBOX",
            "Synthetic legacy mailbox",
            &crate::ingestion::newsletter::NewsletterConfig {
                host: "127.0.0.1".into(), port: imap_port,
                username: "synthetic@example.invalid".into(),
                password: "SYNTHETIC-ONLY-SECRET".into(), folder: "INBOX".into(),
            },
        ).unwrap();
        db::move_feed(&conn, legacy, Some(folder)).unwrap();
        (Mutex::new(conn), legacy, folder)
    }

    fn local_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap()
    }

    #[tokio::test]
    async fn rss_only_refresh_never_connects_to_legacy_mail_in_any_scope() {
        let tripwire = LocalServer::start(false).await;
        let (db, legacy, folder) = legacy_fixture(tripwire.address.port());
        let client = local_client();
        for scope in [RefreshScope::All, RefreshScope::Due, RefreshScope::Feed(legacy), RefreshScope::Folder(folder)] {
            let mut events = Vec::new();
            let summary = tokio::time::timeout(
                Duration::from_secs(3), refresh_core(&db, &client, scope, |event| events.push(event)),
            ).await.expect("RSS-only refresh must not wait for IMAP").unwrap();
            assert_eq!(summary.new_articles, 0);
            assert_eq!(summary.ran, scope != RefreshScope::Due);
            assert!(matches!(events.as_slice(), [RefreshProgress::Started { total: 0 }, RefreshProgress::Finished { new_articles: 0 }]));
            assert_eq!(tripwire.connections.load(Ordering::SeqCst), 0);
        }
        let conn = db.lock().await;
        let untouched: (Option<String>, Option<String>) = conn.query_row(
            "SELECT last_fetched_at, fetch_error FROM feeds WHERE id=?1", [legacy],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(untouched, (None, None));
        assert_eq!(conn.query_row("SELECT count(*) FROM newsletter_sources", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[tokio::test]
    async fn rss_only_refresh_preserves_rss_counts_progress_and_conditional_fetches() {
        let tripwire = LocalServer::start(false).await;
        let server = LocalServer::start(true).await;
        let (db, legacy, folder) = legacy_fixture(tripwire.address.port());
        let rss = {
            let conn = db.lock().await;
            let rss = db::insert_feed(&conn, &format!("http://{}/rss", server.address), None,
                "Existing RSS", None, SourceType::Rss, Some(folder)).unwrap();
            conn.execute("INSERT INTO articles(feed_id,guid,title) VALUES(?1,'existing-rss','Existing RSS article')", [rss]).unwrap();
            rss
        };
        let client = local_client();
        for (scope, expected_new) in [(RefreshScope::All, 1), (RefreshScope::Feed(rss), 0), (RefreshScope::Folder(folder), 0), (RefreshScope::Due, 0)] {
            if scope == RefreshScope::Due {
                // Exercise an actually due RSS feed alongside the legacy row.
                db.lock().await.execute("UPDATE feeds SET last_fetched_at=NULL WHERE id=?1", [rss]).unwrap();
            }
            let mut events = Vec::new();
            let summary = tokio::time::timeout(
                Duration::from_secs(3), refresh_core(&db, &client, scope, |event| events.push(event)),
            ).await.expect("local RSS fixture should finish").unwrap();
            assert!(summary.ran);
            assert_eq!(summary.new_articles, expected_new);
            assert!(matches!(events.as_slice(), [RefreshProgress::Started { total: 1 }, RefreshProgress::FeedDone { feed_id, new_articles, error: None }, RefreshProgress::Finished { new_articles: finished }] if *feed_id == rss && *new_articles == expected_new && *finished == expected_new));
        }
        // The legacy mailbox is still never-fetched/due, but cannot keep an
        // otherwise idle desktop scheduler active or add a refresh event.
        let idle = refresh_core(&db, &client, RefreshScope::Due, |_| {}).await.unwrap();
        assert!(!idle.ran);
        assert_eq!(server.connections.load(Ordering::SeqCst), 4);
        assert_eq!(server.conditional.load(Ordering::SeqCst), 3);
        assert_eq!(tripwire.connections.load(Ordering::SeqCst), 0);
        let conn = db.lock().await;
        assert_eq!(conn.query_row("SELECT count(*) FROM articles WHERE feed_id=?1", [rss], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert!(db::feed_last_fetched(&conn, rss).unwrap().is_some());
        assert!(db::feed_last_fetched(&conn, legacy).unwrap().is_none());
    }
}
