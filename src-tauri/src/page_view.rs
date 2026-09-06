//! In-app original-page view (issue #49).
//!
//! A child webview overlaid on the main window's reading area, so feeds that
//! only ship a summary — or sites that refuse to be framed via
//! `X-Frame-Options` (V2EX, most news/community sites) — still render inside
//! Papr. An `<iframe>` cannot do this: the remote server rejects the frame and
//! the browser gives no reliable failure signal across origins. A native child
//! webview is a real WebView, so framing headers do not apply.
//!
//! The child webview is NOT in the DOM — it floats above the main webview — so
//! the frontend measures the reading area and feeds us logical (CSS-px) bounds,
//! and re-sends them whenever the window resizes.
//!
//! Security: capabilities/default.json grants only the local `main` webview,
//! not its whole window or the `page-view` child. No remote origins are
//! granted capabilities; remote pages cannot invoke the app's backend IPC.
//!
//! Built on Tauri's `unstable` child-webview API; see `Cargo.toml`.

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

/// Label of the single original-page child webview.
const LABEL: &str = "page-view";
const STATUS_EVENT: &str = "page-view-status";
#[cfg(target_os = "macos")]
const MACOS_DESKTOP_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
// Serialize open/close/history IPC operations and invalidate callbacks from
// destroyed views, including popup work queued before an article switch.
static VIEW_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACTIVE_INSTANCE: AtomicU64 = AtomicU64::new(0);
static ACTIVE_REQUEST: Mutex<Option<Arc<PageRequest>>> = Mutex::new(None);

#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PagePhase {
    Loading,
    Loaded,
    Blocked,
    Download,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct PageViewStatus {
    request_id: String,
    url: String,
    phase: PagePhase,
}

struct PageRequest {
    instance: u64,
    request_id: String,
    // Only on_page_load updates this main-page URL. on_navigation also sees
    // iframe candidates and must never use them as the displayed address.
    current_url: Mutex<url::Url>,
    initial_url: url::Url,
    navigation_epoch: AtomicU64,
    loaded: AtomicBool,
}

impl PageRequest {
    fn is_active(&self) -> bool {
        ACTIVE_INSTANCE.load(Ordering::Acquire) == self.instance
    }

    fn payload(&self, phase: PagePhase, candidate: Option<&url::Url>) -> PageViewStatus {
        let current = self.current_url.lock().unwrap_or_else(|e| e.into_inner());
        // A blocked file/data/javascript URL must never be exposed to the UI.
        // Downloads can report a safe HTTP URL without replacing current_url.
        let url = if matches!(phase, PagePhase::Loading | PagePhase::Download) {
            candidate
                .filter(|url| is_original_page_url(url))
                .unwrap_or(&current)
        } else {
            &current
        };
        PageViewStatus {
            request_id: self.request_id.clone(),
            url: url.to_string(),
            phase,
        }
    }
}

fn status_target() -> EventTarget {
    // Do not use emit() or the shared window label: a remote child webview
    // must never receive events intended for the trusted application UI.
    EventTarget::Webview {
        label: "main".into(),
    }
}

fn emit_status(app: &AppHandle, request: &PageRequest, phase: PagePhase, url: Option<&url::Url>) {
    if request.is_active() {
        let _ = app.emit_to(status_target(), STATUS_EVENT, request.payload(phase, url));
    }
}

fn queue_navigation(app: AppHandle, request: Arc<PageRequest>, url: url::Url) {
    // run_on_main_thread executes immediately on the UI thread. Start from
    // the async runtime so the navigation is queued after the current native
    // delegate returns, avoiding reentrant WKWebView/event-loop access.
    tauri::async_runtime::spawn(async move {
        let _operation = VIEW_OPERATION.lock().await;
        if !request.is_active() {
            return;
        }
        let app_for_main = app.clone();
        let request_for_main = request.clone();
        if app
            .run_on_main_thread(move || {
                // A closed view's pending task must not navigate its replacement.
                if !request_for_main.is_active() {
                    return;
                }
                if let Some(view) = app_for_main.get_webview(LABEL) {
                    if view.navigate(url).is_err() {
                        emit_status(&app_for_main, &request_for_main, PagePhase::Blocked, None);
                    }
                }
            })
            .is_err()
        {
            emit_status(&app, &request, PagePhase::Blocked, None);
        }
    });
}

