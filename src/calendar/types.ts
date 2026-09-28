export type CalendarView = "year" | "history";
export type CalendarLayout = "almanac" | "timeline" | "openings";
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
/** How this calendar item entered the product. */
export type CalendarEventOrigin = "rss" | "web_search" | "curated";
/** The authority of the page linked as evidence, not the authority of its title. */
export type CalendarSourceTier = "official" | "official_repost" | "aggregator" | "community" | "unknown";
/** A date is only verified after an editor has checked it against its source page. */
export type CalendarVerificationStatus = "verified" | "needs_review" | "unverified";

/**
 * Optional while legacy RSS seeds are migrated. Search discoveries should carry
 * all three fields before they become public calendar events.
 */
export interface CalendarProvenance {
  origin?: CalendarEventOrigin;
  sourceTier?: CalendarSourceTier;
  verification?: CalendarVerificationStatus;
  reviewedAt?: string;
}

/**
 * A displayable source image. Images are deliberately separate from article
 * sources: a cited page is not automatically licensed as a visual asset.
 */
export interface CalendarMedia {
  imageUrl: string;
  sourcePage: string;
  credit: string;
  alt: string;
  /** "cleared" is the only status the interface is allowed to render. */
  reuseStatus: "cleared" | "needs_permission";
  reviewedAt: string;
  /** Preserve diagrams and tall archival images rather than cropping them. */
  fit?: "cover" | "contain";
}

export interface EventDate {
  year: number;
  month: number;
  day: number | null;
}

export interface CalendarEventPayload {
  /** Short, source-attributed digest for the collapsed card state. */
  summary?: string;
  /** Full text captured from the primary page, when local storage has it. */
  body?: string;
  /** The local source capture was capped; keep the primary page available. */
  bodyTruncated?: boolean;
  meta?: string;
  scope?: string | null;
  sourceName?: string;
  sourceUrl?: string;
  factSummary?: string;
  historicalSignificance?: string;
  eventType?: string;
  importance?: string;
  sources?: HistorySource[];
  provenance?: CalendarProvenance;
  media?: CalendarMedia;
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
