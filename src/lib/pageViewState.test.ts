import { describe, expect, it } from "vitest";
import {
  applyPageViewStatus, createPageViewState, dismissPageViewNotice, isPageViewStatusEvent, markPageViewCreated,
  markPageViewError, markPageViewWaiting, pageViewExternalUrl, pageViewForArticle,
  pageViewBanner, safePageViewUrl, startPageViewWait,
} from "./pageViewState";

const state = () => createPageViewState("request-a", 11, "http://example.com/article");

describe("native page loading lifecycle", () => {
  it("does not confuse native creation with a completed network load", () => {
    expect(markPageViewCreated(state(), "request-a")).toMatchObject({ created: true, loading: true, waiting: false });
  });
  it("shows only a waiting hint after the timer and recovers on a late loaded event", () => {
    const waiting = markPageViewWaiting(state(), "request-a");
    expect(waiting).toMatchObject({ loading: true, waiting: true, error: null });
    expect(applyPageViewStatus(waiting, { requestId: "request-a", phase: "loaded", url: "https://example.com/article" }))
      .toMatchObject({ loading: false, waiting: false, error: null, currentUrl: "https://example.com/article" });
  });
  it("does not revive a completed load when an old timer fires", () => {
    const loaded = applyPageViewStatus(state(), { requestId: "request-a", phase: "loaded", url: "https://example.com/" });
    expect(markPageViewWaiting(loaded, "request-a")).toBe(loaded);
  });
  it("restarts the waiting state for a toolbar navigation without losing history identity", () => {
    const loaded = applyPageViewStatus(markPageViewCreated(state(), "request-a"), { requestId: "request-a", phase: "loaded", url: "https://example.com/new" });
    expect(startPageViewWait(loaded, "request-a")).toMatchObject({ requestId: "request-a", created: true, loading: true, currentUrl: "https://example.com/new" });
  });
  it("distinguishes a native creation failure from a failed history/reload command", () => {
    const created = markPageViewCreated(state(), "request-a");
    expect(markPageViewError(created, "request-a", "control")).toMatchObject({ created: true, error: "control", loading: false });
    expect(markPageViewError(created, "request-a", "create")).toMatchObject({ created: false, error: "create", loading: false });
  });
});

describe("page event isolation", () => {
  it("ignores prior lifecycle events, timers, errors and command completions", () => {
    const current = state();
    expect(applyPageViewStatus(current, { requestId: "old-request", phase: "loaded", url: "https://wrong.example/" })).toBe(current);
    expect(markPageViewWaiting(current, "old-request")).toBe(current);
    expect(markPageViewCreated(current, "old-request")).toBe(current);
    expect(markPageViewError(current, "old-request", "create")).toBe(current);
    expect(startPageViewWait(current, "old-request")).toBe(current);
  });
  it("does not turn a blocked iframe into a failed main load or a new toolbar address", () => {
    const current = state();
    for (const url of ["about:blank", "custom-app://open", "http://example.com/article"]) {
      const blocked = applyPageViewStatus(current, { requestId: "request-a", phase: "blocked", url });
      expect(blocked).toBe(current);
      expect(pageViewBanner(blocked)).toBeNull();
    }
  });
  it("keeps a download target separate from the page address", () => {
    expect(applyPageViewStatus(state(), { requestId: "request-a", phase: "download", url: "https://example.com/file.pdf" }))
      .toMatchObject({ currentUrl: "http://example.com/article", notice: "download", noticeUrl: "https://example.com/file.pdf", loading: true });
  });
  it("rejects malformed events and non-web loading addresses", () => {
    const current = state();
    for (const invalid of [null, {}, { requestId: "request-a", url: "https://example.com", phase: "failed" }, { requestId: 1, url: "https://example.com", phase: "loaded" }]) {
      expect(isPageViewStatusEvent(invalid)).toBe(false);
      expect(applyPageViewStatus(current, invalid)).toBe(current);
    }
    expect(applyPageViewStatus(current, { requestId: "request-a", phase: "loaded", url: "file:///tmp/private" })).toBe(current);
  });
});

