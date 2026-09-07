//! Platform-specific auth adapters. Return allowlisted status fields only;
//! passwords, access secrets and cookies never enter RSS or MCP responses.
use crate::hot_board;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use tokio::io::AsyncWriteExt;

fn zhihu_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // Match the official installer; do not search PATH or accept executable
    // paths from remote content/settings. This is not a generic shell runner.
    #[cfg(windows)]
    { return app.path().local_data_dir().map(|p| p.join("ZhihuCLI/current/zhihu-cli.exe")).map_err(|_| "Cannot resolve local application directory".into()); }
    #[cfg(target_os = "macos")]
    { return app.path().home_dir().map(|p| p.join("Library/Application Support/zhihu-cli/current/zhihu-cli")).map_err(|_| "Cannot resolve home directory".into()); }
    #[cfg(not(any(target_os = "macos", windows)))]
    { app.path().data_dir().map(|p| p.join("zhihu-cli/current/zhihu-cli")).map_err(|_| "Cannot resolve data directory".into()) }
}

async fn zhihu(app: &AppHandle, args: &[&str], secret: Option<String>) -> Result<Value, String> {
    let path = zhihu_path(app)?;
    if !path.is_file() {
        return Err("知乎 CLI 尚未安装".into());
    }
    let mut cmd = tokio::process::Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW; no console flash on each status poll.
    cmd.args(args)
        .env_remove("ZHIHU_ACCESS_SECRET")
        .stdin(if secret.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| "无法启动知乎 CLI")?;
    if let Some(secret) = secret {
        if secret.len() > 4096 || secret.trim().is_empty() {
            return Err("请输入有效的 Access Secret".into());
        }
        let mut input = child.stdin.take().ok_or("无法创建安全凭证输入")?;
        input
            .write_all(secret.trim().as_bytes())
            .await
            .map_err(|_| "凭证传递失败")?;
        // CLI receives stdin, never a command-line argument or environment value.
        let mut consumed = secret.into_bytes();
        consumed.fill(0);
        drop(input);
    }
    let output = tokio::time::timeout(Duration::from_secs(22), child.wait_with_output())
        .await
        .map_err(|_| "验证超时，原授权未被更改")?
        .map_err(|_| "无法读取知乎状态")?;
    if output.stdout.len() > 65536 {
        return Err("知乎返回了异常响应".into());
    }
    let data: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "知乎暂时无法验证，请检查网络")?;
    if !output.status.success() {
        return Err("知乎操作未完成，请检查授权有效期或网络连接；详情可在官方 CLI 验证".into());
    }
    Ok(data)
}
fn zhihu_status(data: Value) -> Value {
    let configured = data["source"].as_str().is_some_and(|s| s != "none");
    let verification = data["verification"].as_str().unwrap_or("not_performed");
    let status = if !configured {
        "unconfigured"
    } else if matches!(verification, "success" | "verified" | "valid") {
        "verified"
    } else if matches!(verification, "failed" | "invalid") {
        "expired"
    } else {
        "configured"
    };
    let verified_at = if status == "verified" {
        json!(chrono::Utc::now().to_rfc3339())
    } else {
        data["last_verified_at"].clone()
    };
    json!({"id":"zhihu","name":"知乎","method":"开放平台 Access Secret · 系统凭证库","status":status,"service":"available","lastVerifiedAt":verified_at,"detail":"API 授权用于知识雷达抓取，不等同于知乎网页账号登录。"})
}
fn local_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| "无法创建本地连接".into())
}
async fn local_json(client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let response = client
        .get(format!("http://127.0.0.1:8080{path}"))
        .send()
        .await
        .map_err(|_| "微信连接器未启动")?
        .error_for_status()
        .map_err(|_| "连接器返回错误")?;
    if response.content_length().is_some_and(|n| n > 262144) {
        return Err("连接器响应异常".into());
    }
    let bytes = response.bytes().await.map_err(|_| "无法读取连接器")?;
    if bytes.len() > 262144 {
        return Err("连接器响应异常".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "连接器响应格式不兼容".into())
}
async fn wechat() -> Value {
    let result=async {
        let client=local_client()?;let health=local_json(&client,"/api/health").await?;
        if health["ok"]!=true {return Err("连接器健康检查失败".into());}
        let sources=local_json(&client,"/api/sources").await.unwrap_or(json!([]));
        let latest=sources.as_array().and_then(|s|s.iter().max_by_key(|x|x["last_sync_at"].as_i64().unwrap_or(0)));
        let last_status=latest.and_then(|s|s["last_status"].as_str());
        let login=health["login"].as_str().unwrap_or("idle");
        let status=if matches!(login,"requesting"|"waiting"|"scanned"|"exchanging"|"initializing"){"authorizing"}else if health["credentials"]!=true{"unconfigured"}else if last_status==Some("auth_expired"){"expired"}else if last_status==Some("risk_control"){"challenge"}else{"configured"};
        Ok::<_,String>(json!({"id":"wechat","name":"微信公众号","method":"WechRss · 微信读书扫码会话","service":"available","status":status,"lastSyncAt":latest.map(|s|&s["last_sync_at"]),"lastSyncStatus":last_status,"detail":"凭证由本机 WechRss 保管。已配置不代表当前会话已验证；抓取状态与授权状态分别显示。"}))
    }.await;
    result.unwrap_or_else(|error|json!({"id":"wechat","name":"微信公众号","method":"WechRss · 微信读书扫码会话","service":"offline","status":"unknown","detail":error}))
}

#[tauri::command]
pub async fn platform_status(app: AppHandle, webview: Webview) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    let (z, w) = tokio::join!(zhihu(&app, &["auth", "status"], None), wechat());
    let z=z.map(zhihu_status).unwrap_or_else(|detail|json!({"id":"zhihu","name":"知乎","method":"开放平台 Access Secret · 系统凭证库","service":"unknown","status":"unknown","detail":detail}));
    Ok(json!([z, w]))
}
#[tauri::command]
pub async fn platform_action(
    app: AppHandle,
    webview: Webview,
    platform: String,
    action: String,
    secret: Option<String>,
) -> Result<Value, String> {
    hot_board::require_main(&webview)?;
    match (platform.as_str(), action.as_str()) {
        ("zhihu", "verify") => Ok(zhihu_status(
            zhihu(
                &app,
                &["auth", "status", "--verify", "--timeout", "15s"],
                None,
            )
            .await?,
        )),
        ("zhihu", "save") => {
            zhihu(
                &app,
                &["auth", "set", "--secret-stdin", "--timeout", "15s"],
                secret,
            )
            .await?;
            Ok(zhihu_status(zhihu(&app, &["auth", "status"], None).await?))
        }
        ("zhihu", "logout") => {
            zhihu(&app, &["auth", "logout"], None).await?;
            Ok(zhihu_status(zhihu(&app, &["auth", "status"], None).await?))
        }
        ("wechat", "verify") => Ok(wechat().await),
        ("wechat", "authorize") => {
            if let Some(window) = app.get_webview_window("platform-wechat-auth") {
                window.show().map_err(|e| e.to_string())?;
                window.set_focus().map_err(|e| e.to_string())?;
            } else {
                let url = url::Url::parse("http://127.0.0.1:8080/settings#login").unwrap();
                WebviewWindowBuilder::new(&app, "platform-wechat-auth", WebviewUrl::External(url))
                    .title("微信公众号授权 · scholay today")
                    .inner_size(840.0, 760.0)
                    .min_inner_size(560.0, 520.0)
                    .on_navigation(|url| {
                        url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(8080)
                    })
                    .build()
                    .map_err(|_| "无法打开微信授权窗口")?;
            }
            Ok(json!({"opened":true}))
        }
        _ => Err("不支持的授权操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_is_not_verified_and_secrets_are_not_returned() {
        let value = zhihu_status(
            json!({"source":"keychain","verification":"not_performed","masked":"do-not-return","secret":"never"}),
        );
        assert_eq!(value["status"], "configured");
        assert!(!value.to_string().contains("do-not-return"));
        assert!(!value.to_string().contains("never"));
    }
}
