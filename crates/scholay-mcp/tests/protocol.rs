//! Exercise the real stdio executable through the actual OS-local transport.
//! Synthetic library only; never open a user's app, database or credentials.
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

async fn scenario(version: &str) {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = scholay_local_ipc::endpoint(dir.path()).unwrap();
    let mut listener = scholay_local_ipc::Listener::bind(&endpoint).await.unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let stream = listener.accept().await.unwrap();
            let (read, mut write) = tokio::io::split(stream);
            let mut line = String::new();
            BufReader::new(read.take(131073))
                .read_line(&mut line)
                .await
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let response = if request["method"] == "library_list" {
                json!({"result":{"revision":7,"feeds":[],"folders":[]}})
            } else {
                json!({"error":"This server is read-only"})
            };
            write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_scholay-mcp"))
        .args(["--socket", endpoint.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    async fn call(
        input: &mut tokio::process::ChildStdin,
        output: &mut BufReader<tokio::process::ChildStdout>,
        id: i32,
        method: &str,
        params: Value,
    ) -> Value {
        input
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                output.read_line(&mut line),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(n > 0);
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == id {
                return value;
            }
        }
    }
    let initialized = call(&mut input, &mut output, 1, "initialize", json!({"protocolVersion":version,"capabilities":{},"clientInfo":{"name":"synthetic-ci","version":"1"}})).await;
    assert_eq!(initialized["result"]["protocolVersion"], version);
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let tools = call(&mut input, &mut output, 2, "tools/list", json!({})).await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 3);
    let list = call(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"library_list","arguments":{}}),
    )
    .await;
    assert_eq!(list["result"]["structuredContent"]["revision"], 7);
    let denied = call(
        &mut input,
        &mut output,
        4,
        "tools/call",
        json!({"name":"library_apply","arguments":{"actions":[],"dry_run":true}}),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true);
    server.await.unwrap();
    child.kill().await.unwrap();
}
#[tokio::test]
async fn supported_mcp_versions_work_over_native_transport() {
    scenario("2025-11-25").await;
    scenario("2024-11-05").await;
}
