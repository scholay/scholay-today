import { almanacDayIndex, dateKeyFromParts, inferMonthDay, parseDateKey } from "./helpers";
import type { CalendarEvent, HistoryEvent, TagHeat } from "./types";

export function adaptHistoryEvents(events: readonly HistoryEvent[]): CalendarEvent[] {
  return events.map((event) => {
    const [month, day] = event.dateKey.split("-").map(Number);
    return {
      id: `history:${event.year}:${event.dateKey}:${event.title}`,
      title: event.title,
      tags: [event.domain],
      precision: "day" as const,
      start: { year: event.year, month, day },
      kind: "point" as const,
      source: "history" as const,
      approximate: !event.preciseToDay,
      payload: {
        factSummary: event.factSummary,
        historicalSignificance: event.historicalSignificance,
        eventType: event.eventType,
        importance: event.importance,
        sources: event.sources,
      },
    };
  });
}

export function tagHeat(events: readonly CalendarEvent[]): TagHeat[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const tag of event.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"));
}

export function filterByTag(events: readonly CalendarEvent[], tag: string | null): CalendarEvent[] {
  if (!tag) return [...events];
  return events.filter((event) => event.tags.includes(tag));
}

export function eventDisplayDay(event: CalendarEvent): number {
  if (event.start.day != null) return event.start.day;
  return inferMonthDay(event.payload.meta ?? "", event.start.year, event.start.month);
}

export function dayPoints(events: readonly CalendarEvent[], year: number, month: number, day: number): CalendarEvent[] {
  return events.filter((event) => (
    event.precision === "day"
    && event.start.year === year
    && event.start.month === month
    && event.start.day === day
  )).sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

function matchesDate(date: { year: number; month: number; day: number | null } | undefined, year: number, month: number, day: number): boolean {
  return !!date && date.year === year && date.month === month && date.day === day;
}

export function cellPoints(events: readonly CalendarEvent[], year: number, month: number, day: number): CalendarEvent[] {
  return events.filter((event) => (
    (event.start.year === year && event.start.month === month && eventDisplayDay(event) === day)
    || (event.kind === "span" && matchesDate(event.end, year, month, day))
  )).sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

export function cellSpanFlags(events: readonly CalendarEvent[], year: number, month: number, day: number): { starts: CalendarEvent[]; ends: CalendarEvent[]; points: CalendarEvent[] } {
  const items = cellPoints(events, year, month, day);
  return {
    starts: items.filter((event) => event.kind === "span" && matchesDate(event.start, year, month, day)),
    ends: items.filter((event) => event.kind === "span" && matchesDate(event.end, year, month, day)),
    points: items.filter((event) => event.kind !== "span"),
  };
}

export function eventDateKey(event: CalendarEvent): string {
  return dateKeyFromParts(event.start.month, eventDisplayDay(event));
}

export function historyOnDateKey(events: readonly CalendarEvent[], dateKey: string): CalendarEvent[] {
  return events.filter((event) => event.source === "history" && eventDateKey(event) === dateKey)
    .sort((a, b) => a.start.year - b.start.year || a.title.localeCompare(b.title, "zh"));
}

export function spanCoversDateKey(event: CalendarEvent, dateKey: string): boolean {
  if (event.kind !== "span" || event.end?.day == null) return false;
  const start = almanacDayIndex(event.start.month, eventDisplayDay(event));
  const end = almanacDayIndex(event.end.month, event.end.day);
  const at = almanacDayIndex(parseDateKey(dateKey).month, parseDateKey(dateKey).day);
  if (start <= end) return at >= start && at <= end;
  return at >= start || at <= end;
}

/** 0 at the opening day, 1 at the closing day, even steps across the 366-day year. */
export function spanProgressOnDateKey(event: CalendarEvent, dateKey: string): number | null {
  if (!spanCoversDateKey(event, dateKey) || event.end?.day == null) return null;
  const start = almanacDayIndex(event.start.month, eventDisplayDay(event));
  const end = almanacDayIndex(event.end.month, event.end.day);
  const at = almanacDayIndex(parseDateKey(dateKey).month, parseDateKey(dateKey).day);
  const length = start <= end ? end - start : 366 - start + end;
  if (length <= 0) return 0;
  const traveled = start <= end ? at - start : at >= start ? at - start : 366 - start + at;
  return traveled / length;
}

export function yearOnDateKey(events: readonly CalendarEvent[], dateKey: string): CalendarEvent[] {
  return events.filter((event) => {
    if (event.source !== "year") return false;
    if (eventDateKey(event) === dateKey) return true;
    return spanCoversDateKey(event, dateKey);
  }).sort((a, b) => a.start.year - b.start.year || a.title.localeCompare(b.title, "zh"));
}

export function eventSortStamp(event: CalendarEvent): number {
  return event.start.year * 10000 + event.start.month * 100 + eventDisplayDay(event);
}

export function sortTimelineEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => eventSortStamp(a) - eventSortStamp(b) || a.title.localeCompare(b.title, "zh"));
}

export function timelineDateLabel(event: CalendarEvent): string {
  if (event.precision === "month") {
    return event.source === "history" ? `${event.start.year} · ${event.start.month} 月` : `${event.start.month} 月`;
  }
  const day = event.start.day ?? eventDisplayDay(event);
  const start = event.source === "history"
    ? `${event.start.year} · ${event.start.month} 月 ${day} 日`
    : `${event.start.month} 月 ${day} 日`;
  if (event.kind === "span" && event.end?.day != null) {
    const sameYear = event.end.year === event.start.year;
    const end = `${sameYear ? "" : `${event.end.year} 年 `}${event.end.month} 月 ${event.end.day} 日`;
    return `${start} – ${end}`;
  }
  return start;
}

export function eventYearRange(events: readonly CalendarEvent[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    min = Math.min(min, event.start.year);
    max = Math.max(max, event.start.year);
    if (event.end) {
      min = Math.min(min, event.end.year);
      max = Math.max(max, event.end.year);
    }
  }
  if (!Number.isFinite(min)) return { min: 1846, max: 2026 };
  return { min, max };
}
