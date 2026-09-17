import { describe, expect, it } from "vitest";
import { BOARD_PANE_BOUNDS, boardPaneKey, fitBoardPanes, parseBoardPanes } from "./boardPanes";
import { resizePaneWidths } from "./paneGeometry";

describe("independent resizable board geometry", () => {
  it("uses separate persistence keys and tolerates malformed preferences", () => {
    expect(boardPaneKey("labels")).not.toBe(boardPaneKey("hotboard"));
    expect(boardPaneKey("calendar")).not.toBe(boardPaneKey("labels"));
    expect(parseBoardPanes("{", "hotboard")).toEqual({ sidebarWidth: 248, listWidth: 360 });
    expect(parseBoardPanes('{"sidebarWidth":10000,"listWidth":"large"}', "labels")).toEqual({ sidebarWidth: 420, listWidth: 370 });
  });
  it("supports the full range without the former 248px/360px/370px caps", () => {
    expect(fitBoardPanes(1440, { sidebarWidth: 420, listWidth: 560 }, true)).toEqual({ sidebarWidth: 420, listWidth: 560, readerWidth: 460 });
  });
  it("fits both overview and detail layouts without losing saved widths", () => {
    const preference = Object.freeze({ sidebarWidth: 420, listWidth: 560 });
    for (const width of [920, 1024, 1280, 1763]) for (const hasList of [false, true]) {
      const panes = fitBoardPanes(width, preference, hasList);
      expect(panes.readerWidth).toBeGreaterThanOrEqual(360);
      expect(panes.sidebarWidth).toBeGreaterThanOrEqual(200);
      expect(panes.listWidth).toBeGreaterThanOrEqual(hasList ? 280 : 0);
      expect(panes.sidebarWidth + panes.listWidth + panes.readerWidth).toBeCloseTo(width);
    }
    expect(fitBoardPanes(1440, preference, false).sidebarWidth).toBe(420);
    expect(fitBoardPanes(1440, preference, true).listWidth).toBe(560);
  });
  it("allows overview resizing without reserving an invisible list", () => {
    const before = fitBoardPanes(920, { sidebarWidth: 248, listWidth: 560 }, false);
    expect(resizePaneWidths(920, before, "sidebar", 420, BOARD_PANE_BOUNDS)).toEqual({ sidebarWidth: 420, listWidth: 0, readerWidth: 500 });
  });
  it("keeps geometry nonnegative below the native minimum", () => {
    for (const width of [0, 100, 320, 640]) for (const hasList of [false, true]) {
      const panes = fitBoardPanes(width, { sidebarWidth: 420, listWidth: 560 }, hasList);
      expect(Object.values(panes).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    }
  });
});
