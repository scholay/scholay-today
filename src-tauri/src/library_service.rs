//! The app remains the single writer. MCP uses a permission-restricted local
//! Unix socket / Windows named pipe; remote WebViews cannot control the service.
use crate::{db, hot_board, state::AppState};
use papr_core::library::{self, Mutation};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub fn changed(app: &AppHandle) {
    let _ = app.emit("library-changed", ());
}

pub async fn mutate(
    app: &AppHandle,
    actions: Vec<Mutation>,
    actor: &str,
    dry_run: bool,
    expected: Option<i64>,
    request_key: Option<&str>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let result = {
        let c = state.db.lock().await;
        if actor == "mcp"
            && (!db::setting_flag(&c, "mcp_enabled", false)
                || !db::setting_flag(&c, "mcp_writable", false))
        {
            return Err("Agent access was disabled before this change could be committed".into());
        }
        library::apply(&c, &actions, actor, dry_run, expected, request_key)
            .map_err(|e| e.to_string())?
    };
    if !dry_run {
        changed(app);
    }
    Ok(result)
}

#[tauri::command]
pub async fn library_apply(
    app: AppHandle,
    webview: Webview,
    actions: Vec<Mutation>,
    dry_run: bool,
    expected_revision: Option<i64>,
    request_key: Option<String>,
) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    mutate(
        &app,
        actions,
        "desktop",
        dry_run,
        expected_revision,
        request_key.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn library_status(
    app: AppHandle,
    state: State<'_, AppState>,
    webview: Webview,
) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    let c = state.read().await;
    let executable = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(if cfg!(windows) { "mcp/scholay-mcp.exe" } else { "mcp/scholay-mcp" });
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let socket = scholay_local_ipc::endpoint(&dir).map_err(|_| "Cannot resolve the local bridge")?;
    Ok(
        json!({"enabled":db::setting_flag(&c,"mcp_enabled",false),"writable":db::setting_flag(&c,"mcp_writable",false),
      "revision":library::revision(&c).map_err(|e|e.to_string())?,"archived":library::archived(&c).map_err(|e|e.to_string())?,
      "history":library::history(&c).map_err(|e|e.to_string())?,"configuration":{"mcpServers":{"scholay-today":{"command":executable,"args":["--socket",socket]}}}}),
    )
}

#[tauri::command]
pub async fn library_permissions(
    app: AppHandle,
    state: State<'_, AppState>,
    webview: Webview,
    enabled: bool,
    writable: bool,
) -> Result<(), String> {
    hot_board::require_main(&webview)?;
    let c = state.db.lock().await;
    db::set_setting(&c, "mcp_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    db::set_setting(&c, "mcp_writable", if writable { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    changed(&app);
    Ok(())
}

async fn dispatch(app: &AppHandle, request: Value) -> Result<Value, String> {
    let method = request["method"].as_str().ok_or("Missing method")?;
    let p = &request["params"];
    let state = app.state::<AppState>();
    {
        let c = state.read().await;
        if !db::setting_flag(&c, "mcp_enabled", false) {
            return Err("MCP is disabled. Enable it in Settings → Agent access.".into());
        }
        if method != "library_list" && !db::setting_flag(&c, "mcp_writable", false) {
            return Err(
                "This server is read-only. The user must enable write access in Settings.".into(),
            );
        }
    }
    match method {
        "library_list" => {
            let c = state.read().await;
            Ok(
                json!({"revision":library::revision(&c).map_err(|e|e.to_string())?,"feeds":db::list_feeds(&c).map_err(|e|e.to_string())?,"folders":library::folders(&c).map_err(|e|e.to_string())?,"archived":library::archived(&c).map_err(|e|e.to_string())?}),
            )
        }
        "library_apply" => {
            if p["dry_run"].as_bool() == Some(false) && p["expected_revision"].as_i64().is_none() {
                return Err("Read library_list and supply expected_revision before writing".into());
            }
            let actions: Vec<Mutation> = serde_json::from_value(p["actions"].clone())
                .map_err(|_| "Invalid library actions")?;
            // V1 only allows public subscription URLs from agents. Approved
            // loopback connectors are added through the desktop's feed dialog.
            for action in &actions {
                if let Mutation::SetFeedUrl { url, .. } = action {
                    crate::public_fetch::resolve(url).await?;
                }
            }
            mutate(
                app,
                actions,
                "mcp",
                p["dry_run"].as_bool().unwrap_or(true),
                p["expected_revision"].as_i64(),
                p["request_key"].as_str(),
            )
            .await
        }
        "feed_add" => {
            let url = p["url"].as_str().ok_or("Missing URL")?;
            let (bytes, _, url) = crate::public_fetch::fetch(url, None, 8 * 1024 * 1024).await?;
            if !crate::ingestion::parse::looks_like_feed(&bytes) {
                return Err("Provide a direct RSS/Atom URL. Website discovery is available in the desktop app.".into());
            }
            let feed = {
                let c = state.db.lock().await;
                if !db::setting_flag(&c, "mcp_enabled", false)
                    || !db::setting_flag(&c, "mcp_writable", false)
                {
                    return Err(
                        "Agent access was disabled before this subscription could be saved".into(),
                    );
                }
                library::subscribe(&c, &url, &bytes, None, p["folder_id"].as_i64(), "mcp")
                    .map_err(|_| "Could not subscribe. Check the URL and folder in the app.")?
            };
            changed(app);
            Ok(json!(feed))
        }
        _ => Err("Unknown method".into()),
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(dir) = app.path().app_data_dir() else {
            return;
        };
        let Ok(socket) = scholay_local_ipc::endpoint(&dir) else { return };
        let Ok(mut listener) = scholay_local_ipc::Listener::bind(&socket).await else {
            log::warn!("Agent bridge could not bind");
            return;
        };
        let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            let Ok(stream) = listener.accept().await else {
                break;
            };
            let Ok(permit) = limit.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let (read, mut write) = tokio::io::split(stream);
                let mut line = String::new();
                let mut reader = BufReader::new(read.take(131073));
                let read = reader.read_line(&mut line);
                // Keep the bounded reader alive across await.
                let read_result =
                    tokio::time::timeout(std::time::Duration::from_secs(5), read).await;
                if !matches!(read_result,Ok(Ok(n)) if n>0 && n<=131072) {
                    return;
                }
                let response = match serde_json::from_str::<Value>(&line) {
                    Ok(request) => match tokio::time::timeout(
                        std::time::Duration::from_secs(90),
                        dispatch(&app, request),
                    )
                    .await
                    {
                        Ok(Ok(value)) => json!({"result":value}),
                        Ok(Err(error)) => json!({"error":error}),
                        Err(_) => {
                            json!({"error":"Request timed out; read current state before retrying"})
                        }
                    },
                    Err(_) => json!({"error":"Invalid JSON request"}),
                };
                let _ = write.write_all(format!("{response}\n").as_bytes()).await;
            });
        }
    });
}
