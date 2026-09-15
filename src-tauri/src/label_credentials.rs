//! Labels-only credential vault. Cookie values never leave native code after
//! import/capture; UI status is metadata only. No SQLite/plaintext fallback.
use crate::label_board::{self, Source};
use serde::{Deserialize, Serialize};
#[cfg(not(any(target_os = "macos", windows)))]
use std::collections::BTreeMap;
#[cfg(not(any(target_os = "macos", windows)))]
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Webview};
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
#[path = "label_credentials/windows.rs"]
mod windows_cookies;

const SERVICE: &str = "com.thomas.papr.labels.cookies.v1";
const LIMIT: usize = 128 * 1024;
static VAULT_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, Deserialize)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: Option<String>,
    expires: Option<i64>,
}
#[derive(Serialize, Deserialize)]
struct Jar {
    saved_at: i64,
    cookies: Vec<StoredCookie>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    configured: bool,
    count: usize,
    saved_at: Option<i64>,
    expired: bool,
    persistent: bool,
}

fn cookie_domain_allowed(source: &Source, domain: &str) -> bool {
    let domain = domain
        .strip_prefix('.')
        .unwrap_or(domain)
        .to_ascii_lowercase();
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && source
            .cookie_domains
            .iter()
            .any(|root| domain == *root || domain.ends_with(&format!(".{root}")))
}
fn valid(source: &Source, cookie: &StoredCookie) -> bool {
    cookie_domain_allowed(source, &cookie.domain)
        && !cookie.name.is_empty()
        && cookie.name.len() <= 256
        && cookie
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        && cookie.value.len() <= 16_384
        && !cookie.value.chars().any(|c| c.is_control() || c == ';')
        && cookie.path.starts_with('/')
        && cookie.path.len() <= 2048
        && !cookie.path.chars().any(char::is_control)
}
fn live(cookie: &StoredCookie) -> bool {
    cookie
        .expires
        .is_none_or(|end| end > chrono::Utc::now().timestamp())
}
fn status(jar: Option<&Jar>) -> CredentialStatus {
    CredentialStatus {
        configured: jar.is_some(),
        count: jar.map_or(0, |j| j.cookies.iter().filter(|c| live(c)).count()),
        saved_at: jar.map(|j| j.saved_at),
        expired: jar.is_some_and(|j| !j.cookies.iter().any(live)),
        persistent: cfg!(any(target_os = "macos", windows)),
    }
}

#[cfg(target_os = "macos")]
fn vault_read(id: &str) -> Result<Option<Vec<u8>>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, id) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.code() == -25300 => Ok(None),
        Err(_) => Err("无法读取系统钥匙串中的标签授权".into()),
    }
}
#[cfg(target_os = "macos")]
fn vault_write(id: &str, bytes: &[u8]) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, id, bytes)
        .map_err(|_| "无法保存到系统钥匙串；没有写入普通配置文件".into())
}
#[cfg(target_os = "macos")]
fn vault_delete(id: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, id) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(_) => Err("无法清除保存的标签授权".into()),
    }
}

