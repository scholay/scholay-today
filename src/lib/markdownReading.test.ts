import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { capturedImageSources, renderMarkdown } from "./markdown";
import { prepareObsidianMarkdown, splitMarkdownFrontmatter } from "./aiFormatted";
import { activeMarkdownHeading, isChineseParagraph, prepareMarkdownReading } from "./markdownReading";

afterEach(() => vi.unstubAllGlobals());
function preview(markdown: string, articleId = 12) {
  const dom = new JSDOM();
  vi.stubGlobal("DOMParser", dom.window.DOMParser);
  const body = splitMarkdownFrontmatter(markdown).body;
  const sanitized = renderMarkdown(prepareObsidianMarkdown(body), capturedImageSources(body));
  const result = prepareMarkdownReading(sanitized, articleId);
  return { ...result, doc: new JSDOM(result.html).window.document };
}
describe("Markdown reading navigation", () => {
  it("builds a correctly nested outline with skipped levels and duplicate Chinese headings", () => {
    const p = preview("## 文章标题\n\n### 方法\n\n##### **重复**\n\n### 结果\n\n#### 重复\n\n## 附录");
    expect(p.headings.map(h => h.level)).toEqual([2, 3, 5, 3, 4, 2]);
    expect(p.headings.map(h => h.depth)).toEqual([0, 1, 2, 1, 2, 0]);
    expect(p.outline.map(h => h.text)).toEqual(["文章标题", "附录"]);
    expect(p.outline[0].children.map(h => h.text)).toEqual(["方法", "结果"]);
    expect(p.outline[0].children[0].children[0].text).toBe("重复");
    expect(new Set(p.headings.map(h => h.id)).size).toBe(6);
    for (const heading of p.headings) expect(p.doc.getElementById(heading.id)?.textContent).toBe(heading.text);
    expect(p.doc.querySelector("h2")?.classList.contains("md-document-title")).toBe(true);
  });
  it("ignores YAML, fenced examples and blockquote headings; article anchors do not collide", () => {
    const md = '---\ntitle: "# metadata"\n---\n\n# 真正标题\n\n```md\n## 示例，不是目录\n```\n\n> ## 引用里的标题\n\n## 正文';
    expect(preview(md).headings.map(h => h.text)).toEqual(["真正标题", "正文"]);
    expect(preview(md, 12).headings[0].id).not.toBe(preview(md, 13).headings[0].id);
    expect(preview("没有标题的中文文章。").headings).toHaveLength(0);
  });
  it("does not undo sanitization, lose pictures, or modify the source", () => {
    const md = '# 标题<script>alert(1)</script>\n\n![图2](https://example.org/figure.png)\n\n图2 研究结果\n\n正文内容保持原样。';
    const original = md;
    const p = preview(md);
    expect(p.html).not.toContain("<script");
    expect(p.html).not.toContain("alert(1)");
    expect(p.doc.querySelector("img")?.getAttribute("data-captured-src")).toBe("https://example.org/figure.png");
    expect(p.doc.querySelector(".md-caption")?.textContent).toBe("图2 研究结果");
    expect(md).toBe(original);
  });
  it("tracks the current section, including the last short section", () => {
    expect(activeMarkdownHeading([], 28, false)).toBe(-1);
    expect(activeMarkdownHeading([100, 600, 1000], 28, false)).toBe(0);
    expect(activeMarkdownHeading([-500, 25, 450], 28, false)).toBe(1);
    expect(activeMarkdownHeading([-500, 25, 450], 28, true)).toBe(2);
  });
});
describe("Chinese reading typography", () => {
  it("indents Chinese prose only, not lists, quotes, metadata, captions, images or code", () => {
    const p = preview('# 标题\n\n2026-9-6 16:41\n\n本文首发于“生态学者”公众号！\n\n这是中文正文，包含 **主要信息**。\n\n- 重要列表内容\n\n> 引用文本保留原样。\n\n> [!info]\n> 来源提示是次要信息。\n\n![图](https://example.org/a.png)\n\n图2 草地研究结果\n\n原文链接：https://example.org\n\n```text\n中文代码不要缩进\n```\n\nEnglish paragraph with ordinary prose.');
    expect(Array.from(p.doc.querySelectorAll(".md-chinese-paragraph")).map(el => el.textContent)).toEqual(["这是中文正文，包含 主要信息。"]);
    expect(p.doc.querySelectorAll(".md-secondary")).toHaveLength(3);
    expect(p.doc.querySelectorAll(".md-callout")).toHaveLength(1);
    expect(p.doc.querySelectorAll(".md-caption")).toHaveLength(1);
    expect(p.doc.querySelector("li")?.textContent).toBe("重要列表内容");
    expect(p.doc.querySelector("pre")?.textContent).toBe("中文代码不要缩进\n");
  });
  it("keeps English and Japanese paragraphs unindented", () => {
    expect(isChineseParagraph("The authors include 张三 and 李四 in this study.")).toBe(false);
    expect(isChineseParagraph("これは日本語の文章です。")).toBe(false);
    expect(isChineseParagraph("本研究采用 CRISPR 技术处理样品并开展进一步分析。")).toBe(true);
  });
  it("scopes styles to Markdown and provides compact navigation without altering RSS", () => {
    const css = readFileSync(new URL("../components/ai-formatted.css", import.meta.url), "utf8");
    expect(css).toContain(".ai-formatted-body p.md-chinese-paragraph { text-indent: 2em;");
    expect(css).toContain(".md-compact .md-outline { position: absolute;");
    expect(css).not.toMatch(/\.article-body p\s*\{[^}]*text-indent/);
  });
});
