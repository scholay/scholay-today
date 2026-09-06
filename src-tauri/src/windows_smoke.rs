//! Actual WebView2 render -> isolated capture -> offline ZIP. Synthetic content
//! and a unique temporary browser profile; no app DB, account, AI or public URL.
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{webview::PageLoadEvent, Manager};
const PNG: &[u8] = include_bytes!("../icons/32x32.png");
const HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Windows 图文验收</title></head><body>
<article><h1>Windows 图文验收</h1><p>这是一篇完全虚构的本地测试文章，用来验证 Windows 浏览器能够正确读取中文、标题、段落和图片，并将结果组织为可离线阅读的 Markdown 文件。本文不包含任何用户的订阅、账户或私有资料。科研信息整理应该保留来源信息，也应该明确内容抓取的边界；在保存图片和正文时，程序需要检查页面是否发生切换，以免把不同文章错误地混合。本段内容仅供自动化测试，不能作为真实研究结论引用。</p>
<figure><img src="/figure.png" width="80" height="80" alt="Synthetic figure"><figcaption>图一：测试图片</figcaption></figure>
<p><strong>测试结论</strong>：保留图文顺序和来源。</p><form><input value="PRIVATE_FORM_SENTINEL"></form><div hidden>HIDDEN_SENTINEL</div>
</article><script>JSON.stringify = () => { throw Error('PAGE_WORLD_SENTINEL'); };</script></body></html>"#;

pub fn run() {
    let folder =
        std::env::temp_dir().join(format!("scholay-webview2-smoke-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
            let mut request = [0u8; 4096];
            let n = stream.read(&mut request).unwrap_or(0);
            let image = String::from_utf8_lossy(&request[..n]).starts_with("GET /figure.png ");
            let (mime, body) = if image {
                ("image/png", PNG)
            } else {
                ("text/html; charset=utf-8", HTML.as_bytes())
            };
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(body);
        }
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.scholay.windows-smoke".into();
    let once = Arc::new(AtomicBool::new(false));
    tauri::Builder::default().setup(move |app| {
        let output = folder.clone();
        let handle = app.handle().clone();
        // WebView2 can dispatch page callbacks during synchronous creation.
        // Let setup return before creating the window, so exit events are live.
        let window_host = handle.clone();
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(40)); eprintln!("WebView2 fixture timed out"); std::process::exit(2); });
        std::thread::spawn(move || {
        let created = tauri::WebviewWindowBuilder::new(&window_host, "windows-smoke", tauri::WebviewUrl::External(url.parse().unwrap()))
            .title("scholay tody · synthetic WebView2 verification").inner_size(800.0, 640.0)
            .data_directory(folder.join("browser"))
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished) || once.swap(true, Ordering::AcqRel) { return; }
                let handle = handle.clone(); let output = output.clone();
                let view = window.get_webview("windows-smoke").expect("fixture webview");
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let dom = crate::page_view::capture_smoke_fixture(view).await?;
                        if !dom.text.contains("测试结论") || dom.text.contains("SENTINEL") || dom.html.contains("SENTINEL") { return Err("Capture isolation/exclusion failed".to_string()); }
                        let mut doc = crate::article_document::parse(crate::article_document::Document {
                            schema_version:1, capture_id:"windows-synthetic".into(), article_id:0, title:dom.title, source_url:dom.url,
                            captured_at:chrono::Utc::now().to_rfc3339(), source_kind:"rendered_webpage".into(), author:None, published_at:None,
                            truncated:dom.truncated, blocks:vec![], assets:vec![], warnings:vec![],
                        }, &dom.html);
                        if doc.assets.len() != 1 || doc.blocks.len() < 4 || doc.truncated { return Err("Unexpected structured fixture".into()); }
                        let path = "assets/fixture.png".to_string();
                        doc.assets[0].path = Some(path.clone()); doc.assets[0].status = "saved".into(); doc.assets[0].sha256 = Some(format!("{:x}", Sha256::digest(PNG)));
                        let archive = output.join("图文资料包.zip");
                        crate::article_export::package(&doc, None, &[(path, PNG.to_vec())], &archive)?;
                        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                        let mut markdown = String::new(); zip.by_name("article.md").map_err(|e|e.to_string())?.read_to_string(&mut markdown).map_err(|e|e.to_string())?;
                        if !markdown.contains("assets/fixture.png") { return Err("Offline Markdown image link missing".into()); }
                        Ok::<_,String>(serde_json::json!({"passed":true,"engine":"WebView2","isolatedWorld":true,"formAndHiddenExcluded":true,"blocks":doc.blocks.len(),"images":doc.assets.len(),"archive":archive}))
                    }.await;
                    match result {
                        Ok(report) => {
                            println!("{report}");
                            // Tear down the test browser before ending its UI
                            // loop; WebView2 may otherwise retain a modal loop.
                            if let Some(window) = handle.get_webview_window("windows-smoke") { let _ = window.destroy(); }
                            handle.exit(0);
                        }
                        Err(error) => { eprintln!("WebView2 smoke failed: {error}"); std::process::exit(1); }
                    }
                });
            }).build();
        if let Err(error) = created { eprintln!("WebView2 fixture window failed: {error}"); window_host.exit(1); }
        });
        Ok(())
    }).build(context).expect("WebView2 smoke app").run(|_, event| {
        match event {
            tauri::RunEvent::ExitRequested { code, .. } => eprintln!("WebView2 fixture exit requested: {code:?}"),
            tauri::RunEvent::Exit => eprintln!("WebView2 fixture event loop exited"),
            _ => {}
        }
    });
}
