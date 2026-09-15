//! Public subscription-only first-run defaults. No database or account import.
use crate::{db, error::AppResult, models::SourceType};
use rusqlite::{params, Connection};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Feed {
    title: String,
    url: String,
    folder: Option<String>,
    open_mode: Option<String>,
    refresh_interval_min: Option<i64>,
}

/// Only a newly created database is eligible. Deleting subscriptions later
/// must never cause defaults to return; existing installations remain untouched.
pub fn initialize(conn: &Connection, fresh_database: bool) -> AppResult<usize> {
    if !fresh_database || db::get_setting(conn, "starter_catalog_v1")?.is_some() {
        return Ok(0);
    }
    let feeds: Vec<Feed> = serde_json::from_str(include_str!("starter-feeds.json"))
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let tx = conn.unchecked_transaction()?;
    let existing: i64 = tx.query_row("SELECT count(*) FROM feeds", [], |r| r.get(0))?;
    if existing != 0 { return Ok(0); }
    for feed in &feeds {
        let folder = feed.folder.as_deref().map(|name| db::create_folder(&tx, name)).transpose()?;
        let id = db::insert_feed(&tx, &feed.url, None, &feed.title, None, SourceType::Rss, folder)?;
        tx.execute("UPDATE feeds SET custom_title=1, open_mode=?2, refresh_interval_min=?3 WHERE id=?1",
            params![id, feed.open_mode, feed.refresh_interval_min])?;
        if feed.url.starts_with("http://127.0.0.1:") {
            let status = if feed.url.starts_with("http://127.0.0.1:8767/") {
                "知乎连接器需要本人授权；未迁移原电脑账号。"
            } else {
                "本地公开采集准备中；首次加载可能需要几分钟。"
            };
            tx.execute("UPDATE feeds SET fetch_error=?2 WHERE id=?1", params![id,
                status])?;
        }
    }
    db::set_setting(&tx, "starter_catalog_v1", "2026-09-09")?;
    tx.commit()?;
    Ok(feeds.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_only_and_no_credentials() {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(initialize(&conn, true).unwrap(), 139);
        assert_eq!(initialize(&conn, true).unwrap(), 0);
        let keys: Vec<String> = conn.prepare("SELECT key FROM settings").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(keys, vec!["starter_catalog_v1"]);
        conn.execute("DELETE FROM feeds", []).unwrap();
        assert_eq!(initialize(&conn, true).unwrap(), 0);
        let feeds: Vec<Feed> = serde_json::from_str(include_str!("starter-feeds.json")).unwrap();
        for feed in feeds {
            let u = url::Url::parse(&feed.url).unwrap();
            assert!(u.username().is_empty() && u.password().is_none());
            for (key, _) in u.query_pairs() {
                assert!(!["token", "secret", "password", "cookie", "api_key", "auth"].contains(&key.to_lowercase().as_str()));
            }
        }
    }
    #[test]
    fn existing_database_is_never_modified() {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(initialize(&conn, false).unwrap(), 0);
        assert_eq!(db::get_setting(&conn, "starter_catalog_v1").unwrap(), None);
    }
}
