// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceSwitcher, { type Workspace } from "../components/WorkspaceSwitcher";

let host: HTMLDivElement;
let root: Root;
const change = vi.fn();
const render = (workspace: Workspace = "rss", captureBusy = false) => act(() => root.render(createElement(WorkspaceSwitcher, { workspace, captureBusy, onChange: change })));
const items = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.platform = "mac";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  change.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("small title brand and full-width workspace segments", () => {
  it("shows three direct icon choices without a large adjacent logo or dropdown", () => {
    render("hotboard");
    expect(items().map(item => item.textContent)).toEqual(["RSS", "热榜", "标签"]);
    expect(host.querySelector(".app-brand-name")).toBeNull();
    expect(host.querySelector(".app-brand-logo")).not.toBeNull();
    expect(host.querySelector(".workspace-brand")).toBeNull();
    expect(host.querySelector(".workspace-tabs")?.nextElementSibling).toBeNull();
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector("img")?.getAttribute("width")).toBe("14");
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
    for (const item of items()) expect(item.querySelector("svg")).not.toBeNull();
    expect(items().map(item => item.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });
  it("switches each workspace with one click and preserves accessible targets", () => {
    render();
    for (const [index, workspace] of ["rss", "hotboard", "labels"].entries()) {
      change.mockClear();
      expect(items()[index].getAttribute("aria-controls")).toBe(`workspace-${workspace}-panel`);
      act(() => items()[index].click());
      expect(change).toHaveBeenCalledExactlyOnceWith(workspace);
    }
  });
  it("follows host selection without maintaining stale local state", () => {
    render(); render("labels");
    expect(items().map(item => item.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(change).not.toHaveBeenCalled();
  });
  it("keeps the exact product name in the title strip across all workspaces", () => {
    for (const workspace of ["rss", "hotboard", "labels"] as const) {
      render(workspace);
      expect(host.querySelector(".workspace-title-brand")?.textContent).toBe("scholay today");
      expect(host.querySelector(".workspace-purpose")).toBeNull();
      expect(items()).toHaveLength(3);
    }
  });
  it("locks all three controls during capture and restores them afterwards", () => {
    render("labels", true);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    for (const item of items()) { expect(item.disabled).toBe(true); act(() => item.click()); }
    expect(change).not.toHaveBeenCalled();
    render("labels");
    expect(items().every(item => !item.disabled)).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it("retains platform-specific shortcut hints and native button keyboard activation", () => {
    render();
    expect(items().map(item => item.title)).toEqual(["RSS · ⌘1", "热榜 · ⌘2", "标签 · ⌘3"]);
    expect(items().every(item => item.tabIndex === 0 && item.type === "button")).toBe(true);
    document.documentElement.dataset.platform = "other";
    render("labels");
    expect(items()[2].title).toBe("标签 · Ctrl+3");
  });
});
