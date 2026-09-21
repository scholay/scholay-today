// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import FilesBoard from "./FilesBoard";
import ResizeHandle from "../components/ResizeHandle";
import type { StructuredListItem } from "../types";
import { closeReadingTabs, emptyGroupSession, reopenReadingTab, useReadingGroups } from "../lib/readingGroups";
import { useReaderTabs } from "../lib/readerTabs";
import { useUi } from "../store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key, language: "en" } }));
vi.mock("../toast", () => ({ reportError: vi.fn(), toast: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root, host: HTMLDivElement, qc: QueryClient;
const folders = [{ id: 1, name: "Parent", position: 0 }, { id: 2, name: "Child", position: 1, parentId: 1 }, { id: 3, name: "Empty", position: 2 }];
const doc = (id: number, folderId: number | null): StructuredListItem => ({ articleId: id, feedId: 1, feedTitle: "Test feed", folderId, folderName: folderId === 2 ? "Child" : null, title: `Document ${id}`, url: null, publishedAt: null, cleanedAt: "2026-09-21", sourceKind: "web", blocks: 1, words: 20, images: 0, staleSchema: false });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function mount(docs: StructuredListItem[] = []) {
  qc.setQueryData(["folders"], folders); qc.setQueryData(["structured-documents"], docs);
  for (const item of docs) qc.setQueryData(["structured", item.articleId], { articleId: item.articleId, cleaned: true, markdown: `## Heading ${item.articleId}\n\nStored evidence.` });
  await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(FilesBoard, { active: true }))));
  await settle();
}
async function button(text: string, selector = "button") {
  const found = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(el => el.textContent?.includes(text));
  if (!found) throw Error(`Missing ${text}`);
  await act(() => found.click()); await settle();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.mocked(invoke).mockClear(); localStorage.clear();
  useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null });
  useReadingGroups.setState({ ...emptyGroupSession(), closed: [], loading: {} });
  useUi.setState({ modalOpen: false, menuOpen: false, aiOpen: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
});
afterEach(async () => { await act(() => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals(); });

it("hides empty folders and unfiled, while retaining populated ancestors", async () => {
  await mount([doc(1, 2)]);
  const nav = host.querySelector(".files-tree")!;
  expect(nav.textContent).toContain("Parent"); expect(nav.textContent).toContain("Child");
  expect(nav.textContent).not.toContain("Empty"); expect(nav.textContent).not.toContain("未分类");
});
it("preloads explicit offline examples without any article IPC or real count changes", async () => {
  await mount();
  expect(host.querySelector(".files-list h2")?.textContent).toBe("排版示例");
  expect(host.querySelectorAll(".files-list li")).toHaveLength(3);
  await button("一篇清洗文档", ".files-list button");
  expect(host.querySelector(".files-reader-head h1")?.textContent).toContain("一篇清洗文档");
  expect(host.querySelector(".files-example-notice")?.textContent).toContain("非真实文章");
  expect(host.querySelector(".files-tree")?.textContent).toContain("全部已清洗0");
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => /article|structured|capture|ai_/.test(name))).toHaveLength(0);
  await button("全部已清洗");
  expect(host.querySelectorAll(".files-list li")).toHaveLength(0);
  expect(host.querySelector(".files-reader-head h1")?.textContent).toContain("一篇清洗文档");
  expect(host.querySelector(".files-list .is-active")).toBeNull();
});
it("scope changes preserve the active tab; each document restores its own source mode and scroll", async () => {
  await mount([doc(1, 2), doc(2, null)]);
  await button("Document 1", ".files-list button");
  await button("aiFormatted.source");
  const source = host.querySelector("textarea")!;
  await act(() => { source.scrollTop = 87; source.dispatchEvent(new Event("scroll")); });
  await button("未分类", ".files-tree button");
  expect(host.querySelector(".files-reader-head h1")?.textContent).toBe("Document 1");
  expect(host.querySelector(".files-list .is-active")).toBeNull();
  await button("Document 2", ".files-list button");
  expect(host.querySelector(".files-reader-head h1")?.textContent).toBe("Document 2");
  expect(host.querySelector("textarea")).toBeNull();
  await button("Child", ".files-tree button");
  expect(host.querySelector(".files-reader-head h1")?.textContent).toBe("Document 2");
  await button("Document 1", ".files-list button");
  expect(host.querySelector(".files-reader-head h1")?.textContent).toBe("Document 1");
  expect(host.querySelector("textarea")?.scrollTop).toBe(87);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
});
it("removes an emptied folder after refresh without leaving a dead selected scope", async () => {
  await mount([doc(1, 2)]); await button("Child", ".files-tree button");
  await act(() => qc.setQueryData(["structured-documents"], [])); await settle();
  expect(host.querySelector(".files-tree")?.textContent).not.toContain("Child");
  expect(host.querySelector(".files-list h2")?.textContent).toBe("全部已清洗");
});
it("skips deleted documents during restore and when reopening a stale closed record", async () => {
  useReadingGroups.getState().openFile(doc(404, null));
  await mount([doc(1, 2)]);
  expect(useReadingGroups.getState().tabs).toHaveLength(0);
  expect(useReadingGroups.getState().closed).toHaveLength(0);
  await button("Document 1", ".files-list button");
  await act(() => closeReadingTabs([useReadingGroups.getState().active.files!]));
  await act(() => qc.setQueryData(["structured-documents"], [])); await settle();
  await act(() => reopenReadingTab("files")); await settle();
  expect(useReadingGroups.getState().tabs).toHaveLength(0);
  expect(useReadingGroups.getState().closed).toHaveLength(0);
  expect(host.querySelector(".files-reader-head")).toBeNull();
});
it("visible divider supports keyboard, dragging and blur cleanup", async () => {
  const onResize = vi.fn();
  await act(() => root.render(createElement(ResizeHandle, { width: 360, side: "right", min: 240, max: 600, label: "调整月历宽度", visible: true, onResize })));
  const handle = host.querySelector("[role=separator]")!;
  expect(handle.classList.contains("is-visible")).toBe(true);
  await act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(onResize).toHaveBeenLastCalledWith(376);
  await act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(onResize).toHaveBeenLastCalledWith(240);
  await act(() => handle.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 360, bubbles: true })));
  await act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 })));
  expect(onResize).toHaveBeenLastCalledWith(400);
  expect(handle.classList.contains("is-dragging")).toBe(true);
  await act(() => window.dispatchEvent(new Event("blur")));
  expect(document.body.style.cursor).toBe("");
  expect(handle.classList.contains("is-dragging")).toBe(false);
});
