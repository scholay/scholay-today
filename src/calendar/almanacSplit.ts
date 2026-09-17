export const CALENDAR_SPLIT_KEY = "scholay.calendar.split.v1";
export const ALMANAC_MIN = 240;
export const DETAIL_MIN = 320;
export const ALMANAC_DEFAULT = 360;

export function parseAlmanacWidth(raw: string | null): number {
  try {
    const value = JSON.parse(raw ?? "null");
    const width = value?.almanacWidth;
    if (typeof width === "number" && Number.isFinite(width)) return Math.min(800, Math.max(ALMANAC_MIN, width));
  } catch { /* Preference is optional. */ }
  return ALMANAC_DEFAULT;
}

export function fitAlmanacWidth(splitWidth: number, preferred: number): { almanacWidth: number; maxAlmanac: number } {
  const width = Number.isFinite(splitWidth) ? Math.max(0, splitWidth) : 0;
  if (width === 0) return { almanacWidth: preferred, maxAlmanac: Math.max(preferred, ALMANAC_MIN) };
  const minAlmanac = Math.min(ALMANAC_MIN, width);
  const minDetail = Math.min(DETAIL_MIN, Math.max(0, width - minAlmanac));
  const maxAlmanac = Math.max(minAlmanac, width - minDetail);
  return {
    almanacWidth: Math.min(maxAlmanac, Math.max(minAlmanac, preferred)),
    maxAlmanac,
  };
}

export function persistAlmanacWidth(width: number) {
  try { localStorage.setItem(CALENDAR_SPLIT_KEY, JSON.stringify({ almanacWidth: width })); }
  catch { /* Drag still works without persistence. */ }
}
