import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { enqueuePageView } from "../src/lib/pageViewQueue";
import type { AiFormattedDraft, ArticleDetail, Feed, PageCapture } from "../src/types";
import "../src/styles.css";

// This page has no native backend: both IPC and browser storage are replaced
// before importing app modules. No real database, page, provider or preference
// can be read or written by this fixture.
const storage = new Map<string, string>([["pref.readerViewMode", "web"], ["language", "en"]]);
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const firstOpen = deferred<void>();
const capture = deferred<PageCapture>();
let model = deferred<AiFormattedDraft>();
let holdFirstOpen = true;
let nativeOwner: string | null = null;
let nativeUrl = "";
let callbackId = 0;
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const retiredCallbacks: Array<(event: unknown) => void> = [];
const operations: Array<{ op: string; owner: string | null; url?: string; visible?: boolean }> = [];
const calls: string[] = [];
const failures: string[] = [];
const busyChanges: boolean[] = [];
let captureBusy = false;
let cases = 0;
const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
const emit = (requestId: string, url: string, phase: string) => {
  for (const [id, listener] of listeners) {
    if (listener.event === "page-view-status") callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { requestId, url, phase } });
  }
};
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: {
  unregisterListener: (_event: string, id: number) => {
    const listener = listeners.get(id);
    const callback = listener && callbacks.get(listener.handler);
    if (callback) retiredCallbacks.push(callback);
    listeners.delete(id);
  },
} });
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
  transformCallback: (callback: (event: unknown) => void) => { const id = ++callbackId; callbacks.set(id, callback); return id; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push(command);
    if (command === "plugin:event|listen") {
      const id = ++callbackId;
      listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
      return id;
    }
    if (command === "plugin:event|unlisten" || command === "set_setting") return;
    // Language setup refreshes the tray; simulate it without any native write.
    // Article mutations (including mark_read) remain forbidden below.
    if (command === "refresh_tray") return;
    if (command === "get_setting") return null;
    if (command === "list_highlights" || command === "list_tags") return [];
    if (command === "open_page_view") {
      const owner = String(args.requestId);
      operations.push({ op: "open-start", owner, url: String(args.url), visible: Boolean(args.visible) });
      check(nativeOwner === null, `New open ${owner} started before ${nativeOwner} closed`);
      check([...listeners.values()].some((value) => value.event === "page-view-status"), "Native open preceded its listener");
      if (holdFirstOpen) { holdFirstOpen = false; await firstOpen.promise; }
      nativeOwner = owner;
      nativeUrl = String(args.url);
      // Deliberately complete loading BEFORE the open promise resolves.
      emit(owner, nativeUrl, "loaded");
      operations.push({ op: "open-finish", owner });
      return;
    }
    if (command === "close_page_view") {
      operations.push({ op: "close", owner: nativeOwner });
      nativeOwner = null;
      return;
    }
    if (command === "set_page_view_bounds" || command === "set_page_view_visible") {
      operations.push({ op: command, owner: nativeOwner, visible: command === "set_page_view_visible" ? Boolean(args.visible) : undefined });
      return;
    }
    if (command === "page_view_reload" || command === "page_view_navigate_history") {
      check(nativeOwner?.startsWith("hot-") || nativeOwner?.startsWith("reader-"), "Navigation had no native owner");
      operations.push({ op: command, owner: nativeOwner });
      if (nativeOwner) emit(nativeOwner, nativeUrl, "loaded");
      return;
    }
    if (command === "capture_page_view") {
      check(nativeOwner === args.requestId, "Capture targeted a different native owner");
      return capture.promise;
    }
    if (command === "ai_format_page") return model.promise;
    if (command === "plugin:opener|open_url") return;
    failures.push(`Unexpected synthetic IPC: ${command}`);
    throw new Error(`Synthetic fixture blocks ${command}`);
  },
} });

