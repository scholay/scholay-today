import { describe, expect, it } from "vitest";
import { eventFocusOnDate } from "./eventFocus";
import type { CalendarEvent } from "./types";

const windowEvent: CalendarEvent = { id: "window", title: "Window", tags: ["会议"], start: { year: 2026, month: 12, day: 28 }, end: { year: 2027, month: 1, day: 3 }, kind: "span", source: "year", precision: "day", approximate: false, payload: {} };
describe("card date highlights", () => {
  it("marks both endpoints and interior dates across a year boundary", () => {
    expect(eventFocusOnDate([windowEvent], "12-28")).toEqual({ related: true, start: true, end: false, point: false });
    expect(eventFocusOnDate([windowEvent], "01-01")).toEqual({ related: true, start: false, end: false, point: false });
    expect(eventFocusOnDate([windowEvent], "01-03")).toEqual({ related: true, start: false, end: true, point: false });
    expect(eventFocusOnDate([windowEvent], "06-01").related).toBe(false);
  });
  it("limits a point to its own day, and marks same-day span endpoints together", () => {
    const point = { ...windowEvent, kind: "point" as const, end: undefined };
    expect(eventFocusOnDate([point], "12-28").point).toBe(true);
    expect(eventFocusOnDate([point], "12-29").related).toBe(false);
    expect(eventFocusOnDate([{ ...windowEvent, end: windowEvent.start }], "12-28")).toMatchObject({ start: true, end: true });
    expect(eventFocusOnDate([], "12-28").related).toBe(false);
  });
});
