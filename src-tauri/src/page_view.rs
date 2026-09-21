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
use std::{collections::HashMap, sync::LazyLock};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

/// Legacy workspace page, isolated from the retained RSS tab pages.
const LABEL: &str = "page-view";
const STATUS_EVENT: &str = "page-view-status";
const ZOOM_EVENT: &str = "page-view-zoom";
const PAGE_ZOOM_CONTROLLER: &str = include_str!("page_zoom.js");
const PAGE_ZOOM_MIN: f64 = 0.3;
const PAGE_ZOOM_MAX: f64 = 3.0;
#[cfg(target_os = "macos")]
const MACOS_DESKTOP_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
// Serialize open/close/history IPC operations and invalidate callbacks from
// destroyed views, including popup work queued before an article switch.
static VIEW_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACTIVE_INSTANCE: AtomicU64 = AtomicU64::new(0);
static PAGES: LazyLock<Mutex<HashMap<String, Arc<PageRequest>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static VISIBLE_PAGE: Mutex<Option<String>> = Mutex::new(None);
static USE_CLOCK: AtomicU64 = AtomicU64::new(0);
const RSS_PAGE_LIMIT: usize = 10;

#[cfg(feature = "reader-tabs-smoke")]
#[path = "reader_tabs_smoke.rs"]
pub mod smoke;

fn page_id(id: Option<&str>) -> Result<&str, String> {
    let id = id.unwrap_or(LABEL);
    if matches!(id, LABEL | "labels-page") || (id.starts_with("rss-") && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) { Ok(id) }
    else { Err("Invalid page instance.".into()) }
}
fn page(id: &str) -> Option<Arc<PageRequest>> {
    PAGES.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
}
fn page_for_request(id: &str) -> Option<Arc<PageRequest>> {
    PAGES.lock().unwrap_or_else(|e| e.into_inner()).values().find(|r| r.request_id == id).cloned()
}
fn pages() -> Vec<Arc<PageRequest>> {
    PAGES.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect()
}
fn refresh_page_address(app: &AppHandle, request: &PageRequest) {
    // History API / hash navigation need not emit a document load. Read the
    // native main-frame address when suspending, reusing or capturing a page.
    if let Some(url) = app.get_webview(&request.view_id).and_then(|view| view.url().ok()).filter(is_original_page_url) {
        let mut current = request.current_url.lock().unwrap_or_else(|e| e.into_inner());
        if *current != url { *current = url; request.navigation_epoch.fetch_add(1, Ordering::AcqRel); }
    }
}
fn activate_page(app: &AppHandle, id: &str) {
    *VISIBLE_PAGE.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.into());
    for request in pages() {
        if request.view_id != id {
            request.presentation.lock().unwrap_or_else(|e| e.into_inner()).visible = false;
            if let Some(view) = app.get_webview(&request.view_id) { let _ = view.hide(); }
        }
    }
}
fn destroy_page(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(request) = page(id) {
        if request.capturing.load(Ordering::Acquire) { return Err("This page is being captured.".into()); }
        request.alive.store(false, Ordering::Release);
        if let Some(view) = app.get_webview(id) {
            if let Err(error) = view.close() { request.alive.store(true, Ordering::Release); return Err(error.to_string()); }
        }
        PAGES.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
    let mut visible = VISIBLE_PAGE.lock().unwrap_or_else(|e| e.into_inner());
    if visible.as_deref() == Some(id) { *visible = None; }
    Ok(())
}
fn eviction_candidate(entries: &[Arc<PageRequest>]) -> Option<String> {
    entries.iter().filter(|r| r.view_id.starts_with("rss-") && !r.capturing.load(Ordering::Acquire) && !r.presentation.lock().unwrap_or_else(|e| e.into_inner()).visible)
        .min_by_key(|r| r.last_used.load(Ordering::Acquire)).map(|r| r.view_id.clone())
}


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
    view_id: String,
    instance: u64,
    request_id: String,
    url: String,
    phase: PagePhase,
}

struct PageRequest {
    view_id: String,
    alive: AtomicBool,
    capturing: AtomicBool,
    last_used: AtomicU64,
    instance: u64,
    request_id: String,
    // Only on_page_load updates this main-page URL. on_navigation also sees
    // iframe candidates and must never use them as the displayed address.
    current_url: Mutex<url::Url>,
    initial_url: url::Url,
    navigation_epoch: AtomicU64,
    loaded: AtomicBool,
    presentation: Mutex<crate::page_theme::Presentation>,
    zoom: Mutex<PageZoom>,
}

