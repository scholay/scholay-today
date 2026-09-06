import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fitPaneWidths, MIN_READER_PANE, paneResizeMax, resizePaneWidths } from "./paneGeometry";

const bounds = { sidebar: { min: 200, max: 420 }, list: { min: 300, max: 560 } };

describe("display-only pane geometry", () => {
  it("leaves saved widths exact when the viewport can accommodate them", () => {
    expect(fitPaneWidths(1763, 248, 388, bounds)).toEqual({ sidebarWidth: 248, listWidth: 388, readerWidth: 1127 });
  });
  it("fits every supported width and pane preference without starving the reader", () => {
    for (const width of [920, 1024, 1280, 1763, 2560]) for (const sidebar of [200, 248, 420]) for (const list of [300, 388, 560]) {
      const actual = fitPaneWidths(width, sidebar, list, bounds);
      expect(actual.sidebarWidth).toBeGreaterThanOrEqual(bounds.sidebar.min);
      expect(actual.listWidth).toBeGreaterThanOrEqual(bounds.list.min);
      expect(actual.readerWidth).toBeGreaterThanOrEqual(MIN_READER_PANE);
      expect(actual.sidebarWidth + actual.listWidth + actual.readerWidth).toBeCloseTo(width);
    }
  });
  it("restores preferences after a shrink/grow cycle and never mutates inputs", () => {
    const preferences = Object.freeze({ sidebar: 420, list: 560 });
    const small = fitPaneWidths(920, preferences.sidebar, preferences.list, bounds);
    expect(small.sidebarWidth).toBeLessThan(preferences.sidebar);
    expect(small.listWidth).toBeLessThan(preferences.list);
    expect(fitPaneWidths(1800, preferences.sidebar, preferences.list, bounds)).toEqual({ sidebarWidth: 420, listWidth: 560, readerWidth: 820 });
    expect(preferences).toEqual({ sidebar: 420, list: 560 });
  });
  it("starts a clamped drag from the displayed boundary without jumping to hidden preferences", () => {
    const small = fitPaneWidths(920, 420, 560, bounds);
    const sidebarIntent = small.sidebarWidth - 12;
    const afterSidebarDrag = resizePaneWidths(920, small, "sidebar", sidebarIntent, bounds);
    expect(afterSidebarDrag.sidebarWidth).toBeCloseTo(sidebarIntent);
    expect(afterSidebarDrag.listWidth).toBe(small.listWidth);
    expect(afterSidebarDrag.readerWidth).toBeCloseTo(small.readerWidth + 12);
    expect(fitPaneWidths(1763, sidebarIntent, 560, bounds).listWidth).toBe(560);
    const listIntent = small.listWidth - 20;
    const afterListDrag = resizePaneWidths(920, small, "list", listIntent, bounds);
    expect(afterListDrag.listWidth).toBeCloseTo(listIntent);
    expect(afterListDrag.sidebarWidth).toBe(small.sidebarWidth);
    expect(afterListDrag.sidebarWidth + afterListDrag.listWidth).toBeCloseTo(small.sidebarWidth + small.listWidth - 20);
    expect(afterListDrag.readerWidth).toBeCloseTo(small.readerWidth + 20);
    expect(fitPaneWidths(1763, 420, listIntent, bounds).sidebarWidth).toBe(420);
    expect(paneResizeMax(920, "sidebar", bounds, small)).toBeCloseTo(small.sidebarWidth);
    expect(paneResizeMax(920, "list", bounds, small)).toBeCloseTo(small.listWidth);
    expect(resizePaneWidths(920, afterListDrag, "list", listIntent + 10, bounds).listWidth).toBeCloseTo(listIntent + 10);
  });
  it("never produces negative geometry even below the native window minimum", () => {
    for (const width of [0, 320, 640, 800]) {
      const result = fitPaneWidths(width, 420, 560, bounds);
      expect(Object.values(result).every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
      expect(result.sidebarWidth + result.listWidth + result.readerWidth).toBeCloseTo(width);
    }
  });
  it("keeps viewport adaptation separate from persistence and uses actual drag widths", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const widths = app.slice(app.indexOf("// ── apply the draggable pane widths"), app.indexOf("// ── toast"));
    expect(widths).not.toMatch(/setPanel|localStorage|ls\.set/);
    expect(app).toContain("width={displayPanes.sidebarWidth}");
    expect(app).toContain("width={displayPanes.listWidth}");
    expect(app).toContain("setPaneResizeSnapshot(null)");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain("grid-template-columns: var(--col-sidebar) var(--col-list) minmax(0, 1fr)");
    expect(css).toMatch(/\.window\s*\{[^}]*overflow:\s*clip/s);
    expect(css).toMatch(/html, body, #root\s*\{[^}]*overflow:\s*clip/s);
    expect(readFileSync(new URL("../components/ArticleList.tsx", import.meta.url), "utf8")).toContain('className="list-title-text"');
  });
});
