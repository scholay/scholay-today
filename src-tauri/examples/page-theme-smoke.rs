//! Real WKWebView/WebView2 theme round-trip. Local synthetic content only;
//! separate identifier/profile, no application DB, user account or AI request.
#[path = "../src/page_theme.rs"]
mod page_theme;

use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{webview::PageLoadEvent, Manager};

const HTML: &str = r##"<!doctype html><html><head><meta charset="utf-8">
<style>html,body{background:#fff;color:#111;margin:0}article{padding:24px;min-height:2200px}a{color:#06c}.box{background:#fafafa;color:#222}body.native{background:#181a1b;color:#eee}body.native article{background:#181a1b}</style>
</head><body><article><h1>Theme fixture · 暗色网页验收</h1><p>Readable original text, unchanged by styling.</p><a href="#target">Original link</a><input id="form" value="keep-this-value"><img id="image" src="/figure.png" width="32" height="32"><canvas width="32" height="32"></canvas><div id="target">Target</div></article></body></html>"##;

const VERIFY: &str = r#"(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const theme = window.__scholayPageThemeV1;
  const checks = {};
  const assert = (key, value) => { checks[key] = Boolean(value); if (!value) throw Error(key); };
  const rgb = el => getComputedStyle(el).backgroundColor;
  const dark = el => { const m=rgb(el).match(/\d+/g); return m && Number(m[0]) < 100 && Number(m[1]) < 100 && Number(m[2]) < 100; };
  const styleCount = () => document.querySelectorAll('style.darkreader').length;
  try {
    assert('controllerAvailable', !!theme);
    const text = document.querySelector('p').textContent;
    const src = document.querySelector('img').src;
    const chrome = window.chrome;
    const darkReader = window.DarkReader;
    const sheets = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets').get;
    theme.setEnabled(false);
    assert('originalHasNoReadinessWait', theme.isReadyToDisplay());
    await wait(150);
    const original = rgb(document.body);
    scrollTo(0, 100);
    theme.setEnabled(true);
    assert('darkWaitsForStyles', !theme.isReadyToDisplay());
    const started = performance.now();
    while (!theme.isReadyToDisplay() && performance.now() - started < 6000) await wait(40);
    assert('hiddenPageCanPrepare', theme.isReadyToDisplay() && performance.now() - started < 6000 && document.hidden);
    assert('readyBeforeRevealIsDark', dark(document.body));
    window.__themeSmokePrepared = true;
    while (document.hidden && performance.now() - started < 8000) await wait(40);
    assert('nativeOwnerRevealed', !document.hidden);
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(requestAnimationFrame);
      assert('firstVisibleFramesStayDark', dark(document.body));
    }
    assert('lightPageAdapted', dark(document.body) && styleCount() > 0);
    assert('siteGlobalsPreserved', window.chrome === chrome && window.DarkReader === darkReader && Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets').get === sheets);
    assert('mediaNotInverted', getComputedStyle(document.querySelector('img')).filter === 'none' && getComputedStyle(document.querySelector('canvas')).filter === 'none' && document.querySelector('img').src === src);
    const box = document.createElement('div'); box.className='box'; box.textContent='Dynamic content'; document.querySelector('article').append(box);
    await wait(600);
    assert('dynamicContentAdapted', dark(box));
    assert('contentFormsScrollPreserved', document.querySelector('p').textContent===text && document.querySelector('input').value==='keep-this-value' && scrollY===100);
    theme.setEnabled(false);
    await wait(400);
    assert('originalRestored', rgb(document.body) === original && styleCount() === 0);
    document.body.classList.add('native');
    const native = rgb(document.body);
    theme.setEnabled(true);
    await wait(300);
    assert('nativeDarkNotOverridden', rgb(document.body) === native && styleCount() === 0);
    document.body.classList.remove('native');
    await wait(700);
    assert('nativeToLightReapplies', dark(document.body) && styleCount() > 0);
    theme.setEnabled(false);
    await wait(200);
    assert('secondRestore', rgb(document.body) === original && styleCount() === 0);
    window.__themeSmokeResult = { passed: true, checks };
  } catch(error) { window.__themeSmokeResult = { passed: false, error: String(error), checks, background: rgb(document.body), styles: styleCount() }; }
})();"#;

fn main() {
    let folder = std::env::temp_dir().join(format!("scholay-theme-smoke-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut request = [0u8; 2048];
            let n = stream.read(&mut request).unwrap_or(0);
            let image = String::from_utf8_lossy(&request[..n]).starts_with("GET /figure.png ");
            let (mime, body): (&str, &[u8]) = if image {
                ("image/png", include_bytes!("../icons/32x32.png"))
            } else {
                ("text/html; charset=utf-8", HTML.as_bytes())
            };
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(body);
        }
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.scholay.page-theme-smoke".into();
    page_theme::set_dark(false);
    let once = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(35));
                eprintln!("Theme smoke timed out");
                std::process::exit(2);
            });
            std::thread::spawn(move || {
                let callback_handle = handle.clone();
                let result = tauri::WebviewWindowBuilder::new(
                    &handle,
                    "theme-smoke",
                    tauri::WebviewUrl::External(url.parse().unwrap()),
                )
                .title("scholay tody · synthetic webpage theme test")
                .inner_size(800.0, 640.0)
                .visible(false)
                .data_directory(folder.join("browser"))
                .initialization_script(page_theme::initialization_script())
                .on_page_load(move |window, event| {
                    if !matches!(event.event(), PageLoadEvent::Finished)
                        || once.swap(true, Ordering::AcqRel)
                    {
                        return;
                    }
                    let view = window.get_webview("theme-smoke").unwrap();
                    page_theme::apply_backing(&view, true);
                    view.eval(VERIFY).unwrap();
                    let handle = callback_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut shown = false;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            let (tx, rx) = tokio::sync::oneshot::channel();
                            let tx = std::sync::Mutex::new(Some(tx));
                            view.eval_with_callback(
                                "({report: window.__themeSmokeResult || null, prepared: window.__themeSmokePrepared === true})",
                                move |result| {
                                    if let Some(tx) = tx.lock().unwrap().take() {
                                        let _ = tx.send(result);
                                    }
                                },
                            )
                            .unwrap();
                            let result = rx.await.unwrap();
                            let Ok(state) = serde_json::from_str::<serde_json::Value>(&result)
                            else {
                                continue;
                            };
                            if !shown && state["prepared"] == true {
                                handle.get_webview_window("theme-smoke").unwrap().show().unwrap();
                                shown = true;
                            }
                            let report = &state["report"];
                            if report.is_null() {
                                continue;
                            }
                            println!("{report}");
                            if report["passed"] != true {
                                std::process::exit(1);
                            }
                            if let Some(window) = handle.get_webview_window("theme-smoke") {
                                let _ = window.destroy();
                            }
                            handle.exit(0);
                            break;
                        }
                    });
                })
                .build();
                if let Err(error) = result {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            });
            Ok(())
        })
        .build(context)
        .unwrap()
        .run(|_, _| {});
}
