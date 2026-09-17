// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceSwitcher, { parseWorkspace, type Workspace } from "../components/WorkspaceSwitcher";

let host: HTMLDivElement;
let root: Root;
const change = vi.fn();
const openSettings = vi.fn();
const render = (workspace: Workspace = "rss", captureBusy = false) => act(() => root.render(createElement(WorkspaceSwitcher, {
  workspace, captureBusy, onChange: change, onOpenSettings: openSettings,
})));
const rail = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".workspace-rail-group button"));
const settings = () => host.querySelector<HTMLButtonElement>(".workspace-rail-settings");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.platform = "mac";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  change.mockClear();
  openSettings.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("activity rail and feature title", () => {
  it("shows the brand logo as RSS plus files and settings without a product wordmark", () => {
    render("hot");
    expect(rail().map(item => item.textContent)).toEqual(["RSS", "文库", "热榜", "标签", "学术年历", "昔日学术"]);
    expect(host.querySelector(".workspace-sidebar-toggle")).toBeNull();
    expect(host.querySelector(".app-brand-name")).toBeNull();
    expect(host.querySelector(".workspace-tabs")).toBeNull();
    expect(rail()[0].querySelector("img")?.getAttribute("src")).toBe("/scholay-logo.png");
    expect(rail()[0].querySelector("svg")).toBeNull();
    for (const item of rail().slice(1)) expect(item.querySelector("svg")).not.toBeNull();
    expect(settings()?.querySelector("svg")).not.toBeNull();
    expect(rail().map(item => item.getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false", "false", "false"]);
    expect(host.querySelector(".workspace-title-brand")?.textContent).toBe("热榜");
  });
  it("switches each workspace with one click and preserves accessible targets", () => {
    render();
    const values: Workspace[] = ["rss", "files", "hot", "labels", "year", "history"];
    const panels = ["workspace-rss-panel", "workspace-files-panel", "workspace-hotboard-panel", "workspace-hotboard-panel", "workspace-calendar-panel", "workspace-calendar-panel"];
    for (const [index, workspace] of values.entries()) {
      change.mockClear();
      expect(rail()[index].getAttribute("aria-controls")).toBe(panels[index]);
      act(() => rail()[index].click());
      expect(change).toHaveBeenCalledExactlyOnceWith(workspace);
    }
  });
  it("follows host selection without maintaining stale local state", () => {
    render(); render("history");
    expect(rail().map(item => item.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "false", "true"]);
    expect(host.querySelector(".workspace-title-brand")?.textContent).toBe("昔日学术");
    expect(change).not.toHaveBeenCalled();
  });
  it("names the current feature in the title strip across all workspaces", () => {
    const labels = ["RSS", "文库", "热榜", "标签", "学术年历", "昔日学术"] as const;
    for (const [index, workspace] of (["rss", "files", "hot", "labels", "year", "history"] as const).entries()) {
      render(workspace);
      expect(host.querySelector(".workspace-title-brand")?.textContent).toBe(labels[index]);
      expect(host.querySelector(".workspace-purpose")).toBeNull();
      expect(rail()).toHaveLength(6);
    }
    render("rss");
    expect(host.querySelector(".workspace-title-brand img")?.getAttribute("src")).toBe("/scholay-logo.png");
  });
  it("locks workspace switching during capture but keeps settings available", () => {
    render("year", true);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    for (const item of rail()) { expect(item.disabled).toBe(true); act(() => item.click()); }
    expect(change).not.toHaveBeenCalled();
    expect(settings()?.disabled).toBe(false);
    act(() => settings()?.click());
    expect(openSettings).toHaveBeenCalledOnce();
    render("year");
    expect(rail().every(item => !item.disabled)).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it("retains platform-specific shortcut hints and native button keyboard activation", () => {
    render();
    expect(rail().map(item => item.title)).toEqual(["RSS · ⌘1", "文库 · ⌘2", "热榜 · ⌘3", "标签 · ⌘4", "学术年历 · ⌘5", "昔日学术 · ⌘6"]);
    expect(settings()?.title).toBe("设置 · ⌘,");
    expect(rail().every(item => item.tabIndex === 0 && item.type === "button")).toBe(true);
    document.documentElement.dataset.platform = "other";
    render("history");
    expect(rail()[5].title).toBe("昔日学术 · Ctrl+6");
    expect(settings()?.title).toBe("设置 · Ctrl+,");
  });
  it("migrates the retired workspace names", () => {
    expect(parseWorkspace("hotboard")).toBe("hot");
    expect(parseWorkspace("calendar")).toBe("year");
    expect(parseWorkspace("home")).toBe("rss");
    expect(parseWorkspace("labels")).toBe("labels");
    expect(parseWorkspace("year")).toBe("year");
    expect(parseWorkspace("files")).toBe("files");
    expect(parseWorkspace("unknown")).toBe("rss");
  });
});
