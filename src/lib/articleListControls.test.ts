import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ArticleListControls from "../components/ArticleListControls";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("title-strip controls", () => {
  it("puts the same callbacks above the list title without changing data actions", () => {
    const list = read("components/ArticleList.tsx");
    expect(list.indexOf("<ArticleListControls")).toBeLessThan(list.indexOf('<h1 className="list-title"'));
    expect(list).toContain("onToggleSort={toggleSort} onToggleUnreadOnly={toggleUnreadOnly} onMarkAll={markAll}");
    expect(list).not.toContain('className="list-meta"');
  });
  it("keeps all three actions accessible when the narrow layout hides a label", () => {
    for (const state of [false, true]) {
      const html = renderToStaticMarkup(createElement(ArticleListControls, { sortOldest: state, unreadOnly: state, onToggleSort: () => {}, onToggleUnreadOnly: () => {}, onMarkAll: () => {} }));
      expect(html.match(/<button/g)).toHaveLength(3);
      expect(html).toContain('aria-label="articleList.markRead"');
      expect(html).toContain('title="articleList.markAllRead"');
      expect(html.match(new RegExp(`aria-pressed="${state}"`, "g"))).toHaveLength(2);
    }
  });
  it("keeps controls single-row and out of native drag hit regions", () => {
    const css = read("styles.css"), workspace = read("workspace.css");
    expect(css).toMatch(/\.list-meta\s*\{[^}]*height: 38px;[^}]*flex-wrap: nowrap;/);
    expect(css).toContain("@container list-heading (max-width: 330px)");
    expect(css).toMatch(/\.list-meta-btn\s*\{[^}]*-webkit-app-region: no-drag;/);
    expect(workspace).toContain(':root[data-platform="mac"] .workspace-sidebar-heading .workspace-tabs { left: 80px;');
    expect(workspace).toMatch(/\.workspace-sidebar-heading \.workspace-tabs\s*\{[^}]*top: 6px;[^}]*z-index: 51;/);
    expect(workspace).toContain('.reader-toolbar .workspace-brand { display: none; }');
  });
});
