import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReaderViewOutlet, { readerSummaryKey, readerViewKey } from "../components/ReaderViewOutlet";
import type { ReaderTab } from "./aiFormatted";

describe("exclusive reader view outlet", () => {
  it.each<ReaderTab>(["reader", "web", "formatted"])("renders and invokes only the %s branch", (mode) => {
    const renderReading = vi.fn(() => createElement("div", { "data-pane": "reader" }, "Reading"));
    const renderWeb = vi.fn(() => createElement("div", { "data-pane": "web" }, "Web"));
    const renderFormatted = vi.fn(() => createElement("div", { "data-pane": "formatted", className: "ai-formatted" }, "AI formatted"));
    const html = renderToStaticMarkup(createElement(ReaderViewOutlet, { articleId: 12, mode, renderReading, renderWeb, renderFormatted }));
    expect(html.match(/data-pane=/g)).toHaveLength(1);
    expect(html).toContain(`data-pane="${mode}"`);
    expect(renderReading).toHaveBeenCalledTimes(mode === "reader" ? 1 : 0);
    expect(renderWeb).toHaveBeenCalledTimes(mode === "web" ? 1 : 0);
    expect(renderFormatted).toHaveBeenCalledTimes(mode === "formatted" ? 1 : 0);
  });
  it("assigns non-colliding keys for every body and sibling summary", () => {
    const keys = [1, 2, 12].flatMap((articleId) => [
      ...(["reader", "web", "formatted"] as const).map((mode) => readerViewKey(articleId, mode)),
      readerSummaryKey(articleId),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