// Credential Manager has a 2560-byte item limit. Keep bounded encrypted chunks
// with a generation manifest, commit the manifest last, then retire old chunks.
#[cfg(windows)]
mod win {
    use super::*;
    #[derive(Deserialize, Serialize)]
    struct Manifest {
        generation: String,
        parts: usize,
    }
    fn base(id: &str) -> String {
        format!("{SERVICE}.{id}")
    }
    fn read_manifest(id: &str) -> Result<Option<Manifest>, String> {
        crate::windows_credentials::read(&base(id))
            .map_err(|_| "无法读取凭据管理器".to_string())?
            .map(|mut bytes| {
                let decoded: Result<Manifest, _> = serde_json::from_slice(&bytes);
                bytes.fill(0);
                let value = decoded.map_err(|_| "授权索引损坏")?;
                if uuid::Uuid::parse_str(&value.generation).is_err()
                    || value.parts == 0
                    || value.parts > 64
                {
                    return Err("授权索引无效".into());
                }
                Ok(value)
            })
            .transpose()
    }
    fn part(id: &str, value: &Manifest, n: usize) -> String {
        format!("{}.{}.{}", base(id), value.generation, n)
    }
    fn retire(id: &str, value: &Manifest) {
        for n in 0..value.parts {
            let _ = crate::windows_credentials::delete(&part(id, value, n));
        }
    }
    pub fn read(id: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(manifest) = read_manifest(id)? else {
            return Ok(None);
        };
        let mut out = Vec::new();
        for n in 0..manifest.parts {
            match crate::windows_credentials::read(&part(id, &manifest, n)) {
                Ok(Some(mut bytes)) => {
                    out.extend_from_slice(&bytes);
                    bytes.fill(0);
                }
                _ => {
                    out.fill(0);
                    return Err("保存的授权不完整，请重新授权".into());
                }
            }
        }
        Ok(Some(out))
    }
    pub fn write(id: &str, bytes: &[u8]) -> Result<(), String> {
        let old = read_manifest(id)?;
        let next = Manifest {
            generation: uuid::Uuid::new_v4().to_string(),
            parts: bytes.len().div_ceil(2048),
        };
        for (n, chunk) in bytes.chunks(2048).enumerate() {
            if crate::windows_credentials::save(&part(id, &next, n), chunk).is_err() {
                retire(id, &next);
                return Err("凭据保存失败，原授权未替换".into());
            }
        }
        let manifest = serde_json::to_vec(&next).map_err(|_| "授权索引生成失败")?;
        if crate::windows_credentials::save(&base(id), &manifest).is_err() {
            retire(id, &next);
            return Err("凭据保存失败，原授权未替换".into());
        }
        if let Some(old) = old {
            retire(id, &old);
        }
        Ok(())
    }
    pub fn delete(id: &str) -> Result<(), String> {
        let old = read_manifest(id)?;
        crate::windows_credentials::delete(&base(id)).map_err(|_| "无法清除标签授权")?;
        if let Some(old) = old {
            retire(id, &old);
        }
        Ok(())
    }
}
#[cfg(windows)]
use win::{delete as vault_delete, read as vault_read, write as vault_write};
#[cfg(not(any(target_os = "macos", windows)))]
fn vault_read(_: &str) -> Result<Option<Vec<u8>>, String> {
    Err("当前系统尚不支持安全保存标签授权".into())
}
#[cfg(not(any(target_os = "macos", windows)))]
fn vault_write(_: &str, _: &[u8]) -> Result<(), String> {
    Err("当前系统尚不支持安全保存标签授权".into())
}
#[cfg(not(any(target_os = "macos", windows)))]
fn vault_delete(_: &str) -> Result<(), String> {
    Err("当前系统尚不支持安全保存标签授权".into())
}

fn read(source: &Source) -> Result<Option<Jar>, String> {
    let Some(mut bytes) = vault_read(&source.id)? else {
        return Ok(None);
    };
    if bytes.len() > LIMIT {
        bytes.fill(0);
        return Err("保存的授权过大".into());
    }
    let jar = serde_json::from_slice::<Jar>(&bytes);
    bytes.fill(0);
    let jar = jar.map_err(|_| "保存的授权格式已失效，请重新授权")?;
    if jar.cookies.len() > 200 || jar.cookies.iter().any(|cookie| !valid(source, cookie)) {
        return Err("保存的授权范围无效，请重新授权".into());
    }
    Ok(Some(jar))
}
fn save(source: &Source, cookies: Vec<StoredCookie>) -> Result<CredentialStatus, String> {
    let _write = VAULT_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    save_unlocked(source, cookies)
}
fn save_unlocked(source: &Source, cookies: Vec<StoredCookie>) -> Result<CredentialStatus, String> {
    if cookies.is_empty()
        || cookies.len() > 200
        || cookies.iter().any(|cookie| !valid(source, cookie))
    {
        return Err("没有可安全保存的本站 Cookie；原授权未修改".into());
    }
    let jar = Jar {
        saved_at: chrono::Utc::now().timestamp(),
        cookies,
    };
    let mut bytes = serde_json::to_vec(&jar).map_err(|_| "授权编码失败")?;
    if bytes.len() > LIMIT {
        bytes.fill(0);
        return Err("Cookie 超出 128 KB 限制".into());
    }
    let result = vault_write(&source.id, &bytes);
    bytes.fill(0);
    result?;
    Ok(status(Some(&jar)))
}

