//! Separately stored AI formatting of a captured original page.
//!
//! The capture text is evidence, not a replacement for the RSS article. Saves
//! touch only `article_ai_formatted`; source and translation fields stay intact.

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Desktop-only opt-in extension. Deliberately NOT a core migration: retaining
/// the existing user_version lets an already installed CLI or fallback app
/// continue to open and refresh the same RSS database. Idempotent and additive.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS article_ai_formatted (
            article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
            capture_id TEXT NOT NULL CHECK(length(trim(capture_id)) > 0),
            source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
            source_title TEXT NOT NULL,
            source_text TEXT NOT NULL CHECK(length(trim(source_text)) > 0),
            captured_at TEXT NOT NULL CHECK(length(trim(captured_at)) > 0),
            generated_at TEXT NOT NULL CHECK(length(trim(generated_at)) > 0),
            model TEXT NOT NULL CHECK(length(trim(model)) > 0),
            language TEXT NOT NULL CHECK(length(trim(language)) > 0),
            markdown TEXT NOT NULL CHECK(length(trim(markdown)) > 0),
            source_char_count INTEGER NOT NULL CHECK(source_char_count > 0),
            source_truncated INTEGER NOT NULL CHECK(source_truncated IN (0, 1)),
            warnings TEXT NOT NULL
        );",
    )
    .map_err(|_| AppError::other("Could not initialize the independent AI-formatted copies."))?;
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCapture {
    pub capture_id: String,
    pub article_id: i64,
    pub source_url: String,
    pub source_title: String,
    pub text: String,
    pub captured_at: String,
    pub truncated: bool,
    /// Unicode scalar values in `text`, matching Rust's `str::chars().count()`.
    pub char_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFormattedDraft {
    pub article_id: i64,
    pub capture_id: String,
    pub source_url: String,
    pub source_title: String,
    /// Exact captured text, including its original whitespace.
    pub source_text: String,
    pub captured_at: String,
    pub generated_at: String,
    pub model: String,
    pub language: String,
    pub markdown: String,
    /// Unicode scalar values in `source_text`, not its UTF-8 byte length.
    pub source_char_count: usize,
    pub source_truncated: bool,
    pub warnings: Vec<String>,
}

/// Read the independent formatted copy, if this article has one.
/// Corrupt metadata is reported, never silently replaced with empty evidence.
pub fn get(conn: &Connection, article_id: i64) -> AppResult<Option<AiFormattedDraft>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_ai_formatted')",
        [], |row| row.get(0),
    ).map_err(|_| AppError::other("Could not read the AI-formatted copy."))?;
    if !exists {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "SELECT article_id, capture_id, source_url, source_title, source_text,
                    captured_at, generated_at, model, language, markdown,
                    source_char_count, source_truncated, warnings
             FROM article_ai_formatted WHERE article_id = ?1",
            [article_id],
            |row| {
                Ok((
                    AiFormattedDraft {
                        article_id: row.get(0)?,
                        capture_id: row.get(1)?,
                        source_url: row.get(2)?,
                        source_title: row.get(3)?,
                        source_text: row.get(4)?,
                        captured_at: row.get(5)?,
                        generated_at: row.get(6)?,
                        model: row.get(7)?,
                        language: row.get(8)?,
                        markdown: row.get(9)?,
                        source_char_count: row.get(10)?,
                        source_truncated: row.get(11)?,
                        warnings: Vec::new(),
                    },
                    row.get::<_, String>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|_| AppError::other("Could not read the AI-formatted copy."))?;
    let Some((mut draft, warnings)) = row else {
        return Ok(None);
    };
    draft.warnings = serde_json::from_str(&warnings)
        .map_err(|_| AppError::other("The AI-formatted copy has invalid warning metadata."))?;
    Ok(Some(draft))
}

fn validate(draft: &AiFormattedDraft) -> AppResult<i64> {
    if draft.article_id <= 0 {
        return Err(AppError::other("An AI-formatted copy requires an article."));
    }
    // Test for blank input without changing the captured evidence or output.
    // A page without a title is valid, so source_title may be empty.
    for value in [
        &draft.capture_id,
        &draft.source_url,
        &draft.source_text,
        &draft.captured_at,
        &draft.generated_at,
        &draft.model,
        &draft.language,
        &draft.markdown,
    ] {
        if value.trim().is_empty() {
            return Err(AppError::other(
                "The AI-formatted copy is missing required content or provenance.",
            ));
        }
    }
    if draft.source_char_count != draft.source_text.chars().count() {
        return Err(AppError::other(
            "The AI-formatted copy's source character count does not match its capture.",
        ));
    }
    i64::try_from(draft.source_char_count)
        .map_err(|_| AppError::other("The AI-formatted copy's source is too large to store."))
}

/// Atomically insert or replace this article's independent formatted copy.
/// Validation/serialization complete before the single SQLite upsert; a failed
/// statement leaves any previous copy intact. No original article is updated.
pub fn save(conn: &Connection, draft: &AiFormattedDraft) -> AppResult<()> {
    let source_char_count = validate(draft)?;
    let warnings = serde_json::to_string(&draft.warnings)
        .map_err(|_| AppError::other("Could not encode the AI-formatted copy's warnings."))?;
    conn.execute(
        "INSERT INTO article_ai_formatted (
            article_id, capture_id, source_url, source_title, source_text,
            captured_at, generated_at, model, language, markdown,
            source_char_count, source_truncated, warnings
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(article_id) DO UPDATE SET
            capture_id = excluded.capture_id,
            source_url = excluded.source_url,
            source_title = excluded.source_title,
            source_text = excluded.source_text,
            captured_at = excluded.captured_at,
            generated_at = excluded.generated_at,
            model = excluded.model,
            language = excluded.language,
            markdown = excluded.markdown,
            source_char_count = excluded.source_char_count,
            source_truncated = excluded.source_truncated,
            warnings = excluded.warnings",
        params![
            draft.article_id,
            draft.capture_id,
            draft.source_url,
            draft.source_title,
            draft.source_text,
            draft.captured_at,
            draft.generated_at,
            draft.model,
            draft.language,
            draft.markdown,
            source_char_count,
            draft.source_truncated,
            warnings,
        ],
    )
    .map_err(|_| AppError::other("Could not save the AI-formatted copy; no copy was replaced."))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, models::SourceType};
    use rusqlite::types::Value;
    use std::path::Path;

    fn fixture() -> (Connection, i64) {
        // SQLite's special path opens no user database or filesystem artifact.
        let conn = db::open(Path::new(":memory:")).unwrap();
        ensure_schema(&conn).unwrap();
        let feed = db::insert_feed(
            &conn,
            "https://example.invalid/rss",
            None,
            "Synthetic feed",
            None,
            SourceType::Rss,
            None,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO articles (
                feed_id, guid, url, title, summary, content_html, extracted_html,
                body_text, translated_html, translated_lang, ai_summary
             ) VALUES (?1, 'source-article', 'https://example.invalid/article',
                       'RSS title', 'RSS summary', '<p>RSS HTML</p>',
                       '<p>Extracted source</p>', 'RSS body', '<p>Existing translation</p>',
                       'zh-CN', 'Existing AI summary')",
            [feed],
        )
        .unwrap();
        let article_id = conn.last_insert_rowid();
        (conn, article_id)
    }

    fn draft(article_id: i64) -> AiFormattedDraft {
        let source_text = "  原始网页正文 🧪\n第二行保持原样。\n".to_string();
        AiFormattedDraft {
            article_id,
            capture_id: "synthetic-capture-1".into(),
            source_url: "https://example.invalid/original?source=rss".into(),
            source_title: "Original page title".into(),
            source_char_count: source_text.chars().count(),
            source_text,
            captured_at: "2026-08-30T08:00:00Z".into(),
            generated_at: "2026-08-30T08:00:01Z".into(),
            model: "synthetic-model".into(),
            language: "zh-CN".into(),
            markdown: "# 排版副本\n\n原始网页正文 🧪".into(),
            source_truncated: true,
            warnings: vec![
                "Synthetic capture was truncated.".into(),
                "仅用于测试".into(),
            ],
        }
    }

    fn article_snapshot(conn: &Connection, article_id: i64) -> Vec<Value> {
        conn.query_row(
            "SELECT url, title, summary, content_html, extracted_html, body_text,
                    translated_html, translated_lang, ai_summary
             FROM articles WHERE id = ?1",
            [article_id],
            |row| (0..9).map(|index| row.get(index)).collect(),
        )
        .unwrap()
    }

    fn assert_stored(conn: &Connection, expected: &AiFormattedDraft) {
        let actual = get(conn, expected.article_id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn optional_schema_is_additive_idempotent_and_does_not_raise_core_version() {
        let conn = db::open(Path::new(":memory:")).unwrap();
        assert!(get(&conn, 1).unwrap().is_none());
        let before: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        let after: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, 19);
        assert_eq!(after, before);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM article_ai_formatted", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[test]
    fn roundtrip_and_upsert_preserve_original_article_and_translation() {
        let (conn, article_id) = fixture();
        let before = article_snapshot(&conn, article_id);
        assert!(get(&conn, article_id).unwrap().is_none());
        let mut formatted = draft(article_id);
        save(&conn, &formatted).unwrap();
        assert_stored(&conn, &formatted);
        assert_eq!(article_snapshot(&conn, article_id), before);

        formatted.capture_id = "synthetic-capture-2".into();
        formatted.markdown = "# A revised formatted copy".into();
        formatted.source_text = "A second preserved capture.".into();
        formatted.source_char_count = formatted.source_text.chars().count();
        formatted.source_title.clear();
        formatted.source_truncated = false;
        formatted.warnings.clear();
        save(&conn, &formatted).unwrap();
        assert_stored(&conn, &formatted);
        assert_eq!(article_snapshot(&conn, article_id), before);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM article_ai_formatted", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn invalid_content_or_provenance_does_not_replace_an_existing_copy() {
        let (conn, article_id) = fixture();
        let original = draft(article_id);
        save(&conn, &original).unwrap();
        for field in 0..8 {
            let mut invalid = original.clone();
            let value = match field {
                0 => &mut invalid.capture_id,
                1 => &mut invalid.source_url,
                2 => &mut invalid.source_text,
                3 => &mut invalid.captured_at,
                4 => &mut invalid.generated_at,
                5 => &mut invalid.model,
                6 => &mut invalid.language,
                _ => &mut invalid.markdown,
            };
            *value = " \n\t".into();
            assert!(save(&conn, &invalid).is_err());
            assert_stored(&conn, &original);
        }
        let mut wrong_count = original.clone();
        wrong_count.source_char_count = wrong_count.source_text.len();
        assert!(save(&conn, &wrong_count).is_err());
        assert_stored(&conn, &original);
    }

    #[test]
    fn foreign_key_and_sql_failure_preserve_the_previous_copy() {
        let (conn, article_id) = fixture();
        let original = draft(article_id);
        let before = article_snapshot(&conn, article_id);
        save(&conn, &original).unwrap();
        let missing = draft(article_id + 10_000);
        assert!(save(&conn, &missing).is_err());
        assert!(get(&conn, missing.article_id).unwrap().is_none());
        assert_stored(&conn, &original);

        // Force an actual SQL UPDATE failure after validation, not just an
        // application-side rejection. Its diagnostic must not be surfaced.
        conn.execute_batch(
            "CREATE TRIGGER synthetic_formatted_save_failure
             BEFORE UPDATE ON article_ai_formatted BEGIN
                 SELECT RAISE(ABORT, 'SYNTHETIC-SENSITIVE-DIAGNOSTIC');
             END;",
        )
        .unwrap();
        let mut replacement = original.clone();
        replacement.capture_id = "SYNTHETIC-SENSITIVE-CAPTURE".into();
        replacement.markdown = "Replacement that must not be saved.".into();
        let error = save(&conn, &replacement).unwrap_err().to_string();
        assert!(!error.contains("SYNTHETIC-SENSITIVE"));
        assert_stored(&conn, &original);
        assert_eq!(article_snapshot(&conn, article_id), before);
    }

    #[test]
    fn deleting_an_article_cascades_only_its_formatted_copy() {
        let (conn, article_id) = fixture();
        save(&conn, &draft(article_id)).unwrap();
        conn.execute("DELETE FROM articles WHERE id = ?1", [article_id])
            .unwrap();
        assert!(get(&conn, article_id).unwrap().is_none());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM feeds", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn malformed_warning_metadata_is_not_silently_discarded() {
        let (conn, article_id) = fixture();
        save(&conn, &draft(article_id)).unwrap();
        conn.execute(
            "UPDATE article_ai_formatted SET warnings = ?1 WHERE article_id = ?2",
            params!["SYNTHETIC-SENSITIVE-INVALID-JSON", article_id],
        )
        .unwrap();
        let error = get(&conn, article_id).unwrap_err().to_string();
        assert!(!error.contains("SYNTHETIC-SENSITIVE"));
    }

    #[test]
    fn capture_and_draft_use_camel_case_contracts() {
        let formatted = draft(7);
        let capture = PageCapture {
            capture_id: formatted.capture_id.clone(),
            article_id: formatted.article_id,
            source_url: formatted.source_url.clone(),
            source_title: formatted.source_title.clone(),
            text: formatted.source_text.clone(),
            captured_at: formatted.captured_at.clone(),
            truncated: formatted.source_truncated,
            char_count: formatted.source_char_count,
            warnings: formatted.warnings.clone(),
        };
        let capture_json = serde_json::to_value(&capture).unwrap();
        assert_eq!(capture_json["articleId"], 7);
        assert_eq!(capture_json["charCount"], capture.char_count);
        assert!(capture_json.get("capture_id").is_none());
        let restored: PageCapture = serde_json::from_value(capture_json).unwrap();
        assert_eq!(restored.text, capture.text);
        let draft_json = serde_json::to_value(&formatted).unwrap();
        assert_eq!(draft_json["sourceText"], formatted.source_text);
        assert_eq!(draft_json["sourceTruncated"], true);
        assert_eq!(draft_json["sourceCharCount"], formatted.source_char_count);
        assert!(draft_json.get("article_id").is_none());
    }
}
