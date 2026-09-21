// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ReaderWorkspace from "../components/ReaderWorkspace";
import HotPageView from "../hot/HotPageView";
import { useReaderTabs, restoreTabSession } from "./readerTabs";
import { activateReadingTab, closeReadingTabs, emptyGroupSession, reopenReadingTab, useReadingGroups, type HotTab } from "./readingGroups";
import { useFormatJobs } from "./formatJobs";
import { useUi } from "../store";
import { enqueuePageView } from "./pageViewQueue";
import type { ArticleDetail, AiFormattedDraft } from "../types";
import type { PageCapture } from "../types";
import HotTabReader from "../hot/HotTabReader";
import WorkspaceReadingTabs from "../components/WorkspaceReadingTabs";

const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: any }) => void>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class { onmessage = () => {}; } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, listener: (value: any) => void) => {
  if (!bus.has(event)) bus.set(event, new Set()); bus.get(event)!.add(listener);
  return () => bus.get(event)!.delete(listener);
}) }));
vi.mock("../toast", () => ({ reportError: vi.fn(), toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../i18n", () => ({ LANGUAGES: [{ code: "en", label: "English" }], default: { t: (key: string) => key, language: "en" } }));

const article = (id: number): ArticleDetail => ({ id, feedId: 1, feedTitle: "Fixture", sourceType: "rss", title: `Article ${id}`, author: null, url: `https://example.invalid/${id}`, contentHtml: "<p>RSS original body</p>", extractedHtml: null, imageUrl: null, publishedAt: null, isRead: false, isStarred: false, readLater: false, aiSummary: null, translatedHtml: null, translatedLang: null, enclosures: [], tags: [] });
const draft = (articleId: number): AiFormattedDraft => ({ articleId, captureId: "fixture-capture", sourceUrl: `https://example.invalid/${articleId}`, sourceTitle: "Markdown document", sourceText: "Saved source", sourceCharCount: 100, sourceTruncated: false, capturedAt: "2026-09-21", generatedAt: "2026-09-21", model: "fixture", language: "en", markdown: "## Saved Markdown\n\n### Heading\n\nSaved document body.", warnings: [] });
let root: Root, host: HTMLDivElement, qc: QueryClient;
let native: Map<string, { requestId: string; instance: number }>;
let instance: number;
const emit = (event: string, payload: any) => { for (const listener of bus.get(event) ?? []) listener({ payload }); };
async function settle() { await act(async () => { await enqueuePageView(() => {}); await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function mount(active = true) { await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ReaderWorkspace, { active, onToast: vi.fn() })))); await settle(); }
async function open(id: number, background = false) { await act(() => useReaderTabs.getState().open(id, background, { title: `Article ${id}`, feedId: 1 })); await settle(); }
function click(selector: string) { const el = host.querySelector<HTMLButtonElement>(selector); if (!el) throw Error(`missing ${selector}`); return act(() => el.click()); }
const commands = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  bus.clear(); native = new Map(); instance = 0;
  useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null });
  useReadingGroups.setState({ ...emptyGroupSession(), closed: [], loading: {} });
  useFormatJobs.setState({ jobs: {} });
  useUi.setState({ modalOpen: false, menuOpen: false, aiOpen: false, query: { kind: "all" }, prefs: { ...useUi.getState().prefs, markReadOnOpen: true, markReadOnScroll: true } });
  localStorage.setItem("pref.readerViewMode", "web");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["feeds"], [{ id: 1, title: "Fixture", autoTranslate: false, openMode: "reader" }]);
  for (let id = 1; id <= 5; id++) {
    qc.setQueryData(["article", id], article(id));
    qc.setQueryData(["ai-formatted", id], draft(id));
    qc.setQueryData(["structured", id], null);
  }
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd, raw) => {
    const args = raw as any;
    if (cmd === "get_article") { if (args.id === 404) throw { code: "articleNotFound" }; return article(args.id) as any; }
    if (cmd === "list_feeds") return [{ id: 1, title: "Fixture", autoTranslate: false, openMode: "reader" }] as any;
    if (["list_highlights", "list_tags"].includes(cmd)) return [] as any;
    if (cmd === "get_setting") return null as any;
    if (cmd === "open_page_view") {
      const resident = native.get(args.viewId);
      const page = resident ?? { requestId: args.requestId, instance: ++instance };
      native.set(args.viewId, page);
      emit("page-view-status", { ...page, viewId: args.viewId, phase: "loaded", url: args.url });
      return Boolean(resident) as any;
    }
    if (cmd === "close_page_view") native.delete(args.viewId);
    return undefined as any;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); await enqueuePageView(() => {}); qc.clear(); host.remove(); vi.unstubAllGlobals(); });

