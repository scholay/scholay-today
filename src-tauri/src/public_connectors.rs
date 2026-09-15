//! Windows-only bundled public collectors; never reads or imports credentials.
#[cfg(windows)]
pub fn start(app: &tauri::AppHandle, data: &std::path::Path) {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    use tauri::Manager;
    let Ok(resources) = app.path().resource_dir() else { return; };
    let exe = resources.join("connectors/scholay-rss-bridge.exe");
    if !exe.is_file() { log::warn!("Public RSS companion not bundled"); return; }
    // The companion watches this exact PID and exits when the application does.
    // No login task, firewall rule, global Python install or copied session.
    if Command::new(exe).arg("--data-dir").arg(data.join("public-rss"))
        .arg("--parent-pid").arg(std::process::id().to_string())
        .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().is_err() { log::warn!("Public RSS companion could not start"); return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Initial public collectors may take longer than the ordinary 8s RSS
        // startup tick. Retry only these local feeds, never touch account APIs.
        for _ in 0..3 {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let ids = {
                let state = app.state::<crate::state::AppState>();
                let conn = state.db.lock().await;
                let Ok(mut query) = conn.prepare("SELECT id FROM feeds WHERE feed_url LIKE 'http://127.0.0.1:8765/%' OR feed_url LIKE 'http://127.0.0.1:8766/%' OR feed_url LIKE 'http://127.0.0.1:8768/%'") else { return; };
                let Ok(rows) = query.query_map([], |r| r.get::<_, i64>(0)) else { return; };
                rows.filter_map(Result::ok).collect::<Vec<_>>()
            };
            for id in ids {
                let _ = crate::scheduler::refresh_all(&app, None, true, crate::scheduler::RefreshScope::Feed(id)).await;
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start(_: &tauri::AppHandle, _: &std::path::Path) {}
