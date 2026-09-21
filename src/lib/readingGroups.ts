import { create } from "zustand";
import { defaultReadingState, useReaderTabs, type ReadingState, type ReadingTab } from "./readerTabs";
import { safePageViewUrl } from "./pageViewState";
import type { StructuredListItem } from "../types";
import type { HotItem, HotSource } from "../hot/types";

export const READING_GROUPS = ["rss", "files", "hot"] as const;
export type ReadingGroup = typeof READING_GROUPS[number];
export const READING_GROUP_LABELS = { rss: "RSS", files: "文库", hot: "热榜" };
export const GROUP_SESSION_KEY = "scholay.reading-groups.v1";

export interface FileTab {
  group: "files";
  id: string;
  key: string;
  title: string;
  item: StructuredListItem;
  example: boolean;
  reading: ReadingState;
}
export interface HotTab {
  group: "hot";
  id: string;
  key: string;
  title: string;
  // Only display metadata belongs in the session, never authorization settings.
  source: Pick<HotSource, "id" | "name" | "kind" | "description" | "homepage" | "project" | "project_url">;
  item: HotItem;
  fetchedAt: string | null;
  display: "summary" | "web";
  reading: ReadingState;
}
export type ContentTab = FileTab | HotTab;
export type GroupedTab = (ReadingTab & { group: "rss" }) | ContentTab;
type ClosedTab = { group: "rss"; tab: ReadingTab } | { group: "files" | "hot"; tab: ContentTab };
interface GroupSession {
  tabs: ContentTab[];
  active: Record<"files" | "hot", string | null>;
  recent: string[];
}
export const emptyGroupSession = (): GroupSession => ({ tabs: [], active: { files: null, hot: null }, recent: [] });
const freshId = (group: string) => `${group}-${crypto.randomUUID()}`;
const text = (value: unknown, max = 4000) => typeof value === "string" ? value.slice(0, max) : "";
const nullableText = (value: unknown) => typeof value === "string" ? text(value) : null;
const scroll = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
function restoreReading(value: Partial<ReadingState> = {}): ReadingState {
  return { ...defaultReadingState(), markdownDisplay: value.markdownDisplay === "source" ? "source" : "preview", outline: typeof value.outline === "boolean" ? value.outline : null,
    rssScroll: scroll(value.rssScroll), markdownScroll: scroll(value.markdownScroll), markdownSourceScroll: scroll(value.markdownSourceScroll),
    webUrl: safePageViewUrl(value.webUrl), zoom: typeof value.zoom === "number" && Number.isFinite(value.zoom) ? Math.min(3, Math.max(.3, value.zoom)) : 1, zoomMode: value.zoomMode === "manual" ? "manual" : "fit" };
}
export function restoreGroupSession(raw: string | null): GroupSession {
  const result = emptyGroupSession();
  try {
    const saved = JSON.parse(raw ?? "null");
    if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return result;
    const keys = new Set<string>();
    for (const row of saved.tabs) {
      if (!row || typeof row !== "object") continue;
      let tab: ContentTab;
      if (row.group === "files") {
        const item = row.item;
        if (!item || !Number.isSafeInteger(item.articleId) || (row.example === true ? item.articleId >= 0 : item.articleId <= 0)) continue;
        const key = `files:${row.example === true ? "example" : "article"}:${item.articleId}`;
        tab = { group: "files", id: freshId("files"), key, title: text(item.title), example: row.example === true, reading: restoreReading(row.reading ?? {}), item: {
          articleId: item.articleId, title: text(item.title), feedId: Number.isSafeInteger(item.feedId) ? item.feedId : 0, feedTitle: text(item.feedTitle),
          folderId: Number.isSafeInteger(item.folderId) ? item.folderId : null, folderName: nullableText(item.folderName), url: safePageViewUrl(item.url),
          publishedAt: nullableText(item.publishedAt), cleanedAt: text(item.cleanedAt), sourceKind: text(item.sourceKind),
          blocks: scroll(item.blocks), words: scroll(item.words), images: scroll(item.images), staleSchema: item.staleSchema === true,
        } };
      } else if (row.group === "hot") {
        const url = safePageViewUrl(row.item?.url);
        if (!url || !row.source || typeof row.source.id !== "string") continue;
        tab = { group: "hot", id: freshId("hot"), key: `hot:${url}`, title: text(row.item.title), reading: restoreReading(row.reading ?? {}),
          display: row.display === "web" ? "web" : "summary", fetchedAt: nullableText(row.fetchedAt),
          source: { id: text(row.source.id), name: text(row.source.name), kind: ["hot", "latest", "daily"].includes(row.source.kind) ? row.source.kind : "hot", description: text(row.source.description), homepage: safePageViewUrl(row.source.homepage) ?? "", project: text(row.source.project), project_url: safePageViewUrl(row.source.project_url) ?? "" },
          item: { id: text(row.item.id), title: text(row.item.title), url, description: nullableText(row.item.description), heat: nullableText(row.item.heat), rank: scroll(row.item.rank), published_at: nullableText(row.item.published_at) },
        };
      } else continue;
      if (keys.has(tab.key)) continue;
      keys.add(tab.key); result.tabs.push(tab);
    }
    for (const group of ["files", "hot"] as const) {
      result.active[group] = result.tabs.find(t => t.group === group && t.key === saved.active?.[group])?.id ?? result.tabs.find(t => t.group === group)?.id ?? null;
    }
    result.recent = Object.values(result.active).filter((id): id is string => !!id);
  } catch { /* A broken optional session must never block startup. */ }
  return result;
}
export function serializeGroupSession(state: GroupSession): string {
  return JSON.stringify({ version: 1, tabs: state.tabs.map(({ id: _id, ...tab }) => tab),
    active: { files: state.tabs.find(t => t.id === state.active.files)?.key ?? null, hot: state.tabs.find(t => t.id === state.active.hot)?.key ?? null } });
}
interface ReadingGroups extends GroupSession {
  closed: ClosedTab[];
  loading: Record<string, boolean>;
  openFile: (item: StructuredListItem, example?: boolean, background?: boolean) => void;
  openHot: (source: HotSource | HotTab["source"], item: HotItem, fetchedAt?: string | null, background?: boolean, display?: HotTab["display"]) => void;
  update: (id: string, patch: Partial<ReadingState>) => void;
  setHotDisplay: (id: string, display: HotTab["display"]) => void;
  setLoading: (id: string, loading: boolean) => void;
}
let initial = emptyGroupSession();
try { initial = restoreGroupSession(localStorage.getItem(GROUP_SESSION_KEY)); } catch { /* optional */ }
export const useReadingGroups = create<ReadingGroups>((set, get) => ({
  ...initial, closed: [], loading: {},
  openFile: (item, example = false, background = false) => {
    if (readingCaptureBusy()) return;
    const key = `files:${example ? "example" : "article"}:${item.articleId}`;
    const existing = get().tabs.find(t => t.key === key);
    const tab: FileTab = { group: "files", id: freshId("files"), key, title: item.title, item: { ...item }, example, reading: defaultReadingState() };
    if (!existing) set(s => ({ tabs: [...s.tabs, tab] }));
    if (!background) activateReadingTab(existing?.id ?? tab.id);
  },
  openHot: (source, item, fetchedAt = null, background = false, display = "summary") => {
    if (readingCaptureBusy()) return;
    const url = safePageViewUrl(item.url);
    if (!url) return;
    const key = `hot:${url}`;
    const existing = get().tabs.find(t => t.key === key);
    const { id, name, kind, description, homepage, project, project_url } = source;
    const tab: HotTab = { group: "hot", id: freshId("hot"), key, title: item.title, source: { id, name, kind, description, homepage, project, project_url },
      item: { id: item.id, title: item.title, url, description: item.description, heat: item.heat, rank: item.rank, published_at: item.published_at }, fetchedAt, display, reading: defaultReadingState() };
    if (!existing) set(s => ({ tabs: [...s.tabs, tab] }));
    if (!background) activateReadingTab(existing?.id ?? tab.id);
  },
  update: (id, patch) => set(s => ({ tabs: s.tabs.map(t => t.id === id ? { ...t, reading: { ...t.reading, ...patch } } : t) })),
  setHotDisplay: (id, display) => set(s => ({ tabs: s.tabs.map(t => t.id === id && t.group === "hot" ? { ...t, display } : t) })),
  setLoading: (id, loading) => set(s => s.loading[id] === loading ? s : ({ loading: { ...s.loading, [id]: loading } })),
}));