const { default: Reader } = await import("../src/components/Reader");
const { default: HotPageView } = await import("../src/hot/HotPageView");
const { useUi } = await import("../src/store");
const { default: i18n } = await import("../src/i18n");
await i18n.changeLanguage("en");
const article: ArticleDetail = {
  id: 919191, feedId: 919, feedTitle: "Synthetic feed", sourceType: "rss", title: "Synthetic RSS article", author: null,
  url: "https://example.invalid/rss", contentHtml: Array.from({ length: 80 }, (_, index) => `<p>Long synthetic paragraph ${index}. No source data, images or external fetches.</p>`).join(""),
  extractedHtml: null, imageUrl: null, publishedAt: null, isRead: false, isStarred: false, readLater: false,
  aiSummary: null, translatedHtml: null, translatedLang: null, enclosures: [], tags: [],
};
const feed: Feed = { id: 919, feedUrl: "https://example.invalid/feed", siteUrl: "https://example.invalid/", title: "Synthetic feed", description: null, faviconUrl: null, folderId: null, sourceType: "rss", lastFetchedAt: null, fetchError: null, unreadCount: 1, refreshIntervalMin: null, autoTranslate: false, openMode: "reader" };
const capturedPage: PageCapture = { captureId: "synthetic-capture", articleId: article.id, sourceUrl: article.url!, sourceTitle: "Synthetic source", text: "Captured synthetic text retained across workspaces.", capturedAt: "2026-08-31T00:00:00Z", truncated: false, charCount: 49, warnings: [] };
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });
qc.setQueryData(["article", article.id], article);
qc.setQueryData(["ai-formatted", article.id], null);
qc.setQueryData(["feeds"], [feed]);
qc.setQueryData(["setting", "translate_target_lang"], "en");
qc.setQueryData(["setting", "translate_engine"], "llm");
useUi.setState({ selectedArticleId: article.id, query: { kind: "feed", value: feed.id }, queryLabel: feed.title, prefs: { ...useUi.getState().prefs, markReadOnOpen: false, markReadOnScroll: true, defaultOpenMode: "reader" }, aiOpen: false, modalOpen: false, menuOpen: false });
const root = createRoot(document.getElementById("fixture")!);
const onCaptureBusyChange = (value: boolean) => { captureBusy = value; busyChanges.push(value); };
function Harness({ workspace, url }: { workspace: "rss" | "hot"; url: string }) {
  return <QueryClientProvider client={qc}>
    <div id="rss-pane" style={{ height: "100%", display: workspace === "rss" ? "flex" : "none" }} inert={workspace !== "rss"}>
      <Reader active={workspace === "rss"} onToast={() => {}} onCaptureBusyChange={onCaptureBusyChange}/>
    </div>
    <div id="hot-pane" style={{ height: "100%", display: workspace === "hot" ? "flex" : "none" }} inert={workspace !== "hot"}>
      <HotPageView url={url} active={workspace === "hot"}/>
    </div>
  </QueryClientProvider>;
}
const render = (workspace: "rss" | "hot", url = "https://example.invalid/hot") => flushSync(() => root.render(<Harness workspace={workspace} url={url}/>));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => { await frame(); await enqueuePageView(() => {}); await frame(); };
const until = async (condition: () => boolean) => {
  for (let tries = 0; tries < 120 && !condition(); tries++) await frame();
  if (!condition()) throw new Error("Timed out waiting for synthetic component state");
};
const button = (selector: string) => {
  const found = document.querySelector<HTMLButtonElement>(selector);
  if (!found || found.disabled) throw new Error(`Missing/enabled button: ${selector}`);
  flushSync(() => found.click());
};

