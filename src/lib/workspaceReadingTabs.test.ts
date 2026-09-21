// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import WorkspaceReadingTabs from "../components/WorkspaceReadingTabs";
import { useReaderTabs } from "./readerTabs";
import { closeReadingTabs, emptyGroupSession, READING_GROUPS, useReadingGroups, type ReadingGroup } from "./readingGroups";
import { useUi } from "../store";
import { LIBRARY_EXAMPLES } from "../library/examples";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key, language: "en" } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root, host: HTMLDivElement, qc: QueryClient;
const handlers = new Set<(event: { payload: string }) => void>();
const hotSource = { id: "fixture", name: "Hot fixture", kind: "hot" as const, description: "Public", homepage: "https://example.invalid", project: "Test", project_url: "https://example.invalid/docs" };
async function render(active: ReadingGroup) {
  await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement("div", null,
    ...READING_GROUPS.map(group => createElement("section", { key: group, "data-workspace": group }, createElement(WorkspaceReadingTabs, { group, active: group === active }))),
  ))));
}
const titles = (group: ReadingGroup) => [...host.querySelectorAll(`[data-workspace="${group}"] [role=tab]`)].map(tab => tab.getAttribute("title"));
const emit = async (action: string) => { await act(() => { for (const handler of handlers) handler({ payload: action }); }); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  handlers.clear();
  vi.mocked(listen).mockImplementation(async (name, handler: any) => { if (name === "reader-tab-shortcut") handlers.add(handler); return () => { handlers.delete(handler); }; });
  useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null });
  useReadingGroups.setState({ ...emptyGroupSession(), closed: [], loading: {} });
  useUi.setState({ modalOpen: false, menuOpen: false, aiOpen: false });
  for (let n = 1; n <= 2; n++) {
    useReaderTabs.getState().open(n, false, { title: `RSS ${n}` });
    useReadingGroups.getState().openFile(LIBRARY_EXAMPLES[n - 1].item, true);
    useReadingGroups.getState().openHot(hotSource, { id: String(n), title: `Hot ${n}`, url: `https://example.invalid/${n}`, rank: n, description: null, heat: null, published_at: null });
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["feeds"], []);
});
afterEach(async () => { await act(() => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals(); });

it("renders only each workspace's tabs and overflow entries with no shared group controls", async () => {
  await render("files");
  expect(titles("rss")).toEqual(["RSS 1", "RSS 2"]);
  expect(titles("files")).toEqual(LIBRARY_EXAMPLES.slice(0, 2).map(entry => entry.item.title));
  expect(titles("hot")).toEqual(["Hot 1", "Hot 2"]);
  expect(host.querySelector(".reading-group-header")).toBeNull();
  const overflow = host.querySelector<HTMLButtonElement>('[data-workspace="files"] .reader-tabs-overflow')!;
  await act(() => overflow.click());
  const entries = [...host.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
  expect(entries).toHaveLength(2);
  expect(entries.join(" ")).not.toMatch(/RSS|Hot/);
});

it("DOM/native cycling and closing stay local; close-all and empty-state restore leave other tabs intact", async () => {
  await render("hot");
  const rss = useReaderTabs.getState().activeId;
  const files = useReadingGroups.getState().active.files;
  const hotIds = useReadingGroups.getState().tabs.filter(tab => tab.group === "hot").map(tab => tab.id);
  await emit("next"); expect(useReadingGroups.getState().active.hot).toBe(hotIds[0]);
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  expect(useReadingGroups.getState().active.hot).toBe(hotIds[1]);
  expect(useReaderTabs.getState().activeId).toBe(rss); expect(useReadingGroups.getState().active.files).toBe(files);
  const tab = host.querySelector('[data-workspace="hot"] [role=tab]')!;
  await act(() => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const closeAll = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "readerTabs.closeAll")!;
  await act(() => closeAll.click());
  expect(titles("hot")).toEqual([]); expect(useReadingGroups.getState().active.hot).toBeNull();
  expect(titles("rss")).toHaveLength(2); expect(titles("files")).toHaveLength(2);
  await emit("close"); expect(titles("rss")).toHaveLength(2);
  await emit("reopen"); expect(titles("hot")).toEqual(["Hot 2"]);
  expect(useReadingGroups.getState().active.hot).not.toBe(hotIds[1]);
  expect(useReaderTabs.getState().activeId).toBe(rss); expect(useReadingGroups.getState().active.files).toBe(files);
});

it("reopen in a workspace with no closed history does not steal another workspace's closed tab", async () => {
  await render("hot");
  await act(() => closeReadingTabs([useReaderTabs.getState().activeId!]));
  await emit("close");
  await render("files");
  const closed = useReadingGroups.getState().closed;
  await emit("reopen");
  expect(useReadingGroups.getState().closed).toEqual(closed);
  expect(titles("rss")).toHaveLength(1); expect(titles("hot")).toHaveLength(1);
  expect(titles("files")).toHaveLength(2);
  await render("rss"); await emit("reopen");
  expect(titles("rss")).toHaveLength(2); expect(titles("hot")).toHaveLength(1);
});