impl PageRequest {
    fn is_active(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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
            view_id: self.view_id.clone(),
            instance: self.instance,
            request_id: self.request_id.clone(),
            url: url.to_string(),
            phase,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ZoomMode {
    Fit,
    Manual,
}

#[derive(Clone, Copy)]
struct PageZoom {
    mode: ZoomMode,
    factor: f64,
}

impl Default for PageZoom {
    fn default() -> Self {
        Self {
            mode: ZoomMode::Fit,
            factor: 1.0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageViewZoom {
    view_id: String,
    instance: u64,
    request_id: String,
    factor: f64,
    mode: &'static str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ZoomReadback {
    factor: f64,
    mode: String,
}

fn clamp_zoom_factor(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    (value.clamp(PAGE_ZOOM_MIN, PAGE_ZOOM_MAX) * 100.0).round() / 100.0
}

fn zoom_mode_label(mode: ZoomMode) -> &'static str {
    match mode {
        ZoomMode::Fit => "fit",
        ZoomMode::Manual => "manual",
    }
}

fn parse_zoom_object(raw: &str) -> Option<PageZoom> {
    let parsed: ZoomReadback = serde_json::from_str(raw.trim()).ok()?;
    let mode = match parsed.mode.as_str() {
        "fit" => ZoomMode::Fit,
        "manual" => ZoomMode::Manual,
        _ => return None,
    };
    Some(PageZoom {
        mode,
        factor: clamp_zoom_factor(parsed.factor),
    })
}

fn parse_zoom_readback(raw: &str) -> Option<PageZoom> {
    parse_zoom_object(raw)
        .or_else(|| serde_json::from_str::<String>(raw).ok().as_deref().and_then(parse_zoom_object))
}

fn page_zoom_initialization_script() -> String {
    // The remote document may listen for keys and resize, but it is never
    // granted IPC. Zoom stays inside this isolated controller.
    format!(
        r#"(() => {{
          if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
          if (!window.__scholayPageZoomV1) {{
            window.__scholayPageZoomV1 = ({controller})();
          }}
        }})();"#,
        controller = PAGE_ZOOM_CONTROLLER
    )
}

fn zoom_eval_script(action: &str, factor: f64) -> Result<String, String> {
    let call = match action {
        "in" => "adjust(0.1)".to_string(),
        "out" => "adjust(-0.1)".to_string(),
        "reset" => "reset()".to_string(),
        "fit" => "fit()".to_string(),
        "get" => "read()".to_string(),
        "apply" => format!("set({:.2})", clamp_zoom_factor(factor)),
        _ => return Err("Zoom action must be in, out, reset, fit, or get.".into()),
    };
    Ok(format!(
        r#"(() => {{
          const zoom = window.__scholayPageZoomV1;
          if (!zoom) return '{{"factor":1,"mode":"fit"}}';
          return JSON.stringify(zoom.{call});
        }})();"#
    ))
}

fn emit_zoom(app: &AppHandle, request: &PageRequest, zoom: PageZoom) {
    if request.is_active() {
        let _ = app.emit_to(
            status_target(),
            ZOOM_EVENT,
            PageViewZoom {
                view_id: request.view_id.clone(),
                instance: request.instance,
                request_id: request.request_id.clone(),
                factor: zoom.factor,
                mode: zoom_mode_label(zoom.mode),
            },
        );
    }
}