export const readingCaptureBusy = () => useReaderTabs.getState().captureTabId !== null;
export function groupedReadingTabs(): GroupedTab[] {
  return [...useReaderTabs.getState().tabs.map(t => ({ ...t, group: "rss" as const })), ...["files", "hot"].flatMap(group => useReadingGroups.getState().tabs.filter(t => t.group === group))];
}
export function readingTabsFor(group: ReadingGroup): GroupedTab[] {
  return groupedReadingTabs().filter(tab => tab.group === group);
}
export function activeReadingId(group: ReadingGroup): string | null {
  return group === "rss" ? useReaderTabs.getState().activeId : useReadingGroups.getState().active[group];
}
/** Reading actions never navigate between workspaces. The activity rail owns
 * workspace navigation, and each workspace keeps its own active/MRU state. */
export function activateReadingTab(id: string) {
  if (readingCaptureBusy()) return;
  const tab = groupedReadingTabs().find(t => t.id === id);
  if (!tab) return;
  if (tab.group === "rss") useReaderTabs.getState().activate(id);
  else useReadingGroups.setState(s => ({ active: { ...s.active, [tab.group]: id }, recent: [id, ...s.recent.filter(value => value !== id)] }));
}
function limitClosed(records: ClosedTab[]): ClosedTab[] {
  const counts: Record<ReadingGroup, number> = { rss: 0, files: 0, hot: 0 };
  return records.filter(record => ++counts[record.group] <= 20);
}
export function closeReadingTabs(ids: string[], remember = true) {
  const previousRssId = useReaderTabs.getState().activeId;
  const capture = useReaderTabs.getState().captureTabId;
  if (capture && ids.includes(capture)) return;
  const all = groupedReadingTabs();
  const closing = all.filter(t => ids.includes(t.id));
  // RSS retains its existing canonical state and selectedArticleId mapping.
  // Workspace tabs are an adapter, never a second copy of RSS article state.
  useReaderTabs.getState().close(closing.filter(t => t.group === "rss").map(t => t.id), false);
  useReadingGroups.setState(s => {
    const tabs = s.tabs.filter(t => !ids.includes(t.id));
    const recent = s.recent.filter(id => !ids.includes(id));
    const active = { ...s.active };
    for (const group of ["files", "hot"] as const) {
      if (active[group] && ids.includes(active[group]!)) {
        const inGroup = tabs.filter(t => t.group === group);
        const oldIndex = s.tabs.filter(t => t.group === group).findIndex(t => t.id === active[group]);
        active[group] = recent.find(id => inGroup.some(t => t.id === id)) ?? inGroup[Math.min(Math.max(0, oldIndex), inGroup.length - 1)]?.id ?? null;
      }
    }
    const records = closing.map((tab): ClosedTab => tab.group === "rss" ? { group: "rss", tab } : { group: tab.group, tab });
    return { tabs, active, recent, closed: remember ? limitClosed([...records.reverse(), ...s.closed]) : s.closed };
  });
  const next = useReaderTabs.getState();
  if (remember && next.activeId && next.activeId !== previousRssId) next.activate(next.activeId);
}
export function reopenReadingTab(group: ReadingGroup) {
  if (readingCaptureBusy()) return;
  const records = useReadingGroups.getState().closed;
  const index = records.findIndex(record => record.group === group);
  const last = records[index];
  if (!last) return;
  useReadingGroups.setState({ closed: records.filter((_, i) => i !== index) });
  if (last.group === "rss") {
    const id = useReaderTabs.getState().restore(last.tab);
    if (id) activateReadingTab(id);
  } else {
    const existing = useReadingGroups.getState().tabs.find(t => t.key === last.tab.key);
    const tab = { ...last.tab, reading: { ...last.tab.reading }, id: freshId(last.group) };
    if (!existing) useReadingGroups.setState(s => ({ tabs: [...s.tabs, tab] }));
    activateReadingTab(existing?.id ?? tab.id);
  }
}
export function cycleReadingTabs(group: ReadingGroup, delta: number) {
  const tabs = readingTabsFor(group);
  if (!tabs.length) return;
  const index = tabs.findIndex(t => t.id === activeReadingId(group));
  activateReadingTab(tabs[index < 0 ? delta > 0 ? 0 : tabs.length - 1 : (index + delta + tabs.length) % tabs.length].id);
}
export function tabCloseTargets(id: string, action: "close" | "others" | "right" | "all"): string[] {
  const owner = groupedReadingTabs().find(tab => tab.id === id)?.group;
  if (!owner) return [];
  const tabs = readingTabsFor(owner);
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return [];
  return (action === "all" ? tabs : action === "right" ? tabs.slice(index + 1) : tabs.filter(t => action === "others" ? t.id !== id : t.id === id)).map(t => t.id);
}
// Preserve closes performed elsewhere (article deletion / existing RSS API).
useReaderTabs.subscribe((next, prev) => {
  const records = next.closed.filter(t => !prev.closed.some(old => old.id === t.id));
  if (!records.length) return;
  useReadingGroups.setState(s => ({
    closed: limitClosed([...records.map((tab): ClosedTab => ({ group: "rss", tab })), ...s.closed]),
  }));
});
let persistTimer: ReturnType<typeof setTimeout> | undefined;
export function persistReadingGroups() { try { localStorage.setItem(GROUP_SESSION_KEY, serializeGroupSession(useReadingGroups.getState())); } catch { /* optional */ } }
useReadingGroups.subscribe((next, prev) => {
  if (next.tabs === prev.tabs && next.active === prev.active) return;
  clearTimeout(persistTimer); persistTimer = setTimeout(persistReadingGroups, 150);
});
if (typeof window !== "undefined") { window.addEventListener("pagehide", persistReadingGroups); window.addEventListener("beforeunload", persistReadingGroups); }
