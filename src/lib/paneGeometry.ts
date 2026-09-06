export interface PaneWidthBounds {
  sidebar: { min: number; max: number };
  list: { min: number; max: number };
}
export const MIN_READER_PANE = 360;
export interface PaneWidths { sidebarWidth: number; listWidth: number; readerWidth: number }

/** Fit only the displayed geometry. Never mutate the saved drag preferences:
 *  their exact widths return as soon as the viewport has enough room. */
export function fitPaneWidths(viewportWidth: number, preferredSidebar: number, preferredList: number, bounds: PaneWidthBounds): PaneWidths {
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? value : range.min));
  const sidebar = clamp(preferredSidebar, bounds.sidebar);
  const list = clamp(preferredList, bounds.list);
  const minimumLeft = bounds.sidebar.min + bounds.list.min;
  // The native window is at least 920px wide. This floor also remains sane
  // in smaller isolated previews: reserve the navigation minima when possible.
  const readerMinimum = Math.min(MIN_READER_PANE, Math.max(0, width - minimumLeft));
  const available = Math.max(0, width - readerMinimum);
  if (sidebar + list <= available) return { sidebarWidth: sidebar, listWidth: list, readerWidth: width - sidebar - list };
  if (available < minimumLeft) {
    const sidebarWidth = available * bounds.sidebar.min / minimumLeft;
    return { sidebarWidth, listWidth: available - sidebarWidth, readerWidth: width - available };
  }
  const flexible = sidebar + list - minimumLeft;
  const remaining = available - minimumLeft;
  const sidebarWidth = bounds.sidebar.min + (flexible > 0 ? remaining * (sidebar - bounds.sidebar.min) / flexible : 0);
  const listWidth = available - sidebarWidth;
  return { sidebarWidth, listWidth, readerWidth: width - available };
}

export function paneResizeMax(viewportWidth: number, pane: "sidebar" | "list", bounds: PaneWidthBounds, displayed: PaneWidths): number {
  const otherWidth = pane === "sidebar" ? displayed.listWidth : displayed.sidebarWidth;
  return Math.max(bounds[pane].min, Math.min(bounds[pane].max, viewportWidth - MIN_READER_PANE - otherWidth));
}

/** During an explicit drag the other pane must stay at its displayed width:
 *  restoring its larger saved preference would make this boundary stop moving.
 *  Keep this snapshot in memory only, and discard it on viewport resize. */
export function resizePaneWidths(viewportWidth: number, displayed: PaneWidths, pane: "sidebar" | "list", requested: number, bounds: PaneWidthBounds): PaneWidths {
  const next = Math.min(paneResizeMax(viewportWidth, pane, bounds, displayed), Math.max(bounds[pane].min, requested));
  const sidebarWidth = pane === "sidebar" ? next : displayed.sidebarWidth;
  const listWidth = pane === "list" ? next : displayed.listWidth;
  return { sidebarWidth, listWidth, readerWidth: Math.max(0, viewportWidth - sidebarWidth - listWidth) };
}