fn apply_page_zoom(app: &AppHandle, view: &tauri::Webview, request: Arc<PageRequest>) {
    let zoom = *request.zoom.lock().unwrap_or_else(|e| e.into_inner());
    let script = match zoom.mode {
        ZoomMode::Fit => zoom_eval_script("fit", zoom.factor),
        ZoomMode::Manual => zoom_eval_script("apply", zoom.factor),
    };
    let Ok(script) = script else { return };
    let app = app.clone();
    let view = view.clone();
    let _ = view.eval_with_callback(script, move |value| {
        if !request.is_active() {
            return;
        }
        if let Some(next) = parse_zoom_readback(&value) {
            *request.zoom.lock().unwrap_or_else(|e| e.into_inner()) = next;
            emit_zoom(&app, &request, next);
        }
    });
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

fn sync_page_visibility(view: &tauri::Webview, request: Arc<PageRequest>) {
    let current_view = view.clone();
    // Recheck on the UI thread: a late preparation result must not show over
    // a settings dialog or resurrect a view replaced by another article.
    let _ = view.run_on_main_thread(move || {
        if !request.is_active() { return; }
        let show = request.presentation.lock().unwrap_or_else(|e| e.into_inner()).should_show()
            && VISIBLE_PAGE.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(request.view_id.as_str());
        if show { let _ = current_view.show(); }
        else { let _ = current_view.hide(); }
    });
}

fn prepare_page_presentation(view: &tauri::Webview, request: Arc<PageRequest>, dark: bool) {
    let revision = request.presentation.lock().unwrap_or_else(|e| e.into_inner()).begin(dark);
    crate::page_theme::apply_backing(view, dark);
    sync_page_visibility(view, request.clone());
    if !dark {
        // Original colours have no readiness timer, loading gate or engine.
        let _ = view.eval("window.__scholayPageThemeV1?.setEnabled(false);");
        return;
    }
    let view = view.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            if !request.is_active() || !request.presentation.lock().unwrap_or_else(|e| e.into_inner()).pending(revision) { return; }
            let (tx, rx) = tokio::sync::oneshot::channel();
            let tx = Mutex::new(Some(tx));
            let probe_view = view.clone();
            let probe_request = request.clone();
            let submitted = view.run_on_main_thread(move || {
                if !probe_request.is_active() || !probe_request.presentation.lock().unwrap_or_else(|e| e.into_inner()).pending(revision) {
                    return;
                }
                let _ = probe_view.eval_with_callback(crate::page_theme::PREPARE_SCRIPT, move |value| {
                    if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        let _ = tx.send(value);
                    }
                });
            });
            let ready = if submitted.is_ok() {
                matches!(tokio::time::timeout(std::time::Duration::from_millis(300), rx).await, Ok(Ok(value)) if value == "true")
            } else { false };
            // Broken CSS, blocked scripts or a failed navigation must not
            // leave the reading area hidden forever. No unconditional delay
            // on healthy pages: reveal as soon as first-paint CSS is ready.
            if ready || started.elapsed() >= std::time::Duration::from_secs(8) {
                request.presentation.lock().unwrap_or_else(|e| e.into_inner()).finish(revision);
                sync_page_visibility(&view, request);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
    });
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
                if let Some(view) = app_for_main.get_webview(&request_for_main.view_id) {
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

/// Fixed labels-only DOM probe. No article capture or remote IPC grant. Bind
/// before and after evaluation so a late callback cannot read a new workspace.
pub(crate) fn label_auth_view(app: &AppHandle, request_id: &str, source: &crate::label_board::Source) -> Result<tauri::Webview, String> {
    let request = page("labels-page").ok_or("授权页面已关闭")?;
    if request.request_id != request_id || !request.is_active()
        || request.initial_url.as_str() != source.url || !request.loaded.load(Ordering::Acquire) {
        return Err("请等待当前平台授权页面就绪".into());
    }
    let view = app.get_webview(&request.view_id).ok_or("授权页面已关闭")?;
    if !crate::label_board::allowed(source, &view.url().map_err(|_| "无法确认授权页面")?) {
        return Err("请回到当前平台的官方页面保存授权".into());
    }
    Ok(view)
}

pub(crate) async fn inspect_label_page(
    app: AppHandle, request_id: String, source: &crate::label_board::Source, script: String,
) -> Result<String, String> {
    let request = page("labels-page")
        .ok_or("请先打开平台页面")?;
    let initial = url::Url::parse(&source.url).map_err(|_| "平台网址无效")?;
    if request.request_id != request_id || !request.is_active() || request.initial_url != initial
        || !request.loaded.load(Ordering::Acquire) {
        return Err("等待当前平台页面就绪".into());
    }
    let epoch = request.navigation_epoch.load(Ordering::Acquire);
    let view = app.get_webview(&request.view_id).ok_or("平台页面已关闭")?;
    // SPA filters can change the URL without a page-load event. Bind to the
    // actual native URL (not the last load event), including before/after eval.
    let current = view.url().map_err(|_| "无法确认平台页面")?;
    if !crate::label_board::allowed(source, &current) { return Err("请在官方平台页面内操作".into()); }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let probe_request = request.clone();
    let probe_view = view.clone();
    let expected = current.clone();
    view.run_on_main_thread(move || {
        if !probe_request.is_active() || probe_request.navigation_epoch.load(Ordering::Acquire) != epoch
            || probe_view.url().ok().as_ref() != Some(&expected) { return; }
        let _ = probe_view.eval_with_callback(script, move |value| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = tx.send(value); }
        });
    }).map_err(|_| "平台页面不可用")?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(4), rx).await
        .map_err(|_| "平台页面响应较慢")?.map_err(|_| "平台页面已切换")?;
    if !request.is_active() || request.navigation_epoch.load(Ordering::Acquire) != epoch
        || view.url().ok().as_ref() != Some(&current) { return Err("平台页面已切换".into()); }
    Ok(raw)
}

