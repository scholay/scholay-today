// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useBoardPanes } from "../hooks/useBoardPanes";
import BoardResizeHandles from "../components/BoardResizeHandles";
import { boardPaneKey, type BoardWorkspace } from "./boardPanes";

let width = 1440;
let callbacks: Set<() => void>;
let host: HTMLDivElement;
let root: Root;
function Harness({ workspace = "hotboard", hasList = true, active = true }: { workspace?: BoardWorkspace; hasList?: boolean; active?: boolean }) {
  const panes = useBoardPanes(workspace, hasList, active);
  return createElement("section", { ref: panes.hostRef, style: panes.style, "data-board": workspace },
    active && createElement(BoardResizeHandles, { panes, hasList, label: workspace }));
}
function render(workspace: BoardWorkspace = "hotboard", hasList = true, active = true) {
  act(() => root.render(createElement(Harness, { key: workspace, workspace, hasList, active })));
}
const handles = () => Array.from(host.querySelectorAll<HTMLElement>('[role="separator"]'));
const current = (index = 0) => Number(handles()[index].getAttribute("aria-valuenow"));
const key = (index: number, key: string) => act(() => handles()[index].dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const resize = (next: number) => act(() => { width = next; callbacks.forEach(callback => callback()); });

beforeEach(() => {
  width = 1440; callbacks = new Set();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("sidebarWidth", "260");
  localStorage.setItem("listWidth", "400");
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { callbacks.add(this.callback); }
    disconnect() { callbacks.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 900, width, height: 900, toJSON() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("board pane drag, keyboard and persistence", () => {
  it("drags the sidebar and adjusts the list using the existing keyboard interaction", () => {
    render();
    act(() => handles()[0].dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 248, bubbles: true })));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 348 })));
    act(() => window.dispatchEvent(new MouseEvent("pointerup")));
    expect(current()).toBe(348);
    key(1, "ArrowRight");
    expect(current(1)).toBe(376);
    expect(JSON.parse(localStorage.getItem(boardPaneKey("hotboard"))!)).toEqual({ sidebarWidth: 348, listWidth: 376 });
    expect(document.body.style.cursor).toBe("");
  });
  it("remembers each board independently without modifying RSS preferences", () => {
    render(); key(0, "ArrowRight");
    expect(current()).toBe(264);
    render("labels"); expect(current()).toBe(248); key(1, "ArrowRight");
    render("hotboard"); expect(current()).toBe(264); expect(current(1)).toBe(360);
    render("labels"); expect(current(1)).toBe(386);
    expect(localStorage.getItem("sidebarWidth")).toBe("260");
    expect(localStorage.getItem("listWidth")).toBe("400");
  });
  it("does not overwrite preferences when shrinking the window or changing overview mode", () => {
    const saved = JSON.stringify({ sidebarWidth: 420, listWidth: 560 });
    localStorage.setItem(boardPaneKey("hotboard"), saved);
    render(); resize(920);
    expect(current()).toBeLessThan(420);
    expect(current(1)).toBeLessThan(560);
    expect(localStorage.getItem(boardPaneKey("hotboard"))).toBe(saved);
    resize(1440); expect(current()).toBe(420); expect(current(1)).toBe(560);
    render("hotboard", false); expect(handles()).toHaveLength(1); expect(current()).toBe(420);
    render(); expect(handles()).toHaveLength(2); expect(current(1)).toBe(560);
  });
  it("preserves the other pane's saved preference after dragging in a compressed window", () => {
    localStorage.setItem(boardPaneKey("hotboard"), JSON.stringify({ sidebarWidth: 420, listWidth: 560 }));
    render(); resize(920); key(0, "ArrowLeft");
    const after = JSON.parse(localStorage.getItem(boardPaneKey("hotboard"))!);
    expect(after.listWidth).toBe(560);
    resize(1440); expect(current()).toBe(Math.round(after.sidebarWidth)); expect(current(1)).toBe(560);
  });
  it("cancels an in-progress drag when leaving the board", () => {
    render();
    act(() => handles()[0].dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 248, bubbles: true })));
    expect(document.body.style.cursor).toBe("col-resize");
    render("hotboard", true, false);
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 420 })));
    expect(localStorage.getItem(boardPaneKey("hotboard"))).toBeNull();
    expect(document.body.style.cursor).toBe("");
    expect(handles()).toHaveLength(0);
  });
  it("continues to resize when saving preferences fails", () => {
    render();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    key(0, "ArrowRight");
    expect(current()).toBe(264);
  });
});