it("background open is lazy and unread; activation uses a unique retained native page", async () => {
  await mount(); await open(1); await open(2, true); await open(2, true);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(commands("open_page_view")).toHaveLength(1);
  expect(commands("mark_read").every(([, args]) => (args as any).id === 1)).toBe(true);
  await click('[role="tab"][aria-selected="false"]'); await settle();
  expect(commands("open_page_view")).toHaveLength(2);
  expect(commands("mark_read").some(([, args]) => (args as any).id === 2)).toBe(true);
  await open(1);
  expect(native.size).toBe(2);
  expect(commands("close_page_view")).toHaveLength(0);
  expect(commands("open_page_view")[0][1]).toMatchObject({ viewId: commands("open_page_view")[2][1]?.viewId });
});

it("keeps A/B/C Web, Markdown and RSS state separate, including source scroll", async () => {
  await mount(); await open(1); await open(2);
  await click('button[title="aiFormatted.tabHint"]'); await settle();
  await click('.ai-formatted-display button:last-child');
  const source = host.querySelector<HTMLTextAreaElement>(".ai-formatted-source");
  expect(source).not.toBeNull();
  await act(() => { source!.scrollTop = 88; source!.dispatchEvent(new Event("scroll")); });
  await open(3); await click('button[title="reader.readingMode"]'); await settle();
  const rss = host.querySelector<HTMLElement>(".reader-scroll")!;
  await act(() => { rss.scrollTop = 144; rss.dispatchEvent(new Event("scroll")); });
  await open(1); expect(host.querySelector(".reader-webview-host")).not.toBeNull();
  await open(2); expect(host.querySelector<HTMLTextAreaElement>(".ai-formatted-source")?.scrollTop).toBe(88);
  await open(3); expect(host.querySelector<HTMLElement>(".reader-scroll")?.scrollTop).toBe(144);
  expect(useReaderTabs.getState().tabs.map(t => t.reading.mode)).toEqual(["web", "formatted", "reader"]);
});

it("retains tabs when list scope changes and applies article actions to the active tab", async () => {
  await mount(); await open(1); const activeId = useReaderTabs.getState().activeId;
  await act(() => useUi.getState().select({ kind: "feed", value: 99 }, "Unrelated feed"));
  expect(useReaderTabs.getState().activeId).toBe(activeId);
  expect(useUi.getState().selectedArticleId).toBe(1);
  await click('button[title="reader.tbStar"]'); await settle();
  expect(commands("mark_starred").at(-1)?.[1]).toMatchObject({ id: 1, starred: true });
  expect(useUi.getState().query).toEqual({ kind: "feed", value: 99 });
});

it("routes native and DOM shortcuts, gives modals priority, and restores a fresh tab identity", async () => {
  await mount(); await open(1); await open(2); const oldId = useReaderTabs.getState().activeId;
  await act(() => emit("reader-tab-shortcut", "close")); await settle();
  expect(useReaderTabs.getState().tabs.map(t => t.articleId)).toEqual([1]);
  expect(native.has(oldId!)).toBe(false);
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))); await settle();
  expect(useReaderTabs.getState().tabs).toHaveLength(2); expect(useReaderTabs.getState().activeId).not.toBe(oldId);
  await act(() => useUi.setState({ modalOpen: true }));
  await act(() => emit("reader-tab-shortcut", "close"));
  expect(useReaderTabs.getState().tabs).toHaveLength(2);
  await act(() => useUi.setState({ modalOpen: false })); await mount(false);
  await act(() => emit("reader-tab-shortcut", "close"));
  expect(useReaderTabs.getState().tabs).toHaveLength(2);
  await mount(true); await act(() => useReaderTabs.getState().close(useReaderTabs.getState().tabs.map(t => t.id))); await settle();
  expect(host.querySelector('[role="tab"]')).toBeNull(); expect(native.size).toBe(0);
});