/// Show the original page at `url` over the given reading-area rectangle.
/// Reuse a resident tab, or create a new generation after eviction/retry.
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
    dark_mode: bool,
    view_id: Option<String>,
    resume_url: Option<String>,
    zoom_factor: Option<f64>,
    zoom_mode: Option<String>,
) -> Result<bool, String> {
    let parsed = parse_url(&url)?;
    if request_id.is_empty() || request_id.len() > 256 || request_id.chars().any(char::is_control) {
        return Err("Invalid original-page request ID.".into());
    }
    let id = page_id(view_id.as_deref())?.to_owned();
    let _operation = VIEW_OPERATION.lock().await;
    crate::page_theme::set_dark(dark_mode);
    if let Some(existing) = page(&id) {
        if existing.request_id == request_id && existing.initial_url == parsed {
            if let Some(view) = app.get_webview(&id) {
                refresh_page_address(&app, &existing);
                existing.last_used.store(USE_CLOCK.fetch_add(1, Ordering::AcqRel), Ordering::Release);
                if visible { activate_page(&app, &id); }
                existing.presentation.lock().unwrap_or_else(|e| e.into_inner()).visible = visible;
                view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
                view.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
                prepare_page_presentation(&view, existing.clone(), dark_mode);
                emit_status(&app, &existing, if existing.loaded.load(Ordering::Acquire) { PagePhase::Loaded } else { PagePhase::Loading }, None);
                emit_zoom(&app, &existing, *existing.zoom.lock().unwrap_or_else(|e| e.into_inner()));
                return Ok(true);
            }
        }
        destroy_page(&app, &id)?;
    }
    // The previously visible page is now a background eviction candidate.
    activate_page(&app, &id);
    if id.starts_with("rss-") {
        let entries = pages();
        if entries.iter().filter(|r| r.view_id.starts_with("rss-")).count() >= RSS_PAGE_LIMIT {
            let victim = eviction_candidate(&entries).ok_or("All cached pages are busy.")?;
            let retired = page(&victim).ok_or("Missing cached page.")?;
            refresh_page_address(&app, &retired);
            let url = retired.current_url.lock().unwrap_or_else(|e| e.into_inner()).to_string();
            let zoom = *retired.zoom.lock().unwrap_or_else(|e| e.into_inner());
            destroy_page(&app, &victim)?;
            let _ = app.emit_to(status_target(), "page-view-evicted", serde_json::json!({ "viewId": victim, "requestId": retired.request_id, "instance": retired.instance, "url": url, "factor": zoom.factor, "mode": zoom_mode_label(zoom.mode) }));
        }
    }
    let destination = resume_url.as_deref().map(parse_url).transpose()?.unwrap_or_else(|| parsed.clone());
    let instance = ACTIVE_INSTANCE.fetch_add(1, Ordering::AcqRel) + 1;
    let request = Arc::new(PageRequest {
        view_id: id.clone(),
        alive: AtomicBool::new(true),
        capturing: AtomicBool::new(false),
        last_used: AtomicU64::new(USE_CLOCK.fetch_add(1, Ordering::AcqRel)),
        instance,
        request_id,
        current_url: Mutex::new(destination.clone()),
        initial_url: parsed.clone(),
        navigation_epoch: AtomicU64::new(0),
        loaded: AtomicBool::new(false),
        presentation: Mutex::new(crate::page_theme::Presentation::new(visible, dark_mode)),
        zoom: Mutex::new(PageZoom { mode: if zoom_mode.as_deref() == Some("manual") { ZoomMode::Manual } else { ZoomMode::Fit }, factor: clamp_zoom_factor(zoom_factor.unwrap_or(1.0)) }),
    });
    PAGES.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), request.clone());
    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

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
    let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(destination))
        .initialization_script(crate::page_theme::initialization_script())
        .initialization_script(page_zoom_initialization_script());
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
        .on_page_load(move |view, payload| {
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
                    // Wry reports Started at document commit / ContentLoading,
                    // before the new document paints (not a subframe request).
                    prepare_page_presentation(&view, load_request.clone(), crate::page_theme::is_dark());
                    PagePhase::Loading
                }
                PageLoadEvent::Finished => {
                    // Theme may have changed since this native view was created.
                    // Reconcile on every document, including history/redirects.
                    let _ = view.eval(crate::page_theme::update_script());
                    apply_page_zoom(&load_app, &view, load_request.clone());
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
    // Create dark-mode children outside the visible window until their native
    // backing and preparation gate are in place, avoiding even a blank white
    // frame between add_child and hide. Original mode takes the direct path.
    let initial_position = if dark_mode || !visible { LogicalPosition::new(-width.max(1.0) - 100.0, y) } else { position };
    let view = match window.add_child(builder, initial_position, size) {
        Ok(view) => view,
        Err(_) => { destroy_page(&app, &id)?; return Err("Could not open the original-page webview.".into()); }
    };
    if !visible || dark_mode {
        view.hide()
            .map_err(|_| "Could not hide the original-page webview.".to_string())?;
    }
    if dark_mode || !visible {
        view.set_position(position).map_err(|e| e.to_string())?;
    }
    prepare_page_presentation(&view, request, dark_mode);
    Ok(false)
}

/// All controls target a named page, never an unrelated current tab.
#[tauri::command]
pub async fn set_page_view_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64, view_id: Option<String>, request_id: Option<String>) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    let Some(request) = controlled_page(view_id.as_deref(), request_id.as_deref())? else { return Ok(()) };
    if let Some(view) = app.get_webview(&request.view_id) {
        view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        if request.zoom.lock().unwrap_or_else(|e| e.into_inner()).mode == ZoomMode::Fit { apply_page_zoom(&app, &view, request); }
    }
    Ok(())
}
fn controlled_page(view_id: Option<&str>, request_id: Option<&str>) -> Result<Option<Arc<PageRequest>>, String> {
    let request = page(page_id(view_id)?);
    Ok(request.filter(|r| request_id.is_none_or(|id| id == r.request_id)))
}
#[tauri::command]
pub async fn set_page_view_visible(app: AppHandle, visible: bool, view_id: Option<String>, request_id: Option<String>) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    let Some(request) = controlled_page(view_id.as_deref(), request_id.as_deref())? else { return Ok(()) };
    if let Some(view) = app.get_webview(&request.view_id) {
        if visible { activate_page(&app, &request.view_id); request.last_used.store(USE_CLOCK.fetch_add(1, Ordering::AcqRel), Ordering::Release); }
        refresh_page_address(&app, &request);
        emit_status(&app, &request, if request.loaded.load(Ordering::Acquire) { PagePhase::Loaded } else { PagePhase::Loading }, None);
        request.presentation.lock().unwrap_or_else(|e| e.into_inner()).visible = visible;
        sync_page_visibility(&view, request);
    }
    Ok(())
}
#[tauri::command]
pub async fn close_page_view(app: AppHandle, view_id: Option<String>, request_id: Option<String>) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    if let Some(request) = controlled_page(view_id.as_deref(), request_id.as_deref())? { destroy_page(&app, &request.view_id)?; }
    Ok(())
}
#[tauri::command]
pub async fn page_view_navigate_history(app: AppHandle, direction: String, view_id: Option<String>, request_id: Option<String>) -> Result<(), String> {
    let script = history_script(&direction)?;
    let _operation = VIEW_OPERATION.lock().await;
    let request = controlled_page(view_id.as_deref(), request_id.as_deref())?.ok_or("Original page view is not open.")?;
    let view = app.get_webview(&request.view_id).ok_or("Original page view is not open.")?;
    view.eval(script).map_err(|_| "Could not navigate original-page history.".into())
}
#[tauri::command]
pub async fn page_view_reload(app: AppHandle, view_id: Option<String>, request_id: Option<String>) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    let request = controlled_page(view_id.as_deref(), request_id.as_deref())?.ok_or("Original page view is not open.")?;
    let view = app.get_webview(&request.view_id).ok_or("Original page view is not open.")?;
    view.reload().map_err(|_| "Could not reload the original page.".into())
}

