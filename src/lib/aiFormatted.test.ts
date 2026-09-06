import { describe, expect, it } from "vitest";
import { capturedSourceForPreview, DEFAULT_FORMAT_LANGUAGE, dismissAiFormatError, formattedMarkdownFilename, isAiFormatBusy, isAiFormatLanguage, isCurrentCapture, prepareObsidianMarkdown, readerTabForArticle, settleAiFormatJob, splitMarkdownFrontmatter, type AiFormatJob } from "./aiFormatted";
import { markdownCacheAction } from "./aiFormatted";

describe("Markdown cache-first entry", () => {
  it("starts generation only after a confirmed local cache miss", () => {
    expect(markdownCacheAction("pending", true, false)).toBe("wait");
    expect(markdownCacheAction("pending", false, false)).toBe("wait");
    expect(markdownCacheAction("success", true, false)).toBe("wait");
    expect(markdownCacheAction("error", false, false)).toBe("error");
    expect(markdownCacheAction("error", true, false)).toBe("wait");
    expect(markdownCacheAction("success", false, false)).toBe("generate");
  });
  it("reuses saved Markdown without loading a page or invoking AI", () => {
    expect(markdownCacheAction("success", false, true)).toBe("cached");
    expect(markdownCacheAction("success", true, true)).toBe("cached");
    expect(markdownCacheAction("error", false, true)).toBe("cached");
  });
  it("lets explicit reformatting proceed while preserving the old draft", () => {
    expect(markdownCacheAction("success", false, true, true)).toBe("generate");
    expect(markdownCacheAction("success", true, true, true)).toBe("generate");
    expect(markdownCacheAction("error", false, true, true)).toBe("generate");
  });
});

describe("AI formatted article isolation", () => {
  it("defaults to Simplified Chinese without depending on the UI language", () => {
    expect(DEFAULT_FORMAT_LANGUAGE).toBe("zh");
    expect(["zh", "en", "ja"].every(isAiFormatLanguage)).toBe(true);
    expect(isAiFormatLanguage("auto")).toBe(false);
  });
  it("overlays AI only for the selected article and leaves the base Web preference intact", () => {
    expect(readerTabForArticle("web", 12, 12)).toBe("formatted");
    expect(readerTabForArticle("web", 12, 13)).toBe("web");
    expect(readerTabForArticle("web", null, 12)).toBe("web");
    expect(readerTabForArticle("reader", 12, undefined)).toBe("reader");
  });
  it("rejects captures from a switched article or replaced native instance", () => {
    expect(isCurrentCapture(12, "page-a", 12, "page-a")).toBe(true);
    expect(isCurrentCapture(12, "page-a", 13, "page-a")).toBe(false);
    expect(isCurrentCapture(12, "page-a", 12, "page-b")).toBe(false);
    expect(isCurrentCapture(12, "page-a", null, undefined)).toBe(false);
  });
  it("treats opening, capture and formatting as one busy pipeline", () => {
    const job = (phase: AiFormatJob["phase"]): AiFormatJob => ({ runId: 1, phase, captureId: null, error: phase === "failed" ? "stopped" : null });
    expect(isAiFormatBusy(job("opening"))).toBe(true);
    expect(isAiFormatBusy(job("capturing"))).toBe(true);
    expect(isAiFormatBusy(job("formatting"))).toBe(true);
    expect(isAiFormatBusy(job("failed"))).toBe(false);
    expect(isAiFormatBusy(null)).toBe(false);
  });
  it("settles only the originating run and keeps failed captured text available to retry", () => {
    const jobs: Record<number, AiFormatJob> = {
      12: { runId: 4, phase: "formatting", captureId: "capture-a", error: null },
      13: { runId: 5, phase: "capturing", captureId: null, error: null },
    };
    expect(settleAiFormatJob(jobs, 12, 3, null)).toBe(jobs);
    expect(settleAiFormatJob(jobs, 12, 3, "late failure")).toBe(jobs);
    const failed = settleAiFormatJob(jobs, 12, 4, "Provider unavailable");
    expect(failed[12]).toEqual({ ...jobs[12], phase: "failed", error: "Provider unavailable" });
    expect(failed[13]).toBe(jobs[13]);
    expect(settleAiFormatJob(failed, 12, 4, null)).toEqual({ 13: jobs[13] });
    expect(jobs[12].phase).toBe("formatting");
  });
  it("shows an existing capture after generation fails without replacing a saved draft's preview", () => {
    const source = { sourceUrl: "https://example.org/actual-page", sourceTitle: "Actual page", sourceText: "<script>plain captured text</script>", capturedAt: "2026-08-30T12:00:00Z", charCount: 36, truncated: true, warnings: ["Truncated"] };
    const job: AiFormatJob = { runId: 4, phase: "formatting", captureId: "same-capture", source, error: null };
    const failed = settleAiFormatJob({ 12: job }, 12, 4, "Generation rejected");
    expect(capturedSourceForPreview(false, failed[12])).toBe(source);
    expect(capturedSourceForPreview(true, failed[12])).toBeNull();
    expect(capturedSourceForPreview(false, { ...job, captureId: null })).toBeNull();
    const dismissed = dismissAiFormatError(failed, 12);
    expect(dismissed[12].error).toBeNull();
    expect(dismissed[12].captureId).toBe("same-capture");
    expect(capturedSourceForPreview(false, dismissed[12])?.sourceText).toBe(source.sourceText);
  });
});

