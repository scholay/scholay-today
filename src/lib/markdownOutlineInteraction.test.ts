// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AIFormatted from "../components/AIFormatted";
import type { AiFormattedDraft } from "../types";
import { fetchCapturedImage } from "../api";

vi.mock("../api", () => ({ fetchCapturedImage: vi.fn() }));
vi.mock("../toast", () => ({ reportError: vi.fn() }));
vi.mock("react-i18next", () => {
  const t = (key: string, args?: { title?: string }) => args?.title ?? key;
  return { useTranslation: () => ({ t, i18n: { language: "zh" } }) };
});

const draft: AiFormattedDraft = {
  articleId: 42, captureId: "saved-capture", sourceUrl: "https://example.org/article",
  sourceTitle: "研究文章", capturedAt: "2026-09-06T10:00:00Z", generatedAt: "2026-09-06T10:01:00Z",
  model: "existing-model", language: "zh", markdown: "## 研究文章\n\n中文正文保持原样。\n\n### 研究方法\n\n方法内容。\n\n#### 数据分析\n\n分析内容。\n\n### 主要结果\n\n结果内容。",
  sourceText: "已保存的抓取内容", sourceCharCount: 100, sourceTruncated: false, warnings: [],
};
let host: HTMLDivElement;
let root: Root;
let width: number;
const scrollTo = vi.fn();
const regenerate = vi.fn();
function button(text: string) {
  const found = Array.from(host.querySelectorAll("button")).find(el => el.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(el: HTMLElement) { await act(() => el.click()); }
async function mount(markdown = draft.markdown) {
  await act(() => root.render(createElement(AIFormatted, {
    articleId: 42, articleTitle: "研究文章", hasUrl: true, draft: { ...draft, markdown }, loading: false,
    loadError: null, job: null, language: "zh", onLanguageChange: vi.fn(), onReformat: regenerate,
    onRetry: vi.fn(), onToast: vi.fn(),
  })));
}
beforeEach(() => {
  width = 900;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const top = this.classList.contains("md-heading") ? 500 : this.classList.contains("ai-formatted-scroll") ? 100 : 0;
    return { width, height: 600, top, bottom: top + 600, left: 0, right: width, x: 0, y: top, toJSON() {} };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  scrollTo.mockClear(); regenerate.mockClear();
  vi.mocked(fetchCapturedImage).mockReset().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Markdown outline interactions", () => {
  it("shows a nested rail on wide panes and navigates only the reader scroll area", async () => {
    await mount();
    expect(button("aiFormatted.outline").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("nav ol ol ol button")?.textContent).toBe("数据分析");
    await click(button("研究方法"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 378, behavior: "instant" });
    expect(document.activeElement?.id).toBe("md-42-heading-2");
    expect(button("研究方法").getAttribute("aria-current")).toBe("location");
    expect(host.querySelector("nav")).not.toBeNull();
    expect(regenerate).not.toHaveBeenCalled();
  });
  it("keeps compact panes uncluttered, closing the overlay after navigation", async () => {
    width = 500;
    await mount();
    expect(host.querySelector("nav")).toBeNull();
    await click(button("aiFormatted.outline"));
    expect(host.querySelector(".md-compact .md-outline")).not.toBeNull();
    await click(button("主要结果"));
    expect(host.querySelector("nav")).toBeNull();
    expect(document.activeElement?.id).toBe("md-42-heading-4");
  });
  it("supports Escape and leaves the source tab and saved Markdown unchanged", async () => {
    await mount();
    await act(() => host.querySelector("nav")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("nav")).toBeNull();
    expect(document.activeElement).toBe(button("aiFormatted.outline"));
    await click(button("aiFormatted.source"));
    expect(host.querySelector("textarea")?.value).toBe(draft.markdown);
    expect(host.querySelector(".md-outline-toggle")).toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    expect(regenerate).not.toHaveBeenCalled();
  });
  it("does not show an empty outline for an article without headings", async () => {
    await mount("只有普通的中文正文。");
    expect(host.querySelector(".md-outline-toggle")).toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    expect(host.querySelector(".md-chinese-paragraph")?.textContent).toBe("只有普通的中文正文。");
  });
  it("preserves hydrated picture nodes while the active heading and outline change", async () => {
    await mount(`${draft.markdown}\n\n![研究图](https://example.org/figure.png)`);
    const picture = host.querySelector("img")!;
    expect(picture.src).toMatch(/^data:image\/png;base64,/);
    await click(button("研究方法"));
    await click(button("aiFormatted.outline"));
    await click(button("aiFormatted.outline"));
    expect(host.querySelector("img")).toBe(picture);
    expect(picture.src).toMatch(/^data:image\/png;base64,/);
    expect(fetchCapturedImage).toHaveBeenCalledTimes(1);
  });
});
