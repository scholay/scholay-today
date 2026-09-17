import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { LABEL_SOURCES, parseLabelCache, parseLabelUi } from "./helpers";

const script = readFileSync(new URL("../../src-tauri/src/label_probe.js", import.meta.url), "utf8");
function run(body: string, action = "inspect", host = "https://trends.bilibili.com/content/?tid=-1", extra = {}) {
  const dom = new JSDOM(body, { url: host, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return (this.hasAttribute("hidden") ? [] : [{}]) as unknown as DOMRectList; };
  const result = JSON.parse(dom.window.eval(script.replace("__LABEL_PROBE_OPTIONS__", JSON.stringify({ id: "bilibili", hosts: ["trends.bilibili.com"], action, ...extra }))));
  return { result, dom };
}
const fixture = `<h1>内容热点</h1><div class="login">登录</div><a href="/content/full?type=hot&dateType=date&date=1788710399&tid=-1">完整榜单</a><section><h3>热门关键词</h3><div class="ivu-table"><div class="ivu-table-body"><table><tbody><tr><td></td><td><span class="keyword_content">知识</span></td><td>52.8W</td></tr><tr hidden><td>2</td><td>hidden</td><td>9W</td></tr></tbody></table></div></div></section><section><h3>飙升关键词</h3><div class="ivu-table"><div class="ivu-table-body"><table><tbody><tr><td>1</td><td><span class="keyword_content">天文</span></td><td>1,020</td></tr></tbody></table></div></div></section>`;

describe("labels public DOM adapter and separate workspace", () => {
  it("extracts real keyword kinds and public period, not hot news or private form values", () => {
    const { result, dom } = run(fixture + '<input type="password" value="private-secret">');
    expect(result.rows).toEqual([{ term: "知识", metric: "52.8W", kind: "热门关键词", rank: 1 }, { term: "天文", metric: "1,020", kind: "飙升关键词", rank: 1 }]);
    expect(result.period).toContain("日榜");
    expect(result.auth).toBe("signed_out");
    expect(JSON.stringify(result)).not.toContain("private-secret");
    dom.window.close();
  });
  it("never infers login from successful ranking access", () => {
    const { result, dom } = run(fixture.replace('<div class="login">登录</div>', ''));
    expect(result.auth).toBe("unknown");
    expect(result.rows.length).toBe(2);
    dom.window.close();
  });
  it("distinguishes logout controls, challenges, and hidden controls", () => {
    for (const [html, expected] of [['<button>退出登录</button>', 'signed_in'], ['<h1>安全验证</h1>', 'challenge'], ['<button hidden>退出登录</button>', 'unknown']]) {
      const { result, dom } = run(html); expect(result.auth).toBe(expected); dom.window.close();
    }
  });
  it("clicks only the explicitly requested login or matching keyword, not on read", () => {
    for (const action of ["inspect", "login", "keyword"]) {
      const dom = new JSDOM(fixture, { url: "https://trends.bilibili.com/content/", runScripts: "outside-only" });
      dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
      const clicks: string[] = [];
      dom.window.document.addEventListener("click", event => clicks.push((event.target as Element).textContent ?? ""));
      dom.window.eval(script.replace("__LABEL_PROBE_OPTIONS__", JSON.stringify({ id: "bilibili", hosts: ["trends.bilibili.com"], action, term: "天文", kind: "飙升关键词" })));
      expect(clicks).toEqual(action === "inspect" ? [] : action === "login" ? ["登录"] : ["天文"]);
      dom.window.close();
    }
  });
  it("rejects unexpected origins and does not extract unrelated platform tables", () => {
    for (const url of ["https://evil.example/content/", "https://trends.bilibili.com/content/detail?keyword=private", "http://trends.bilibili.com/content/"]) {
      const { result, dom } = run(fixture, "inspect", url); expect(result.rows).toEqual([]); dom.window.close();
    }
  });
  it("does not submit existing login forms or request verification codes", () => {
    const { result, dom } = run('<input placeholder="请输入手机号"><input placeholder="请输入验证码"><button>登录</button><button>获取验证码</button>', 'login');
    expect(result.auth).toBe('signed_out');
    expect(result.clicked).toBe(false);
    dom.window.close();
  });
  it("keeps existing preferences compatible and only persists bounded ranking fields", () => {
    expect(parseLabelUi(null).sourceId).toBe("all");
    expect(parseLabelUi('{"sourceId":"mail"}').sourceId).toBe("all");
    expect(parseLabelUi('{"sourceId":"douyin","search":"private","expanded":true}')).toEqual({ sourceId: "douyin", search: "", group: "全部" });
    const valid = { rows: [{ term: "知识", metric: "1W", kind: "热门关键词", rank: 1 }], period: "日榜", capturedAt: new Date().toISOString(), auth: "signed_in", cookie: "never-store" };
    const cache = parseLabelCache(JSON.stringify({ bilibili: valid, unknown: valid }));
    expect(Object.keys(cache)).toEqual(["bilibili"]);
    expect(JSON.stringify(cache)).not.toMatch(/signed_in|cookie|never-store/);
    expect(parseLabelCache("invalid")).toEqual({});
  });
  it("suspends hidden workspaces and never calls RSS, capture, AI, or login on a timer", () => {
    const board = readFileSync(new URL("./LabelBoard.tsx", import.meta.url), "utf8");
    expect(board).toContain("!active || authId || !current()");
    expect(board).toContain("revision === owner.current");
    expect(board).toContain("window.clearTimeout(timer)");
    expect(board).toContain('"cancel_label_collection"');
    expect(board).not.toContain('<HotPageView');
    expect(board).not.toMatch(/open_page_view|capturePageView|aiFormatPage|addFeed|papr\.db|document\.cookie/);
    const shell = readFileSync(new URL("../WorkspaceApp.tsx", import.meta.url), "utf8");
    const trends = readFileSync(new URL("../hot/TrendsWorkspace.tsx", import.meta.url), "utf8");
    expect(shell).toContain("<TrendsWorkspace");
    expect(shell).toContain("inert={!trendsOpen}");
    expect(shell).toContain('section={workspace === "labels" ? "labels" : "hot"}');
    expect(trends).toContain("LabelBoard");
    expect(trends).toContain('section === "labels"');
    for (const source of LABEL_SOURCES) expect(new URL(source.url).protocol).toBe("https:");
  });
});
