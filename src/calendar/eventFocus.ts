import { eventDateKey, spanCoversDateKey } from "./adapters";
import { dateKeyFromParts } from "./helpers";
import type { CalendarEvent } from "./types";

/** Highlight selected evidence without removing any other calendar marks. */
export function eventFocusOnDate(events: readonly CalendarEvent[], dateKey: string) {
  const related = events.filter(event => eventDateKey(event) === dateKey || spanCoversDateKey(event, dateKey));
  return {
    related: related.length > 0,
    start: related.some(event => event.kind === "span" && eventDateKey(event) === dateKey),
    end: related.some(event => event.kind === "span" && event.end?.day != null && dateKeyFromParts(event.end.month, event.end.day) === dateKey),
    point: related.some(event => event.kind === "point"),
  };
}