fn capture(source: &Source, view: &Webview) -> Result<Vec<StoredCookie>, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::capture(source, view).map(|items| {
            items
                .into_iter()
                .filter(|item| valid(source, item) && live(item))
                .collect()
        });
    }
    #[cfg(windows)]
    {
        return windows_cookies::capture(source, view).map(|items| {
            items
                .into_iter()
                .filter(|item| valid(source, item) && live(item))
                .collect()
        });
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let mut cookies = BTreeMap::new();
        let mut urls: Vec<_> = source
            .hosts
            .iter()
            .chain(&source.cookie_domains)
            .filter_map(|host| url::Url::parse(&format!("https://{host}/")).ok())
            .collect();
        if let Ok(url) = view.url() {
            if label_board::allowed(source, &url) {
                urls.push(url);
            }
        }
        for url in urls {
            for item in view
                .cookies_for_url(url)
                .map_err(|_| "无法读取当前平台 Cookie")?
            {
                let Some(domain) = item.domain().map(str::to_string) else {
                    continue;
                };
                let cookie = StoredCookie {
                    name: item.name().into(),
                    value: item.value().into(),
                    domain,
                    path: item.path().unwrap_or("/").into(),
                    secure: item.secure().unwrap_or(true),
                    http_only: item.http_only().unwrap_or(false),
                    same_site: item.same_site().map(|s| s.to_string()),
                    expires: item.expires_datetime().map(|date| date.unix_timestamp()),
                };
                if valid(source, &cookie) && live(&cookie) {
                    cookies.insert(
                        (
                            cookie.domain.clone(),
                            cookie.path.clone(),
                            cookie.name.clone(),
                        ),
                        cookie,
                    );
                }
            }
        }
        Ok(cookies.into_values().collect())
    }
}

/// A user-saved session may rotate during a successful sync. Refresh only an
/// existing vault record, under the same writer lock as import/forget. Never
/// silently create a credential record from anonymous browsing.
pub(crate) fn refresh_saved_from(source: &Source, view: &Webview) -> Result<(), String> {
    let _write = VAULT_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if read(source)?.is_none() {
        return Ok(());
    }
    let cookies = capture(source, view)?;
    if !cookies.is_empty() {
        save_unlocked(source, cookies)?;
    }
    Ok(())
}

/// Blocking native cookie APIs must run off the UI thread on Windows.
pub(crate) fn restore_to(source: &Source, view: &Webview) -> Result<usize, String> {
    let Some(jar) = read(source)? else {
        return Ok(0);
    };
    #[cfg(target_os = "macos")]
    {
        return macos::restore(jar.cookies.into_iter().filter(live).collect(), view);
    }
    #[cfg(windows)]
    {
        return windows_cookies::restore(jar.cookies.into_iter().filter(live).collect(), view);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let mut count = 0;
        for item in jar.cookies.into_iter().filter(live) {
            let mut cookie = Cookie::new(item.name, item.value);
            cookie.set_domain(item.domain);
            cookie.set_path(item.path);
            cookie.set_secure(item.secure);
            cookie.set_http_only(item.http_only);
            // Preserve expiry; never extend server validity to claim permanence.
            if let Some(end) = item.expires {
                if let Ok(date) =
                    tauri::webview::cookie::time::OffsetDateTime::from_unix_timestamp(end)
                {
                    cookie.set_expires(date);
                }
            }
            match item
                .same_site
                .as_deref()
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("strict") => cookie.set_same_site(tauri::webview::cookie::SameSite::Strict),
                Some("lax") => cookie.set_same_site(tauri::webview::cookie::SameSite::Lax),
                Some("none" | "no_restriction") => {
                    cookie.set_same_site(tauri::webview::cookie::SameSite::None)
                }
                _ => {}
            }
            view.set_cookie(cookie)
                .map_err(|_| "恢复平台 Cookie 失败")?;
            count += 1;
        }
        Ok(count)
    }
}

#[tauri::command]
pub async fn get_label_credential_status(
    webview: Webview,
    source_id: String,
) -> Result<CredentialStatus, String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    tokio::task::spawn_blocking(move || read(&source).map(|jar| status(jar.as_ref())))
        .await
        .map_err(|_| "无法查询授权状态".to_string())?
}
#[tauri::command]
pub async fn restore_label_credentials(
    app: AppHandle,
    webview: Webview,
    source_id: String,
) -> Result<(), String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    let main = app.get_webview("main").ok_or("应用窗口不可用")?;
    tokio::task::spawn_blocking(move || restore_to(&source, &main).map(|_| ()))
        .await
        .map_err(|_| "恢复授权失败".to_string())?
}
#[tauri::command]
pub async fn save_label_browser_credentials(
    app: AppHandle,
    webview: Webview,
    request_id: String,
    source_id: String,
) -> Result<CredentialStatus, String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    let view = crate::page_view::label_auth_view(&app, &request_id, &source)?;
    tokio::task::spawn_blocking(move || {
        let cookies = capture(&source, &view)?;
        // Recheck ownership after asynchronous native access; no credential
        // from a replacement page may be saved under the previous platform.
        crate::page_view::label_auth_view(&app, &request_id, &source)?;
        save(&source, cookies)
    })
    .await
    .map_err(|_| "保存平台 Cookie 失败".to_string())?
}

