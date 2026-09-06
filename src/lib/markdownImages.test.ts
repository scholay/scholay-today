import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { capturedImageSources, renderMarkdown } from "./markdown";

afterEach(() => vi.unstubAllGlobals());
function render(source: string, output = source) {
  const dom = new JSDOM();
  vi.stubGlobal("DOMParser", dom.window.DOMParser);
  return new JSDOM(renderMarkdown(output, capturedImageSources(source))).window.document;
}
describe("captured Markdown images", () => {
  it("renders Markdown references in place, without initiating raw remote requests", () => {
    const src = "https://example.org/image?x=1&y=2";
    const doc = render(`Before\n\n![图 2](<${src}>)\n\n图 2: 185 plants.`);
    const img = doc.querySelector("img")!;
    expect(img.dataset.capturedSrc).toBe(src);
    expect(img.alt).toBe("图 2");
    expect(img.hasAttribute("src")).toBe(false);
    expect(doc.body.textContent).toContain("图 2: 185 plants.");
  });
  it("strips event handlers, raw HTML, and model-invented images", () => {
    const doc = render("![allowed](https://example.org/a.png)", '<img src="https://example.org/a.png" onerror="alert(1)" style="position:fixed" srcset="https://evil.example/b"><img src="https://evil.example/x"><script>EVIL</script>');
    expect(doc.querySelectorAll("img")).toHaveLength(1);
    expect(doc.body.innerHTML).not.toMatch(/onerror|srcset|style=|EVIL|evil\.example/);
  });
  it("never enables images for ordinary AI summaries or dangerous URL schemes", () => {
    const dom = new JSDOM();
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    expect(renderMarkdown("![x](https://example.org/a.png)")).not.toContain("<img");
    for (const src of ["file:///etc/passwd", "javascript:alert(1)", "data:image/svg+xml,bad", "https://user:secret@example.org/a", "/relative.png"]) {
      expect(capturedImageSources(`![x](<${src}>)`).size).toBe(0);
    }
  });
});
