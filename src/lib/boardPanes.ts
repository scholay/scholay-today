import { fitPaneWidths, MIN_READER_PANE, type PaneWidthBounds, type PaneWidths } from "./paneGeometry";

export type BoardWorkspace = "hotboard" | "labels" | "calendar" | "files";
export interface BoardPanePreference { sidebarWidth: number; listWidth: number }
export const BOARD_PANE_BOUNDS: PaneWidthBounds = { sidebar: { min: 200, max: 420 }, list: { min: 280, max: 560 } };
export const HOT_PANE_BOUNDS: PaneWidthBounds = { ...BOARD_PANE_BOUNDS, list: { min: 280, max: Number.MAX_SAFE_INTEGER } };
export const boardPaneBounds = (workspace: BoardWorkspace) => workspace === "hotboard" ? HOT_PANE_BOUNDS : BOARD_PANE_BOUNDS;
export const boardPaneKey = (workspace: BoardWorkspace) => `scholay.${workspace}.panes.v1`;
export function parseBoardPanes(raw: string | null, workspace: BoardWorkspace): BoardPanePreference {
  const fallback = { sidebarWidth: workspace === "files" ? 220 : 248, listWidth: workspace === "labels" ? 370 : workspace === "files" ? 300 : 360 };
  try {
    const value = JSON.parse(raw ?? "null");
    const valid = (n: unknown, min: number, max: number, fallback: number) => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    return {
      sidebarWidth: valid(value?.sidebarWidth, 200, 420, fallback.sidebarWidth),
      listWidth: valid(value?.listWidth, 280, boardPaneBounds(workspace).list.max, fallback.listWidth),
    };
  } catch { return fallback; }
}
export function fitBoardPanes(viewport: number, preference: BoardPanePreference, hasList: boolean, bounds = BOARD_PANE_BOUNDS): PaneWidths {
  if (hasList) return fitPaneWidths(viewport, preference.sidebarWidth, preference.listWidth, bounds);
  const width = Number.isFinite(viewport) ? Math.max(0, viewport) : 0;
  const preferred = Math.min(420, Math.max(200, preference.sidebarWidth));
  const sidebarWidth = Math.min(preferred, Math.max(Math.min(200, width), width - MIN_READER_PANE));
  return { sidebarWidth, listWidth: 0, readerWidth: width - sidebarWidth };
}
