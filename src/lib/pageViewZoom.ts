export type PageZoomMode = "fit" | "manual";

export interface PageViewZoomEvent {
  requestId: string;
  factor: number;
  mode: PageZoomMode;
}

export type PageZoomAction = "in" | "out" | "reset" | "fit" | "get";

export function isPageViewZoomEvent(value: unknown): value is PageViewZoomEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<PageViewZoomEvent>;
  return typeof event.requestId === "string"
    && Number.isFinite(event.factor)
    && (event.mode === "fit" || event.mode === "manual");
}

export function formatPageZoom(factor: number): string {
  const safe = Number.isFinite(factor) ? factor : 1;
  return `${Math.round(safe * 100)}%`;
}