fn is_original_page_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_bilibili_host(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("bilibili.com" | "b23.tv"))
        || url
            .host_str()
            .is_some_and(|host| host.ends_with(".bilibili.com") || host.ends_with(".b23.tv"))
}

#[cfg(target_os = "macos")]
fn page_view_user_agent(url: &url::Url) -> Option<&'static str> {
    is_bilibili_host(url).then_some(MACOS_DESKTOP_SAFARI_USER_AGENT)
}

#[cfg(not(target_os = "macos"))]
fn page_view_user_agent(_url: &url::Url) -> Option<&'static str> {
    None
}

fn parse_url(url: &str) -> Result<url::Url, String> {
    let mut parsed = url::Url::parse(url).map_err(|_| "Invalid original-page URL.".to_string())?;
    if !is_original_page_url(&parsed) {
        return Err(
            "Original pages must use HTTP or HTTPS without embedded credentials.".to_string(),
        );
    }
    // These RSS feeds still publish HTTP links. The installed WKWebView can
    // stay blank before following their HTTPS redirect, although verified
    // HTTPS documents respond promptly. Skip that stalled entry point only
    // for these verified exact hosts at their default HTTP port. Preserve the
    // route/query/fragment and never rewrite the stored source URL.
    if parsed.scheme() == "http"
        && matches!(
            parsed.host_str(),
            Some("news.sciencenet.cn" | "talent.sciencenet.cn")
        )
        && parsed.port_or_known_default() == Some(80)
    {
        parsed
            .set_port(None)
            .map_err(|_| "Invalid original-page port.".to_string())?;
        parsed
            .set_scheme("https")
            .map_err(|_| "Invalid original-page scheme.".to_string())?;
    }
    Ok(parsed)
}

fn history_script(direction: &str) -> Result<&'static str, String> {
    match direction {
        "back" => Ok("window.history.back();"),
        "forward" => Ok("window.history.forward();"),
        _ => Err("History direction must be back or forward.".into()),
    }
}

/// Show the original page at `url` over the given reading-area rectangle.
/// Each open creates a fresh view whose callbacks capture this request ID.
#[tauri::command]
pub async fn open_page_view(
    app: AppHandle,
    url: String,
    request_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    if request_id.is_empty() || request_id.len() > 256 || request_id.chars().any(char::is_control) {
        return Err("Invalid original-page request ID.".into());
    }
    let _operation = VIEW_OPERATION.lock().await;
    let instance = ACTIVE_INSTANCE.fetch_add(1, Ordering::AcqRel) + 1;
    let request = Arc::new(PageRequest {
        instance,
        request_id,
        current_url: Mutex::new(parsed.clone()),
        initial_url: parsed.clone(),
        navigation_epoch: AtomicU64::new(0),
        loaded: AtomicBool::new(false),
    });
    *ACTIVE_REQUEST.lock().unwrap_or_else(|e| e.into_inner()) = Some(request.clone());
    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

    if let Some(view) = app.get_webview(LABEL) {
        view.close()
            .map_err(|_| "Could not close the previous original page.".to_string())?;
    }

    // `get_window` / `add_child` are part of the `unstable` feature. The main
    // WebviewWindow's underlying Window shares its "main" label.
    let window = app.get_window("main").ok_or("main window not found")?;
    // Apply the same rule after opening, including redirects and page links:
    // this view must never navigate into local files or the app's own origin.
    let navigation_app = app.clone();
    let navigation_request = request.clone();
    let popup_app = app.clone();
    let popup_request = request.clone();
    let load_app = app.clone();
    let load_request = request.clone();
    let download_app = app.clone();
    let download_request = request.clone();
    // WKWebView's default UA omits the Safari version/product tokens. Bilibili
    // treats that otherwise-current WebKit engine as an obsolete browser and
    // can redirect valid links to its download fallback. Keep the override
    // narrow: it follows this webview through Bilibili redirects, while every
    // unrelated publisher retains the native default UA.
    let user_agent = page_view_user_agent(&parsed);
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(parsed));
    if let Some(user_agent) = user_agent {
        builder = builder.user_agent(user_agent);
    }
    let builder = builder
        .on_navigation(move |url| {
            if !navigation_request.is_active() {
                return false;
            }
            let allowed = is_original_page_url(url);
            if !allowed {
                emit_status(
                    &navigation_app,
                    &navigation_request,
                    PagePhase::Blocked,
                    None,
                );
            }
            // This callback cannot distinguish a subframe: it is strictly a
            // URL safety gate, never a main-view redirect or address update.
            allowed
        })
        .on_new_window(move |url, _features| {
            if !popup_request.is_active() {
                return NewWindowResponse::Deny;
            }
            let Ok(url) = parse_url(url.as_str()) else {
                emit_status(&popup_app, &popup_request, PagePhase::Blocked, None);
                return NewWindowResponse::Deny;
            };
            // A popup promoted to this main view has an explicit destination.
            // Start UI timeout tracking before navigation, even if WebKit
            // fails before committing; Finished is the only loaded signal.
            emit_status(&popup_app, &popup_request, PagePhase::Loading, Some(&url));
            queue_navigation(popup_app.clone(), popup_request.clone(), url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |_view, payload| {
            if !load_request.is_active() {
                return;
            }
            if !is_original_page_url(payload.url()) {
                emit_status(&load_app, &load_request, PagePhase::Blocked, None);
                return;
            }
            *load_request
                .current_url
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = payload.url().clone();
            let phase = match payload.event() {
                PageLoadEvent::Started => {
                    load_request.loaded.store(false, Ordering::Release);
                    load_request.navigation_epoch.fetch_add(1, Ordering::AcqRel);
                    PagePhase::Loading
                }
                PageLoadEvent::Finished => {
                    load_request.loaded.store(true, Ordering::Release);
                    PagePhase::Loaded
                }
            };
            emit_status(&load_app, &load_request, phase, None);
        })
        .on_download(move |_view, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                if is_original_page_url(&url) {
                    emit_status(
                        &download_app,
                        &download_request,
                        PagePhase::Download,
                        Some(&url),
                    );
                } else {
                    emit_status(&download_app, &download_request, PagePhase::Blocked, None);
                }
            }
            // No automatic downloads, destination access, or execution.
            false
        });
    emit_status(&app, &request, PagePhase::Loading, None);
    let view = window
        .add_child(builder, position, size)
        .map_err(|_| "Could not open the original-page webview.".to_string())?;
    if !visible {
        view.hide()
            .map_err(|_| "Could not hide the original-page webview.".to_string())?;
    }
    Ok(())
}

