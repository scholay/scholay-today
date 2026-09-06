import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceSwitcher from "../components/WorkspaceSwitcher";
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("shared workspace frame with independent RSS and hot content", () => {
  it("retains the RSS tree and full-size hidden panes instead of remounting or collapsing", () => {
    const shell = read("WorkspaceApp.tsx"), css = read("workspace.css");
    expect(shell.match(/<App\s/g)).toHaveLength(1);
    expect(shell).toContain('<App active={workspace === "rss"}');
    expect(shell).not.toMatch(/workspace === "rss"\s*\?\s*<App/);
    expect(shell).toContain('inert={workspace !== "rss"}');
    expect(css).toMatch(/\.workspace-panel\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    expect(css).toMatch(/\.workspace-panel\.is-inactive\s*\{[^}]*visibility:\s*hidden/);
    expect(css).not.toMatch(/\.workspace-panel\.is-inactive[^}]*display:\s*none/);
    expect(shell).not.toMatch(/setFocusMode|setAiOpen|saveReaderViewPreference|\.select\(/);
  });
  it("replaces sidebar brands without reserving a global toolbar row", () => {
    const shell = read("WorkspaceApp.tsx"), css = read("workspace.css");
    expect(shell).not.toContain("workspace-bar");
    expect(css).not.toContain("workspace-bar");
    expect(css).not.toMatch(/padding-top:\s*(0|14px)|padding-left:\s*18px/);
    expect(css).toMatch(/\.workspace-sidebar-heading\s*\{[^}]*margin:\s*19px 12px 10px/);
    for (const file of ["components/Sidebar.tsx", "hot/HotBoard.tsx"]) {
      expect(read(file)).toContain('workspaceSwitch ? <div className="workspace-sidebar-heading">{workspaceSwitch}</div>');
      expect(read(file)).toContain('<div className="titlebar" data-tauri-drag-region />');
    }
    expect(read("styles.css")).toContain(':root[data-platform="mac"] .sidebar { padding-top: 38px; }');
    expect(read("hot/hot.css")).toContain(':root[data-platform="mac"] .hot-sidebar { padding-top: 38px; }');
    expect(read("styles.css")).toMatch(/\.window\.focus \.reader-toolbar\s*\{\s*padding-left:\s*80px/);
    expect(css).toContain("overflow: clip");
  });
  it("keeps a switch in every reader focus state without adding duplicate IDs", () => {
    expect(read("components/Reader.tsx").match(/\{focusMode && workspaceSwitch\}/g)).toHaveLength(3);
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace: "hotboard", captureBusy: false, onChange: () => {} }));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="workspace-hotboard-panel"');
    expect(html).not.toMatch(/\sid=|disabled|正在捕获/);
  });
  it("disables every sidebar/focus switch while a page capture is in progress", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace: "rss", captureBusy: true, onChange: () => {} }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('role="status"');
    expect(read("WorkspaceApp.tsx")).toContain("if (captureBusy) return;");
  });
  it("routes external settings/subscription events to RSS and gates inactive shortcuts", () => {
    const app = read("App.tsx");
    expect(app).toContain("if (!active) return;\n    const onKey");
    expect(app).toContain("setModalOpen(active &&");
    expect(app).toContain('listen("tray-open-settings", () => { onRequestActivate?.();');
    expect(app).toContain('<Reader onToast={showToast} active={active}');
    expect(app).toContain('<ArticleList onToast={showToast} />');
    expect(read("components/WorkspaceSwitcher.tsx")).toContain("disabled={captureBusy}");
  });
  it("keeps the retired list-preview translator out of the production article list", () => {
    const list = read("components/ArticleList.tsx");
    expect(list).not.toMatch(/list_translate_mode|useListTranslation|listTranslateMode/);
    expect(list).not.toMatch(/enqueueVisibleTranslations|setForegroundActive|resolveRowTranslation/);
    expect(list).not.toContain('from "../listTranslation"');
    expect(list).not.toContain('from "../lib/rowTranslation"');
    expect(list).not.toMatch(/list-translate-toggle|translateStatusLoading/);
    expect(list).toContain('<h3 className="art-title">{a.title}</h3>');
    expect(list).toContain('<p className="art-snippet">{a.snippet}</p>');
  });
  it("does not mix caches, content APIs, persisted UI or credentials", () => {
    const shell = read("WorkspaceApp.tsx"), board = read("hot/HotBoard.tsx"), api = read("hot/api.ts");
    expect(shell).toContain("client={hotQueries}");
    expect(board).toContain('queryKey: ["hot", "sources"]');
    expect(board).toContain("enabled: active");
    expect(board).toContain("getHotSnapshot(source.id, false, signal)");
    expect(board).toContain('cached.stale || cached.status === "never"');
    expect(board).not.toMatch(/api\.addFeed|api\.getArticle|api\.ai|personal_mail_|useUi/);
    expect(api).toContain("createHotRequestQueue(4)");
    expect(api).not.toMatch(/localStorage|console\./);
    const auth = read("hot/SourceAuthorization.tsx");
    expect(auth).toContain('type="password"');
    expect(auth).toContain('finally { setToken("");');
    expect(auth).not.toMatch(/localStorage\.|console\.|setQueryData/);
    expect(auth).toContain("保存不会联网验证");
    expect(auth).toContain("若刚获取失败，请约 2 分钟后刷新验证。");
  });
});
