//! Persistent, source-auditable storage for the academic-calendar evidence set.
//!
//! Calendar notices deliberately do not live in the RSS `articles` table:
//! they are hand-verified web records rather than feed deliveries, and need to
//! retain their provenance without appearing as fabricated reader articles.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

const OFFICIAL_SEED_BATCHES: [&str; 17] = [
    include_str!("../../src/calendar/yearOfficialSeeds.json"),
    include_str!("../../src/calendar/yearOfficialNationalSeeds.json"),
    include_str!("../../src/calendar/yearOfficialTalentSeeds.json"),
    include_str!("../../src/calendar/yearOfficialHumanitiesSeeds.json"),
    include_str!("../../src/calendar/yearOfficialMoeSeeds.json"),
    include_str!("../../src/calendar/yearOfficialPostdocHistorySeeds.json"),
    include_str!("../../src/calendar/yearOfficialEducationPlanningSeeds.json"),
    include_str!("../../src/calendar/yearOfficialInternationalTalentSeeds.json"),
    include_str!("../../src/calendar/yearOfficialArtsSeeds.json"),
    include_str!("../../src/calendar/yearOfficialRecurringSeeds.json"),
    include_str!("../../src/calendar/yearOfficialArtsFundSeeds.json"),
    include_str!("../../src/calendar/yearOfficialYouthFundSeeds.json"),
    include_str!("../../src/calendar/yearOfficialNsfcGrowthSeeds.json"),
    include_str!("../../src/calendar/yearOfficialConferenceBodySeeds.json"),
    include_str!("../../src/calendar/yearOfficialCastTalentSeeds.json"),
    include_str!("../../src/calendar/yearOfficialCscTalentSeeds.json"),
    include_str!("../../src/calendar/yearOfficialCampusSeeds.json"),
];

