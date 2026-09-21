import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { BOARD_PANE_BOUNDS, boardPaneKey, fitBoardPanes, parseBoardPanes, type BoardWorkspace } from "../lib/boardPanes";
import { paneResizeMax, resizePaneWidths, type PaneWidths } from "../lib/paneGeometry";

/** Each board owns its geometry and saved preferences. Never write RSS's
 * root CSS variables or rewrite preferred widths during a window resize. */
export function useBoardPanes(workspace: BoardWorkspace, hasList: boolean, active: boolean) {
  const hostRef = useRef<HTMLElement>(null);
  const [preference, setPreference] = useState(() => {
    try { return parseBoardPanes(localStorage.getItem(boardPaneKey(workspace)), workspace); }
    catch { return parseBoardPanes(null, workspace); }
  });
  const [viewport, setViewport] = useState(() => document.documentElement.clientWidth || window.innerWidth);
  const [snapshot, setSnapshot] = useState<{ viewport: number; hasList: boolean; widths: PaneWidths } | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      // Pane variables are CSS layout pixels. A bounding rect includes the
      // application zoom and would apply that scale a second time to columns.
      const width = host.clientWidth || host.getBoundingClientRect().width;
      if (width > 0) setViewport(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // Resizing away and back must not resurrect a temporary compressed snapshot.
  useLayoutEffect(() => setSnapshot(null), [viewport, hasList]);
  const widths = snapshot?.viewport === viewport && snapshot.hasList === hasList
    ? snapshot.widths : fitBoardPanes(viewport, preference, hasList);
  const resize = (pane: "sidebar" | "list", requested: number) => {
    if (!active || !Number.isFinite(requested) || (pane === "list" && !hasList)) return;
    const next = resizePaneWidths(viewport, widths, pane, requested, BOARD_PANE_BOUNDS);
    setSnapshot({ viewport, hasList, widths: next });
    const saved = { ...preference, [pane === "sidebar" ? "sidebarWidth" : "listWidth"]: pane === "sidebar" ? next.sidebarWidth : next.listWidth };
    setPreference(saved);
    try { localStorage.setItem(boardPaneKey(workspace), JSON.stringify(saved)); } catch { /* Drag still works without persistence. */ }
  };
  return {
    hostRef, widths, resize,
    sidebarMax: paneResizeMax(viewport, "sidebar", BOARD_PANE_BOUNDS, widths),
    listMax: paneResizeMax(viewport, "list", BOARD_PANE_BOUNDS, widths),
    style: { "--hot-sidebar-width": `${widths.sidebarWidth}px`, "--hot-list-width": `${widths.listWidth}px` } as CSSProperties,
  };
}
