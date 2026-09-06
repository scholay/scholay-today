import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WorkspaceSwitcher, { type Workspace } from "../src/components/WorkspaceSwitcher";
import { enqueuePageView } from "../src/lib/pageViewQueue";
import type { HotSnapshot, HotSource } from "../src/hot/types";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/newsreader";
import "../src/styles.css";
import "../src/hot/hot.css";
import "../src/workspace.css";

// Every item, timestamp and authorization value is synthetic. This page blocks
// all real IPC and replaces storage before any production component is loaded.
const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key), clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; },
} });
const sources: HotSource[] = Array.from({ length: 12 }, (_, index) => ({
  id: index === 11 ? "producthunt-ranking" : `synthetic-${index}`,
  name: index === 11 ? "Synthetic Product Hunt ranking" : `Synthetic ${index % 2 ? "West" : "East"} ${index}`,
  region: index % 2 ? "global" : "china", category: ["科技", "财经", "生活"][index % 3], kind: index === 2 ? "daily" : index % 3 ? "hot" : "latest",
  homepage: `https://example.invalid/source-${index}`, description: `Synthetic source ${index}, no real endpoint.`, project: "Synthetic fixture", project_url: "https://example.invalid/docs", refresh_secs: index === 2 ? 3600 : 600,
  auth_kind: index === 11 ? "api_token" : null, auth_url: index === 11 ? "https://example.invalid/developer-token" : null,
}));
const snapshots = new Map<string, HotSnapshot>(sources.map((source, index) => [source.id, {
  source_id: source.id, items: Array.from({ length: 12 }, (_, rank) => ({ id: `${source.id}-${rank}`, title: `Synthetic headline ${rank + 1}${index === 0 && rank === 0 ? " LOCAL_ONLY" : ""} — ${"长标题测试".repeat(2)}`, description: `Cached synthetic description ${rank}. No live content.`, rank: rank + 1, heat: `${1200 - rank * 10} votes`, url: `https://example.invalid/${source.id}/item-${rank}`, published_at: null })),
  fetched_at: "2026-08-31T02:00:00Z", last_attempt_at: "2026-08-31T02:00:00Z", status: "ok", error: null, stale: index !== 2, cached: true,
}]));
const failures: string[] = [], blocked: string[] = [];
const calls: Array<{ command: string; sourceId?: string; refresh?: boolean }> = [];
let inFlight = 0, peak = 0, configured = false, nativeOwner: string | null = null, callbackId = 0;
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const emit = (requestId: string, url: string) => {
  for (const [id, listener] of listeners) if (listener.event === "page-view-status") callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { requestId, url, phase: "loaded" } });
};
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: (_event: string, id: number) => listeners.delete(id) } });
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
  transformCallback: (callback: (event: unknown) => void) => { const id = ++callbackId; callbacks.set(id, callback); return id; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    // Only command names/public source IDs are retained, never argument dumps.
    calls.push({ command, sourceId: typeof args.sourceId === "string" ? args.sourceId : undefined, refresh: typeof args.refresh === "boolean" ? args.refresh : undefined });
    if (command === "list_hot_sources") return sources;
    if (command === "get_hot_snapshot") {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      const id = String(args.sourceId);
      const cached = snapshots.get(id)!;
      if (!args.refresh) return cached;
      const result: HotSnapshot = id === "synthetic-1" || (id === "producthunt-ranking" && !configured)
        ? { ...cached, status: "error", error: "Synthetic endpoint unavailable", stale: true, cached: true }
        : { ...cached, status: "ok", error: null, stale: false, cached: false, fetched_at: "2026-08-31T03:00:00Z" };
      snapshots.set(id, result); return result;
    }
    if (command === "get_hot_auth_status") return { configured, supported: args.sourceId === "producthunt-ranking" };
    if (command === "save_hot_api_token") { if (typeof args.token !== "string" || args.token.length < 1) throw new Error("Synthetic blank token"); configured = true; return; }
    if (command === "set_setting" || command === "refresh_tray") return;
    if (command === "plugin:event|listen") { const id = ++callbackId; listeners.set(id, { event: String(args.event), handler: Number(args.handler) }); return id; }
    if (command === "plugin:event|unlisten") return;
    if (command === "open_page_view") { if (nativeOwner) failures.push("Native open preceded previous cleanup"); nativeOwner = String(args.requestId); emit(nativeOwner, String(args.url)); return; }
    if (command === "close_page_view") { nativeOwner = null; return; }
    if (command === "set_page_view_bounds" || command === "set_page_view_visible") return;
    blocked.push(command); throw new Error(`Synthetic fixture blocks ${command}`);
  },
} });
const { default: HotBoard } = await import("../src/hot/HotBoard");
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });
const root = createRoot(document.getElementById("root")!);
let setActive: (active: boolean) => void = () => {};
let setCaptureBusy: (busy: boolean) => void = () => {};
function Harness() {
  const [active, changeActive] = useState(false); setActive = changeActive;
  const [captureBusy, changeCaptureBusy] = useState(false); setCaptureBusy = changeCaptureBusy;
  const chooseWorkspace = (next: Workspace) => { if (!captureBusy) changeActive(next === "hotboard"); };
  const workspaceSwitch = <WorkspaceSwitcher workspace={active ? "hotboard" : "rss"} captureBusy={captureBusy} onChange={chooseWorkspace}/>;
  return <QueryClientProvider client={queryClient}>
    <div className="workspace-host">
      <div className="workspace-panels">
        <div id="workspace-rss-panel" className={`workspace-panel ${active ? "is-inactive" : ""}`} role="region" aria-label="RSS" aria-hidden={active} inert={active}>
          <div className="app-shell"><div className="window">
            <aside className="sidebar" aria-label="Synthetic RSS sidebar">
              <div className="titlebar" data-tauri-drag-region/>
              <div className="workspace-sidebar-heading">{workspaceSwitch}</div>
              <p style={{ padding: 12 }}>Synthetic RSS placeholder. No RSS API is connected.</p>
            </aside>
            <main style={{ gridColumn: "2 / -1", padding: 20 }}>Synthetic RSS content. Existing RSS APIs and private data are not connected.</main>
          </div></div>
        </div>
        <div id="workspace-hotboard-panel" className={`workspace-panel ${active ? "" : "is-inactive"}`} role="region" aria-label="热榜" aria-hidden={!active} inert={!active}>
          <HotBoard active={active} workspaceSwitch={workspaceSwitch}/>
        </div>
      </div>
    </div>
  </QueryClientProvider>;
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const until = async (condition: () => boolean) => { for (let attempt = 0; attempt < 240 && !condition(); attempt++) await frame(); if (!condition()) throw new Error("Synthetic UI did not settle"); };
const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
const click = (selector: string) => { const button = document.querySelector<HTMLButtonElement>(selector); if (!button || button.disabled) throw new Error(`Missing enabled control ${selector}`); flushSync(() => button.click()); };
const type = (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
let checks = 0;
try {
  flushSync(() => root.render(<Harness/>)); await frame();
  check(!calls.some((call) => call.command.startsWith("get_hot") || call.command === "list_hot_sources"), "Inactive cold start requested hot data"); checks++;
  check(!document.querySelector(".workspace-bar") && document.querySelector(".workspace-host")?.firstElementChild?.classList.contains("workspace-panels"), "A global workspace strip still reserves space"); checks++;
  check(document.querySelectorAll(".workspace-sidebar-heading > .workspace-switcher").length === 2 && [...document.querySelectorAll(".workspace-switcher")].every((element) => element.closest(".sidebar, .hot-sidebar")), "Workspace controls are not hosted inside both sidebar headings"); checks++;
  check(!document.querySelector(".sb-brand, .hot-brand"), "Sidebar title was duplicated beside the relocated switch"); checks++;
  check(!document.querySelector(".workspace-switcher [id]") && [...document.querySelectorAll(".workspace-switcher button")].every((button) => document.getElementById(button.getAttribute("aria-controls") ?? "")), "Workspace switches have duplicate IDs or unresolved controlled panels"); checks++;
  const previousSidebarWidth = document.documentElement.style.getPropertyValue("--col-sidebar");
  document.documentElement.style.setProperty("--col-sidebar", "200px");
  await document.fonts.ready; await frame();
  for (const selector of [".sidebar", ".hot-sidebar"]) {
    const sidebar = document.querySelector<HTMLElement>(selector)!;
    const sidebarRect = sidebar.getBoundingClientRect();
    const tabs = sidebar.querySelector<HTMLElement>(".workspace-tabs")!;
    const tabRect = tabs.getBoundingClientRect();
    check(Math.abs(sidebarRect.width - 200) <= 1 && tabRect.left >= sidebarRect.left + 10 && tabRect.right <= sidebarRect.right - 10, `${selector} switch overflows the 200px minimum sidebar`); checks++;
    check(tabRect.top >= sidebarRect.top + 38 && !!sidebar.querySelector(".titlebar[data-tauri-drag-region]"), `${selector} switch overlaps native traffic lights or has no drag strip`); checks++;
  }
  check(Math.abs(document.querySelector(".hot-workspace-toolbar")!.getBoundingClientRect().top - document.querySelector(".hot-workspace")!.getBoundingClientRect().top) <= 1, "Hot toolbar is displaced by the removed global row"); checks++;
  if (previousSidebarWidth) document.documentElement.style.setProperty("--col-sidebar", previousSidebarWidth);
  else document.documentElement.style.removeProperty("--col-sidebar");
  flushSync(() => setCaptureBusy(true)); await frame();
  const lockedSwitches = [...document.querySelectorAll<HTMLButtonElement>(".workspace-switcher button")];
  check(lockedSwitches.length === 4 && lockedSwitches.every((button) => button.disabled), "Capture lock did not disable every mounted workspace switch"); checks++;
  flushSync(() => document.querySelector<HTMLButtonElement>('#workspace-rss-panel button[aria-controls="workspace-hotboard-panel"]')!.click());
  check(document.getElementById("workspace-hotboard-panel")!.hasAttribute("inert") && document.querySelectorAll(".workspace-capture-status[role='status']").length === 2, "A locked switch changed workspace or lost capture feedback"); checks++;
  flushSync(() => setCaptureBusy(false));
  click('#workspace-rss-panel button[aria-controls="workspace-hotboard-panel"]');
  check(document.getElementById("workspace-rss-panel")!.hasAttribute("inert") && !document.getElementById("workspace-hotboard-panel")!.hasAttribute("inert"), "Relocated sidebar control did not activate its workspace"); checks++;
  await until(() => document.querySelectorAll(".hot-card").length === 12 && inFlight === 0 && !document.querySelector(".hot-spinner"));
  check(peak <= 4, `Source concurrency exceeded four (${peak})`);
  check(!calls.some((call) => call.sourceId === "synthetic-2" && call.refresh), "Fresh daily source was force-refreshed");
  check(document.querySelectorAll(".hot-card-items li").length === 60, "Top 5 overview is not complete");
  check(document.querySelectorAll(".hot-snapshot-status.has-error").length >= 1, "Failed source lost its error/cache state");
  check(!calls.some((call) => call.command === "get_hot_auth_status"), "Authorization queried before opening a panel"); checks += 5;
  const count = calls.length;
  type('.hot-search input', "LOCAL_ONLY"); await frame();
  check(document.querySelectorAll(".hot-card").length === 1, "Cached keyword did not filter overview");
  check(calls.length === count, "Local keyword search dispatched IPC"); checks += 2;
  type('.hot-search input', ""); await frame();
  click('.hot-card button[aria-label="关注Synthetic East 0"]');
  check(JSON.parse(storage.get("papr.hotboard.ui.v1")!).favorites.includes("synthetic-0"), "Pin preference not retained in isolated storage"); checks++;
  click('.hot-card-limit button:last-child');
  check(document.querySelectorAll(".hot-card-items li").length === 96, "Top 8 did not expand cards"); checks++;
  const sourceNav = [...document.querySelectorAll<HTMLButtonElement>(".hot-source-nav button")].find((button) => button.textContent?.includes("Synthetic Product Hunt ranking"))!;
  flushSync(() => sourceNav.click()); await frame();
  click(".hot-source-access");
  await until(() => calls.some((call) => call.command === "get_hot_auth_status")); await frame();
  const beforeSaveRefresh = calls.filter((call) => call.refresh).length;
  type('.hot-token-field input', "fixture-not-a-real-token");
  click('.hot-authorization button[type="submit"]');
  await until(() => configured); await frame();
  check(document.querySelector<HTMLInputElement>('.hot-token-field input')?.value === "", "Synthetic token remained in the form after save");
  check(calls.filter((call) => call.refresh).length === beforeSaveRefresh, "Saving token automatically refreshed the network");
  check(![...storage.values()].some((value) => value.includes("fixture-not-a-real-token")), "Token leaked into workspace storage"); checks += 3;
  click('.hot-authorization > .hot-action'); await enqueuePageView(() => {}); await frame();
  check(!!document.querySelector(".hot-page-view") && nativeOwner?.startsWith("hot-"), "Official-page control did not open independent native view");
  check(!document.querySelector("iframe"), "Hot detail uses an iframe"); checks += 2;
  click(".hot-source-access"); await enqueuePageView(() => {}); await frame();
  check(nativeOwner === null && !!document.querySelector(".hot-authorization"), "Authorization was occluded by a native view"); checks++;
  const beforeHidden = calls.filter((call) => call.command === "get_hot_snapshot").length;
  const beforeRect = document.querySelector(".hot-workspace")!.getBoundingClientRect();
  flushSync(() => setActive(false)); await frame(); await frame();
  const afterRect = document.querySelector(".hot-workspace")!.getBoundingClientRect();
  check(beforeRect.width === afterRect.width && beforeRect.height === afterRect.height, "Hidden workspace lost its measured dimensions");
  check(calls.filter((call) => call.command === "get_hot_snapshot").length === beforeHidden, "Inactive workspace dispatched source requests"); checks += 2;
  flushSync(() => setActive(true)); await frame();
  click('.hot-breadcrumb button'); await frame();
  for (const selector of ["html", "body", "#root", ".workspace-host", ".workspace-panels"]) {
    const element = document.querySelector<HTMLElement>(selector)!; element.scrollLeft = 100;
    check(element.scrollLeft === 0, `${selector} scrolls horizontally`);
  }
  checks++;
} catch (cause) { failures.push(cause instanceof Error ? cause.message : String(cause)); }
if (blocked.length) failures.push(`Unexpected blocked IPC: ${[...new Set(blocked)].join(", ")}`);
const result = { passed: failures.length === 0, checks, peakRequests: peak, failures, blockedIpc: blocked, sourceCount: sources.length };
Object.assign(window, { __PAPR_HOT_BOARD_QA__: result });
document.getElementById("results")!.textContent = JSON.stringify(result, null, 2);
document.title = `${result.passed ? "PASS" : "FAIL"} — synthetic hot board QA`;
document.documentElement.dataset.result = result.passed ? "pass" : "fail";
