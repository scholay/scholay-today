// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import CalendarBoard from "./CalendarBoard";
import type { CalendarEvent } from "./types";

const events = vi.hoisted(() => [
  { id: "window", title: "Cross-month window", tags: ["学术会议"], start: { year: 2026, month: 5, day: 28 }, end: { year: 2026, month: 6, day: 3 }, kind: "span", source: "year", precision: "day", approximate: false, payload: { sourceUrl: "https://example.org/window" } },
  { id: "point", title: "Single-day event", tags: ["学术会议"], start: { year: 2026, month: 5, day: 29 }, kind: "point", source: "year", precision: "day", approximate: false, payload: {} },
] as CalendarEvent[]);
vi.mock("./yearGrow", async original => ({ ...await original<typeof import("./yearGrow")>(), growYearEvents: () => events, loadGrowSeeds: async () => [] }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
let host: HTMLDivElement, root: Root, qc: QueryClient;
const date = (key: string) => host.querySelector<HTMLButtonElement>(`[data-date="${key}"]`)!;
const evidence = (title: string) => [...host.querySelectorAll<HTMLButtonElement>(".calendar-evidence-select")].find(button => button.textContent?.includes(title))!;
const cardSelect = (title: string) => [...host.querySelectorAll<HTMLButtonElement>(".calendar-card-select")].find(button => button.textContent?.includes(title))!;
const scroll = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = scroll;
  HTMLElement.prototype.scrollTo = vi.fn();
  scroll.mockClear(); vi.mocked(openUrl).mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "year" }))));
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals(); });
it("selects a day without hiding planner ribbons, then highlights a card and locates its end", () => {
  const marks = host.querySelectorAll(".calendar-ribbons").length;
  act(() => date("02-16").click());
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  expect(host.querySelectorAll(".calendar-ribbons")).toHaveLength(marks);
  act(() => cardSelect("春节放假").click());
  expect(date("02-15").classList.contains("is-range-start")).toBe(true);
  expect(date("02-23").classList.contains("is-range-end")).toBe(true);
  expect(date("02-16").classList.contains("is-related")).toBe(true);
  expect(date("02-14").classList.contains("is-related")).toBe(false);
  expect(host.querySelectorAll(".calendar-ribbons")).toHaveLength(marks);
  const end = [...host.querySelectorAll<HTMLButtonElement>(".calendar-focus-summary button")].find(button => button.textContent?.startsWith("止"))!;
  act(() => end.click()); expect(scroll.mock.instances.at(-1)).toBe(date("02-23"));
  act(() => date("03-03").click());
  act(() => cardSelect("元宵节").click());
  expect(date("03-03").classList.contains("is-related")).toBe(true);
  expect(date("02-16").classList.contains("is-related")).toBe(false);
  expect(date("03-03").textContent).toContain("当日");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
});
it("puts tag groups left, the academic planner in the middle, and selected-day detail on the right", async () => {
  const split = host.querySelector(".calendar-split")!;
  const planner = split.querySelector(":scope > .calendar-almanac")!;
  const detail = split.querySelector(":scope > .calendar-detail")!;
  expect(planner.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const sidebar = host.querySelector(".hot-sidebar");
  expect(sidebar!.compareDocumentPosition(detail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "history" }))));
  const historySplit = host.querySelector(".calendar-split")!;
  const historyDetail = historySplit.querySelector(":scope > .calendar-detail")!;
  const historyCalendar = historySplit.querySelector(":scope > .calendar-almanac")!;
  expect(historyCalendar.compareDocumentPosition(historyDetail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("shows the 2026 national holidays on the year rail and on the festival day", () => {
  expect(host.textContent).toContain("节假日");
  act(() => date("02-16").click());
  const detail = host.querySelector(".calendar-detail")!.textContent ?? "";
  expect(detail).toContain("除夕");
  expect(detail).toContain("春节放假");
  act(() => date("03-03").click());
  expect(host.querySelector(".calendar-detail")!.textContent).toContain("元宵节");
  act(() => date("10-18").click());
  expect(host.querySelector(".calendar-detail")!.textContent).toContain("重阳节");
});
it("shows compact provenance on calendar event cards", () => {
  act(() => date("02-16").click());
  const card = [...host.querySelectorAll<HTMLElement>(".calendar-card")].find((item) => item.textContent?.includes("春节放假"))!;
  const badge = card.querySelector<HTMLElement>(".calendar-provenance")!;
  expect(badge.textContent).toBe("整理入库 · 官网原文 · 已核验");
  expect(badge.dataset).toMatchObject({ origin: "curated", tier: "official", verification: "verified" });
  expect(card.querySelector(".calendar-category-icon[title='节假日']")).toBeTruthy();
});
it("keeps a card compact until its source detail is explicitly expanded", () => {
  act(() => date("02-16").click());
  const card = [...host.querySelectorAll<HTMLElement>(".calendar-card")].find((item) => item.textContent?.includes("春节放假"))!;
  const disclosure = card.querySelector<HTMLButtonElement>(".calendar-card-disclosure")!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(card.querySelector(".calendar-card-details")).toBeNull();
  expect(card.querySelector(".calendar-card-summary")?.textContent).toContain("2月15日（腊月二十八）至23日");
  act(() => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(card.querySelector(".calendar-card-detail-block > small")?.textContent).toBe("正文");
  expect(card.querySelector(".calendar-card-source-block")?.textContent).toContain("原文链接");
});
it("keeps the history detail rail scoped to the selected date", async () => {
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "history" }))));
  const detail = host.querySelector<HTMLElement>(".calendar-detail")!;
  const total = Number(host.querySelector(".hot-source-nav button.is-active small")!.textContent);
  expect(detail.querySelectorAll(".calendar-card").length).toBeLessThan(total);
  expect(detail.querySelectorAll("[data-day-group]")).toHaveLength(0);
  act(() => date("01-19").click());
  expect(detail.textContent).toContain("1 月 19 日");
  expect(detail.querySelectorAll(".calendar-card").length).toBeGreaterThan(0);
  expect(detail.querySelectorAll(".calendar-card").length).toBeLessThan(total);
});
it("groups historic tags while preserving exact member filters", async () => {
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "history" }))));
  const tagButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".hot-source-nav button")]
    .find((button) => button.querySelector("span")?.textContent === name)!;

  expect(tagButton("研究体系")).toBeTruthy();
  expect(tagButton("基础与计算")).toBeTruthy();
  expect(tagButton("生命、健康与环境")).toBeTruthy();
  expect(tagButton("航天与空间")).toBeTruthy();
  act(() => tagButton("研究体系").click());
  expect(host.querySelector(".calendar-detail > h2")?.textContent).toBe("昔日学术 · 研究体系");
  expect(tagButton("研究规范史")).toBeTruthy();
  expect(tagButton("数据治理史")).toBeTruthy();
  act(() => tagButton("数据治理史").click());
  expect(host.querySelector(".calendar-detail > h2")?.textContent).toBe("昔日学术 · 数据治理史");
});
it("offers month and timeline tabs in both academic calendar workspaces", async () => {
  expect(host.querySelectorAll(".calendar-layout-switch button")).toHaveLength(2);
  const timeline = [...host.querySelectorAll<HTMLButtonElement>(".calendar-layout-switch button")].find(button => button.textContent?.includes("时间轴"))!;
  act(() => timeline.click());
  expect(host.querySelector(".calendar-timeline-wrap")).toBeTruthy();
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "history" }))));
  expect(host.querySelectorAll(".calendar-layout-switch button")).toHaveLength(2);
});
it("keeps source actions independent, supports card selection and clears highlights on another day", () => {
  act(() => date("02-16").click());
  const disclosure = host.querySelector<HTMLButtonElement>(".calendar-detail .calendar-card-disclosure")!;
  act(() => disclosure.click());
  const source = host.querySelector<HTMLButtonElement>(".calendar-detail .calendar-source")!;
  act(() => source.click());
  expect(openUrl).toHaveBeenCalledWith("https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm");
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  const card = [...host.querySelectorAll<HTMLButtonElement>(".calendar-detail .calendar-card-select")].find((button) => button.textContent === "春节放假")!;
  act(() => card.click());
  expect(date("02-15").classList.contains("is-related")).toBe(true);
  act(() => date("03-03").click());
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  expect(host.querySelector(".calendar-selection-heading h2")?.textContent).toBe("全部");
});
it("keeps holiday filters in the planner while the detail rail only shows the selected day", () => {
  const tagButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".hot-source-nav button")].find((button) => button.querySelector("span")?.textContent === name);
  const open = (name: string) => act(() => tagButton(name)!.click());
  const titles = () => [...host.querySelectorAll(".calendar-detail .calendar-card h3")].map((node) => node.textContent ?? "");
  open("节假日");
  expect(host.querySelectorAll(".calendar-ribbon").length).toBeGreaterThan(0);
  act(() => date("02-16").click());
  expect(titles()).toEqual(expect.arrayContaining(["春节放假", "除夕"]));
  open("传统节日");
  act(() => date("03-03").click());
  const folk = titles();
  expect(folk).toEqual(expect.arrayContaining(["元宵节"]));
  expect(folk.some((title) => title.includes("调休") || title.includes("放假"))).toBe(false);
  open("调休上班");
  act(() => date("02-14").click());
  const work = titles();
  expect(work.length).toBeGreaterThan(0);
  expect(work.every((title) => title.includes("调休"))).toBe(true);
  open("法定放假");
  act(() => date("02-16").click());
  const rests = titles();
  expect(rests).toEqual(expect.arrayContaining(["春节放假"]));
  expect(rests.some((title) => title === "元宵节")).toBe(false);
});
