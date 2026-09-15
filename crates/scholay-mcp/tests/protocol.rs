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
        for _ in 0..4 {
            let stream = listener.accept().await.unwrap();
            let (read, mut write) = tokio::io::split(stream);
            let mut line = String::new();
            BufReader::new(read.take(131073))
                .read_line(&mut line)
                .await
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let response = match request["method"].as_str() {
                Some("library_list") => json!({"result":{"revision":7,"feeds":[],"folders":[]}}),
                // A cleaned article is paginated and always framed as data.
                Some("article_read") => {
                    json!({"result":{"articleId":4,"status":"cleaned","totalBlocks":2,"nextOffset":1,"complete":false,"markdown":"## 方法\n\n"}})
                }
                Some("article_clean") => json!({"error":"Structured cleaning is disabled"}),
                _ => json!({"error":"This server is read-only"}),
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
    assert_eq!(initialized["result"]["serverInfo"]["name"], "scholay-today");
    assert_eq!(initialized["result"]["serverInfo"]["title"], "scholay today");
    assert!(initialized["result"]["instructions"].as_str().unwrap().contains("scholay today"));
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let tools = call(&mut input, &mut output, 2, "tools/list", json!({})).await;
    let listed = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(listed.len(), 7);
    let named = |name: &str| {
        listed
            .iter()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("{name} is not advertised"))
            .clone()
    };
    // Reading is read-only and stays local; cleaning is the one article tool
    // allowed to leave the machine, and it never destroys anything.
    assert_eq!(named("article_read")["annotations"]["readOnlyHint"], true);
    assert_eq!(named("article_list")["annotations"]["openWorldHint"], false);
    assert_eq!(named("article_clean")["annotations"]["openWorldHint"], true);
    assert_eq!(named("article_clean")["annotations"]["destructiveHint"], false);
    assert_eq!(
        named("article_clean")["inputSchema"]["properties"]["dry_run"]["default"],
        true
    );
    assert_eq!(
        named("article_clean")["inputSchema"]["properties"]["article_ids"]["maxItems"],
        200
    );
    let list = call(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"library_list","arguments":{}}),
    )
    .await;
    assert_eq!(list["result"]["structuredContent"]["revision"], 7);
    let read = call(
        &mut input,
        &mut output,
        4,
        "tools/call",
        json!({"name":"article_read","arguments":{"article_id":4}}),
    )
    .await;
    assert_eq!(read["result"]["structuredContent"]["nextOffset"], 1);
    assert_eq!(read["result"]["structuredContent"]["complete"], false);
    // Each capability has its own switch, so a refusal is reported per tool.
    for (id, request) in [
        (5, json!({"name":"library_apply","arguments":{"actions":[],"dry_run":true}})),
        (6, json!({"name":"article_clean","arguments":{"dry_run":true}})),
    ] {
        let denied = call(&mut input, &mut output, id, "tools/call", request).await;
        assert_eq!(denied["result"]["isError"], true);
    }
    server.await.unwrap();
    child.kill().await.unwrap();
}
#[tokio::test]
async fn supported_mcp_versions_work_over_native_transport() {
    scenario("2025-11-25").await;
    scenario("2024-11-05").await;
}
