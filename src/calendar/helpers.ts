import type { AlmanacMonth, CalendarDay, HistoryEvent, YearNode, YearPhase } from "./types";

export const CALENDAR_TIMEZONE = "Asia/Shanghai";
export const MONTH_LABELS = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];
export const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export const MONTH_SHORT_LABELS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
export const YEAR_CATEGORY_LABELS: Record<string, string> = {
  term: "学期",
  degree: "培养学位",
  recruit: "招生推免",
  research: "科研申报",
  career: "职称考核",
  award: "评奖评优",
  employment: "就业招聘",
  break: "假期节点",
};
export const YEAR_PHASE_LABELS: Record<YearPhase, string> = {
  past: "已经发生",
  current: "本月进行",
  upcoming: "即将发生",
};

export function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function dateKeyFromParts(month: number, day: number): string {
  return `${padDatePart(month)}-${padDatePart(day)}`;
}

/** Day index on the 366-day almanac grid (February always has 29). */
const ALMANAC_CUMULATIVE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

export function almanacDayIndex(month: number, day: number): number {
  return ALMANAC_CUMULATIVE[month - 1] + day;
}

export function parseDateKey(dateKey: string): { month: number; day: number } {
  const [month, day] = dateKey.split("-").map(Number);
  return { month, day };
}

export function shanghaiToday(now = new Date()): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return { year, month, day, dateKey: dateKeyFromParts(month, day) };
}

export function shanghaiCivilFromIso(value: string): CalendarDay | null {
  const trimmed = value.trim();
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayOnly) {
    const year = Number(dayOnly[1]);
    const month = Number(dayOnly[2]);
    const day = Number(dayOnly[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day, dateKey: dateKeyFromParts(month, day) };
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return shanghaiToday(date);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function historyDaysInMonth(year: number, month: number): number {
  return month === 2 ? 29 : daysInMonth(year, month);
}

export function historyYearMonths(year: number): AlmanacMonth[] {
  return Array.from({ length: 12 }, (_, index) => ({ year, month: index + 1 }));
}

export function yearNodePhase(eventMonth: number, todayMonth: number): YearPhase {
  if (eventMonth < todayMonth) return "past";
  if (eventMonth > todayMonth) return "upcoming";
  return "current";
}

export function groupYearNodes(nodes: YearNode[], todayMonth: number): Record<YearPhase, YearNode[]> {
  const groups: Record<YearPhase, YearNode[]> = { past: [], current: [], upcoming: [] };
  for (const node of nodes) groups[yearNodePhase(node.month, todayMonth)].push(node);
  return groups;
}

export function eventsOnDate(events: readonly HistoryEvent[], dateKey: string): HistoryEvent[] {
  return events.filter((event) => event.dateKey === dateKey).sort((a, b) => a.year - b.year || a.title.localeCompare(b.title, "zh"));
}

export function clipTitle(title: string, max = 8): string {
  const chars = [...title];
  return chars.length <= max ? title : `${chars.slice(0, max).join("")}…`;
}

export function weekRows<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += 7) rows.push(items.slice(index, index + 7));
  return rows;
}

export interface MonthGridCell {
  year: number;
  month: number;
  day: number;
  dateKey: string;
  inMonth: boolean;
}

export function weekdaySundayIndex(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function monthGrid(year: number, month: number): MonthGridCell[] {
  return buildMonthGrid(year, month, daysInMonth);
}

export function historyMonthGrid(year: number, month: number): MonthGridCell[] {
  return buildMonthGrid(year, month, historyDaysInMonth);
}

function buildMonthGrid(year: number, month: number, daysFor: (year: number, month: number) => number): MonthGridCell[] {
  const days = daysFor(year, month);
  const lead = weekdaySundayIndex(year, month, 1);
  const cells: MonthGridCell[] = [];
  const push = (cellYear: number, cellMonth: number, day: number, inMonth: boolean) => {
    cells.push({ year: cellYear, month: cellMonth, day, dateKey: dateKeyFromParts(cellMonth, day), inMonth });
  };
  if (lead > 0) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevDays = daysFor(prevYear, prevMonth);
    for (let i = lead - 1; i >= 0; i -= 1) push(prevYear, prevMonth, prevDays - i, false);
  }
  for (let day = 1; day <= days; day += 1) push(year, month, day, true);
  const fill = (7 - (cells.length % 7)) % 7;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let day = 1; day <= fill; day += 1) push(nextYear, nextMonth, day, false);
  return cells;
}

export function shiftAlmanacPage(anchor: AlmanacMonth, monthDelta: number): AlmanacMonth {
  const next = new Date(Date.UTC(anchor.year, anchor.month - 1 + monthDelta, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

export function pairMonths(anchor: AlmanacMonth): [AlmanacMonth, AlmanacMonth] {
  return [anchor, shiftAlmanacPage(anchor, 1)];
}

export function sameAlmanacMonth(left: AlmanacMonth, right: AlmanacMonth): boolean {
  return left.year === right.year && left.month === right.month;
}

export function monthInPair(anchor: AlmanacMonth, target: AlmanacMonth): boolean {
  const [first, second] = pairMonths(anchor);
  return sameAlmanacMonth(first, target) || sameAlmanacMonth(second, target);
}

export function pairOriginForDay(day: AlmanacMonth, current: AlmanacMonth): AlmanacMonth {
  if (monthInPair(current, day)) return current;
  return { year: day.year, month: day.month };
}

export function monthRange(start: AlmanacMonth, count: number): AlmanacMonth[] {
  return Array.from({ length: count }, (_, index) => shiftAlmanacPage(start, index));
}

export function almanacPageLabel(anchor: AlmanacMonth): string {
  const next = shiftAlmanacPage(anchor, 1);
  if (anchor.year === next.year) return `${anchor.year} 年 ${anchor.month} 月 — ${next.month} 月`;
  return `${anchor.year} 年 ${anchor.month} 月 — ${next.year} 年 ${next.month} 月`;
}

export function sameDay(left: { year: number; month: number; day: number }, right: { year: number; month: number; day: number }): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function sameDateKey(left: { month: number; day: number }, right: { month: number; day: number }): boolean {
  return left.month === right.month && left.day === right.day;
}

export function inferMonthDay(meta: string, year: number, month: number): number {
  const last = daysInMonth(year, month);
  if (/上中旬/.test(meta)) return Math.min(10, last);
  if (/中下旬/.test(meta)) return Math.min(20, last);
  if (/上旬/.test(meta)) return Math.min(8, last);
  if (/中旬/.test(meta)) return Math.min(15, last);
  if (/月底/.test(meta)) return last;
  if (/下旬/.test(meta)) return Math.min(25, last);
  if (/月初/.test(meta)) return 3;
  return Math.min(15, last);
}

export function shiftDateKey(dateKey: string, year: number, delta: number): { dateKey: string; year: number } {
  const [month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: next.getUTCFullYear(),
    dateKey: dateKeyFromParts(next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

export function shiftMonthKey(dateKey: string, year: number, monthDelta: number): string {
  const [month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  const nextMonth = next.getUTCMonth() + 1;
  const nextYear = next.getUTCFullYear();
  return dateKeyFromParts(nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
}