describe("quiet, single-banner browser presentation", () => {
  it("does not show banners during normal loading, waiting or successful loading", () => {
    expect(pageViewBanner(state())).toBeNull();
    expect(pageViewBanner(markPageViewWaiting(state(), "request-a"))).toBeNull();
    const download = applyPageViewStatus(state(), { requestId: "request-a", phase: "download", url: "https://example.com/file.pdf" });
    const loaded = applyPageViewStatus(download, { requestId: "request-a", phase: "loaded", url: "https://example.com/article" });
    expect(loaded).toMatchObject({ loading: false, waiting: false, error: null, notice: null, noticeUrl: null });
    expect(pageViewBanner(loaded)).toBeNull();
  });
  it("shows only the actual error when a download notice also existed", () => {
    const download = applyPageViewStatus(state(), { requestId: "request-a", phase: "download", url: "https://example.com/file.pdf" });
    const failed = markPageViewError(download, "request-a", "control");
    expect(pageViewBanner(failed)).toBe("control");
    expect(failed).toMatchObject({ notice: null, noticeUrl: null });
    expect(applyPageViewStatus(failed, { requestId: "request-a", phase: "download", url: "https://example.com/other.pdf" })).toBe(failed);
  });
  it("dismisses a create error without losing its page identity or fabricating a created view", () => {
    const failed = markPageViewError(state(), "request-a", "create");
    const dismissed = dismissPageViewNotice(failed, "request-a");
    expect(pageViewBanner(dismissed)).toBeNull();
    expect(dismissed).toMatchObject({ requestId: "request-a", articleId: 11, created: false, currentUrl: "http://example.com/article", loading: false });
    expect(dismissPageViewNotice(failed, "previous-request")).toBe(failed);
  });
  it("dismisses a download without changing loading or the current address", () => {
    const download = applyPageViewStatus(state(), { requestId: "request-a", phase: "download", url: "https://example.com/file.pdf" });
    expect(pageViewBanner(download)).toBe("download");
    expect(dismissPageViewNotice(download, "request-a")).toMatchObject({ notice: null, noticeUrl: null, loading: true, currentUrl: "http://example.com/article" });
  });
  it("clears notices on navigation and allows a new actionable event after dismissal", () => {
    const download = applyPageViewStatus(state(), { requestId: "request-a", phase: "download", url: "https://example.com/file.pdf" });
    expect(pageViewBanner(startPageViewWait(download, "request-a"))).toBeNull();
    const dismissed = dismissPageViewNotice(download, "request-a");
    expect(pageViewBanner(markPageViewError(dismissed, "request-a", "control"))).toBe("control");
  });
});

describe("current page external-open safety", () => {
  it("uses the redirected URL for the current article", () => {
    const loaded = applyPageViewStatus(state(), { requestId: "request-a", phase: "loaded", url: "https://example.com/redirected" });
    expect(pageViewExternalUrl(loaded, 11, "http://example.com/article")).toBe("https://example.com/redirected");
  });
  it("never uses a previous article's URL, even when the source URLs match", () => {
    const loaded = applyPageViewStatus(state(), { requestId: "request-a", phase: "loaded", url: "https://wrong.example/" });
    expect(pageViewForArticle(loaded, 12, "http://example.com/article")).toBeNull();
    expect(pageViewExternalUrl(loaded, 12, "https://new.example/article")).toBe("https://new.example/article");
    expect(pageViewExternalUrl(loaded, 12, null)).toBeNull();
  });
  it("allows only explicit HTTP(S) targets", () => {
    for (const value of ["javascript:alert(1)", "file:///tmp/private", "tauri://localhost", "mailto:a@example.com", "blob:https://example.com/id", "about:blank", "data:text/plain,test", "relative/path"]) {
      expect(safePageViewUrl(value)).toBeNull();
    }
    expect(safePageViewUrl("HTTPS://example.com")).toBe("https://example.com/");
  });
  it("rejects URLs with embedded credentials instead of displaying or externally opening them", () => {
    expect(safePageViewUrl("https://user:secret@example.com/article")).toBeNull();
    expect(safePageViewUrl("https://user@example.com/article")).toBeNull();
    expect(pageViewExternalUrl(null, 11, "https://user:secret@example.com/article")).toBeNull();
    const current = state();
    expect(applyPageViewStatus(current, { requestId: "request-a", phase: "loaded", url: "https://user:secret@example.com/article" })).toBe(current);
  });
});