/// Reposition/resize the open page view (window resized, sidebar toggled, …).
/// No-op when the view isn't open.
#[tauri::command]
pub async fn set_page_view_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        view.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show or hide the open page view without tearing it down. A transient
/// overlay (context menu, modal, AI drawer) only needs the native webview out
/// of the way for a moment — hiding keeps the loaded page alive, so dismissing
/// the overlay reveals it instantly instead of reloading the whole page.
/// No-op when the view isn't open.
#[tauri::command]
pub async fn set_page_view_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        if visible {
            view.show().map_err(|e| e.to_string())?;
        } else {
            view.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Tear down the page view (left web mode, switched away, reader unmounted).
#[tauri::command]
pub async fn close_page_view(app: AppHandle) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    ACTIVE_INSTANCE.fetch_add(1, Ordering::AcqRel);
    *ACTIVE_REQUEST.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(view) = app.get_webview(LABEL) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Only fixed history actions are accepted; this is not a JavaScript runner.
#[tauri::command]
pub async fn page_view_navigate_history(app: AppHandle, direction: String) -> Result<(), String> {
    let script = history_script(&direction)?;
    let _operation = VIEW_OPERATION.lock().await;
    let view = app
        .get_webview(LABEL)
        .ok_or("Original page view is not open.")?;
    view.eval(script)
        .map_err(|_| "Could not navigate original-page history.".into())
}

#[tauri::command]
pub async fn page_view_reload(app: AppHandle) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    let view = app
        .get_webview(LABEL)
        .ok_or("Original page view is not open.")?;
    view.reload()
        .map_err(|_| "Could not reload the original page.".into())
}

