import type { LabelCapture } from "./history";

export const EDITION_HOURS = 8;
export const EDITION_MS = EDITION_HOURS * 3600_000;
const BEIJING_OFFSET = 8 * 3600_000;
export interface LabelEdition { start: number; captures: LabelCapture[] }
export interface EditionPage { editions: LabelEdition[]; hasMore: boolean }
/** Fixed Beijing slots: 00–08 / 08–16 / 16–24, independent of OS timezone/DST. */
export const editionStart = (at: number) => Math.floor((at + BEIJING_OFFSET) / EDITION_MS) * EDITION_MS - BEIJING_OFFSET;
export function editionDay(start: number): string { return new Date(start + BEIJING_OFFSET).toISOString().slice(0, 10); }
export function editionHours(start: number): string {
  const hour = new Date(start + BEIJING_OFFSET).getUTCHours();
  return `${String(hour).padStart(2, "0")}:00–${String(hour + EDITION_HOURS).padStart(2, "0")}:00`;
}
export const editionTitle = (start: number) => `${editionDay(start)} ${editionHours(start)}`;
/** One latest observation per provider in an edition; never combine different
 * slots to pretend a missing provider has fresh data. */
export function groupEditions(captures: LabelCapture[]): LabelEdition[] {
  const slots = new Map<number, Map<string, LabelCapture>>();
  for (const capture of captures) {
    const start = editionStart(capture.at);
    if (!slots.has(start)) slots.set(start, new Map());
    const providers = slots.get(start)!;
    if (!providers.has(capture.sourceId) || providers.get(capture.sourceId)!.at < capture.at) providers.set(capture.sourceId, capture);
  }
  return [...slots].sort(([a], [b]) => b - a).map(([start, values]) => ({ start, captures: [...values.values()] }));
}