it("restores without marking read or generating, and discards only missing articles", async () => {
  useReaderTabs.setState(restoreTabSession(JSON.stringify({ version: 1, activeArticleId: 1, tabs: [{ articleId: 1, reading: { mode: "reader", rssScroll: 50 } }, { articleId: 404 }, { articleId: 3, reading: { mode: "formatted" } }] })));
  await mount(); await act(() => new Promise(resolve => setTimeout(resolve, 450)));
  expect(useReaderTabs.getState().tabs.map(t => t.articleId)).toEqual([1, 3]);
  for (const command of ["mark_read", "extract_fulltext", "ai_format_page", "capture_page_view"]) expect(commands(command)).toHaveLength(0);
  expect(useReaderTabs.getState().closed).toHaveLength(0);
});

it("ignores retired events, keeps overlays above pages, and binds close after reopen", async () => {
  await mount(); await open(1);
  const tab = useReaderTabs.getState().tabs[0]; const page = native.get(tab.id)!;
  await act(() => useUi.setState({ modalOpen: true })); await settle();
  expect(commands("set_page_view_visible").at(-1)?.[1]).toMatchObject({ visible: false, viewId: tab.id });
  await act(() => useUi.setState({ modalOpen: false })); await settle();
  expect(commands("set_page_view_visible").at(-1)?.[1]).toMatchObject({ visible: true, viewId: tab.id });
  await act(() => useReaderTabs.getState().close([tab.id])); await settle();
  await open(1); const replacement = useReaderTabs.getState().tabs[0];
  await act(() => emit("page-view-status", { ...page, viewId: tab.id, phase: "loaded", url: "https://wrong.invalid/late" }));
  expect(replacement.id).not.toBe(tab.id);
  expect(host.querySelector(".reader-webview-url")?.textContent).toBe(article(1).url);
  expect(useReaderTabs.getState().tabs[0].reading.webUrl).toBe(article(1).url);
});

it("cancels opening on leaving the tab, locks only capture, and saves model work after closure", async () => {
  qc.setQueryData(["ai-formatted", 1], null);
  let finishCapture!: (value: PageCapture) => void;
  let finishModel!: (value: AiFormattedDraft) => void;
  const captured = new Promise<PageCapture>(resolve => { finishCapture = resolve; });
  const generated = new Promise<AiFormattedDraft>(resolve => { finishModel = resolve; });
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args, options) => command === "capture_page_view" ? captured as any : command === "ai_format_page" ? generated as any : normal(command, args, options));
  await mount(); await open(1); await click('button[title="aiFormatted.tabHint"]'); await settle();
  expect(useFormatJobs.getState().jobs[1]?.phase).toBe("opening");
  await open(2);
  expect(useFormatJobs.getState().jobs[1]).toBeUndefined();
  await open(1); await settle();
  expect(useFormatJobs.getState().jobs[1]).toBeUndefined();
  await click('button[title="aiFormatted.tabHint"]'); await settle();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 760)); });
  expect(useReaderTabs.getState().captureTabId).toBe(useReaderTabs.getState().activeId);
  const capturedId = useReaderTabs.getState().activeId!;
  await act(() => { useReaderTabs.getState().close([capturedId]); useReaderTabs.getState().open(2); });
  expect(useReaderTabs.getState().activeId).toBe(capturedId);
  await act(async () => { finishCapture({ captureId: "fixture-capture", articleId: 1, sourceUrl: article(1).url!, sourceTitle: "Captured", text: "Saved original source", capturedAt: "2026-09-21", charCount: 21, truncated: false, warnings: [] }); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(useReaderTabs.getState().captureTabId).toBeNull(); expect(useFormatJobs.getState().jobs[1]?.phase).toBe("formatting");
  await act(() => useReaderTabs.getState().close([capturedId])); await settle();
  await act(async () => { finishModel(draft(1)); await generated; }); await settle();
  expect(qc.getQueryData(["ai-formatted", 1])).toMatchObject({ articleId: 1, markdown: draft(1).markdown });
  expect(useReaderTabs.getState().tabs.map(t => t.articleId)).toEqual([2]);
  expect(useUi.getState().selectedArticleId).toBe(2);
});

