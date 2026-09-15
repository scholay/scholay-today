//! Preserve WebKit's leading-dot domain semantics, which the generic Cookie
//! wrapper normalizes away. Values are filtered natively before returning.
use super::{cookie_domain_allowed, Source, StoredCookie};
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    NSArray, NSDate, NSHTTPCookie, NSHTTPCookiePropertyKey, NSMutableDictionary, NSString,
};
use objc2_web_kit::WKWebView;
use std::{
    ptr::NonNull,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

pub(super) fn capture(source: &Source, view: &tauri::Webview) -> Result<Vec<StoredCookie>, String> {
    let source = source.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| unsafe {
        let wk = &*platform.inner().cast::<WKWebView>();
        wk.configuration()
            .websiteDataStore()
            .httpCookieStore()
            .getAllCookies(&RcBlock::new(
                move |items: NonNull<NSArray<NSHTTPCookie>>| {
                    let mut result = Vec::new();
                    for item in items.as_ref() {
                        let domain = item.domain().to_string();
                        if !cookie_domain_allowed(&source, &domain) {
                            continue;
                        }
                        result.push(StoredCookie {
                            name: item.name().to_string(),
                            value: item.value().to_string(),
                            domain,
                            path: item.path().to_string(),
                            secure: item.isSecure(),
                            http_only: item.isHTTPOnly(),
                            same_site: item.sameSitePolicy().map(|s| s.to_string()),
                            expires: item.expiresDate().map(|d| d.timeIntervalSince1970() as i64),
                        });
                        if result.len() > 200 {
                            break;
                        }
                    }
                    let _ = tx.send(result);
                },
            ));
    })
    .map_err(|_| "无法访问平台 Cookie 存储")?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "读取平台 Cookie 超时".into())
}

pub(super) fn restore(cookies: Vec<StoredCookie>, view: &tauri::Webview) -> Result<usize, String> {
    if cookies.is_empty() {
        return Ok(0);
    }
    let count = cookies.len();
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| unsafe {
        let wk = &*platform.inner().cast::<WKWebView>();
        let store = wk.configuration().websiteDataStore().httpCookieStore();
        let mut native = Vec::new();
        for item in cookies {
            let properties = NSMutableDictionary::<NSHTTPCookiePropertyKey, AnyObject>::new();
            let name = NSString::from_str(&item.name);
            let value = NSString::from_str(&item.value);
            let domain = NSString::from_str(&item.domain);
            let path = NSString::from_str(&item.path);
            for (key, value) in [
                ("Name", &*name),
                ("Value", &*value),
                ("Domain", &*domain),
                ("Path", &*path),
            ] {
                properties.insert(&*NSString::from_str(key), value.as_ref());
            }
            properties.insert(
                &*NSString::from_str("Secure"),
                NSString::from_str(if item.secure { "TRUE" } else { "FALSE" }).as_ref(),
            );
            properties.insert(
                &*NSString::from_str("HttpOnly"),
                NSString::from_str(if item.http_only { "TRUE" } else { "FALSE" }).as_ref(),
            );
            if let Some(end) = item.expires {
                properties.insert(
                    &*NSString::from_str("Expires"),
                    NSDate::dateWithTimeIntervalSince1970(end as f64).as_ref(),
                );
            }
            if let Some(policy) = item.same_site {
                if matches!(
                    policy.to_ascii_lowercase().as_str(),
                    "lax" | "strict" | "none"
                ) {
                    properties.insert(
                        &*NSString::from_str("SameSite"),
                        NSString::from_str(&policy.to_ascii_lowercase()).as_ref(),
                    );
                }
            }
            let Some(cookie) = NSHTTPCookie::cookieWithProperties(&properties) else {
                let _ = tx.send(Err("平台 Cookie 格式无法恢复".to_string()));
                return;
            };
            native.push(cookie);
        }
        let pending = Arc::new(AtomicUsize::new(count));
        for cookie in native {
            let pending = pending.clone();
            let tx = tx.clone();
            store.setCookie_completionHandler(
                &cookie,
                Some(&RcBlock::new(move || {
                    if pending.fetch_sub(1, Ordering::AcqRel) == 1 {
                        let _ = tx.send(Ok(count));
                    }
                })),
            );
        }
    })
    .map_err(|_| "无法恢复平台 Cookie")?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "恢复平台 Cookie 超时".to_string())?
}
