export const UI_SCALES = ["90", "100", "110", "125"] as const;
export type UiScale = (typeof UI_SCALES)[number];

export function stepUiScale(current: UiScale, delta: -1 | 1): UiScale {
  const index = UI_SCALES.indexOf(current);
  return UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, index + delta))] ?? "100";
}

export function applyUiScale(scale: UiScale) {
  if (typeof document === "undefined") return;
  document.documentElement.style.zoom = String(Number(scale) / 100);
}
