export type TrendsSection = "hot" | "labels";
export const TRENDS_SECTION_KEY = "scholay.hot.section.v1";

export function parseTrendsSection(raw: string | null): TrendsSection {
  return raw === "labels" ? "labels" : "hot";
}

export function loadTrendsSection(): TrendsSection {
  try { return parseTrendsSection(localStorage.getItem(TRENDS_SECTION_KEY)); }
  catch { return "hot"; }
}

export function saveTrendsSection(section: TrendsSection) {
  try { localStorage.setItem(TRENDS_SECTION_KEY, section); }
  catch { /* Preference is optional. */ }
}