try {
  render("rss");
  await until(() => operations.some((value) => value.op === "open-start"));
  const firstOwner = operations[0].owner!;
  render("hot");
  await frame();
  check(!operations.some((value) => value.op === "open-start" && value.owner?.startsWith("hot-")), "Hot bypassed a pending RSS native open");
  firstOpen.resolve();
  await settle();
  check(nativeOwner?.startsWith("hot-"), "Hot did not take ownership after late RSS cleanup");
  check(!document.querySelector("#hot-pane .reader-web-loading"), "Loaded-before-open left Hot loading forever");
  check(!document.querySelector("#hot-pane .reader-web-notice"), "A successfully loaded Hot page has a permanent notice");
  cases++;

  for (const callback of retiredCallbacks) callback({ payload: { requestId: firstOwner, url: "https://wrong.invalid/late", phase: "loaded" } });
  emit(firstOwner, "https://wrong.invalid/late", "loaded");
  await frame();
  check(document.querySelector("#hot-pane .reader-webview-url")?.textContent === "https://example.invalid/hot", "An old RSS event replaced Hot's address");
  for (const index of [1, 2, 3]) { button(`#hot-pane .reader-web-navigation:first-child button:nth-child(${index})`); await settle(); }
  cases += 4;

  const openCount = operations.filter((value) => value.op === "open-start").length;
  render("hot", "javascript:alert('never')");
  await settle();
  check(nativeOwner === null, "Unsafe source failed to close the previous native view");
  check(operations.filter((value) => value.op === "open-start").length === openCount, "Unsafe source opened a native view");
  cases++;

  for (let index = 0; index < 20; index++) {
    const workspace = index % 2 ? "hot" : "rss";
    render(workspace);
    await settle();
    check(nativeOwner?.startsWith(workspace === "rss" ? "reader-" : "hot-"), `Wrong owner after transition ${index}`);
    check(storage.get("pref.readerViewMode") === "web", `Workspace transition ${index} overwrote Web preference`);
    check(useUi.getState().selectedArticleId === article.id, `Workspace transition ${index} reset RSS selection`);
    cases++;
  }

  render("rss");
  await settle();
  button("#rss-pane .reader-view-switch button:nth-child(3)");
  check(document.querySelector("#rss-pane .reader-view-content")?.getAttribute("data-reader-view") === "formatted", "AI tab did not open immediately");
  check(!document.querySelector("#rss-pane .ai-format-capture"), "AI still exposed the old manual capture confirmation");
  await until(() => calls.includes("capture_page_view"));
  check(captureBusy, "Automatic capture did not lock the workspace switch");
  check(calls.filter((command) => command === "capture_page_view").length === 1, "One AI click started more than one capture");
  check(operations.some((value) => value.op === "set_page_view_visible" && value.visible === false), "AI did not hide the native Web view before capture");
  capture.resolve(capturedPage);
  await until(() => calls.includes("ai_format_page"));
  await settle();
  check(!captureBusy, "Model generation incorrectly kept the capture lock");
  render("hot");
  await settle();
  check(nativeOwner?.startsWith("hot-"), "Pending model generation held the native queue");
  model.reject(new Error("Synthetic model failure"));
  await frame();
  render("rss");
  await settle();
  check(!!document.querySelector("#rss-pane .ai-format-error"), "Hidden model failure was lost");
  check(document.querySelector<HTMLTextAreaElement>("#rss-pane .ai-formatted-source")?.value.includes("Captured synthetic text"), "Captured source was lost while RSS was hidden");
  check(document.querySelector("#rss-pane .reader-view-content")?.getAttribute("data-reader-view") === "formatted", "Returning to RSS reset its AI formatted tab");
  check(storage.get("pref.readerViewMode") === "web", "AI formatting overwrote Web preference");
  cases += 4;

  model = deferred<AiFormattedDraft>();
  button("#rss-pane .ai-format-error .ai-format-retry");
  render("hot");
  await settle();
  model.resolve({ articleId: article.id, captureId: "synthetic-capture", sourceUrl: article.url!, sourceTitle: "Synthetic source", capturedAt: "2026-08-31T00:00:00Z", generatedAt: "2026-08-31T00:01:00Z", model: "synthetic-no-provider", language: "zh", markdown: "# Synthetic saved draft\n\nNo provider was used.", sourceText: "Captured synthetic text retained across workspaces.", sourceCharCount: 49, sourceTruncated: false, warnings: [] });
  await frame();
  render("rss");
  await settle();
  check(!!qc.getQueryData(["ai-formatted", article.id]), "Hidden model success did not populate its original article cache");
  button("#rss-pane .ai-formatted-display button:nth-child(2)");
  render("hot");
  await settle();
  render("rss");
  await settle();
  check(document.querySelector<HTMLTextAreaElement>("#rss-pane .ai-formatted-source")?.value.includes("Synthetic saved draft"), "AI source display state reset after workspace switch");
  cases += 2;

  button("#rss-pane .reader-view-switch button:nth-child(1)");
  await settle();
  const scroll = document.querySelector<HTMLElement>("#rss-pane .reader-scroll")!;
  scroll.scrollTop = 222;
  const before = scroll.scrollTop;
  render("hot");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 450));
  check(!calls.includes("mark_read"), "Hidden zero-height RSS pane marked an article read");
  render("rss");
  await settle();
  check(scroll.scrollTop === before && before > 0, "RSS reading scroll position was not retained");
  cases++;
} catch (cause) {
  failures.push(String(cause));
} finally {
  firstOpen.resolve();
  capture.resolve(capturedPage);
  flushSync(() => root.unmount());
  await enqueuePageView(() => {});
  check(nativeOwner === null, "Final unmount left a native owner");
  check(!captureBusy, "Final unmount left the capture lock enabled");
  const result = { passed: failures.length === 0, cases, failures, busyChanges, syntheticIpcOnly: true, operations, commands: [...new Set(calls)] };
  Object.assign(window, { __PAPR_NATIVE_WORKSPACE_QA__: result });
  document.getElementById("results")!.textContent = JSON.stringify(result, null, 2);
  document.title = `${result.passed ? "PASS" : "FAIL"} — native workspace lifecycle (${cases} cases)`;
  document.documentElement.dataset.result = result.passed ? "pass" : "fail";
}
