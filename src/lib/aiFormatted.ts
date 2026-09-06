import type { ReaderViewMode } from "./readerViewMode";

/** Formatting is independent of the app's display language and Web preference. */
export const DEFAULT_FORMAT_LANGUAGE = "zh";
export type AiFormatLanguage = "zh" | "en" | "ja";
export type ReaderTab = ReaderViewMode | "formatted";
export type AiFormatPhase = "opening" | "capturing" | "formatting" | "failed";
export interface AiFormatSource {
  sourceUrl: string;
  sourceTitle: string;
  sourceText: string;
  capturedAt: string;
  truncated: boolean;
  charCount: number;
  warnings: string[];
}

/** A captured page is useful evidence even before an AI document exists.
 *  A saved document always keeps its own preview and source selection. */
export function capturedSourceForPreview(hasDraft: boolean, job: AiFormatJob | null): AiFormatSource | null {
  return !hasDraft && job?.captureId && job.source ? job.source : null;
}

export function dismissAiFormatError(jobs: Record<number, AiFormatJob>, articleId: number): Record<number, AiFormatJob> {
  const job = jobs[articleId];
  return job?.phase === "failed" && job.error ? { ...jobs, [articleId]: { ...job, error: null } } : jobs;
}
export interface AiFormatJob {
  runId: number;
  phase: AiFormatPhase;
  captureId: string | null;
  error: string | null;
  source?: AiFormatSource;
}

/** Opening the source page is part of the same user-requested pipeline as its
 *  capture and formatting. A terminal failure is the only non-busy job. */
export function isAiFormatBusy(job: AiFormatJob | null | undefined): boolean {
  return job?.phase === "opening" || job?.phase === "capturing" || job?.phase === "formatting";
}

/** Late completion from an older run cannot clear a replacement job. Draft
 *  storage is deliberately separate: an error changes only this job state. */
export function settleAiFormatJob(jobs: Record<number, AiFormatJob>, articleId: number, runId: number, error: string | null): Record<number, AiFormatJob> {
  const job = jobs[articleId];
  if (!job || job.runId !== runId) return jobs;
  if (error !== null) return { ...jobs, [articleId]: { ...job, phase: "failed", error } };
  const next = { ...jobs };
  delete next[articleId];
  return next;
}

export function isAiFormatLanguage(value: string): value is AiFormatLanguage {
  return value === "zh" || value === "en" || value === "ja";
}

export function readerTabForArticle(baseMode: ReaderViewMode, formattedArticleId: number | null, articleId: number | undefined): ReaderTab {
  return articleId !== undefined && formattedArticleId === articleId ? "formatted" : baseMode;
}

/** Capturing a native view must finish before switching away from that view.
 *  Both the selected article and the native instance must still match. */
export function isCurrentCapture(articleId: number, requestId: string, selectedArticleId: number | null, activeRequestId: string | undefined): boolean {
  return articleId === selectedArticleId && requestId === activeRequestId;
}

export function splitMarkdownFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const text = markdown.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: null, body: text };
  const end = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  if (end < 0) return { frontmatter: null, body: text };
  // YAML remains plain text. Do not execute tags, deserialize objects, or put
  // its values into DOM attributes. The complete original is kept for export.
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

/** Obsidian callouts degrade to ordinary Markdown blockquotes with a bold
 *  label. This produces no HTML and still goes through renderMarkdown's
 *  allowlist sanitizer. Fenced examples remain literal; folds preview open. */
export function prepareObsidianMarkdown(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;
  return markdown.split("\n").map((line) => {
    const match = /^(?:\s{0,3}>\s*)*\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = { marker: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.marker && match[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^(\s{0,3}(?:>\s*)+)\[!([A-Za-z][\w-]*)\][+-]?(?:\s+(.*))?$/, (_all, quote: string, kind: string, title: string | undefined) =>
      `${quote}**${kind.toUpperCase()}**${title ? ` · ${title}` : ""}`);
  }).join("\n");
}

export function formattedMarkdownFilename(title: string, articleId: number): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  const basename = Array.from(cleaned).slice(0, 100).join("").replace(/[. ]+$/, "") || `article-${articleId}`;
  return `${/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(basename) ? `article-${basename}` : basename}.md`;
}
