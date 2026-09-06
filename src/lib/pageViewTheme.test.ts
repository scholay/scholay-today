import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePageViewDarkMode } from "./pageViewTheme";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const controller = read("src-tauri/src/page-theme-controller.js");

function fixture(background = "rgb(255, 255, 255)", readyState = "complete") {
  const body = { background };
  const engine = { enable: vi.fn(), disable: vi.fn(), setFetchMethod: vi.fn() };
  const factory = vi.fn(() => engine);
  const disconnect = vi.fn();
  const fallback = { textContent: "" };
  const mutations: (() => void)[] = [];
  const document = { body, head: {}, documentElement: body, readyState, querySelector: vi.fn((selector: string) => selector === "style.darkreader--fallback" ? fallback : null), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const instance = runInNewContext(`(${controller})`, {
    document, getComputedStyle: (node: typeof body) => ({ backgroundColor: node.background }),
    MutationObserver: class { constructor(callback: () => void) { mutations.push(callback); } observe = vi.fn(); disconnect = disconnect; },
    setTimeout, clearTimeout, Date, URL, AbortController, fetch: vi.fn(),
    location: { href: "https://example.org/article" },
  })(factory);
  return { instance, engine, factory, document, body, disconnect, fallback, mutations };
}

describe("reversible embedded webpage theme", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("follows resolved appearance and preserves an explicit opt-out", () => {
    expect(resolvePageViewDarkMode("dark", true, false)).toBe(true);
    expect(resolvePageViewDarkMode("light", true, true)).toBe(false);
    expect(resolvePageViewDarkMode(undefined, true, true)).toBe(true);
    expect(resolvePageViewDarkMode("dark", false, true)).toBe(false);
  });
  it("original mode is immediately displayable and starts no timers", () => {
    const f = fixture("rgb(255, 255, 255)", "loading");
    f.instance.setEnabled(false);
    expect(f.instance.isReadyToDisplay()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("waits for first CSS render and a quiet interval, not just enable() returning", () => {
    const f = fixture();
    f.instance.setEnabled(true);
    expect(f.instance.isReadyToDisplay()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(f.engine.enable).toHaveBeenCalledTimes(1);
    expect(f.engine.enable.mock.calls[0][0]).toMatchObject({ immediateModify: true });
    expect(f.instance.isReadyToDisplay()).toBe(false);
    vi.advanceTimersByTime(119);
    f.mutations[0]();
    vi.advanceTimersByTime(119);
    expect(f.instance.isReadyToDisplay()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(f.instance.isReadyToDisplay()).toBe(true);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits while engine fallback styles are still in use", () => {
    const f = fixture();
    f.fallback.textContent = "html { background: black; }";
    f.instance.setEnabled(true);
    vi.advanceTimersByTime(300);
    expect(f.instance.isReadyToDisplay()).toBe(false);
    f.fallback.textContent = "";
    expect(f.instance.isReadyToDisplay()).toBe(true);
  });
  it("opt-out immediately interrupts preparation and removes temporary observers", () => {
    const f = fixture();
    f.instance.setEnabled(true);
    vi.advanceTimersByTime(100);
    f.instance.setEnabled(false);
    expect(f.instance.isReadyToDisplay()).toBe(true);
    expect(f.engine.disable).toHaveBeenCalledOnce();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not leave an unreadable page hidden forever when styles never settle", () => {
    const f = fixture();
    f.fallback.textContent = "still loading";
    f.instance.setEnabled(true);
    vi.advanceTimersByTime(7999);
    expect(f.instance.isReadyToDisplay()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(f.instance.isReadyToDisplay()).toBe(true);
    expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it("does nothing until requested and enables only once across repeated load events", () => {
    const f = fixture();
    expect(f.factory).not.toHaveBeenCalled();
    f.instance.setEnabled(true);
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    expect(f.engine.enable).toHaveBeenCalledTimes(1);
    expect(f.engine.enable.mock.calls[0][1]).toMatchObject({ ignoreImageAnalysis: ["*"], disableStyleSheetsProxy: true, invert: [] });
  });
  it("disables the engine without reloading and can enable it again", () => {
    const f = fixture();
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    f.instance.setEnabled(false);
    expect(f.engine.disable).toHaveBeenCalledTimes(1);
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    expect(f.engine.enable).toHaveBeenCalledTimes(2);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it("cancels pending work when dark mode is disabled before DOM readiness", () => {
    const f = fixture("rgb(255, 255, 255)", "loading");
    f.instance.setEnabled(true);
    expect(f.document.addEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function), { once: true });
    f.instance.setEnabled(false);
    vi.runOnlyPendingTimers();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.document.removeEventListener).toHaveBeenCalled();
  });
  it("leaves native dark surfaces alone and cleans up its small observer", () => {
    const f = fixture("rgb(20, 25, 30)");
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    expect(f.factory).not.toHaveBeenCalled();
    f.instance.setEnabled(false);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });
  it("does not disable or replace the website's own Dark Reader styles", () => {
    const f = fixture();
    f.document.querySelector.mockReturnValue({} as never);
    f.instance.setEnabled(true);
    vi.runOnlyPendingTimers();
    f.instance.setEnabled(false);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.engine.disable).not.toHaveBeenCalled();
  });
  it("fails open to the unmodified website if its styling engine fails", () => {
    const f = fixture();
    f.engine.enable.mockImplementation(() => { throw new Error("unsupported CSS"); });
    f.instance.setEnabled(true);
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(f.engine.disable).toHaveBeenCalled();
  });
  it("ships the pinned local engine and license, never a CDN loader or native fetch proxy", () => {
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
    expect(normalize(read("src-tauri/vendor/darkreader.js"))).toBe(normalize(read("node_modules/darkreader/darkreader.js")));
    expect(normalize(read("src-tauri/vendor/DARKREADER-LICENSE"))).toBe(normalize(read("node_modules/darkreader/LICENSE")));
    expect(controller).toContain("credentials: 'omit'");
    expect(controller).toContain("mode: 'cors'");
    expect(controller).not.toMatch(/__TAURI|invoke\(|api\.|innerHTML|innerText|localStorage|document\.cookie/);
    expect(read("src/components/Reader.tsx")).toContain("<WebThemeToggle");
    expect(read("src/hot/HotPageView.tsx")).toContain("<WebThemeToggle");
    expect(read("src/App.tsx")).toContain('api.setPageViewTheme(webDarkMode && effectiveMode === "dark")');
    const store = read("src/store.ts");
    expect(store.slice(store.indexOf("const PREF_KEYS"), store.indexOf("function loadPrefs"))).toContain('"webDarkMode"');
    expect(store).toContain('webDarkMode: ls.bool("pref.webDarkMode", true)');
  });
});
