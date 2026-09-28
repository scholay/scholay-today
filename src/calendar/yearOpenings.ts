import { calendarProvenance } from "./adapters";
import { isOfficialCalendarSource } from "./sourceRegistry";
import type { CalendarEvent } from "./types";

/**
 * A verified, registered-official opportunity for one concrete calendar year.
 *
 * This intentionally does not use the annual-habit threshold: a newly verified
 * official call should be available in an "openings" surface even before a
 * later year proves that it recurs. Holidays and campus administration are
 * calendar facts, but not research opportunities.
 */
export function isYearOpening(event: CalendarEvent, targetYear: number): boolean {
  if (event.source !== "year" || event.start.year !== targetYear) return false;
  if (event.tags.includes("节假日") || event.tags.includes("培养节点")) return false;
  const provenance = calendarProvenance(event);
  return provenance.sourceTier === "official"
    && provenance.verification === "verified"
    && isOfficialCalendarSource(event.payload.sourceUrl);
}

function openingSort(left: CalendarEvent, right: CalendarEvent): number {
  return left.start.month - right.start.month
    || (left.start.day ?? 0) - (right.start.day ?? 0)
    || left.title.localeCompare(right.title, "zh")
    || left.id.localeCompare(right.id);
}

/** Current-year verified opportunities, ordered for a date-led list. */
export function yearOpenings(events: readonly CalendarEvent[], targetYear: number): CalendarEvent[] {
  return events.filter((event) => isYearOpening(event, targetYear)).sort(openingSort);
}

/** Small count helper for a future opening-list badge without exposing raw candidates. */
export function yearOpeningsCount(events: readonly CalendarEvent[], targetYear: number): number {
  return events.reduce((count, event) => count + Number(isYearOpening(event, targetYear)), 0);
}
