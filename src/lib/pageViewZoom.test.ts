import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { formatPageZoom, isPageViewZoomEvent } from "./pageViewZoom";

const controller = readFileSync(new URL("../../src-tauri/src/page_zoom.js", import.meta.url), "utf8");

function fixture(innerWidth = 640, scrollWidth = 1280) {
  const html = { scrollWidth, style: { zoom: "" } };
  const body = { scrollWidth };
  const head = { appended: [] as { name: string; content: string }[], appendChild(node: { name: string; content: string }) { this.appended.push(node); } };
  const listeners: Record<string, ((event: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; key?: string; deltaY?: number }) => void)[]> = {};
  const document = {
    documentElement: html,
    body,
    head,
    readyState: "complete",
    querySelector: vi.fn(() => null),
    createElement: () => ({ name: "", content: "", setAttribute(key: string, value: string) { if (key === "name") this.name = value; if (key === "content") this.content = value; } }),
    addEventListener: vi.fn(),
  };
  const instance = runInNewContext(`(${controller})()`, {
    document,
    window: {
      innerWidth,
      addEventListener: (type: string, handler: (event: never) => void) => {
        (listeners[type] ??= []).push(handler);
      },
    },
    ResizeObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { fn(); return 1; },
    clearTimeout: () => {},
    Number,
    Math,
    JSON,
  });
  return { instance, html, head, listeners };
}

describe("embedded webpage zoom", () => {
  it("fits overflowing pages to the current pane and keeps already-fitting pages at 100%", () => {
    const wide = fixture(640, 1280);
    expect(wide.instance.fit()).toEqual({ factor: 0.5, mode: "fit" });
    expect(wide.html.style.zoom).toBe("0.5");
    expect(fixture(800, 790).instance.fit()).toEqual({ factor: 1, mode: "fit" });
  });

  it("clamps manual zoom and restores actual size without executing page scripts", () => {
    const page = fixture();
    expect(page.instance.set(9)).toEqual({ factor: 3, mode: "manual" });
    expect(page.instance.adjust(-0.2)).toEqual({ factor: 2.8, mode: "manual" });
    expect(page.instance.reset()).toEqual({ factor: 1, mode: "manual" });
    expect(controller).not.toMatch(/__TAURI|invoke\(|document\.cookie|localStorage|innerHTML/);
  });

  it("adds a missing responsive viewport without rewriting one the site already set", () => {
    const missing = fixture();
    expect(missing.head.appended.map(({ name, content }) => ({ name, content }))).toEqual([
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ]);
    const html = { scrollWidth: 800, style: { zoom: "" } };
    const head = { appended: [] as { name: string; content: string }[], appendChild(node: { name: string; content: string }) { this.appended.push(node); } };
    runInNewContext(`(${controller})()`, {
      document: {
        documentElement: html, body: html, head, readyState: "complete",
        querySelector: () => ({ name: "viewport" }),
        createElement: () => ({ setAttribute() {} }),
        addEventListener: () => {},
      },
      window: { innerWidth: 800, addEventListener: () => {} },
      ResizeObserver: class { observe() {} },
      setTimeout: (fn: () => void) => { fn(); return 1; },
      clearTimeout: () => {},
      Number, Math, JSON,
    });
    expect(head.appended).toEqual([]);
  });

  it("zooms from modifier keys and wheel without granting IPC", () => {
    const page = fixture();
    const preventDefault = vi.fn();
    page.listeners.keydown[0]({ preventDefault, metaKey: true, key: "=" });
    expect(page.instance.read()).toEqual({ factor: 1.1, mode: "manual" });
    page.listeners.keydown[0]({ preventDefault, metaKey: true, key: "0" });
    expect(page.instance.read()).toEqual({ factor: 1, mode: "manual" });
    page.listeners.wheel[0]({ preventDefault, ctrlKey: true, deltaY: 40 });
    expect(page.instance.read().factor).toBe(0.9);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("accepts only finite public zoom events", () => {
    expect(isPageViewZoomEvent({ requestId: "reader-1", factor: 0.8, mode: "fit" })).toBe(true);
    expect(isPageViewZoomEvent({ requestId: "reader-1", factor: 1, mode: "steal" })).toBe(false);
    expect(isPageViewZoomEvent({ requestId: "reader-1", factor: Number.NaN, mode: "manual" })).toBe(false);
    expect(formatPageZoom(0.724)).toBe("72%");
  });
});