// Fixed read-only script, executed in an isolated browser world, in the main
// frame only. It neither executes page-provided instructions nor reads forms,
// credentials, cookies, storage, frame documents, or shadow roots. Visibility
// checks exclude hidden DOM; off-screen rendered article paragraphs are kept.
const CAPTURE_SCRIPT: &str = r#"(() => {
  const safeSlice = (text, limit) => {
    const part = text.slice(0, limit);
    const last = part.charCodeAt(part.length - 1);
    return last >= 0xD800 && last <= 0xDBFF ? part.slice(0, -1) : part;
  };
  const scienceNet = ['news.sciencenet.cn', 'talent.sciencenet.cn'].includes(location.hostname);
  const excluded = 'script,style,noscript,template,iframe,frame,object,embed,input,textarea,select,button,form,[contenteditable],[hidden],[aria-hidden="true"],nav,aside,footer,[role="navigation"],[role="dialog"],[role="contentinfo"],#site-footer,.site-footer' + (scienceNet ? ',#footer' : '');
  const visible = el => {
    if (el.closest(excluded)) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0') return false;
    }
    return el.getClientRects().length > 0;
  };
  const talentArticle = location.hostname === 'talent.sciencenet.cn' ? document.querySelector('div#showtable') : null;
  const exactArticle = talentArticle && visible(talentArticle) ? talentArticle : null;
  const candidates = Array.from(document.querySelectorAll('[itemprop="articleBody"],article,main,[role="main"],#article,.article-content,.article_content,.content_detail,#content'));
  const score = el => el.querySelectorAll('p,li,td,th,h1,h2,h3,blockquote,pre').length;
  const root = exactArticle || candidates.filter(visible).sort((a,b) => score(b) - score(a))[0] || document.body;
  // This verified site puts the publication date/location in the preceding
  // table row, outside its article container. Retain that rendered metadata.
  const precedingRow = exactArticle?.closest('tr')?.previousElementSibling;
  const metadata = precedingRow?.tagName === 'TR' ? precedingRow : null;
  const parts = []; let length = 0, visited = 0, truncated = false;
  const start = performance.now();
  function append(text) {
    if (length >= 60000) { truncated = true; return; }
    const part = safeSlice(text, 60000 - length);
    if (part.length !== text.length) truncated = true;
    parts.push(part); length += part.length;
  }
  function visit(node) {
    if (++visited > 30000 || performance.now() - start > 2000 || length >= 60000) { truncated = true; return; }
    if (node.nodeType === Node.TEXT_NODE) {
      append((node.textContent || '').replace(/\s+/g, ' ')); return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || !visible(node)) return;
    const tag = node.tagName.toLowerCase();
    const block = /^(p|div|section|article|main|h[1-6]|ul|ol|li|table|tr|blockquote|pre)$/.test(tag);
    if (block || tag === 'br') append('\n');
    if (tag === 'li') append('- ');
    const beforeChildren = length;
    for (const child of node.childNodes) {
      visit(child);
      if (truncated) break;
    }
    if (tag === 'a' && length > beforeChildren && node.hasAttribute('href')) {
      try {
        const link = new URL(node.getAttribute('href') || '', location.href);
        if (/^https?:$/.test(link.protocol) && !link.username && !link.password) append(' <' + link.href + '>');
      } catch (_) {}
    }
    if (tag === 'td' || tag === 'th') append('\t');
    if (block) append('\n');
  }
  if (metadata) visit(metadata);
  if (root) visit(root);
  // A separate, inert markup snapshot retains document structure and image
  // positions. Only allowlisted markup is serialized; nothing is executed or
  // fetched, and form values/session data are never inspected.
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  let htmlSize=0, htmlNodes=0; const htmlStart=performance.now();
  const safeUrl = raw => { try {const u=new URL(raw,location.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:'';}catch(_){return '';} };
  function markup(node) {
    if (++htmlNodes>30000 || htmlSize>180000 || performance.now()-htmlStart>1500) {truncated=true;return '';}
    if (node.nodeType===Node.TEXT_NODE) {const t=esc(node.textContent||'');htmlSize+=t.length;return t;}
    if (node.nodeType!==Node.ELEMENT_NODE || !visible(node)) return '';
    const tag=node.tagName.toLowerCase();
    if (tag==='img') {
      const url=safeUrl(node.getAttribute('data-src')||node.currentSrc||node.getAttribute('src')||'');
      const out=url?'<img src="'+esc(url)+'" alt="'+esc(node.getAttribute('alt')||'')+'">':'';htmlSize+=out.length;return out;
    }
    const children=Array.from(node.childNodes).map(markup).join('');
    if (tag==='a') {const url=safeUrl(node.getAttribute('href')||'');return url?'<a href="'+esc(url)+'">'+children+'</a>':children;}
    if (!/^(p|div|section|article|main|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code|strong|b|em|i|del|figure|figcaption|br|hr)$/.test(tag)) return children;
    return '<'+tag+'>'+children+'</'+tag+'>';
  }
  const html=(metadata?markup(metadata):'')+(root?markup(root):'');
  return JSON.stringify({url: location.href, title: safeSlice(document.title,1000), readyState: document.readyState,
    html,
    text: parts.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim(), truncated: truncated || document.title.length > 1000,
    bodyFallback: root === document.body, hasMedia: !!root?.querySelector('img,canvas,video,iframe,object,embed')});
})()"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedDom {
    pub url: String,
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub html: String,
    pub truncated: bool,
    pub body_fallback: bool,
    pub has_media: bool,
    ready_state: String,
}

