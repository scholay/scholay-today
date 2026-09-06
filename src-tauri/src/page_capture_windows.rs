//! WebView2's in-process CDP interface. No debugging port and no remote IPC.
//! Fixed extraction code runs only in a main-frame isolated world; page code
//! cannot override JSON/DOM prototypes or forge a host-message capture result.
use super::{PageRequest, CAPTURE_SCRIPT};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc, Mutex};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

fn active(request: &PageRequest, epoch: u64) -> bool {
    request.is_active()
        && request.loaded.load(Ordering::Acquire)
        && request.navigation_epoch.load(Ordering::Acquire) == epoch
}

async fn cdp(
    view: &tauri::Webview,
    method: &'static str,
    params: Value,
    request: Arc<PageRequest>,
    epoch: u64,
) -> Result<Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        if !active(&request, epoch) {
            let _ = sender.send(Err("The page changed during capture.".into()));
            return;
        }
        let sender = Arc::new(Mutex::new(Some(sender)));
        let callback_sender = sender.clone();
        // All COM access stays on the UI thread. Only owned JSON crosses back.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|webview| {
                webview.CallDevToolsProtocolMethod(
                    &HSTRING::from(method),
                    &HSTRING::from(params.to_string()),
                    &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, value| {
                            let value = if status.is_err() || !active(&request, epoch) {
                                Err("The page changed or WebView2 could not read it.".into())
                            } else if value.len() > 2 * 1024 * 1024 {
                                Err("WebView2 returned an oversized capture.".into())
                            } else {
                                serde_json::from_str(&value)
                                    .map_err(|_| "WebView2 returned an invalid capture.".into())
                            };
                            if let Some(sender) = callback_sender
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .take()
                            {
                                let _ = sender.send(value);
                            }
                            Ok(())
                        },
                    )),
                )
            })
        };
        if result.is_err() {
            if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = sender.send(Err(
                    "WebView2 capture is unavailable. Update the WebView2 Runtime.".into(),
                ));
            }
        }
    })
    .map_err(|_| "The original webpage is no longer open.")?;
    receiver
        .await
        .map_err(|_| "The original webpage closed during capture.".to_string())?
}

fn frame(value: &Value, request: &PageRequest) -> Result<String, String> {
    let frame = &value["frameTree"]["frame"];
    let actual = frame["url"].as_str().and_then(|s| url::Url::parse(s).ok());
    if actual.as_ref()
        != Some(
            &*request
                .current_url
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        )
    {
        return Err("The main webpage changed before capture.".into());
    }
    frame["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or("WebView2 did not return a main frame.".into())
}

pub(super) async fn capture(
    view: tauri::Webview,
    request: Arc<PageRequest>,
    epoch: u64,
) -> Result<String, String> {
    let before = cdp(
        &view,
        "Page.getFrameTree",
        json!({}),
        request.clone(),
        epoch,
    )
    .await?;
    let id = frame(&before, &request)?;
    let loader = before["frameTree"]["frame"]["loaderId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("WebView2 did not identify the loaded document.")?
        .to_string();
    let world = cdp(
        &view,
        "Page.createIsolatedWorld",
        json!({"frameId":id,"worldName":"scholay.capture.v1","grantUniveralAccess":false}),
        request.clone(),
        epoch,
    )
    .await?;
    let context = world["executionContextId"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("Could not create a safe capture context.")?;
    let result = cdp(&view, "Runtime.evaluate", json!({"expression":CAPTURE_SCRIPT,"contextId":context,"returnByValue":true,"awaitPromise":false,"silent":true,"timeout":6000}), request.clone(), epoch).await?;
    if result.get("exceptionDetails").is_some() {
        return Err("The webpage could not be captured safely.".into());
    }
    let raw = result["result"]["value"]
        .as_str()
        .filter(|s| s.len() <= 1_048_576)
        .ok_or("The webpage did not return a bounded text capture.")?
        .to_string();
    let after = cdp(
        &view,
        "Page.getFrameTree",
        json!({}),
        request.clone(),
        epoch,
    )
    .await?;
    if id != frame(&after, &request)?
        || after["frameTree"]["frame"]["loaderId"] != loader
        || !active(&request, epoch)
    {
        return Err("The page changed during capture.".into());
    }
    // The shared caller also validates URL, readyState and navigation epoch.
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_expected_main_frame_is_accepted() {
        let request = super::super::tests::capture_request();
        let expected = request.current_url.lock().unwrap().to_string();
        assert_eq!(
            frame(
                &json!({"frameTree":{"frame":{"id":"main","url":expected}}}),
                &request
            )
            .unwrap(),
            "main"
        );
        assert!(frame(
            &json!({"frameTree":{"frame":{"id":"main","url":"https://other.example/"}}}),
            &request
        )
        .is_err());
        assert!(frame(&json!({}), &request).is_err());
    }
}
