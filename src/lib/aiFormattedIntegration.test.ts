import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { aiFormatPage, capturePageView, getAiFormatted } from "../api";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("explicit AI formatted IPC", () => {
  beforeEach(() => { invoke.mockReset(); });
  it("keeps local capture, saved-draft reads and provider requests separate", async () => {
    invoke.mockResolvedValueOnce({ captureId: "opaque-1" }).mockResolvedValueOnce(null);
    await expect(capturePageView(12, "page-unique")).resolves.toEqual({ captureId: "opaque-1" });
    await expect(getAiFormatted(12)).resolves.toBeNull();
    expect(invoke.mock.calls).toEqual([
      ["capture_page_view", { articleId: 12, requestId: "page-unique" }],
      ["get_ai_formatted", { articleId: 12 }],
    ]);
  });
  it("sends only an opaque capture ID, defaults to Chinese and preserves explicit language", async () => {
    invoke.mockResolvedValue({ markdown: "# Test" });
    await aiFormatPage(12, "opaque-1");
    await aiFormatPage(12, "opaque-1", "ja");
    expect(invoke.mock.calls).toEqual([
      ["ai_format_page", { articleId: 12, captureId: "opaque-1", language: "zh" }],
      ["ai_format_page", { articleId: 12, captureId: "opaque-1", language: "ja" }],
    ]);
  });
  it("propagates backend errors without manufacturing an empty replacement draft", async () => {
    invoke.mockRejectedValue("AI request failed");
    await expect(aiFormatPage(12, "opaque-1")).rejects.toBe("AI request failed");
  });
});

describe("AI reader integration boundaries", () => {
  it("opens AI immediately, then captures one loaded matching native page before formatting", () => {
    const reader = read("components/Reader.tsx");
    const capture = reader.slice(reader.indexOf("const captureAndFormat ="), reader.indexOf("const openFormatted ="));
    const captureAt = capture.indexOf("await controller.capture()");
    const guardAt = capture.indexOf("isCurrentCapture(");
    const generateAt = capture.indexOf("void generateFormatted(");
    expect(captureAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(captureAt);
    expect(generateAt).toBeGreaterThan(guardAt);
    expect(capture).not.toMatch(/saveReaderViewPreference|closePageView|setPageViewVisible/);
    const automatic = reader.slice(reader.indexOf("// Capture only after"), reader.indexOf("const openFormatted ="));
    expect(automatic).toContain("currentPageView?.created");
    expect(automatic).toContain("currentPageView.loading");
    expect(automatic).toContain("controller.requestId !== currentPageView.requestId");
    expect(automatic).toContain("formatCaptureClaimRef.current = claim");
    expect(automatic).toContain("void captureAndFormat(articleId, runId, formatLanguage)");
    const open = reader.slice(reader.indexOf("const openFormatted ="), reader.indexOf("const reformat ="));
    expect(open).toContain("setFormattedArticleId(a.id)");
    expect(open).toContain("beginFormatPipeline(a.id, articleUrl)");
    expect(reader).toContain('qc.setQueryData(["ai-formatted", articleId], draft)');
    expect(reader).toContain('readerTabForArticle(viewMode, formattedArticleId, a?.id)');
    expect(reader).toContain('phase: "opening"');
    expect(reader).toContain('api.openPageView(articleUrl, bounds(), requestId, initiallyVisible)');
    expect(reader).toContain('nativeFormatActive && <div className="ai-format-page-host"');
    expect(reader).not.toMatch(/formatPromptArticleId|ai-format-capture|captureConsent/);
    expect(reader).not.toMatch(/saveReaderViewPreference\("formatted"/);
    expect(reader.match(/<ReaderViewOutlet\b/g)).toHaveLength(1);
    expect(reader.match(/<AIFormatted\b/g)).toHaveLength(1);
    expect(reader).toContain("key={readerViewKey(a.id, readerTab)}");
    expect(reader).toContain("key={readerSummaryKey(a.id)}");
    expect(reader).toContain("renderFormatted={() => (");
    expect(reader).toContain("renderWeb={() => (");
    expect(reader).toContain("renderReading={() => (");
    expect(reader).toContain("key={`highlights-${a.id}-${readerTab}`}");
    expect(reader).toContain("[readerTab, a?.id, a?.url, showExtracted, a?.extractedHtml, showTranslation, a?.translatedHtml]");
    expect(reader).toMatch(/aria-pressed=\{readerTab === "reader"\}\s+disabled=\{formatJob\?\.phase === "capturing"\}/);
    expect(reader).toMatch(/aria-pressed=\{readerTab === "web"\}\s+disabled=\{!a\.url \|\| formatJob\?\.phase === "capturing"\}/);
  });
  it("keeps preview HTML behind the shared sanitizer and raw metadata/text in escaped React nodes", () => {
    const component = read("components/AIFormatted.tsx");
    expect(component).toContain('import { renderMarkdown } from "../lib/markdown"');
    expect(component).toContain("renderMarkdown(prepareObsidianMarkdown(parts.body))");
    expect(component.match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
    expect(component).toContain("dangerouslySetInnerHTML={{ __html: html }}");
    expect(component).toContain("<pre>{parts.frontmatter}</pre>");
    expect(component).toContain("<pre>{draft.sourceText}</pre>");
    expect(component).toContain("value={draft.markdown}");
    expect(component).toContain("value={capturedOnly.sourceText}");
    expect(component).toContain("capturedSourceForPreview(Boolean(draft), job)");
    expect(component.indexOf("</> : capturedOnly ?")).toBeLessThan(component.indexOf('t("aiFormatted.emptyHint")'));
    expect(component).toContain('"text/markdown;charset=utf-8"');
  });
  it("has matching English, Chinese and Japanese copy with the exact tab name", () => {
    const copies = ["en", "zh", "ja"].map((locale) => JSON.parse(read(`locales/${locale}.json`)).aiFormatted);
    for (const copy of copies) {
      expect(copy.tab).toBe("AI formatted");
      expect(Object.keys(copy).sort()).toEqual(Object.keys(copies[0]).sort());
      expect(Object.values(copy).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    }
  });
});