const OFFICIAL_BODY_CACHE: &str = include_str!("../../src/calendar/yearOfficialBodyCache.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarArticle {
    pub id: i64,
    pub feed_title: String,
    pub title: String,
    pub snippet: Option<String>,
    pub url: Option<String>,
    pub published_at: Option<String>,
    pub body: Option<String>,
    pub body_truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialBodyCacheEntry {
    article_id: i64,
    source_url: String,
    body: String,
    truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
struct OfficialBodyCache {
    version: u8,
    entries: Vec<OfficialBodyCacheEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarProvenance {
    pub origin: String,
    pub source_tier: String,
    pub verification: String,
    pub reviewed_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CalendarSeed {
    pub article: CalendarArticle,
    pub lane: String,
    pub provenance: Option<CalendarProvenance>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    article_id INTEGER NOT NULL UNIQUE,
    lane TEXT NOT NULL,
    source_name TEXT NOT NULL,
    title TEXT NOT NULL,
    snippet TEXT,
    source_url TEXT,
    published_at TEXT,
    origin TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    verification TEXT NOT NULL,
    reviewed_at TEXT,
    seed_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_review
    ON calendar_events(source_tier, verification);
CREATE INDEX IF NOT EXISTS idx_calendar_events_source
    ON calendar_events(source_url);
"#;

fn bundled_seeds() -> Result<Vec<CalendarSeed>, String> {
    let mut all = Vec::new();
    for (batch_index, json) in OFFICIAL_SEED_BATCHES.iter().enumerate() {
        let mut batch: Vec<CalendarSeed> = serde_json::from_str(json).map_err(|error| {
            format!("parse bundled calendar batch {}: {error}", batch_index + 1)
        })?;
        all.append(&mut batch);
    }
    attach_cached_bodies(&mut all)?;
    Ok(all)
}

/// Body captures are a sidecar of the reviewed seed set. This makes body
/// refreshes auditable and prevents a scrape from altering dates or
/// provenance. A cache entry must match the exact reviewed source URL.
fn attach_cached_bodies(seeds: &mut [CalendarSeed]) -> Result<(), String> {
    let cache: OfficialBodyCache = serde_json::from_str(OFFICIAL_BODY_CACHE)
        .map_err(|error| format!("parse calendar body cache: {error}"))?;
    if cache.version != 2 {
        return Err(format!("unsupported calendar body cache version {}", cache.version));
    }

    let mut entries = std::collections::HashMap::new();
    for entry in cache.entries {
        if entry.body.trim().is_empty() {
            return Err(format!("calendar body cache {} is empty", entry.article_id));
        }
        let key = (entry.article_id, entry.source_url.clone());
        if entries.insert(key, entry).is_some() {
            return Err("calendar body cache has duplicate article/source pairs".into());
        }
    }

    for seed in seeds {
        if seed.article.body.as_deref().is_some_and(|body| !body.trim().is_empty()) {
            continue;
        }
        let Some(source_url) = seed.article.url.as_deref() else {
            continue;
        };
        let Some(entry) = entries.get(&(seed.article.id, source_url.to_owned())) else {
            continue;
        };
        seed.article.body = Some(entry.body.clone());
        seed.article.body_truncated = entry.truncated.filter(|value| *value);
    }
    Ok(())
}

fn validate_seed(seed: &CalendarSeed) -> Result<&CalendarProvenance, String> {
    if seed.article.id <= 0 {
        return Err("calendar source record id must be positive".into());
    }
    if seed.lane.trim().is_empty()
        || seed.article.feed_title.trim().is_empty()
        || seed.article.title.trim().is_empty()
    {
        return Err(format!(
            "calendar record {} has an incomplete display field",
            seed.article.id
        ));
    }
    let url = seed.article.url.as_deref().ok_or_else(|| {
        format!(
            "calendar record {} is missing its official source URL",
            seed.article.id
        )
    })?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!(
            "calendar record {} has an unsafe source URL",
            seed.article.id
        ));
    }
    let provenance = seed
        .provenance
        .as_ref()
        .ok_or_else(|| format!("calendar record {} is missing provenance", seed.article.id))?;
    if provenance.source_tier != "official" || provenance.verification != "verified" {
        return Err(format!(
            "calendar record {} is not a verified official notice",
            seed.article.id
        ));
    }
    Ok(provenance)
}

/// Create the isolated calendar-evidence table and synchronize bundled,
/// manually reviewed records into it. Re-running this is idempotent and also
/// refreshes corrected provenance or snippets without touching RSS articles.
pub fn ensure_schema_and_seed(conn: &mut Connection) -> Result<usize, String> {
    let seeds = bundled_seeds()?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("begin calendar evidence transaction: {error}"))?;
    tx.execute_batch(SCHEMA)
        .map_err(|error| format!("create calendar evidence schema: {error}"))?;

    let mut written = 0;
    for seed in &seeds {
        let provenance = validate_seed(seed)?;
        let seed_json = serde_json::to_string(seed)
            .map_err(|error| format!("serialize calendar record {}: {error}", seed.article.id))?;
        written += tx
            .execute(
                r#"
                INSERT INTO calendar_events (
                    id, article_id, lane, source_name, title, snippet, source_url,
                    published_at, origin, source_tier, verification, reviewed_at, seed_json
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
                )
                ON CONFLICT(id) DO UPDATE SET
                    article_id = excluded.article_id,
                    lane = excluded.lane,
                    source_name = excluded.source_name,
                    title = excluded.title,
                    snippet = excluded.snippet,
                    source_url = excluded.source_url,
                    published_at = excluded.published_at,
                    origin = excluded.origin,
                    source_tier = excluded.source_tier,
                    verification = excluded.verification,
                    reviewed_at = excluded.reviewed_at,
                    seed_json = excluded.seed_json,
                    updated_at = CURRENT_TIMESTAMP
                "#,
                params![
                    format!("official:{}", seed.article.id),
                    seed.article.id,
                    seed.lane,
                    seed.article.feed_title,
                    seed.article.title,
                    seed.article.snippet,
                    seed.article.url,
                    seed.article.published_at,
                    provenance.origin,
                    provenance.source_tier,
                    provenance.verification,
                    provenance.reviewed_at,
                    seed_json,
                ],
            )
            .map_err(|error| format!("write calendar record {}: {error}", seed.article.id))?;
    }
    tx.commit()
        .map_err(|error| format!("commit calendar evidence transaction: {error}"))?;
    Ok(written)
}

pub fn list_seeds(conn: &Connection) -> Result<Vec<CalendarSeed>, String> {
    let mut statement = conn
        .prepare("SELECT seed_json FROM calendar_events ORDER BY article_id")
        .map_err(|error| format!("prepare calendar evidence query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("query calendar evidence: {error}"))?;
    let mut seeds = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("read calendar evidence: {error}"))?;
        let seed = serde_json::from_str(&json)
            .map_err(|error| format!("decode calendar evidence: {error}"))?;
        seeds.push(seed);
    }
    Ok(seeds)
}

#[tauri::command]
pub async fn list_calendar_events(state: State<'_, AppState>) -> AppResult<Vec<CalendarSeed>> {
    let conn = state.read().await;
    list_seeds(&conn).map_err(AppError::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_every_bundled_official_record_with_its_provenance() {
        let expected = bundled_seeds().expect("parse bundled records");
        let mut conn = Connection::open_in_memory().expect("open in-memory sqlite");

        assert_eq!(
            ensure_schema_and_seed(&mut conn).expect("seed store"),
            expected.len()
        );
        let stored = list_seeds(&conn).expect("read store");
        assert_eq!(stored.len(), expected.len());
        assert!(stored.iter().all(|seed| {
            seed.article
                .url
                .as_deref()
                .is_some_and(|url| url.starts_with("https://"))
                && seed.provenance.as_ref().is_some_and(|provenance| {
                    provenance.source_tier == "official" && provenance.verification == "verified"
                })
        }));
    }
}