fn capture_matches(request: &PageRequest, request_id: &str, initial_url: &url::Url) -> bool {
    request.is_active()
        && request.request_id == request_id
        && &request.initial_url == initial_url
        && request.loaded.load(Ordering::Acquire)
}

fn validate_snapshot(raw: &str, request: &PageRequest, epoch: u64) -> Result<CapturedDom, String> {
    if raw.len() > 1_048_576 {
        return Err("The rendered page is too large to capture safely.".into());
    }
    let snapshot: CapturedDom = serde_json::from_str(raw)
        .map_err(|_| "The current page did not return readable article text.".to_string())?;
    let actual = url::Url::parse(&snapshot.url)
        .map_err(|_| "The current page has an invalid source URL.".to_string())?;
    if !request.is_active()
        || !request.loaded.load(Ordering::Acquire)
        || request.navigation_epoch.load(Ordering::Acquire) != epoch
        || !is_original_page_url(&actual)
        || actual
            != *request
                .current_url
                .lock()
                .unwrap_or_else(|e| e.into_inner())
        || snapshot.ready_state != "complete"
    {
        return Err("The page changed or is still loading. Capture it again when ready.".into());
    }
    if snapshot.text.chars().filter(|c| !c.is_whitespace()).count() < 120 {
        return Err("The rendered page has too little article text. Wait for the full page or open the article itself.".into());
    }
    Ok(snapshot)
}

/// Capture the actual currently loaded main-frame DOM, never a URL re-fetch.
/// The article's stored source URL binds the capture to the view's original
/// request; a followed link keeps its actual URL in the resulting provenance.
pub(crate) async fn capture_loaded_page(
    app: &AppHandle,
    request_id: &str,
    article_url: &str,
) -> Result<CapturedDom, String> {
    let initial_url = parse_url(article_url)?;
    let request = ACTIVE_REQUEST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("Open this article in Web mode before capturing it.")?;
    if !capture_matches(&request, request_id, &initial_url) {
        return Err("The article or page changed, or has not finished loading. Open its Web view and try again.".into());
    }
    let epoch = request.navigation_epoch.load(Ordering::Acquire);
    let view = app
        .get_webview(LABEL)
        .ok_or("The original page is no longer open.")?;
    let raw = native_capture(view, request.clone(), epoch).await?;
    validate_snapshot(&raw, &request, epoch)
}

#[cfg(target_os = "macos")]
async fn native_capture(
    view: tauri::Webview,
    request: Arc<PageRequest>,
    epoch: u64,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    if !objc2::available!(macos = 11.0) {
        return Err("Capturing rendered pages requires macOS 11 or later.".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    view.with_webview(move |platform| {
        // Check before reading anything: a queued callback must not extract a
        // replacement article merely because it reused the page-view label.
        if !request.is_active() || request.navigation_epoch.load(Ordering::Acquire) != epoch {
            let _ = sender.send(Err("The page changed during capture. Please try again.".into()));
            return;
        }
        let native_matches = unsafe {
            let wk: &WKWebView = &*platform.inner().cast::<WKWebView>();
            let actual = wk.URL().and_then(|url| url.absoluteString())
                .and_then(|url| url::Url::parse(&url.to_string()).ok());
            !wk.isLoading() && actual.as_ref() == Some(&*request.current_url.lock().unwrap_or_else(|e| e.into_inner()))
        };
        if !request.is_active() || request.navigation_epoch.load(Ordering::Acquire) != epoch || !native_matches {
            let _ = sender.send(Err("The page changed or is still loading. Capture it again when ready.".into()));
            return;
        }
        let send = Mutex::new(Some(sender));
        let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = if !request.is_active() || request.navigation_epoch.load(Ordering::Acquire) != epoch {
                Err("The page changed during capture. Please try again.".into())
            } else if !error.is_null() {
                Err("The current page could not be read. Wait for it to finish loading and try again.".into())
            } else {
                // WebKit owns the Objective-C result until this callback ends.
                // Only an owned, bounded Rust string leaves the main thread.
                unsafe { value.as_ref() }.and_then(|value| value.downcast_ref::<NSString>())
                    .filter(|value| value.len() <= 512_000)
                    .map(|value| value.to_string())
                    .ok_or_else(|| "The page returned no readable capture.".into())
            };
            if let Some(sender) = send.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = sender.send(result);
            }
        });
        let Some(mtm) = MainThreadMarker::new() else { return };
        // Tauri guarantees with_webview runs on the main thread. None frame
        // means main frame; defaultClientWorld prevents page script overrides
        // from taking over our fixed extraction code or completion transport.
        unsafe {
            let wk: &WKWebView = &*platform.inner().cast::<WKWebView>();
            let world = WKContentWorld::defaultClientWorld(mtm);
            wk.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(CAPTURE_SCRIPT), None, &world, Some(&callback),
            );
        }
    }).map_err(|_| "The original page is no longer available.".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(8), receiver)
        .await
        .map_err(|_| {
            "Reading the rendered page timed out. Wait for the page and try again.".to_string()
        })?
        .map_err(|_| "The original page closed during capture.".to_string())?
}

