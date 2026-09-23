//! Shared, transactional library operations for desktop and agent adapters.
//! Additive tables deliberately preserve the existing core schema version.
use crate::{
    db,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn ensure_schema(c: &Connection) -> AppResult<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS library_folder_links (
      folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS library_archived_feeds (
      feed_id INTEGER PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS library_changes (
      id INTEGER PRIMARY KEY, request_key TEXT UNIQUE, actor TEXT NOT NULL,
      actions TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS library_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO library_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS agented_groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agented_groups_name ON agented_groups(name);
      CREATE TABLE IF NOT EXISTS agented_group_articles (
        article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES agented_groups(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')));")?;
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    CreateFolder {
        name: String,
        #[serde(default)]
        parent_id: Option<i64>,
    },
    RenameFolder {
        id: i64,
        name: String,
    },
    MoveFolder {
        id: i64,
        parent_id: Option<i64>,
        #[serde(default)]
        position: Option<i64>,
    },
    DeleteFolder {
        id: i64,
    },
    RenameFeed {
        id: i64,
        title: String,
    },
    MoveFeed {
        id: i64,
        folder_id: Option<i64>,
    },
    SetFeedUrl {
        id: i64,
        url: String,
    },
    SetFeedInterval {
        id: i64,
        minutes: Option<i64>,
    },
    ArchiveFeed {
        id: i64,
    },
    RestoreFeed {
        id: i64,
    },
    CreateAgentedGroup {
        name: String,
    },
    RenameAgentedGroup {
        id: i64,
        name: String,
    },
    DeleteAgentedGroup {
        id: i64,
    },
    SetArticleGroup {
        id: i64,
        group_id: Option<i64>,
    },
}
fn exists(c: &Connection, kind: &str, id: i64) -> AppResult<()> {
    let sql = if kind == "folder" {
        "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1)"
    } else {
        "SELECT EXISTS(SELECT 1 FROM feeds WHERE id=?1)"
    };
    if id <= 0 || !c.query_row(sql, [id], |r| r.get::<_, bool>(0))? {
        return Err(AppError::other(format!("{kind} {id} no longer exists")));
    }
    Ok(())
}
fn parent(c: &Connection, id: i64, target: Option<i64>) -> AppResult<()> {
    if let Some(target) = target {
        exists(c, "folder", target)?;
        let cycle: bool = c.query_row("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT l.folder_id FROM library_folder_links l JOIN tree t ON l.parent_id=t.id) SELECT EXISTS(SELECT 1 FROM tree WHERE id=?2)",params![id,target], |r|r.get(0))?;
        if cycle {
            return Err(AppError::other(
                "A folder cannot be moved into itself or its descendants",
            ));
        }
    }
    c.execute("INSERT INTO library_folder_links(folder_id,parent_id) VALUES(?1,?2) ON CONFLICT(folder_id) DO UPDATE SET parent_id=excluded.parent_id",params![id,target])?;
    Ok(())
}
pub fn revision(c: &Connection) -> AppResult<i64> {
    Ok(
        c.query_row("SELECT revision FROM library_meta WHERE id=1", [], |r| {
            r.get(0)
        })?,
    )
}
pub fn folders(c: &Connection) -> AppResult<Value> {
    let mut q=c.prepare("SELECT f.id,f.name,f.position,l.parent_id FROM folders f LEFT JOIN library_folder_links l ON l.folder_id=f.id ORDER BY f.position,f.name")?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"position":r.get::<_,i64>(2)?,"parentId":r.get::<_,Option<i64>>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn archived(c: &Connection) -> AppResult<Value> {
    let mut q=c.prepare("SELECT f.id,f.title,x.archived_at,(SELECT count(*) FROM articles a WHERE a.feed_id=f.id) FROM library_archived_feeds x JOIN feeds f ON f.id=x.feed_id ORDER BY x.archived_at DESC")?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"title":r.get::<_,String>(1)?,"archivedAt":r.get::<_,String>(2)?,"articles":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn groups(c: &Connection) -> AppResult<Value> {
    ensure_schema(c)?;
    let mut q = c.prepare(
        "SELECT g.id, g.name, g.position, (SELECT count(*) FROM agented_group_articles m WHERE m.group_id = g.id)
         FROM agented_groups g ORDER BY g.position, g.id",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "position": r.get::<_, i64>(2)?,
                "articles": r.get::<_, i64>(3)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!(rows))
}
fn group_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::other("Group name must be 1–80 characters"));
    }
    Ok(name.to_string())
}
fn group_name_taken(c: &Connection, name: &str, except: i64) -> AppResult<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agented_groups WHERE name = ?1 COLLATE NOCASE AND id != ?2)",
        params![name, except],
        |r| r.get(0),
    )?)
}
fn agented_group(c: &Connection, id: i64) -> AppResult<()> {
    if id <= 0
        || !c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agented_groups WHERE id = ?1)",
            [id],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(AppError::other(format!("group {id} no longer exists")));
    }
    Ok(())
}
fn cleaned_article(c: &Connection, id: i64) -> AppResult<()> {
    let cleaned: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM article_structured WHERE article_id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if !cleaned {
        return Err(AppError::other(
            "Only a cleaned article can be placed in an Agented group",
        ));
    }
    Ok(())
}
pub fn history(c: &Connection) -> AppResult<Value> {
    let mut q = c.prepare(
        "SELECT id,actor,actions,created_at FROM library_changes ORDER BY id DESC LIMIT 30",
    )?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"actor":r.get::<_,String>(1)?,"actions":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"createdAt":r.get::<_,String>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn subscribe(
    c: &Connection,
    feed_url: &str,
    bytes: &[u8],
    forced: Option<crate::models::SourceType>,
    folder_id: Option<i64>,
    actor: &str,
) -> AppResult<crate::models::Feed> {
    use crate::ingestion::parse;
    let parsed = parse::parse_feed(bytes, feed_url)?;
    let source_type = forced.unwrap_or_else(|| {
        parse::refine_source_type(parse::detect_source_type(feed_url), &parsed, feed_url)
    });
    let title = parsed
        .title
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(feed_url);
    let tx = c.unchecked_transaction()?;
    if let Some(id) = folder_id {
        exists(&tx, "folder", id)?;
    }
    let existing = db::find_feed_by_url(&tx, feed_url)?;
    let id = if let Some(id) = existing {
        tx.execute("DELETE FROM library_archived_feeds WHERE feed_id=?1", [id])?;
        id
    } else {
        let id = db::insert_feed(
            &tx,
            feed_url,
            parsed.site_url.as_deref(),
            title,
            parsed.description.as_deref(),
            source_type,
            folder_id,
        )?;
        let favicon = parsed.icon.clone().or_else(|| {
            parsed
                .site_url
                .as_deref()
                .and_then(|s| url::Url::parse(s).ok())
                .and_then(|u| {
                    u.host_str().map(|host| {
                        format!("https://www.google.com/s2/favicons?domain={host}&sz=64")
                    })
                })
        });
        if let Some(icon) = &favicon {
            db::update_feed_meta(&tx, id, None, None, None, Some(icon))?;
        }
        let dedup = db::setting_flag(&tx, "dedup_enabled", false);
        let rules = db::active_rules(&tx)?;
        for article in &parsed.articles {
            db::upsert_article(&tx, id, article, dedup, &rules)?;
        }
        db::touch_feed(&tx, id)?;
        id
    };
    let result = db::list_feeds(&tx)?
        .into_iter()
        .find(|f| f.id == id)
        .ok_or_else(|| AppError::other("Could not read subscribed feed"))?;
    tx.execute("UPDATE library_meta SET revision=revision+1 WHERE id=1", [])?;
    tx.execute(
        "INSERT INTO library_changes(actor,actions,result) VALUES(?1,?2,?3)",
        params![
            actor,
            json!([{"action":"subscribe","id":id}]).to_string(),
            json!({"id":id}).to_string()
        ],
    )?;
    tx.commit()?;
    Ok(result)
}
pub fn apply(
    c: &Connection,
    actions: &[Mutation],
    actor: &str,
    dry_run: bool,
    expected: Option<i64>,
    request_key: Option<&str>,
) -> AppResult<Value> {
    if actions.is_empty() || actions.len() > 100 {
        return Err(AppError::other("Provide between 1 and 100 changes"));
    }
    if request_key.is_some_and(|s| s.is_empty() || s.len() > 128) {
        return Err(AppError::other("Invalid request key"));
    }
    let encoded = serde_json::to_string(actions).map_err(|_| AppError::other("Invalid changes"))?;
    let tx = c.unchecked_transaction()?;
    if let Some(key) = request_key {
        if let Some((old, result)) = tx
            .query_row(
                "SELECT actions,result FROM library_changes WHERE request_key=?1",
                [key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if old != encoded {
                return Err(AppError::other(
                    "Request key already belongs to different changes",
                ));
            }
            return serde_json::from_str(&result)
                .map_err(|_| AppError::other("Invalid recorded result"));
        }
    }
    let current = revision(&tx)?;
    if expected.is_some_and(|r| r != current) {
        return Err(AppError::other(
            "Library changed; read it again before applying this batch",
        ));
    }
    let mut results = vec![];
    for change in actions {
        let mut result = json!({"action":change,"ok":true});
        match change {
            Mutation::CreateFolder { name, parent_id } => {
                let existing: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM folders WHERE name=?1 COLLATE NOCASE",
                        [name.trim()],
                        |r| r.get(0),
                    )
                    .optional()?;
                let id = db::create_folder(&tx, name)?;
                if existing.is_none() {
                    parent(&tx, id, *parent_id)?;
                } else {
                    let old: Option<i64> = tx
                        .query_row(
                            "SELECT parent_id FROM library_folder_links WHERE folder_id=?1",
                            [id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten();
                    if old != *parent_id {
                        return Err(AppError::other(
                            "Folder name already exists under another parent; use move_folder",
                        ));
                    }
                }
                result["id"] = json!(id);
            }
            Mutation::RenameFolder { id, name } => {
                exists(&tx, "folder", *id)?;
                db::rename_folder(&tx, *id, name)?;
            }
            Mutation::MoveFolder {
                id,
                parent_id,
                position,
            } => {
                exists(&tx, "folder", *id)?;
                parent(&tx, *id, *parent_id)?;
                if let Some(p) = position {
                    tx.execute("UPDATE folders SET position=?2 WHERE id=?1", params![id, p])?;
                }
            }
            Mutation::DeleteFolder { id } => {
                exists(&tx, "folder", *id)?;
                db::delete_folder(&tx, *id)?;
            }
            Mutation::RenameFeed { id, title } => {
                exists(&tx, "feed", *id)?;
                db::rename_feed(&tx, *id, title)?;
            }
            Mutation::MoveFeed { id, folder_id } => {
                exists(&tx, "feed", *id)?;
                if let Some(f) = folder_id {
                    exists(&tx, "folder", *f)?;
                }
                db::move_feed(&tx, *id, *folder_id)?;
            }
            Mutation::SetFeedUrl { id, url } => {
                exists(&tx, "feed", *id)?;
                let u = url::Url::parse(url.trim())
                    .map_err(|_| AppError::other("Invalid subscription URL"))?;
                if !matches!(u.scheme(), "http" | "https")
                    || u.host_str().is_none()
                    || !u.username().is_empty()
                    || u.password().is_some()
                {
                    return Err(AppError::other(
                        "Use an HTTP(S) URL without embedded credentials",
                    ));
                }
                tx.execute("UPDATE feeds SET feed_url=?2,etag=NULL,last_modified=NULL,fetch_error=NULL WHERE id=?1",params![id,u.as_str()])?;
            }
            Mutation::SetFeedInterval { id, minutes } => {
                exists(&tx, "feed", *id)?;
                if minutes.is_some_and(|n| !(1..=525600).contains(&n)) {
                    return Err(AppError::other("Refresh interval must be 1–525600 minutes"));
                }
                db::set_feed_refresh_interval(&tx, *id, *minutes)?;
            }
            Mutation::ArchiveFeed { id } => {
                exists(&tx, "feed", *id)?;
                tx.execute(
                    "INSERT OR IGNORE INTO library_archived_feeds(feed_id) VALUES(?1)",
                    [id],
                )?;
            }
            Mutation::RestoreFeed { id } => {
                exists(&tx, "feed", *id)?;
                tx.execute("DELETE FROM library_archived_feeds WHERE feed_id=?1", [id])?;
            }
            Mutation::CreateAgentedGroup { name } => {
                let name = group_name(name)?;
                if group_name_taken(&tx, &name, 0)? {
                    return Err(AppError::other("Group name already exists"));
                }
                let position: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM agented_groups",
                    [],
                    |r| r.get(0),
                )?;
                tx.execute(
                    "INSERT INTO agented_groups(name, position) VALUES(?1, ?2)",
                    params![name, position],
                )?;
                result["id"] = json!(tx.last_insert_rowid());
            }
            Mutation::RenameAgentedGroup { id, name } => {
                agented_group(&tx, *id)?;
                let name = group_name(name)?;
                if group_name_taken(&tx, &name, *id)? {
                    return Err(AppError::other("Group name already exists"));
                }
                tx.execute(
                    "UPDATE agented_groups SET name = ?2 WHERE id = ?1",
                    params![id, name],
                )?;
            }
            Mutation::DeleteAgentedGroup { id } => {
                agented_group(&tx, *id)?;
                tx.execute("DELETE FROM agented_groups WHERE id = ?1", [id])?;
            }
            Mutation::SetArticleGroup { id, group_id } => {
                cleaned_article(&tx, *id)?;
                if let Some(group_id) = group_id {
                    agented_group(&tx, *group_id)?;
                    tx.execute(
                        "INSERT INTO agented_group_articles(article_id, group_id) VALUES(?1, ?2)
                         ON CONFLICT(article_id) DO UPDATE SET group_id = excluded.group_id, assigned_at = datetime('now')",
                        params![id, group_id],
                    )?;
                } else {
                    tx.execute(
                        "DELETE FROM agented_group_articles WHERE article_id = ?1",
                        [id],
                    )?;
                }
            }
        }
        results.push(result);
    }
    let result =
        json!({"dryRun":dry_run,"revision":if dry_run{current}else{current+1},"results":results});
    if dry_run {
        tx.rollback()?;
    } else {
        tx.execute("UPDATE library_meta SET revision=revision+1 WHERE id=1", [])?;
        tx.execute(
            "INSERT INTO library_changes(request_key,actor,actions,result) VALUES(?1,?2,?3,?4)",
            params![request_key, actor, encoded, result.to_string()],
        )?;
        tx.commit()?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        c
    }
    #[test]
    fn batch_rollback_and_cycle_guard() {
        let c = database();
        apply(
            &c,
            &[Mutation::CreateFolder {
                name: "A".into(),
                parent_id: None,
            }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        apply(
            &c,
            &[Mutation::CreateFolder {
                name: "B".into(),
                parent_id: Some(1),
            }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        assert!(apply(
            &c,
            &[
                Mutation::RenameFolder {
                    id: 1,
                    name: "changed".into()
                },
                Mutation::MoveFolder {
                    id: 1,
                    parent_id: Some(2),
                    position: None
                }
            ],
            "test",
            false,
            None,
            None
        )
        .is_err());
        assert_eq!(folders(&c).unwrap()[0]["name"], "A");
    }
    #[test]
    fn preview_revision_and_replay() {
        let c = database();
        let a = [Mutation::CreateFolder {
            name: "A".into(),
            parent_id: None,
        }];
        apply(&c, &a, "test", true, Some(0), None).unwrap();
        assert_eq!(folders(&c).unwrap().as_array().unwrap().len(), 0);
        let x = apply(&c, &a, "test", false, Some(0), Some("one")).unwrap();
        assert_eq!(
            apply(&c, &a, "test", false, Some(0), Some("one")).unwrap(),
            x
        );
        assert!(apply(&c, &a, "test", false, Some(0), None).is_err());
    }
    #[test]
    fn archive_keeps_articles_and_excludes_refresh() {
        let c = database();
        let id = db::insert_feed(
            &c,
            "https://example.org/feed",
            None,
            "Feed",
            None,
            crate::models::SourceType::Rss,
            None,
        )
        .unwrap();
        c.execute(
            "INSERT INTO articles(feed_id,guid,title) VALUES(?1,'one','Keep me')",
            [id],
        )
        .unwrap();
        apply(
            &c,
            &[Mutation::ArchiveFeed { id }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        assert!(db::list_feeds(&c).unwrap().is_empty());
        assert!(db::feeds_to_refresh(&c).unwrap().is_empty());
        assert_eq!(
            c.query_row("SELECT count(*) FROM articles", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        apply(
            &c,
            &[Mutation::RestoreFeed { id }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(db::list_feeds(&c).unwrap().len(), 1);
    }
    #[test]
    fn agented_groups_keep_articles_and_reject_duplicates() {
        let c = database();
        let feed = db::insert_feed(
            &c,
            "https://example.org/feed",
            None,
            "Feed",
            None,
            crate::models::SourceType::Rss,
            None,
        )
        .unwrap();
        c.execute(
            "INSERT INTO articles(feed_id,guid,title) VALUES(?1,'one','Clean me')",
            [feed],
        )
        .unwrap();
        let article: i64 = c
            .query_row("SELECT id FROM articles", [], |r| r.get(0))
            .unwrap();
        assert!(apply(
            &c,
            &[Mutation::SetArticleGroup {
                id: article,
                group_id: Some(1),
            }],
            "test",
            false,
            None,
            None,
        )
        .is_err());
        c.execute(
            "INSERT INTO article_structured VALUES(?1,'cap','rss','hash',1,1,10,0,'2026-09-22',NULL)",
            [article],
        )
        .unwrap();
        let preview = apply(
            &c,
            &[Mutation::CreateAgentedGroup {
                name: " Week ".into(),
            }],
            "test",
            true,
            Some(0),
            None,
        )
        .unwrap();
        assert_eq!(preview["dryRun"], true);
        assert!(groups(&c).unwrap().as_array().unwrap().is_empty());
        let created = apply(
            &c,
            &[Mutation::CreateAgentedGroup {
                name: " Week ".into(),
            }],
            "test",
            false,
            Some(0),
            None,
        )
        .unwrap();
        let group_id = created["results"][0]["id"].as_i64().unwrap();
        assert!(apply(
            &c,
            &[Mutation::CreateAgentedGroup {
                name: "week".into(),
            }],
            "test",
            false,
            None,
            None,
        )
        .is_err());
        apply(
            &c,
            &[Mutation::SetArticleGroup {
                id: article,
                group_id: Some(group_id),
            }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(groups(&c).unwrap()[0]["articles"], 1);
        apply(
            &c,
            &[Mutation::DeleteAgentedGroup { id: group_id }],
            "test",
            false,
            None,
            None,
        )
        .unwrap();
        assert!(groups(&c).unwrap().as_array().unwrap().is_empty());
        assert_eq!(
            c.query_row("SELECT count(*) FROM articles", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM article_structured",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM agented_group_articles",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
