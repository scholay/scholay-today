import { describe, expect, it } from "vitest";
import { applyHotPageViewStatus, createHotPageViewState, hotPageViewForUrl, updateHotPageView, waitForHotPageView } from "../hot/hotPageViewState";

const initial = () => createHotPageViewState("hot-current", "https://example.invalid/source");

describe("standalone Hot native source state", () => {
  it("ignores old owner events and malformed payloads", () => {
    const state = initial();
    for (const payload of [null, {}, { requestId: "reader-old", phase: "loaded", url: "https://wrong.invalid/" }]) {
      expect(applyHotPageViewStatus(state, payload)).toBe(state);
    }
  });

  it("accepts load completion before native open resolves and stays quiet", () => {
    const state = applyHotPageViewStatus(initial(), { requestId: "hot-current", phase: "loaded", url: "https://example.invalid/redirected" });
    const created = updateHotPageView(state, "hot-current", { created: true });
    expect(created).toMatchObject({ created: true, loading: false, waiting: false, error: null, downloadUrl: null, currentUrl: "https://example.invalid/redirected" });
    expect(waitForHotPageView(created, "hot-current")).toBe(created);
  });

  it("ignores blocked subframes and unsafe addresses without permanent warnings", () => {
    const state = initial();
    for (const url of ["javascript:alert(1)", "file:///private/test", "papr://subscribe", "https://name:password@example.invalid/"]) {
      expect(applyHotPageViewStatus(state, { requestId: "hot-current", phase: "loaded", url })).toBe(state);
      expect(applyHotPageViewStatus(state, { requestId: "hot-current", phase: "download", url })).toBe(state);
    }
    expect(applyHotPageViewStatus(state, { requestId: "hot-current", phase: "blocked", url: "https://example.invalid/frame" })).toBe(state);
  });

  it("marks waiting only for the current still-loading instance", () => {
    const state = initial();
    expect(waitForHotPageView(state, "old")).toBe(state);
    expect(waitForHotPageView(state, "hot-current")).toMatchObject({ waiting: true, loading: true, error: null });
  });

  it("keeps an explicit download target separate from the displayed address", () => {
    const state = applyHotPageViewStatus(initial(), { requestId: "hot-current", phase: "download", url: "https://example.invalid/file.pdf" });
    expect(state).toMatchObject({ currentUrl: "https://example.invalid/source", downloadUrl: "https://example.invalid/file.pdf" });
    const dismissed = updateHotPageView(state, "hot-current", { error: null, downloadUrl: null });
    expect(dismissed).toMatchObject({ currentUrl: "https://example.invalid/source", downloadUrl: null });
  });

  it("does not show the previous source URL after changing sources", () => {
    expect(hotPageViewForUrl(initial(), "https://next.invalid/")).toBeNull();
    expect(hotPageViewForUrl(initial(), null)).toBeNull();
    expect(hotPageViewForUrl(initial(), "https://example.invalid/source")).not.toBeNull();
  });
});
