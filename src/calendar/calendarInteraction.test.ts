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
const scroll = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = scroll;
  HTMLElement.prototype.scrollTo = vi.fn();
  scroll.mockClear(); vi.mocked(openUrl).mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CalendarBoard, { active: true, view: "year" }))));
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals(); });
it("selects a day without hiding marks, then highlights only clicked evidence and locates its end", () => {
  const marks = host.querySelectorAll(".calendar-dots").length;
  act(() => date("05-29").click());
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  expect(host.querySelectorAll(".calendar-dots")).toHaveLength(marks);
  act(() => evidence("Cross-month").click());
  expect(date("05-28").classList.contains("is-range-start")).toBe(true);
  expect(date("06-03").classList.contains("is-range-end")).toBe(true);
  expect(date("06-01").classList.contains("is-related")).toBe(true);
  expect(date("05-27").classList.contains("is-related")).toBe(false);
  expect(host.querySelectorAll(".calendar-dots")).toHaveLength(marks);
  const end = [...host.querySelectorAll<HTMLButtonElement>(".calendar-focus-summary button")].find(button => button.textContent?.startsWith("止"))!;
  act(() => end.click()); expect(scroll.mock.instances.at(-1)).toBe(date("06-03"));
  act(() => evidence("Single-day").click());
  expect(date("05-29").classList.contains("is-related")).toBe(true);
  expect(date("06-01").classList.contains("is-related")).toBe(false);
  expect(date("05-29").textContent).toContain("当日");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
});
it("keeps source actions independent, supports card selection and clears highlights on another day", () => {
  act(() => date("05-29").click());
  act(() => host.querySelector<HTMLButtonElement>(".calendar-source")!.click());
  expect(openUrl).toHaveBeenCalledWith("https://example.org/window");
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  act(() => host.querySelector<HTMLButtonElement>(".calendar-card-select")!.click());
  expect(date("05-28").classList.contains("is-related")).toBe(true);
  act(() => date("06-01").click());
  expect(host.querySelectorAll(".is-related")).toHaveLength(0);
  expect(host.querySelector(".calendar-detail h2")?.textContent).toContain("6 月 1 日");
});
