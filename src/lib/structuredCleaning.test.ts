import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { articleStructuredDocument } from "../api";
import { libraryPermissions } from "./integrations";
import { capturedImageSources, renderMarkdown } from "./markdown";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("structured cleaning IPC", () => {
  beforeEach(() => { invoke.mockReset(); });
  it("reads a stored cleaning locally and gates every capability separately", async () => {
    invoke.mockResolvedValueOnce({ articleId: 12, cleaned: false }).mockResolvedValueOnce(undefined);
    await expect(articleStructuredDocument(12)).resolves.toEqual({ articleId: 12, cleaned: false });
    await libraryPermissions({ enabled: true, writable: false, articles: true, articleClean: false });
    expect(invoke.mock.calls).toEqual([
      ["article_structured_document", { articleId: 12 }],
      ["library_permissions", { enabled: true, writable: false, articles: true, articleClean: false }],
    ]);
  });
});

describe("structured reading body", () => {
  it("sanitizes the stored Markdown and keeps images as verified references", () => {
    const dom = new JSDOM();
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    const markdown = "## 方法\n\n正文<script>alert(1)</script>\n\n![图一](<https://example.org/a.png>)\n\n![伪造](<https://evil.example/x.png>)";
    // Only images the cleaning itself recorded become references at all.
    const sources = capturedImageSources(markdown.replace(/!\[伪造\][^\n]*/, ""));
    const doc = new JSDOM(renderMarkdown(markdown, sources)).window.document;
    expect(doc.querySelector("h2")?.textContent).toBe("方法");
    expect(doc.body.innerHTML).not.toContain("alert(1)");
    expect(doc.querySelectorAll("img")).toHaveLength(1);
    const img = doc.querySelector("img")!;
    expect(img.getAttribute("data-captured-src")).toBe("https://example.org/a.png");
    expect(img.hasAttribute("src")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("wires the Reading tab to the stored document without adding a tab or a fetch", () => {
    const reader = read("components/Reader.tsx");
    expect(reader).toContain('import { capturedImageSources, renderMarkdown } from "../lib/markdown"');
    expect(reader).toContain('queryKey: ["structured", id]');
    expect(reader).toContain("api.articleStructuredDocument(id as number)");
    expect(reader).toContain("renderMarkdown(structuredSource, structuredImages)");
    expect(reader).toContain("const usingStructured = Boolean(structuredMarkup) && !showExtracted;");
    expect(reader).toContain("api.fetchCapturedImage(id, captureId, src)");
    // The provenance note sits above the shared body element; no new tab, and
    // the reader never asks the app to clean anything.
    expect(reader).toContain('className="reader-structured"');
    expect(reader).toContain("t(`reader.structuredSource.${structuredDoc.sourceKind}`");
    expect(reader.match(/<ReaderViewOutlet\b/g)).toHaveLength(1);
    expect(reader).not.toMatch(/article_clean|articleClean/);
  });
});
