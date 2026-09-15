//! Scoped, in-process WebView2 cookie operations. No debug port or frontend
//! cookie transport. CDP preserves raw domain semantics unlike Cookie::domain.
use super::{Source, StoredCookie};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

fn call(view: &tauri::Webview, method: &'static str, params: Value) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        let sender = Arc::new(Mutex::new(Some(tx)));
        let callback_sender = sender.clone();
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|browser| {
                browser.CallDevToolsProtocolMethod(
                    &HSTRING::from(method),
                    &HSTRING::from(params.to_string()),
                    &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, value| {
                            let parsed = if status.is_err() || value.len() > 512_000 {
                                Err("平台 Cookie 操作未完成".into())
                            } else {
                                serde_json::from_str::<Value>(&value)
                                    .map_err(|_| "平台 Cookie 数据无效".to_string())
                            };
                            if let Some(tx) = callback_sender
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .take()
                            {
                                let _ = tx.send(parsed);
                            }
                            Ok(())
                        },
                    )),
                )
            })
        };
        if result.is_err() {
            if let Some(tx) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(Err("WebView2 Cookie 接口不可用".into()));
            }
        }
    })
    .map_err(|_| "平台窗口已关闭")?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "平台 Cookie 操作超时".to_string())?
}
pub(super) fn capture(source: &Source, view: &tauri::Webview) -> Result<Vec<StoredCookie>, String> {
    let mut urls: Vec<_> = source
        .hosts
        .iter()
        .chain(&source.cookie_domains)
        .map(|host| format!("https://{host}/"))
        .collect();
    if let Ok(url) = view.url() {
        if crate::label_board::allowed(source, &url) {
            urls.push(url.to_string());
        }
    }
    let result = call(view, "Network.getCookies", json!({"urls":urls}))?;
    let items = result["cookies"]
        .as_array()
        .ok_or("WebView2 未返回平台 Cookie")?;
    if items.len() > 200 {
        return Err("平台 Cookie 数量超出限制".into());
    }
    Ok(items
        .iter()
        .map(|item| StoredCookie {
            name: item["name"].as_str().unwrap_or_default().into(),
            value: item["value"].as_str().unwrap_or_default().into(),
            domain: item["domain"].as_str().unwrap_or_default().into(),
            path: item["path"].as_str().unwrap_or("/").into(),
            secure: item["secure"].as_bool().unwrap_or(true),
            http_only: item["httpOnly"].as_bool().unwrap_or(false),
            same_site: item["sameSite"].as_str().map(str::to_string),
            expires: item["expires"]
                .as_f64()
                .filter(|n| *n > 0.)
                .map(|n| n as i64),
        })
        .collect())
}
pub(super) fn restore(cookies: Vec<StoredCookie>, view: &tauri::Webview) -> Result<usize, String> {
    let count = cookies.len();
    if count == 0 {
        return Ok(0);
    }
    let items:Vec<_>=cookies.into_iter().map(|item|{
        let mut value=json!({"name":item.name,"value":item.value,"domain":item.domain,"path":item.path,"secure":item.secure,"httpOnly":item.http_only});
        if let Some(end)=item.expires {value["expires"]=json!(end);}
        if let Some(policy)=item.same_site {let normalized=match policy.to_ascii_lowercase().as_str(){"strict"=>Some("Strict"),"lax"=>Some("Lax"),"none"|"no_restriction"=>Some("None"),_=>None};if let Some(policy)=normalized {value["sameSite"]=json!(policy);}}
        value
    }).collect();
    call(view, "Network.setCookies", json!({"cookies":items}))?;
    Ok(count)
}
