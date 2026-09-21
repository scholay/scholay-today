import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceSwitcher from "../components/WorkspaceSwitcher";
import { stepUiScale } from "./uiScale";
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
  it("hosts a persistent activity rail instead of a global toolbar row", () => {
    const shell = read("WorkspaceApp.tsx"), css = read("workspace.css");
    expect(shell).not.toContain("workspace-bar");
    expect(css).not.toContain("workspace-bar");
    expect(css).toContain("--workspace-rail-width: 48px");
    expect(css).toContain("grid-template-columns: var(--workspace-rail-width) minmax(0, 1fr)");
    expect(css).toContain(".workspace-rail-group");
    expect(css).not.toContain(".workspace-host.is-sidebar-collapsed");
    expect(css).not.toContain(".workspace-select");
    expect(css).not.toContain(".workspace-tabs");
    expect(css).not.toContain("workspace-sidebar-toggle");
    expect(css).not.toMatch(/workspace[^}]+svg\s*\{\s*display:\s*none/);
    expect(shell).not.toContain("toggleSidebar");
    expect(shell).not.toContain("event.key === \"b\"");
    for (const file of ["components/Sidebar.tsx", "hot/HotBoard.tsx"]) {
      expect(read(file)).not.toContain("workspaceSwitch");
      expect(read(file)).toContain('<div className="titlebar" data-tauri-drag-region />');
    }
    expect(read("calendar/CalendarBoard.tsx")).not.toContain("workspaceSwitch");
    expect(read("WorkspaceApp.tsx")).toContain("<TrendsWorkspace");
    expect(read("WorkspaceApp.tsx")).toContain("<CalendarBoard");
    expect(read("WorkspaceApp.tsx")).not.toContain("HomeBoard");
    expect(read("WorkspaceApp.tsx")).not.toContain("<FilesBoard");
    expect(read("styles.css")).toContain(':root[data-platform="mac"] .sidebar { padding-top: 38px; }');
    expect(read("hot/hot.css")).toContain(':root[data-platform="mac"] .hot-sidebar { padding-top: 38px; }');
    expect(read("styles.css")).toMatch(/\.titlebar\s*\{[^}]*height:\s*38px;/);
    expect(read("styles.css")).toMatch(/\.window\.focus \.reader-toolbar\s*\{\s*padding-left:\s*16px/);
    expect(css).toContain("overflow: clip");
  });
  it("keeps one host rail without adding duplicate IDs", () => {
    expect(read("components/Reader.tsx")).not.toContain("workspaceSwitch");
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace: "hot", captureBusy: false, onChange: () => {} }));
    expect(html.match(/<button/g)).toHaveLength(6);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="workspace-hotboard-panel"');
    expect(html).toContain('aria-label="工作区"');
    expect(html).toContain("workspace-rail-settings");
    expect(html).not.toMatch(/\sid=|disabled|正在捕获/);
  });
  it("disables the rail while a page capture is in progress", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace: "rss", captureBusy: true, onChange: () => {} }));
    expect(html.match(/disabled=""/g)).toHaveLength(5);
    expect(html).toContain('role="status"');
    expect(read("WorkspaceApp.tsx")).toContain("if (captureBusy) return;");
  });
  it("routes external settings/subscription events to RSS and gates inactive shortcuts", () => {
    const app = read("App.tsx");
    expect(app).toContain("if (!active) return;");
    expect(app).toContain("setModalOpen(settings.open || (active &&");
    expect(app).toContain('listen("tray-open-settings", open)');
    expect(app).toContain("papr-open-settings");
    expect(app).toContain('<ReaderWorkspace onToast={showToast} active={active}');
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
    expect(board).not.toMatch(/api\.addFeed|api\.getArticle|api\.ai|personal_mail_|selectedArticleId|markRead/);
    expect(board).toContain("state.modalOpen || state.menuOpen || state.aiOpen");
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

describe("interface scale", () => {
  it("steps through the four sizes and stops at the ends", () => {
    expect(stepUiScale("90", -1)).toBe("90");
    expect(stepUiScale("90", 1)).toBe("100");
    expect(stepUiScale("110", 1)).toBe("125");
    expect(stepUiScale("125", 1)).toBe("125");
    expect(stepUiScale("100", -1)).toBe("90");
  });
});
