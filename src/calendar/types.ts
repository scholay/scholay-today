export type CalendarView = "year" | "history";
export type CalendarLayout = "almanac" | "timeline";
export type YearPhase = "past" | "current" | "upcoming";

export interface YearNode {
  month: number;
  lane: string;
  category: string;
  title: string;
  meta: string;
  body: string;
  sourceName: string;
  sourceUrl: string;
  scope?: string | null;
}

export interface HistorySource {
  label: string;
  url: string;
}

export interface HistoryEvent {
  dateKey: string;
  year: number;
  title: string;
  domain: string;
  eventType: string;
  importance: string;
  factSummary: string;
  historicalSignificance: string;
  sources: HistorySource[];
  preciseToDay: boolean;
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
  dateKey: string;
}

export type EventPrecision = "day" | "month";
export type EventKind = "point" | "span";
export type EventSource = "year" | "history";

export interface EventDate {
  year: number;
  month: number;
  day: number | null;
}

export interface CalendarEventPayload {
  body?: string;
  meta?: string;
  scope?: string | null;
  sourceName?: string;
  sourceUrl?: string;
  factSummary?: string;
  historicalSignificance?: string;
  eventType?: string;
  importance?: string;
  sources?: HistorySource[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  tags: string[];
  precision: EventPrecision;
  start: EventDate;
  end?: EventDate;
  kind: EventKind;
  source: EventSource;
  approximate: boolean;
  payload: CalendarEventPayload;
}

export interface TagHeat {
  tag: string;
  count: number;
}

export interface AlmanacMonth {
  year: number;
  month: number;
}