#[cfg(windows)]
#[path = "page_capture_windows.rs"]
mod windows_capture;

#[cfg(all(windows, feature = "windows-smoke"))]
pub(crate) async fn capture_smoke_fixture(view: tauri::Webview) -> Result<CapturedDom, String> {
    let url = view.url().map_err(|e| e.to_string())?;
    // This entry point is compiled only into the opt-in test executable.
    if url.host_str() != Some("127.0.0.1") { return Err("Smoke fixtures must be local.".into()); }
    let instance = ACTIVE_INSTANCE.fetch_add(1, Ordering::AcqRel) + 1;
    let request = Arc::new(PageRequest { instance, request_id: "synthetic".into(), current_url: Mutex::new(url.clone()), initial_url: url, navigation_epoch: AtomicU64::new(0), loaded: AtomicBool::new(true) });
    let raw = native_capture(view, request.clone(), 0).await?;
    validate_snapshot(&raw, &request, 0)
}

#[cfg(windows)]
async fn native_capture(
    view: tauri::Webview,
    request: Arc<PageRequest>,
    epoch: u64,
) -> Result<String, String> {
    tokio::time::timeout(std::time::Duration::from_secs(12), windows_capture::capture(view, request, epoch))
        .await.map_err(|_| "Reading the rendered page timed out. Try again when the page is ready.".to_string())?
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn native_capture(
    _view: tauri::Webview,
    _request: Arc<PageRequest>,
    _epoch: u64,
) -> Result<String, String> {
    Err("Capturing the rendered original page is currently supported on macOS and Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn capture_request() -> PageRequest {
        PageRequest {
            instance: ACTIVE_INSTANCE.load(Ordering::Acquire),
            request_id: "capture-fixture".into(),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(5),
            loaded: AtomicBool::new(true),
        }
    }

    fn snapshot_json(url: &str, text: &str, ready: &str) -> String {
        serde_json::json!({"url":url,"title":"Fixture","text":text,"readyState":ready,"truncated":false,"bodyFallback":false,"hasMedia":false}).to_string()
    }

    #[test]
    fn captured_page_is_bound_to_article_request_url_epoch_and_loaded_state() {
        let request = capture_request();
        let initial = parse_url("https://example.com/article").unwrap();
        assert!(capture_matches(&request, "capture-fixture", &initial));
        assert!(!capture_matches(&request, "old-request", &initial));
        assert!(!capture_matches(
            &request,
            "capture-fixture",
            &parse_url("https://example.com/other").unwrap()
        ));
        let text = "Rendered source facts and conditions. ".repeat(20);
        let good = snapshot_json("https://example.com/article", &text, "complete");
        assert_eq!(validate_snapshot(&good, &request, 5).unwrap().text, text);
        assert!(validate_snapshot(&good, &request, 4).is_err());
        assert!(validate_snapshot(
            &snapshot_json("https://example.com/redirect", &text, "complete"),
            &request,
            5
        )
        .is_err());
        assert!(validate_snapshot(
            &snapshot_json("https://example.com/article", &text, "loading"),
            &request,
            5
        )
        .is_err());
        request.loaded.store(false, Ordering::Release);
        assert!(!capture_matches(&request, "capture-fixture", &initial));
        assert!(validate_snapshot(&good, &request, 5).is_err());
    }

    #[test]
    fn capture_rejects_blank_short_invalid_and_non_web_results_without_echoing_data() {
        let request = capture_request();
        for raw in [
            "PRIVATE-SENSITIVE-RAW".to_string(),
            snapshot_json("https://example.com/article", "short", "complete"),
            snapshot_json("file:///PRIVATE", &"data ".repeat(100), "complete"),
        ] {
            let error = validate_snapshot(&raw, &request, 5)
                .err()
                .expect("reject invalid capture");
            assert!(!error.contains("PRIVATE"));
        }
    }

    #[test]
    fn fixed_capture_script_has_no_network_credentials_frames_or_ipc_access() {
        for forbidden in [
            "document.cookie",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            ".contentDocument",
            ".contentWindow",
            "fetch(",
            "XMLHttpRequest",
            "__TAURI",
            "postMessage",
            ".value",
        ] {
            assert!(
                !CAPTURE_SCRIPT.contains(forbidden),
                "forbidden capture surface: {forbidden}"
            );
        }
        assert!(CAPTURE_SCRIPT.contains("input,textarea,select,button,form,[contenteditable]"));
        assert!(CAPTURE_SCRIPT.contains("iframe,frame,object,embed"));
        assert!(CAPTURE_SCRIPT.contains("safeSlice"));
        assert!(!CAPTURE_SCRIPT.contains("link.href.slice"));
        assert!(CAPTURE_SCRIPT.contains("location.hostname === 'talent.sciencenet.cn'"));
        assert!(CAPTURE_SCRIPT.contains("document.querySelector('div#showtable')"));
        assert!(CAPTURE_SCRIPT.contains("if (metadata) visit(metadata)"));
    }

    #[test]
    fn original_pages_accept_http_and_https() {
        for candidate in [
            "http://example.com/article",
            "https://example.com/article?lang=zh#body",
            "HTTPS://example.com/article",
        ] {
            let parsed = parse_url(candidate).unwrap();
            assert!(is_original_page_url(&parsed));
        }
    }

    #[test]
    fn bilibili_compatibility_matches_only_owned_hosts() {
        for candidate in [
            "https://bilibili.com/",
            "https://www.bilibili.com/video/BV1example",
            "https://search.bilibili.com/all?keyword=research",
            "https://B23.TV/example",
            "https://sub.b23.tv/example",
        ] {
            assert!(is_bilibili_host(&parse_url(candidate).unwrap()));
        }
        for candidate in [
            "https://notbilibili.com/",
            "https://bilibili.com.evil.example/",
            "https://b23.tv.evil.example/",
            "https://news.sciencenet.cn/article",
            "https://mp.weixin.qq.com/s/example",
        ] {
            assert!(!is_bilibili_host(&parse_url(candidate).unwrap()));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bilibili_uses_a_desktop_safari_identity_only() {
        let user_agent =
            page_view_user_agent(&parse_url("https://www.bilibili.com/v/popular/all").unwrap())
                .unwrap();
        assert!(user_agent.contains("Version/18.6"));
        assert!(user_agent.contains("Safari/605.1.15"));
        assert!(!user_agent.contains("Chrome/"));
        assert!(!user_agent.contains('\r'));
        assert!(!user_agent.contains('\n'));
        assert_eq!(
            page_view_user_agent(&parse_url("https://news.sciencenet.cn/article").unwrap()),
            None
        );
    }

    #[test]
    fn original_pages_reject_non_web_schemes_on_open_and_navigation() {
        for candidate in [
            "file:///tmp/example.html",
            "data:text/html,<h1>Example</h1>",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
            "about:blank",
            "blob:https://example.com/example-id",
            "mailto:test@example.com",
            "ftp://example.com/article",
        ] {
            let parsed = url::Url::parse(candidate).unwrap();
            assert!(!is_original_page_url(&parsed));
            assert!(parse_url(candidate).is_err());
        }
    }

    #[test]
    fn original_pages_reject_invalid_or_relative_urls_without_echoing_input() {
        for candidate in ["", "/article", "https://", "not-a-url-with-private-query"] {
            assert_eq!(
                parse_url(candidate).unwrap_err(),
                "Invalid original-page URL."
            );
        }
    }

    #[test]
    fn sciencenet_default_http_upgrades_without_changing_path_query_or_fragment() {
        for candidate in [
            "http://news.sciencenet.cn/htmlnews/2026/8/123.shtm?from=rss#body",
            "http://news.sciencenet.cn:80/htmlnews/2026/8/123.shtm?from=rss#body",
        ] {
            assert_eq!(
                parse_url(candidate).unwrap().as_str(),
                "https://news.sciencenet.cn/htmlnews/2026/8/123.shtm?from=rss#body"
            );
        }
    }

    #[test]
    fn sciencenet_upgrade_is_exact_host_and_default_port_only() {
        for candidate in [
            "http://news.sciencenet.cn:8080/article",
            "http://news.sciencenet.cn.evil.example/article",
            "http://talent.sciencenet.cn:8080/index.php?s=Info/index/id/24749",
            "http://talent.sciencenet.cn.evil.example/article",
            "http://www.sciencenet.cn/article",
            "http://example.com/article",
            "https://news.sciencenet.cn/article",
        ] {
            assert_eq!(parse_url(candidate).unwrap().as_str(), candidate);
        }
    }

    #[test]
    fn talent_legacy_rss_link_opens_verified_https_route_directly() {
        for candidate in [
            "http://talent.sciencenet.cn/index.php?s=Info/index/id/24749",
            "http://talent.sciencenet.cn:80/index.php?s=Info/index/id/24749",
        ] {
            assert_eq!(
                parse_url(candidate).unwrap().as_str(),
                "https://talent.sciencenet.cn/index.php?s=Info/index/id/24749"
            );
        }
        assert_eq!(
            parse_url(
                "http://talent.sciencenet.cn/index.php?s=Info/index/id/24749&from=rss#requirements"
            )
            .unwrap()
            .as_str(),
            "https://talent.sciencenet.cn/index.php?s=Info/index/id/24749&from=rss#requirements"
        );
    }

    #[test]
    fn embedded_credentials_are_rejected_without_echoing_them() {
        for candidate in [
            "https://private-user:private-password@example.com/article",
            "http://private-user@news.sciencenet.cn/article",
            "https://:private-password@example.com/article",
        ] {
            assert!(!is_original_page_url(&url::Url::parse(candidate).unwrap()));
            let error = parse_url(candidate).unwrap_err();
            assert!(!error.contains("private-user"));
            assert!(!error.contains("private-password"));
        }
    }

    #[test]
    fn page_status_is_camel_case_and_only_targets_main_webview() {
        assert!(matches!(status_target(), EventTarget::Webview { label } if label == "main"));
        let request = PageRequest {
            instance: 0,
            request_id: "request-17".into(),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(0),
            loaded: AtomicBool::new(true),
        };
        let value = serde_json::to_value(request.payload(PagePhase::Loaded, None)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"requestId":"request-17","url":"https://example.com/article","phase":"loaded"})
        );
    }

    #[test]
    fn blocked_and_download_status_do_not_change_current_page_or_expose_unsafe_urls() {
        let request = PageRequest {
            instance: 0,
            request_id: "request-18".into(),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(0),
            loaded: AtomicBool::new(true),
        };
        for candidate in [
            "file:///private/secret.txt",
            "data:text/html,PRIVATE",
            "javascript:PRIVATE()",
        ] {
            let unsafe_url = url::Url::parse(candidate).unwrap();
            for phase in [PagePhase::Blocked, PagePhase::Download] {
                let value = request.payload(phase, Some(&unsafe_url));
                assert_eq!(value.url, "https://example.com/article");
                assert!(!serde_json::to_string(&value).unwrap().contains("PRIVATE"));
            }
        }
        let download = parse_url("https://example.com/file.pdf").unwrap();
        assert_eq!(
            request.payload(PagePhase::Download, Some(&download)).url,
            download.as_str()
        );
        assert_eq!(
            request.payload(PagePhase::Loading, Some(&download)).url,
            download.as_str()
        );
        assert_eq!(
            request.payload(PagePhase::Blocked, Some(&download)).url,
            "https://example.com/article"
        );
        assert_eq!(
            request.current_url.lock().unwrap().as_str(),
            "https://example.com/article"
        );
    }

    #[test]
    fn history_only_accepts_two_fixed_scripts() {
        assert_eq!(history_script("back").unwrap(), "window.history.back();");
        assert_eq!(
            history_script("forward").unwrap(),
            "window.history.forward();"
        );
        for candidate in ["", "reload", "BACK", "back();alert('private-value')"] {
            let error = history_script(candidate).unwrap_err();
            assert!(!error.contains("private-value"));
        }
    }
}