describe("Obsidian-compatible Markdown preparation", () => {
  it("separates frontmatter as inert text and preserves the body", () => {
    expect(splitMarkdownFrontmatter('---\ntitle: "<script>unsafe</script>"\ntags: [rss]\n---\n\n# 标题\n正文')).toEqual({ frontmatter: 'title: "<script>unsafe</script>"\ntags: [rss]', body: "# 标题\n正文" });
    expect(splitMarkdownFrontmatter("\uFEFF---\r\nsource: example\r\n...\r\nBody")).toEqual({ frontmatter: "source: example", body: "Body" });
  });
  it("does not eat an unterminated frontmatter block or a later horizontal rule", () => {
    for (const body of ["---\ntitle: unfinished", "# Title\n---\nBody"]) expect(splitMarkdownFrontmatter(body)).toEqual({ frontmatter: null, body });
  });
  it("previews nested/folded callouts without creating HTML", () => {
    expect(prepareObsidianMarkdown("> [!note] 标题\n> 内容\n>> [!warning]- Nested")).toBe("> **NOTE** · 标题\n> 内容\n>> **WARNING** · Nested");
    expect(prepareObsidianMarkdown("> [!tip]\n> - one\n> - two")).toBe("> **TIP**\n> - one\n> - two");
  });
  it("leaves fenced examples and ordinary tables unchanged", () => {
    const text = "````md\n> [!note] literal\n```\n> [!tip] still literal\n````\n| A | B |\n|---|---|\n| 1 | 2 |";
    expect(prepareObsidianMarkdown(text)).toBe(text);
    expect(prepareObsidianMarkdown("~~~\n> [!note]\n~~~")).toBe("~~~\n> [!note]\n~~~");
    expect(prepareObsidianMarkdown("> ```md\n> [!note] literal\n> ```")).toBe("> ```md\n> [!note] literal\n> ```");
  });
  it("does not turn untrusted callout names into HTML or attributes", () => {
    const attack = '> [!<img src=x onerror=alert(1)>] raw';
    expect(prepareObsidianMarkdown(attack)).toBe(attack);
  });
  it("exports portable single filenames, never title-derived paths", () => {
    expect(formattedMarkdownFilename("研究 / 结果: 表格?", 12)).toBe("研究 结果 表格.md");
    expect(formattedMarkdownFilename("../\\\u0000...", 12)).toBe("article-12.md");
    expect(formattedMarkdownFilename("CON", 12)).toBe("article-CON.md");
    expect(Array.from(formattedMarkdownFilename("研".repeat(130), 12)).length).toBe(103);
  });
});