it("serializes a slow native open across rapid workspace transitions without destroying RSS cache", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const normal = vi.mocked(invoke).getMockImplementation()!;
  let first = true;
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    if (command === "open_page_view" && first) { first = false; await pending; }
    return normal(command, args, options);
  });
  const render = async (rss: boolean) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement("div", null,
    createElement(ReaderWorkspace, { active: rss, onToast: vi.fn() }),
    createElement(HotPageView, { active: !rss, url: "https://example.invalid/hot" }),
  ))));
  useReaderTabs.getState().open(1);
  await render(true); await render(false);
  expect(commands("open_page_view")).toHaveLength(1);
  release(); await settle();
  const rssTab = useReaderTabs.getState().tabs[0];
  expect(native.has(rssTab.id)).toBe(true); expect(native.has("page-view")).toBe(true);
  for (let i = 0; i < 6; i++) { await render(i % 2 === 0); await settle(); }
  expect(native.has(rssTab.id)).toBe(true);
  expect(useUi.getState().selectedArticleId).toBe(1);
  expect(commands("close_page_view").every(([, args]) => (args as any).viewId === "page-view")).toBe(true);
  await render(true); await settle();
  expect(native.has("page-view")).toBe(false);
  expect(host.querySelector(".reader-workspace .reader-webview-url")?.textContent).toBe(article(1).url);
});

