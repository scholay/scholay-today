import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reader = readFileSync(new URL("../components/Reader.tsx", import.meta.url), "utf8");
const hot = readFileSync(new URL("../hot/HotPageView.tsx", import.meta.url), "utf8");
const section = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

describe("RSS and Hot integration lifecycle boundaries", () => {
  it("uses one shared queue for both native owners and unique per-owner IDs", () => {
    for (const source of [reader, hot]) {
      expect(source).toContain('from "../lib/pageViewQueue"');
      expect(source).toContain("enqueuePageView(() => api.closePageView())");
      expect(source).not.toContain("let pageViewTask");
      expect(source.indexOf('await listen<api.PageViewStatusEvent>("page-view-status"')).toBeLessThan(source.indexOf("await api.openPageView("));
    }
    expect(reader).toContain('nextPageViewRequestId("reader")');
    expect(hot).toContain('nextPageViewRequestId("hot")');
  });

  it("binds native creation to visible Web or hidden AI capture without changing Web preference", () => {
    expect(reader).toContain('const nativePageNeeded = readerTab === "web" || nativeFormatActive;');
    expect(reader).toContain('if (!active || !nativePageNeeded || !articleUrl || !host || !a) return;');
    expect(reader).toContain("[active, nativePageNeeded, articleUrl, a?.id, webOpenAttempt]");
    expect(reader).toContain('api.openPageView(articleUrl, bounds(), requestId, initiallyVisible)');
    expect(reader).toContain('readerTabRef.current === "web" && !overlayOpenRef.current');
    const visibility = section(reader, "// Visibility:", "const clearFormatJob");
    expect(visibility).toContain("if (!active");
    expect(visibility).toContain("pageViewControllerRef.current === controller");
    expect(visibility).not.toMatch(/setViewMode|saveReaderViewPreference/);
    expect(hot).toContain("if (!active || !sourceUrl || !host) return;");
    expect(hot).toContain("[active, sourceUrl, attempt]");
  });

  it("locks only capture and always releases it while allowing model jobs to settle", () => {
    const capture = section(reader, "const captureAndFormat =", "const openFormatted =");
    expect(capture).toContain("if (!activeRef.current");
    expect(capture).toContain("captureBusyRef.current");
    expect(capture).toContain("captureBusyChangeRef.current?.(true)");
    expect(capture).toMatch(/finally\s*\{\s*captureBusyRef\.current = false;\s*captureBusyChangeRef\.current\?\.\(false\)/);
    const generate = section(reader, "const generateFormatted =", "const captureAndFormat =");
    expect(generate).not.toMatch(/activeRef|enqueuePageView|captureBusyChange/);
    expect(generate).toContain('qc.setQueryData(["ai-formatted", articleId], draft)');
  });

  it("prevents hidden RSS measurements/actions and portals from affecting Hot", () => {
    expect(reader).toContain("if (!activeRef.current || !el || !markReadOnScroll");
    expect(reader).toContain("if (active && a && !a.isRead && markReadOnOpen)");
    expect(reader).toContain('if (!active || openMode !== "extracted"');
    expect(reader).toContain("if (!active || !autoTranslateFeed");
    expect(reader).toContain("startTranslate(a.id, targetLang, engine)");
    for (const name of ["lightbox", "tagPick", "ctxMenu"]) expect(reader).toContain(`{active && ${name} && (`);
  });

  it("keeps Hot independent of RSS article state, capture and AI", () => {
    expect(hot).not.toMatch(/useUi|selectedArticleId|capturePageView|aiFormatPage|extractFulltext|startTranslate|<iframe\b/);
    expect(hot).toContain("safePageViewUrl(url)");
    expect(hot).toContain("safePageViewUrl(target)");
    expect(hot).toContain("20_000");
    expect(hot).toContain("payload.requestId !== requestId");
  });
});
