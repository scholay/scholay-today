// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import LabelBoard from "./LabelBoard";
import { LABEL_CACHE_KEY, LABEL_UI_KEY } from "./helpers";
import { labelHistoryStats, makeCapture, readLabelEditions, saveLabelCaptures } from "./history";
import { editionStart } from "./editions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./LabelAuthorization", () => ({ default: () => null }));
let host: HTMLDivElement, root: Root;
const row = { term: "科研话题", kind: "抖音实时热点", metric: "100万", metricLabel: "热点指数", rank: 1 };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear(); localStorage.setItem(LABEL_UI_KEY, '{"sourceId":"douyin"}');
  localStorage.setItem(LABEL_CACHE_KEY, JSON.stringify({ douyin: { rows: [row], period: "旧榜单", capturedAt: new Date(editionStart(Date.now()) + 10).toISOString() } }));
  vi.mocked(invoke).mockImplementation(async command => command === "get_label_credential_status" ? { configured: false } : command === "collect_label_source" ? { auth: "unknown", rows: [{ ...row, rank: 2 }], period: "新榜单" } : undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const render = () => act(async () => root.render(createElement(LabelBoard, { active: true })));
const waitFor = async (check: () => void) => {
  // Flush each IndexedDB task and React commit separately; an outer act would
  // batch the very state updates whose rendered result the assertion awaits.
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { check(); return; } catch (error) { if (attempt === 99) throw error; }
  }
};

it("pins the current edition, updates it without another row, and restores older editions after remount", async () => {
  await saveLabelCaptures([makeCapture("douyin", { rows: [{ ...row, rank: 5 }], period: "上期榜单", capturedAt: new Date(editionStart(Date.now()) - 1000).toISOString() })!]);
  await render();
  await waitFor(() => expect(host.querySelector('.label-latest-pinned')?.textContent).toContain("1 条标签"));
  await act(async () => (host.querySelector('[aria-label="同步标签并保存快照"]') as HTMLButtonElement).click());
  await waitFor(() => expect(host.querySelector('.label-auth-state')?.textContent).toBe("已采集并保存快照"));
  await waitFor(() => expect(host.querySelector('.label-insight-expanded')?.textContent).toContain("新榜单"));
  await act(async () => {
    expect((await labelHistoryStats("douyin")).count).toBe(3);
    expect((await readLabelEditions("douyin")).editions).toHaveLength(2);
  });
  const points = host.querySelectorAll<HTMLButtonElement>(".label-snapshot");
  expect(points).toHaveLength(1);
  await act(async () => points[0].click());
  expect(host.querySelector(".label-insights")?.textContent).toContain("1 个标签");
  expect(host.querySelector(".label-insight-expanded")?.textContent).toContain("上期榜单");
  await act(async () => root.unmount()); root = createRoot(host);
  await render();
  await waitFor(() => expect(host.querySelectorAll('.label-snapshot')).toHaveLength(1));
  await act(async () => {
    expect((await readLabelEditions("douyin")).editions.map(item => item.captures[0].rows[0].rank)).toEqual([2, 5]);
  });
});

it("does not create blank history or clear prior observations after an empty failed collection", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "collect_label_source" ? { auth: "challenge", rows: [], period: "" } : undefined);
  await render();
  await waitFor(() => expect(host.querySelector('.label-latest-pinned')?.textContent).toContain("1 条标签"));
  await act(async () => (host.querySelector('[aria-label="同步标签并保存快照"]') as HTMLButtonElement).click());
  await waitFor(() => expect(host.querySelector('.label-auth-state')?.textContent).toBe("需要安全验证"));
  expect((await labelHistoryStats("douyin")).count).toBe(1);
  expect(host.querySelector(".label-insights")?.textContent).toContain("科研话题");
});