const hotSource = { id: "fixture", name: "Fixture hot", kind: "hot" as const, description: "Public fixture", homepage: "https://example.invalid", project: "Fixture", project_url: "https://example.invalid/docs" };
const hotItem = (n: number) => ({ id: String(n), title: `Hot ${n}`, url: `https://example.invalid/hot/${n}`, description: "Public summary", heat: null, rank: n, published_at: null });
function HotTestReader({ active }: { active: boolean }) {
  const tabs = useReadingGroups(s => s.tabs);
  const id = useReadingGroups(s => s.active.hot);
  const tab = tabs.find((t): t is HotTab => t.group === "hot" && t.id === id);
  return createElement("section", { "data-hot-test": true }, createElement(WorkspaceReadingTabs, { group: "hot", active }), tab && createElement(HotTabReader, { key: tab.id, tab, active }));
}
async function mixed(rss: boolean) {
  await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement("div", null,
    createElement(ReaderWorkspace, { active: rss, onToast: vi.fn() }), createElement(HotTestReader, { active: !rss }),
  )))); await settle();
}
it("retains hot tab identity through summary, RSS and overlay transitions; background open is lazy", async () => {
  await mixed(true); await open(1);
  await act(() => { useReadingGroups.getState().openHot(hotSource, hotItem(1), null, true, "web"); useReadingGroups.getState().openHot(hotSource, hotItem(2), null, true, "web"); });
  expect(native.size).toBe(1);
  const hot = useReadingGroups.getState().tabs[0];
  await act(() => activateReadingTab(hot.id)); await mixed(false);
  const first = native.get(hot.id)!;
  expect(first).toBeDefined(); expect(native.size).toBe(2);
  await act(() => useReadingGroups.getState().setHotDisplay(hot.id, "summary")); await settle();
  expect(native.get(hot.id)).toEqual(first);
  await act(() => useReadingGroups.getState().setHotDisplay(hot.id, "web")); await settle();
  await mixed(true); await mixed(false);
  expect(native.get(hot.id)).toEqual(first); expect(commands("close_page_view")).toHaveLength(0);
  await act(() => useUi.setState({ menuOpen: true })); await settle();
  expect(commands("set_page_view_visible").at(-1)?.[1]).toMatchObject({ viewId: hot.id, visible: false });
  await act(() => emit("reader-tab-shortcut", "close")); expect(useReadingGroups.getState().tabs).toHaveLength(2);
  await act(() => useUi.setState({ menuOpen: false })); await settle();
  expect(commands("set_page_view_visible").at(-1)?.[1]).toMatchObject({ viewId: hot.id, visible: true });
  expect(commands("capture_page_view")).toHaveLength(0); expect(commands("ai_format_page")).toHaveLength(0);
});
it("hot native shortcuts close and reopen a fresh instance, rejecting late URL/zoom events", async () => {
  await mixed(false);
  await act(() => useReadingGroups.getState().openHot(hotSource, hotItem(1), null, false, "web")); await settle();
  const tab = useReadingGroups.getState().tabs[0], page = native.get(tab.id)!;
  await act(() => emit("page-view-status", { ...page, viewId: tab.id, phase: "loaded", url: "https://example.invalid/latest" }));
  await act(() => emit("page-view-zoom", { ...page, viewId: tab.id, factor: 1.5, mode: "manual" }));
  await act(() => emit("reader-tab-shortcut", "close")); await settle();
  expect(native.has(tab.id)).toBe(false); expect(useReadingGroups.getState().tabs).toHaveLength(0);
  await act(() => emit("reader-tab-shortcut", "reopen")); await settle();
  const reopened = useReadingGroups.getState().tabs[0];
  expect(reopened.id).not.toBe(tab.id);
  expect(commands("open_page_view").at(-1)?.[1]).toMatchObject({ viewId: reopened.id, resumeUrl: "https://example.invalid/latest", zoomFactor: 1.5 });
  await act(() => {
    emit("page-view-status", { ...page, viewId: tab.id, phase: "loaded", url: "https://wrong.invalid" });
    emit("page-view-zoom", { ...page, viewId: tab.id, factor: 3, mode: "manual" });
  });
  expect(useReadingGroups.getState().tabs[0].reading.zoom).toBe(1.5);
  expect(useReadingGroups.getState().tabs[0].reading.webUrl).not.toContain("wrong.invalid");
});
it("hot eviction keeps the tab and reconstructs it with saved URL/zoom and a new request generation", async () => {
  await mixed(false);
  await act(() => useReadingGroups.getState().openHot(hotSource, hotItem(1), null, false, "web")); await settle();
  const tab = useReadingGroups.getState().tabs[0], page = native.get(tab.id)!;
  await mixed(true);
  await act(() => {
    native.delete(tab.id);
    emit("page-view-evicted", { ...page, viewId: tab.id, url: "https://example.invalid/resumed", factor: 1.4, mode: "manual" });
  });
  expect(useReadingGroups.getState().tabs).toHaveLength(1);
  await mixed(false);
  expect(commands("open_page_view").at(-1)?.[1]).toMatchObject({ viewId: tab.id, resumeUrl: "https://example.invalid/resumed", zoomFactor: 1.4 });
  expect(native.get(tab.id)?.requestId).not.toBe(page.requestId);
  expect(host.querySelector("[data-hot-test] .reader-cache-notice")).not.toBeNull();
});
it("a slow hot open followed by close/reopen cannot close the replacement or resurrect the old tab", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const normal = vi.mocked(invoke).getMockImplementation()!;
  let first = true;
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    if (command === "open_page_view" && first) { first = false; await pending; }
    return normal(command, args, options);
  });
  await mixed(false);
  await act(() => useReadingGroups.getState().openHot(hotSource, hotItem(1), null, false, "web"));
  const old = useReadingGroups.getState().active.hot!;
  await act(() => closeReadingTabs([old]));
  await act(() => reopenReadingTab("hot"));
  const current = useReadingGroups.getState().active.hot!;
  await act(async () => { release(); await enqueuePageView(() => {}); }); await settle();
  expect(current).not.toBe(old); expect(native.has(old)).toBe(false); expect(native.has(current)).toBe(true);
  expect(useReadingGroups.getState().tabs).toHaveLength(1);
});
