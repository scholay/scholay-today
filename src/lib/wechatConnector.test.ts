import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("experimental WechRss entry", () => {
  it("keeps WeChat authentication outside Papr and ordinary RSS available", () => {
    const dialog = read("src/components/AddFeedDialog.tsx");
    expect(dialog).toContain('queryFn: api.wechatConnectorStatus');
    expect(dialog).toContain('openUrl(wechatConnector.data?.endpoint ?? WECHRSS_ENDPOINT)');
    expect(dialog).toContain('t("addFeed.wechatPasteRss")');
    expect(dialog).toContain('api.addFeed(target, folderId)');
    expect(dialog).toContain('ref={urlRef}');
    expect(dialog).not.toMatch(
      /type=["']password["']|document\.cookie|localStorage|sessionStorage|navigator\.credentials/i,
    );
  });

  it("uses a fixed, read-only, short-timeout loopback health check", () => {
    const commands = read("src-tauri/src/commands.rs");
    const connectorStart = commands.indexOf("optional local connectors");
    const connectorEnd = commands.indexOf("folders", connectorStart);
    const connector = commands.slice(connectorStart, connectorEnd);
    const start = commands.indexOf("async fn probe_wechat_connector");
    const end = commands.indexOf("#[tauri::command]", start);
    const probe = commands.slice(start, end);
    expect(commands).toContain('const WECHAT_CONNECTOR_ENDPOINT: &str = "http://127.0.0.1:8080/"');
    expect(probe).toContain(".no_proxy()");
    expect(probe).toContain("Policy::none()");
    expect(probe).toContain("Duration::from_millis(1200)");
    expect(probe).not.toMatch(/state\.db|set_setting|response\.text|response\.bytes/);
    expect(connector).not.toMatch(/\bdb::|State<|INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM/i);
    expect(read("src-tauri/src/lib.rs")).toContain("commands::wechat_connector_status");
  });
});
