import { eventDateKey, spanProgressOnDateKey, yearOnDateKey } from "./adapters";
import { dateKeyFromParts } from "./helpers";
import type { CalendarEvent } from "./types";

export const HABIT_MIN = 2;

export interface YearHabit {
  id: string;
  dateKey: string;
  tag: string;
  title: string;
  habit: boolean;
  starts: boolean;
  ends: boolean;
  /** 0 = green opening, 1 = red close; null is a single-day point. */
  tone: number | null;
  years: number[];
  evidence: CalendarEvent[];
}

function primaryTag(event: CalendarEvent): string {
  return event.tags[0] ?? "科研项目";
}

function habitTitle(tag: string, evidence: readonly CalendarEvent[]): string {
  const spans = evidence.filter((event) => event.kind === "span").length;
  const windows = evidence.filter((event) => /指南|申报|征集|Due Dates|公募/.test(event.title)).length;
  if (spans * 2 >= evidence.length) return `${tag}会期`;
  if (windows * 2 >= evidence.length) return `${tag}窗口`;
  return tag;
}

export function habitsOnDateKey(events: readonly CalendarEvent[], dateKey: string): YearHabit[] {
  const items = yearOnDateKey(events, dateKey);
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of items) {
    const tag = primaryTag(event);
    const list = groups.get(tag) ?? [];
    list.push(event);
    groups.set(tag, list);
  }
  return [...groups.entries()].map(([tag, evidence]) => {
    const years = [...new Set(evidence.map((event) => event.start.year))].sort((left, right) => left - right);
    const tones = evidence.map((event) => spanProgressOnDateKey(event, dateKey)).filter((value): value is number => value != null);
    return {
      id: `habit:${dateKey}:${tag}`,
      dateKey,
      tag,
      title: habitTitle(tag, evidence),
      habit: evidence.length >= HABIT_MIN || years.length >= 2,
      starts: evidence.some((event) => event.kind === "span" && eventDateKey(event) === dateKey),
      ends: evidence.some((event) => event.kind === "span" && event.end?.day != null && dateKeyFromParts(event.end.month, event.end.day) === dateKey),
      tone: tones.length > 0 ? tones.reduce((sum, value) => sum + value, 0) / tones.length : null,
      years,
      evidence,
    };
  }).sort((left, right) => Number(right.habit) - Number(left.habit) || right.evidence.length - left.evidence.length || left.tag.localeCompare(right.tag, "zh"));
}

export function yearHabits(events: readonly CalendarEvent[]): YearHabit[] {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.source !== "year") continue;
    keys.add(eventDateKey(event));
    if (event.kind === "span" && event.end?.day != null) keys.add(dateKeyFromParts(event.end.month, event.end.day));
  }
  // The rail only lists openings, closings, and point days. Mid-span colour
  // lives on the month grid so a 200-day window does not become 200 cards.
  return [...keys].sort().flatMap((dateKey) => (
    habitsOnDateKey(events, dateKey).filter((habit) => habit.starts || habit.ends || habit.tone == null)
  ));
}

export function habitMarks(habits: readonly YearHabit[]): { starts: YearHabit[]; ends: YearHabit[]; through: YearHabit[]; points: YearHabit[] } {
  return {
    starts: habits.filter((habit) => habit.starts),
    ends: habits.filter((habit) => habit.ends),
    through: habits.filter((habit) => !habit.starts && !habit.ends && habit.tone != null),
    points: habits.filter((habit) => !habit.starts && !habit.ends && habit.tone == null),
  };
}

export interface CellMark {
  id: string;
  kind: "start" | "end" | "through" | "point";
  habit: boolean;
  tone: number | null;
}

function markKind(habit: YearHabit): CellMark["kind"] {
  if (habit.starts) return "start";
  if (habit.ends) return "end";
  if (habit.tone != null) return "through";
  return "point";
}

/**
 * One mark per habit, settled ones first, so a dense cell still shows what matters.
 * Span colour walks green → yellow → red; 惯例 is filled, 依据 is a ring.
 */
export function cellMarks(habits: readonly YearHabit[]): CellMark[] {
  return [...habits]
    .sort((left, right) => Number(right.habit) - Number(left.habit) || right.evidence.length - left.evidence.length)
    .map((habit) => ({
      id: habit.id,
      kind: markKind(habit),
      habit: habit.habit,
      tone: habit.tone,
    }));
}

/** Span evidence that covers this cell; a selected cell uses these ids to keep one window. */
export function spanFocusEventIds(events: readonly CalendarEvent[], dateKey: string): string[] {
  return yearOnDateKey(events, dateKey)
    .filter((event) => event.kind === "span")
    .map((event) => event.id);
}

/**
 * While a cell is selected, keep the windows that cover it (from their
 * openings through the close) and drop every other mark. A point-only
 * cell keeps its own dots and hides the rest of the year.
 */
export function habitsInFocus(
  habits: readonly YearHabit[],
  focusKey: string | null,
  focusIds: readonly string[] | null,
  dateKey: string,
): YearHabit[] {
  if (!focusKey || focusIds == null) return [...habits];
  if (focusIds.length === 0) return dateKey === focusKey ? [...habits] : [];
  const focus = new Set(focusIds);
  const related = habits.filter((habit) => habit.evidence.some((event) => focus.has(event.id)));
  if (related.length > 0) return related;
  return dateKey === focusKey ? [...habits] : [];
}