/// A fixed boolean styling command, not a generic script executor. Switching
/// theme preserves page location, scroll position, forms and browser history.
/// Fixed zoom actions only. The remote page never receives IPC or a script
/// built from caller-supplied strings.
#[tauri::command]
pub async fn set_page_view_zoom(app: AppHandle, action: String, view_id: Option<String>, request_id: Option<String>) -> Result<PageViewZoom, String> {
    let _operation = VIEW_OPERATION.lock().await;
    let request = controlled_page(view_id.as_deref(), request_id.as_deref())?.ok_or("Original page view is not open.")?;
    let view = app
        .get_webview(&request.view_id)
        .ok_or("Original page view is not open.")?;
    {
        let mut zoom = request.zoom.lock().unwrap_or_else(|e| e.into_inner());
        match action.as_str() {
            "in" | "out" | "reset" => zoom.mode = ZoomMode::Manual,
            "fit" => zoom.mode = ZoomMode::Fit,
            "get" => {}
            _ => return Err("Zoom action must be in, out, reset, fit, or get.".into()),
        }
        if action == "reset" {
            zoom.factor = 1.0;
        }
    }
    let script = zoom_eval_script(&action, 1.0)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let eval_request = request.clone();
    view.clone().run_on_main_thread(move || {
        if !eval_request.is_active() {
            return;
        }
        let _ = view.eval_with_callback(script, move |value| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(value);
            }
        });
    })
    .map_err(|_| "Could not update original-page zoom.".to_string())?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Original-page zoom timed out.".to_string())?
        .map_err(|_| "Original-page zoom was cancelled.".to_string())?;
    let zoom = parse_zoom_readback(&raw).ok_or("Could not read original-page zoom.")?;
    if request.is_active() {
        *request.zoom.lock().unwrap_or_else(|e| e.into_inner()) = zoom;
        emit_zoom(&app, &request, zoom);
    }
    Ok(PageViewZoom {
        view_id: request.view_id.clone(),
        instance: request.instance,
        request_id: request.request_id.clone(),
        factor: zoom.factor,
        mode: zoom_mode_label(zoom.mode),
    })
}

