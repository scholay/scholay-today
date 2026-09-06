import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the actual fixed script's root selection, with a small rendered
// DOM stand-in. Native end-to-end QA additionally covers text/markup capture.
const source = readFileSync(new URL("../../src-tauri/src/page_view.rs", import.meta.url), "utf8");
const script = source.split('const CAPTURE_SCRIPT: &str = r#"')[1].split('"#;')[0];
const selection = script.slice(0, script.indexOf("  // This verified site")) + "return {root, excluded}; })()";

class Element {
  parentElement: Element | null = null;
  hidden = false;
  constructor(readonly id: string, readonly blocks = 1) {}
  closest(selector: string): Element | null {
    if (selector === "#templateF") return this.parentElement?.id === "templateF" ? this.parentElement : null;
    return null;
  }
  getClientRects() { return this.hidden ? [] : [{}]; }
  querySelectorAll() { return Array.from({ length: this.blocks }, () => ({})); }
}

function select(hostname = "www.nstc.gov.tw", pathname = "/folksonomy/detail/test", hidden = false, panelPresent = true) {
  const body = new Element("body", 100);
  const panel = new Element("templateF");
  const article = new Element("articleContent");
  article.hidden = hidden;
  article.parentElement = panelPresent ? panel : null;
  const main = new Element("main", 20);
  const talent = new Element("showtable");
  const blog = new Element("blog_article");
  blog.hidden = hidden;
  const result = runInNewContext(selection, {
    location: { hostname, pathname },
    document: {
      body,
      querySelector: (selector: string) => selector === "#articleContent" ? article : selector === "div#showtable" ? talent : selector === "div#blog_article" ? blog : null,
      querySelectorAll: () => [main],
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  return { ...result, body, panel, article, main, talent, blog };
}

describe("rendered page capture root", () => {
  it("selects ScienceNet blog body without sidebar, IPs or footer counts", () => {
    const result = select("blog.sciencenet.cn", "/home.php");
    expect(result.root).toBe(result.blog);
    expect(select("blog.sciencenet.cn", "/home.php", true).root.id).toBe("main");
    expect(select("blog.sciencenet.cn.evil.example", "/home.php").root.id).toBe("main");
  });
  it("keeps NSTC's title, attachment/link siblings and update date in the article panel", () => {
    for (const host of ["www.nstc.gov.tw", "nstc.gov.tw"]) {
      const result = select(host);
      expect(result.root).toBe(result.panel);
      expect(result.root).not.toBe(result.article);
      expect(result.root).not.toBe(result.body);
      expect(result.excluded).toContain("a.accessible[accesskey]");
    }
  });
  it("does not apply site rules to other hosts or NSTC listing pages", () => {
    for (const [host, path] of [["example.com", "/folksonomy/detail/test"], ["www.nstc.gov.tw.example", "/folksonomy/detail/test"], ["www.nstc.gov.tw", "/folksonomy/list/test"]]) {
      const result = select(host, path);
      expect(result.root).toBe(result.main);
      expect(result.excluded).not.toContain("a.accessible[accesskey]");
    }
  });
  it("falls back when the verified article panel is absent or hidden", () => {
    expect(select(undefined, undefined, true).root.id).toBe("main");
    expect(select(undefined, undefined, false, false).root.id).toBe("main");
  });
  it("preserves ScienceNet's existing dedicated article root", () => {
    const result = select("talent.sciencenet.cn", "/index.php");
    expect(result.root).toBe(result.talent);
    expect(result.excluded).toContain(",#footer");
  });
});
