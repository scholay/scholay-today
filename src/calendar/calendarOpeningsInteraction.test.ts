// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CalendarBoard from "./CalendarBoard";
import type { CalendarEvent } from "./types";

const verifiedOpening = vi.hoisted(() => ({
  id: "official-opening",
  title: "2026年度官方基金窗口",
  tags: ["自然科学基金", "国自然"],
  start: { year: 2026, month: 9, day: 21 },
  end: { year: 2026, month: 9, day: 28 },
  kind: "span",
  source: "year",
  precision: "day",
  approximate: false,
  payload: {
    sourceName: "国家自然科学基金委员会",
    sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/141466.html",
    provenance: { origin: "web_search", sourceTier: "official", verification: "verified", reviewedAt: "2026-09-27" },
  },
} as CalendarEvent));

const laterOpening = vi.hoisted(() => ({
  ...verifiedOpening,
  id: "later-opening",
  title: "2026年度后续官方基金窗口",
  start: { year: 2026, month: 10, day: 9 },
  end: undefined,
  kind: "point",
} as CalendarEvent));

vi.mock("./yearGrow", async original => ({
  ...await original<typeof import("./yearGrow")>(),
  growYearEvents: () => [verifiedOpening, laterOpening],
  loadGrowSeeds: async () => [],
}));

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(CalendarBoard, { active: true, view: "year" }))));
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps a verified one-off official opportunity in the current tag card stream", () => {
  expect(host.querySelector(".calendar-layout-switch")).toBeTruthy();
  expect(host.querySelector(".calendar-year-months")).toBeTruthy();
  expect(host.textContent).toContain("2026年度官方基金窗口");
  const card = [...host.querySelectorAll<HTMLElement>(".calendar-detail .calendar-card")].find((item) => item.textContent?.includes("2026年度官方基金窗口"))!;
  expect(card.querySelector(".calendar-provenance")?.textContent).toBe("外网检索 · 官网原文 · 已核验");
  expect(host.querySelector(".calendar-selection-heading h2")?.textContent).toBe("全部");

  const timeline = [...host.querySelectorAll<HTMLButtonElement>(".calendar-layout-switch button")]
    .find((button) => button.textContent?.includes("时间轴"));
  expect(timeline).toBeTruthy();
  act(() => timeline?.click());
  expect(host.querySelector(".calendar-timeline-wrap")).toBeTruthy();
});