#[tauri::command]
pub async fn set_page_view_theme(app: AppHandle, dark: bool) -> Result<(), String> {
    let _operation = VIEW_OPERATION.lock().await;
    crate::page_theme::set_dark(dark);
    for request in pages() {
        if let Some(view) = app.get_webview(&request.view_id) { prepare_page_presentation(&view, request, dark); }
    }
    Ok(())
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
  const scienceBlog = location.hostname === 'blog.sciencenet.cn';
  const nstc = ['www.nstc.gov.tw', 'nstc.gov.tw'].includes(location.hostname)
    && location.pathname.startsWith('/folksonomy/detail/');
  const excluded = 'script,style,noscript,template,iframe,frame,object,embed,input,textarea,select,button,form,[contenteditable],[hidden],[aria-hidden="true"],nav,aside,footer,[role="navigation"],[role="dialog"],[role="contentinfo"],#site-footer,.site-footer' + (scienceNet ? ',#footer' : '') + (nstc ? ',a.accessible[accesskey]' : '');
  const visible = el => {
    if (el.closest(excluded)) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0') return false;
    }
    return el.getClientRects().length > 0;
  };
  const talentArticle = location.hostname === 'talent.sciencenet.cn' ? document.querySelector('div#showtable') : null;
  const blogArticle = scienceBlog ? document.querySelector('div#blog_article') : null;
  // NSTC puts the title, related submission links and update date outside
  // #articleContent. Keep its whole article panel, not the surrounding menus
  // (body fallback previously made the first AI chunk almost all navigation).
  const nstcBody = nstc ? document.querySelector('#articleContent') : null;
  const nstcArticle = nstcBody && visible(nstcBody) ? nstcBody.closest('#templateF') : null;
  const exactArticle = [blogArticle, talentArticle, nstcArticle].find(el => el && visible(el)) || null;
  const candidates = Array.from(document.querySelectorAll('[itemprop="articleBody"],article,main,[role="main"],#article,.article-content,.article_content,.content_detail,#content'));
  const score = el => el.querySelectorAll('p,li,td,th,h1,h2,h3,blockquote,pre').length;
  const root = exactArticle || candidates.filter(visible).sort((a,b) => score(b) - score(a))[0] || document.body;
  // This verified site puts the publication date/location in the preceding
  // table row, outside its article container. Retain that rendered metadata.
  const precedingRow = exactArticle?.closest('tr')?.previousElementSibling;
  const metadata = precedingRow?.tagName === 'TR' ? [precedingRow] : [];
  if (root === blogArticle) {
    const header = root.previousElementSibling;
    const title = header?.querySelector('h1.ph');
    const date = Array.from(header?.querySelectorAll('p.xg2 > span.xg1') || [])
      .find(el => /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(el.textContent.trim()));
    if (title) metadata.push(title);
    if (date) metadata.push(date);
  }
  // ScienceNet appends previous-post links, a contest and sponsor logos
  // INSIDE #blog_article. Keep the copyright notice and its source link, but
  // not the following platform chrome. Never mutate the live page.
  let articleChildren = root ? Array.from(root.childNodes) : [];
  if (root === blogArticle) {
    const copyright = articleChildren.findIndex(n => n.nodeType === Node.ELEMENT_NODE
      && n.tagName === 'LABEL' && /^转载本文请联系原作者/.test(n.textContent.trim()));
    if (copyright >= 0) {
      const link = articleChildren.findIndex((n, i) => i > copyright && n.nodeType === Node.ELEMENT_NODE && n.tagName === 'A');
      articleChildren = articleChildren.slice(0, link >= 0 ? link + 1 : copyright + 1);
    }
  }
  const childrenOf = node => node === root ? articleChildren : Array.from(node.childNodes);
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
    for (const child of childrenOf(node)) {
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
  metadata.forEach(visit);
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
      // Older jQuery LazyLoad (used by ScienceNet) stores the real URL in
      // `original`, without the data- prefix, while src becomes grey.gif.
      const url=safeUrl(node.getAttribute('data-src')||node.getAttribute('data-original')||node.getAttribute('data-lazy-src')||node.getAttribute('original')||node.currentSrc||node.getAttribute('src')||'');
      const out=url?'<img src="'+esc(url)+'" alt="'+esc(node.getAttribute('alt')||'')+'">':'';htmlSize+=out.length;return out;
    }
    const children=childrenOf(node).map(markup).join('');
    if (tag==='a') {const url=safeUrl(node.getAttribute('href')||'');return url?'<a href="'+esc(url)+'">'+children+'</a>':children;}
    if (!/^(p|div|section|article|main|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code|strong|b|em|i|del|figure|figcaption|br|hr)$/.test(tag)) return children;
    return '<'+tag+'>'+children+'</'+tag+'>';
  }
  const html=metadata.map(markup).join('')+(root?markup(root):'');
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
    let request = page_for_request(request_id).ok_or("Open this article in Web mode before capturing it.")?;
    if !capture_matches(&request, request_id, &initial_url) {
        return Err("The article or page changed, or has not finished loading. Open its Web view and try again.".into());
    }
    refresh_page_address(app, &request);
    request.last_used.store(USE_CLOCK.fetch_add(1, Ordering::AcqRel), Ordering::Release);
    let epoch = request.navigation_epoch.load(Ordering::Acquire);
    let view = app
        .get_webview(&request.view_id)
        .ok_or("The original page is no longer open.")?;
    request.capturing.store(true, Ordering::Release);
    let result = native_capture(view, request.clone(), epoch).await;
    request.capturing.store(false, Ordering::Release);
    validate_snapshot(&result?, &request, epoch)
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
    let request = Arc::new(PageRequest { view_id: view.label().into(), alive: AtomicBool::new(true), capturing: AtomicBool::new(false), last_used: AtomicU64::new(0), instance, request_id: "synthetic".into(), current_url: Mutex::new(url.clone()), initial_url: url, navigation_epoch: AtomicU64::new(0), loaded: AtomicBool::new(true), presentation: Mutex::new(crate::page_theme::Presentation::new(true, false)), zoom: Mutex::new(PageZoom::default()) });
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

    #[test]
    fn rss_cache_uses_recency_and_excludes_visible_capture_and_workspace_pages() {
        let entries: Vec<_> = (0..10).map(|index| {
            let mut request = capture_request();
            request.view_id = format!("rss-{index}");
            request.last_used.store(index, Ordering::Release);
            request.presentation.lock().unwrap().visible = false;
            Arc::new(request)
        }).collect();
        assert_eq!(eviction_candidate(&entries).as_deref(), Some("rss-0"));
        entries[0].last_used.store(100, Ordering::Release);
        assert_eq!(eviction_candidate(&entries).as_deref(), Some("rss-1"));
        entries[1].presentation.lock().unwrap().visible = true;
        entries[2].capturing.store(true, Ordering::Release);
        assert_eq!(eviction_candidate(&entries).as_deref(), Some("rss-3"));
        let workspace = Arc::new(capture_request());
        assert!(eviction_candidate(&[workspace]).is_none());
    }

    #[test]
    fn retired_requests_cannot_navigate_capture_or_publish_for_a_replacement() {
        let request = capture_request();
        assert!(request.is_active());
        request.alive.store(false, Ordering::Release);
        assert!(!request.is_active());
        assert!(!capture_matches(&request, "capture-fixture", &request.initial_url));
        let replacement = capture_request();
        assert!(replacement.is_active());
    }

    #[test]
    fn native_instance_names_cannot_target_the_main_app_or_authorization_views() {
        assert_eq!(page_id(None).unwrap(), LABEL);
        assert!(page_id(Some("rss-123-abc-def")).is_ok());
        for bad in ["main", "../main", "rss-<script>", "rss-中文", "authorization"] {
            assert!(page_id(Some(bad)).is_err());
        }
    }

    pub(super) fn capture_request() -> PageRequest {
        PageRequest {
            view_id: LABEL.into(), alive: AtomicBool::new(true), capturing: AtomicBool::new(false), last_used: AtomicU64::new(0),
            instance: ACTIVE_INSTANCE.load(Ordering::Acquire),
            request_id: "capture-fixture".into(),
            presentation: Mutex::new(crate::page_theme::Presentation::new(true, false)),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(5),
            loaded: AtomicBool::new(true),
            zoom: Mutex::new(PageZoom::default()),
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
        assert!(CAPTURE_SCRIPT.contains("metadata.forEach(visit)"));
        assert!(CAPTURE_SCRIPT.contains("document.querySelector('div#blog_article')"));
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
            view_id: LABEL.into(), alive: AtomicBool::new(true), capturing: AtomicBool::new(false), last_used: AtomicU64::new(0),
            presentation: Mutex::new(crate::page_theme::Presentation::new(true, false)),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(0),
            loaded: AtomicBool::new(true),
            zoom: Mutex::new(PageZoom::default()),
        };
        let value = serde_json::to_value(request.payload(PagePhase::Loaded, None)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"viewId":LABEL,"instance":0,"requestId":"request-17","url":"https://example.com/article","phase":"loaded"})
        );
    }

    #[test]
    fn blocked_and_download_status_do_not_change_current_page_or_expose_unsafe_urls() {
        let request = PageRequest {
            instance: 0,
            request_id: "request-18".into(),
            view_id: LABEL.into(), alive: AtomicBool::new(true), capturing: AtomicBool::new(false), last_used: AtomicU64::new(0),
            presentation: Mutex::new(crate::page_theme::Presentation::new(true, false)),
            current_url: Mutex::new(parse_url("https://example.com/article").unwrap()),
            initial_url: parse_url("https://example.com/article").unwrap(),
            navigation_epoch: AtomicU64::new(0),
            loaded: AtomicBool::new(true),
            zoom: Mutex::new(PageZoom::default()),
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

    #[test]
    fn zoom_scripts_are_fixed_and_never_include_ipc() {
        let init = page_zoom_initialization_script();
        assert!(init.contains("width=device-width, initial-scale=1"));
        assert!(init.contains("window.top !== window"));
        assert!(!init.contains("__TAURI"));
        assert!(!init.contains("invoke("));
        assert!(!init.contains("document.cookie"));
        assert!(!init.contains("localStorage"));
        for action in ["in", "out", "reset", "fit", "get"] {
            let script = zoom_eval_script(action, 1.0).unwrap();
            assert!(script.contains("__scholayPageZoomV1"));
            assert!(!script.contains("PRIVATE"));
        }
        let error = zoom_eval_script("alert('PRIVATE')", 1.0).unwrap_err();
        assert!(!error.contains("PRIVATE"));
        assert!(zoom_eval_script("apply", 1.25).unwrap().contains("set(1.25)"));
    }

    #[test]
    fn zoom_readback_accepts_only_clamped_public_fields() {
        let fit = parse_zoom_readback(r#"{"factor":0.72,"mode":"fit"}"#).unwrap();
        assert_eq!(fit.factor, 0.72);
        assert_eq!(fit.mode, ZoomMode::Fit);
        let quoted = parse_zoom_readback(r#""{\"factor\":1.2,\"mode\":\"manual\"}""#).unwrap();
        assert_eq!(quoted.factor, 1.2);
        assert_eq!(quoted.mode, ZoomMode::Manual);
        assert_eq!(
            parse_zoom_readback(r#"{"factor":9,"mode":"manual"}"#)
                .unwrap()
                .factor,
            3.0
        );
        assert!(parse_zoom_readback(r#"{"factor":1,"mode":"fit","script":"alert(1)"}"#).is_none());
        assert!(parse_zoom_readback(r#"{"factor":1,"mode":"steal"}"#).is_none());
        assert!(parse_zoom_readback("PRIVATE-SENSITIVE-RAW").is_none());
    }
}
