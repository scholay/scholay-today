//! Opt-in, real WKWebView/WebView2 test. Only localhost synthetic documents;
//! unique app identifier, no database, account, AI provider or production IPC.
use super::*;
use std::io::{Read, Write};
use std::time::Duration;

async fn evaluate(view: &tauri::Webview, script: &str) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    view.eval_with_callback(script, move |raw| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(raw);
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("{e}: {raw}"))
}
async fn wait_loaded(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    for _ in 0..200 {
        if page(id).is_some_and(|p| p.loaded.load(Ordering::Acquire)) {
            let view = app.get_webview(id).ok_or("missing view")?;
            if evaluate(&view, "Boolean(document.querySelector('article'))").await? == true {
                return Ok(view);
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Err(format!("{id} did not load"))
}
async fn open(
    app: &AppHandle,
    base: &str,
    id: &str,
    resume: Option<String>,
    zoom: Option<f64>,
) -> Result<bool, String> {
    open_page_view(
        app.clone(),
        format!("{base}{id}"),
        format!("request-{id}"),
        220.,
        100.,
        720.,
        540.,
        true,
        false,
        Some(id.into()),
        resume,
        zoom,
        Some("manual".into()),
    )
    .await
}
fn check(value: bool, message: &str) -> Result<(), String> {
    if value {
        println!("PASS {message}");
        Ok(())
    } else {
        Err(message.into())
    }
}

#[cfg(target_os = "macos")]
async fn verify_shortcuts(app: &AppHandle, view: &tauri::Webview) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags as Flags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    use tauri::Listener;
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = received.clone();
    let listener = app.listen_any("reader-tab-shortcut", move |event| {
        if let Ok(action) = serde_json::from_str(event.payload()) {
            captured.lock().unwrap().push(action);
        }
    });
    crate::reader_shortcuts::set_reader_shortcuts(app.clone(), true)?;
    app.get_window("main")
        .ok_or("no main window")?
        .set_focus()
        .map_err(|e| e.to_string())?;
    view.set_focus().map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            let mtm = MainThreadMarker::new().ok_or("not main thread")?;
            let application = NSApplication::sharedApplication(mtm);
            let menu = application.mainMenu().ok_or("no main menu")?;
            let window = application.keyWindow().ok_or("no focused window")?;
            for (key, code, flags) in [("w", 13, Flags::Command), ("T", 17, Flags::Command | Flags::Shift), ("\t", 48, Flags::Control), ("\t", 48, Flags::Control | Flags::Shift), ("1", 18, Flags::Command)] {
                let text = NSString::from_str(key);
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(NSEventType::KeyDown, NSPoint::new(0., 0.), flags, 0., window.windowNumber(), None, &text, &text, false, code).ok_or("missing native key event")?;
                if key == "1" {
                    if !menu.performKeyEquivalent(&event) { return Err("workspace accelerator not handled".into()); }
                } else { application.postEvent_atStart(&event, false); }
            }
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())??;
    for _ in 0..50 {
        if received.lock().unwrap().len() == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    app.unlisten(listener);
    let observed = received.lock().unwrap().clone();
    check(
        observed == ["close", "reopen", "next", "previous"],
        &format!("native reader shortcut events: {observed:?}"),
    )?;
    check(
        true,
        "native tab and workspace accelerators resolve with remote WKWebView focused",
    )
}

async fn verify(app: AppHandle, base: String) -> Result<(), String> {
    open(&app, &base, "rss-1", None, None).await?;
    let first = wait_loaded(&app, "rss-1").await?;
    #[cfg(target_os = "macos")]
    verify_shortcuts(&app, &first).await?;
    let first_instance = page("rss-1").unwrap().instance;
    evaluate(&first, "(()=>{window.retainedToken='kept';document.querySelector('input').value='retained';history.pushState({},'', '#second');scrollTo(0,310);return true})()").await?;
    set_page_view_zoom(
        app.clone(),
        "in".into(),
        Some("rss-1".into()),
        Some("request-rss-1".into()),
    )
    .await?;
    let zoom = page("rss-1").unwrap().zoom.lock().unwrap().factor;
    for n in 2..=10 {
        let id = format!("rss-{n}");
        open(&app, &base, &id, None, None).await?;
        wait_loaded(&app, &id).await?;
    }
    check(
        open(&app, &base, "rss-1", None, None).await?,
        "cached open reuses native view",
    )?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    check(
        page("rss-1").unwrap().instance == first_instance,
        "instance generation unchanged on tab switch",
    )?;
    check(evaluate(&first, "retainedToken==='kept' && document.querySelector('input').value==='retained' && location.hash==='#second' && scrollY>0").await? == true, "script, form, URL and scroll survive cache switch")?;
    check(
        (page("rss-1").unwrap().zoom.lock().unwrap().factor - zoom).abs() < 0.001,
        "manual zoom retained",
    )?;
    page_view_navigate_history(
        app.clone(),
        "back".into(),
        Some("rss-1".into()),
        Some("request-rss-1".into()),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    check(
        evaluate(&first, "location.hash===''").await? == true,
        "browser back history survives switch",
    )?;
    page_view_navigate_history(
        app.clone(),
        "forward".into(),
        Some("rss-1".into()),
        Some("request-rss-1".into()),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    check(
        evaluate(&first, "location.hash==='#second'").await? == true,
        "browser forward history survives switch",
    )?;

    open(&app, &base, "rss-11", None, None).await?;
    wait_loaded(&app, "rss-11").await?;
    check(
        pages()
            .iter()
            .filter(|p| p.view_id.starts_with("rss-"))
            .count()
            == 10
            && app.get_webview("rss-2").is_none()
            && app.get_webview("rss-1").is_some(),
        "11th page evicts least recently used, not tab-order first",
    )?;
    check(
        !open(
            &app,
            &base,
            "rss-2",
            Some(format!("{base}resumed")),
            Some(1.4),
        )
        .await?,
        "evicted page recreated",
    )?;
    let resumed = wait_loaded(&app, "rss-2").await?;
    check(
        resumed.url().unwrap().path() == "/resumed",
        "evicted page restores most recent URL",
    )?;
    check(
        (page("rss-2").unwrap().zoom.lock().unwrap().factor - 1.4).abs() < 0.001,
        "evicted page restores manual zoom",
    )?;
    close_page_view(
        app.clone(),
        Some("rss-2".into()),
        Some("stale-request".into()),
    )
    .await?;
    check(
        app.get_webview("rss-2").is_some(),
        "stale close cannot destroy current generation",
    )?;

    open(&app, &base, LABEL, None, None).await?;
    wait_loaded(&app, LABEL).await?;
    open(&app, &base, "labels-page", None, None).await?;
    wait_loaded(&app, "labels-page").await?;
    check(
        pages().len() == 12,
        "hot and authorization pages do not consume ten RSS slots",
    )?;
    check(
        pages()
            .iter()
            .filter(|p| p.presentation.lock().unwrap().visible)
            .count()
            == 1,
        "one visible content owner across workspaces",
    )?;
    set_page_view_visible(app.clone(), false, Some("labels-page".into()), None).await?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    check(
        evaluate(&app.get_webview("labels-page").unwrap(), "document.hidden").await? == true,
        "overlay hides native content",
    )?;
    let retired = page("rss-2").unwrap();
    close_page_view(app.clone(), Some("rss-2".into()), None).await?;
    check(
        !retired.is_active() && app.get_webview("rss-2").is_none(),
        "closing releases native instance and retires callbacks",
    )?;
    open(&app, &base, "rss-2", None, None).await?;
    wait_loaded(&app, "rss-2").await?;
    check(
        page("rss-2").unwrap().instance > retired.instance && !retired.is_active(),
        "close then reopen has a new generation",
    )?;

    let capture = capture_loaded_page(&app, "request-rss-2", &format!("{base}rss-2")).await?;
    check(
        capture.text.contains("Synthetic article") && !capture.text.contains("private-form-value"),
        "capture bound to original page and excludes form data",
    )?;
    check(
        capture_loaded_page(&app, "request-rss-2", &format!("{base}rss-1"))
            .await
            .is_err(),
        "wrong-article capture rejected",
    )?;
    for request in pages() {
        close_page_view(app.clone(), Some(request.view_id.clone()), None).await?;
    }
    check(
        pages().is_empty() && app.get_window("main").is_some(),
        "closing all reading pages leaves application window alive",
    )?;
    println!("READER_TABS_SMOKE_PASSED");
    Ok(())
}

pub fn run() {
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", server.local_addr().unwrap());
    std::thread::spawn(move || {
        let paragraph = "Synthetic article text for a local-only retained browser page. No account data, model requests or application database is used. ";
        let html = format!("<!doctype html><title>RSS tabs native fixture</title><style>body{{margin:20px;background:#faf8f4}}article{{min-height:2600px}}</style><article><h1>Synthetic article</h1><p>{}</p><input value='private-form-value'></article>", paragraph.repeat(30));
        for mut stream in server.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0; 2048];
            let _ = stream.read(&mut buf);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
        }
    });
    let mut context = crate::app_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = format!("com.scholay.tabs-smoke-{}", uuid::Uuid::new_v4());
    tauri::Builder::default()
        .setup(move |app| {
            crate::reader_shortcuts::install(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(60));
                eprintln!("RSS native smoke timed out");
                std::process::exit(2);
            });
            std::thread::spawn(move || {
                tauri::WindowBuilder::new(&handle, "main")
                    .title("RSS tabs · isolated native test")
                    .inner_size(1000., 700.)
                    .build()
                    .unwrap();
                tauri::async_runtime::spawn(async move {
                    match verify(handle.clone(), base).await {
                        Ok(()) => handle.exit(0),
                        Err(error) => {
                            eprintln!("READER_TABS_SMOKE_FAILED: {error}");
                            std::process::exit(1);
                        }
                    }
                });
            });
            Ok(())
        })
        .build(context)
        .unwrap()
        .run(|_, _| {});
}
