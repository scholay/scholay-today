import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import LabelTimeline from "./LabelTimeline";
import LabelInsights from "./LabelInsights";
import { makeCapture } from "./history";
import { groupEditions } from "./editions";

const capture = makeCapture("douyin", { capturedAt: "2026-09-08T02:00:00Z", period: "当前榜单首页", rows: [
  { term: "学术交流", kind: "抖音实时热点", rank: 1, metric: "100万", metricLabel: "热点指数" },
  { term: "科普创作", kind: "抖音飙升热点", rank: 2, metric: "80万", metricLabel: "热点指数" },
] })!;
const older = makeCapture("douyin", { ...capture, capturedAt: "2026-09-07T20:00:00Z" })!;
const noop = () => {};
describe("fixed eight-hour editions and direct tag cards", () => {
  it("pins the newest edition outside the scroll area; older editions alone scroll", () => {
    const editions = groupEditions([capture, older]);
    const html = renderToStaticMarkup(createElement(LabelTimeline, { editions, selection: "latest", loading: false, loadingMore: false, hasMore: false, error: "", onSelect: noop, onMore: noop }));
    const dom = new JSDOM(html), doc = dom.window.document;
    expect(doc.querySelector(".label-latest-pinned")?.textContent).toContain("08:00–16:00");
    expect(doc.querySelector(".label-history-scroll")?.textContent).toContain("00:00–08:00");
    expect(doc.querySelector(".label-history-scroll")?.textContent).not.toContain("最新一期");
    expect(doc.querySelectorAll("input, select")).toHaveLength(0);
    expect(html).not.toMatch(/自定义|24 小时|7 天|30 天|汇总所选区间|搜索标签/);
    expect(html).toContain("每天 3 份");
    dom.window.close();
  });
  it("starts the right pane directly with category cards, without title/stats/search/filter chrome", () => {
    const html = renderToStaticMarkup(createElement(LabelInsights, { captures: [capture], loading: false, onCopy: noop, onOriginal: noop }));
    const dom = new JSDOM(html), doc = dom.window.document;
    expect(doc.querySelector(".label-insights")?.firstElementChild?.className).toBe("label-insight-grid");
    expect(doc.querySelectorAll(".label-insight-card")).toHaveLength(2);
    expect(doc.querySelectorAll("details")).toHaveLength(2);
    expect(doc.querySelectorAll("h1, input, .hot-filters, .label-insights-heading")).toHaveLength(0);
    expect(html).toContain("学术交流"); expect(html).toContain("科普创作");
    expect(html).not.toMatch(/多类标签，一览可见|实际采集覆盖|搜索标签/);
    expect(doc.querySelector(".label-insight-expanded")?.textContent).toContain("采集时间");
    dom.window.close();
  });
});