fn parse_import(source: &Source, raw: &str) -> Result<Vec<StoredCookie>, String> {
    if raw.is_empty()
        || raw.len() > LIMIT
        || raw.contains(['\r', '\n']) && !raw.trim_start().starts_with('[')
    {
        return Err("请输入 Cookie 请求头或浏览器导出的 JSON 数组，最多 128 KB".into());
    }
    let host = url::Url::parse(&source.url)
        .map_err(|_| "平台网址无效")?
        .host_str()
        .ok_or("平台域名无效")?
        .to_string();
    let mut cookies = Vec::new();
    if raw.trim_start().starts_with('[') {
        let items: Vec<serde_json::Value> =
            serde_json::from_str(raw).map_err(|_| "Cookie JSON 格式不正确")?;
        for item in items.into_iter().take(201) {
            cookies.push(StoredCookie {
                name: item["name"].as_str().unwrap_or_default().into(),
                value: item["value"].as_str().unwrap_or_default().into(),
                domain: item["domain"].as_str().unwrap_or(&host).into(),
                path: item["path"].as_str().unwrap_or("/").into(),
                secure: item["secure"].as_bool().unwrap_or(true),
                http_only: item["httpOnly"].as_bool().unwrap_or(false),
                same_site: item["sameSite"].as_str().map(str::to_string),
                expires: item["expirationDate"]
                    .as_f64()
                    .map(|n| n as i64)
                    .filter(|n| *n > 0),
            });
        }
    } else {
        let header = raw
            .trim()
            .strip_prefix("Cookie:")
            .unwrap_or(raw.trim())
            .trim();
        for pair in header
            .split(';')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .take(201)
        {
            let (name, value) = pair.split_once('=').ok_or("Cookie 请求头格式不正确")?;
            cookies.push(StoredCookie {
                name: name.trim().into(),
                value: value.trim().into(),
                domain: host.clone(),
                path: "/".into(),
                secure: true,
                http_only: true,
                same_site: None,
                expires: None,
            });
        }
    }
    if cookies.is_empty()
        || cookies.len() > 200
        || cookies.iter().any(|cookie| !valid(source, cookie))
    {
        return Err("Cookie 包含其他平台域名或无效字段，未保存".into());
    }
    Ok(cookies)
}
#[tauri::command]
pub async fn import_label_cookie(
    webview: Webview,
    source_id: String,
    cookie: String,
) -> Result<CredentialStatus, String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    tokio::task::spawn_blocking(move || {
        let parsed = parse_import(&source, &cookie)?;
        save(&source, parsed)
    })
    .await
    .map_err(|_| "保存授权失败".to_string())?
}
#[tauri::command]
pub async fn forget_label_credentials(webview: Webview, source_id: String) -> Result<(), String> {
    crate::hot_board::require_main(&webview)?;
    let source = label_board::source(&source_id)?;
    tokio::task::spawn_blocking(move || {
        let _write = VAULT_WRITE.lock().unwrap_or_else(|e| e.into_inner());
        vault_delete(&source.id)
    })
    .await
    .map_err(|_| "清除授权失败".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_is_bounded_and_platform_scoped() {
        let source = label_board::source("bilibili").unwrap();
        assert_eq!(
            parse_import(&source, "Cookie: session=synthetic; csrf=abc==")
                .unwrap()
                .len(),
            2
        );
        assert!(parse_import(&source, "session=abc\r\nX-Injected: yes").is_err());
        assert!(parse_import(
            &source,
            r#"[{"name":"session","value":"synthetic","domain":"evil.bilibili.com.evil.org"}]"#
        )
        .is_err());
        assert!(parse_import(&source, &"a".repeat(LIMIT + 1)).is_err());
        assert!(parse_import(
            &source,
            r#"[{"name":"session","value":"synthetic","domain":".bilibili.com"}]"#
        )
        .is_ok());
    }
    #[test]
    fn metadata_never_serializes_values_and_expiry_is_not_extended() {
        let source = label_board::source("bilibili").unwrap();
        let cookies = parse_import(&source, "session=private-test-value").unwrap();
        let mut jar = Jar {
            saved_at: 1,
            cookies,
        };
        assert!(!serde_json::to_string(&status(Some(&jar)))
            .unwrap()
            .contains("private-test-value"));
        jar.cookies[0].expires = Some(1);
        assert!(status(Some(&jar)).expired);
        assert_eq!(status(Some(&jar)).count, 0);
    }
}
