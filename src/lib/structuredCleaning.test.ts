import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { articleStructuredDocument, listStructuredDocuments } from "../api";
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
  it("lists stored cleanings for the files workspace without recleaning", async () => {
    invoke.mockResolvedValueOnce([{ articleId: 12, cleanedAt: "2026-09-01" }]);
    await expect(listStructuredDocuments()).resolves.toEqual([{ articleId: 12, cleanedAt: "2026-09-01" }]);
    expect(invoke.mock.calls).toEqual([["list_structured_documents"]]);
  });
});

describe("structured Markdown body", () => {
  it("retains an ordered list's starting number through sanitization", () => {
    const dom = new JSDOM();
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    try {
      const rendered = new JSDOM(renderMarkdown("3. First step\n4. Next step"));
      expect(rendered.window.document.querySelector("ol")?.getAttribute("start")).toBe("3");
      expect(rendered.window.document.querySelectorAll("li")).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });
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

  it("shows the stored document on the Markdown tab and leaves RSS original untouched", () => {
    const reader = read("components/Reader.tsx");
    const formatted = read("components/AIFormatted.tsx");
    expect(reader).toContain('queryKey: ["structured", id]');
    expect(reader).toContain("api.articleStructuredDocument(id as number)");
    expect(reader).toContain("structured={structuredDoc}");
    expect(reader).toContain("markdownLookupState(");
    expect(reader).toContain("Boolean(structuredDoc?.markdown?.trim())");
    expect(reader).toContain("const baseBody = (showExtracted ? a?.extractedHtml || a?.contentHtml : a?.contentHtml) || \"\";");
    expect(reader).not.toContain("usingStructured");
    expect(reader).not.toContain("structuredMarkup");
    expect(reader).not.toMatch(/article_clean|articleClean/);
    expect(formatted).toContain("const markdown = draft?.markdown ?? structuredMarkdown;");
    expect(formatted).toContain('className="reader-structured"');
    expect(formatted).toContain("t(`reader.structuredSource.${structured.sourceKind}`");
    expect(formatted).toContain("fetchCapturedImage(articleId, captureId, src)");
    expect(reader.match(/<ReaderViewOutlet\b/g)).toHaveLength(1);
  });
});
