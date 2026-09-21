import { create } from "zustand";
import type { ReaderTab as ReaderMode } from "./aiFormatted";

export const READER_SESSION_KEY = "scholay.reader-tabs.v1";
export interface ReadingState {
  mode: ReaderMode | null;
  extracted: boolean;
  translation: boolean;
  rssScroll: number;
  markdownScroll: number;
  markdownSourceScroll: number;
  markdownDisplay: "preview" | "source";
  outline: boolean | null;
  webUrl: string | null;
  zoom: number;
  zoomMode: "fit" | "manual";
}
export interface ReadingTab {
  id: string;
  articleId: number;
  title: string;
  feedId?: number;
  reading: ReadingState;
  /** Restored sessions must not start automatic paid/network work. */
  restored: boolean;
}
export interface TabSession {
  tabs: ReadingTab[];
  activeId: string | null;
  recent: string[];
}
const empty = (): TabSession => ({ tabs: [], activeId: null, recent: [] });
export const defaultReadingState = (): ReadingState => ({ mode: null, extracted: false, translation: false, rssScroll: 0, markdownScroll: 0, markdownSourceScroll: 0, markdownDisplay: "preview", outline: null, webUrl: null, zoom: 1, zoomMode: "fit" });
function webUrl(value: unknown): string | null {
  try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function restoreTabSession(raw: string | null): TabSession {
  try {
    const data = JSON.parse(raw ?? "null");
    if (data?.version !== 1 || !Array.isArray(data.tabs)) return empty();
    const seen = new Set<number>();
    const tabs: ReadingTab[] = [];
    for (const row of data.tabs) {
      if (!Number.isSafeInteger(row?.articleId) || row.articleId <= 0 || seen.has(row.articleId)) continue;
      seen.add(row.articleId);
      const r = row.reading ?? {};
      const reading = defaultReadingState();
      reading.mode = ["reader", "web", "formatted"].includes(r.mode) ? r.mode : null;
      reading.extracted = r.extracted === true;
      reading.translation = r.translation === true;
      reading.rssScroll = Number.isFinite(r.rssScroll) ? Math.max(0, r.rssScroll) : 0;
      reading.markdownScroll = Number.isFinite(r.markdownScroll) ? Math.max(0, r.markdownScroll) : 0;
      reading.markdownSourceScroll = Number.isFinite(r.markdownSourceScroll) ? Math.max(0, r.markdownSourceScroll) : 0;
      reading.markdownDisplay = r.markdownDisplay === "source" ? "source" : "preview";
      reading.outline = typeof r.outline === "boolean" ? r.outline : null;
      reading.webUrl = webUrl(r.webUrl);
      reading.zoom = Number.isFinite(r.zoom) ? Math.min(3, Math.max(.3, r.zoom)) : 1;
      reading.zoomMode = r.zoomMode === "manual" ? "manual" : "fit";
      tabs.push({ id: `rss-${row.articleId}-${crypto.randomUUID()}`, articleId: row.articleId, title: typeof row.title === "string" ? row.title : "", feedId: row.feedId, reading, restored: true });
    }
    const activeId = tabs.find(t => t.articleId === data.activeArticleId)?.id ?? tabs[0]?.id ?? null;
    return { tabs, activeId, recent: activeId ? [activeId] : [] };
  } catch { return empty(); }
}
export function serializeTabSession(s: TabSession): string {
  return JSON.stringify({ version: 1, tabs: s.tabs.map(({ articleId, title, feedId, reading }) => ({ articleId, title, feedId, reading })), activeArticleId: s.tabs.find(t => t.id === s.activeId)?.articleId ?? null });
}
export function activateTab(s: TabSession, id: string): TabSession {
  return s.tabs.some(t => t.id === id) ? { ...s, tabs: s.tabs.map(t => t.id === id ? { ...t, restored: false } : t), activeId: id, recent: [id, ...s.recent.filter(t => t !== id)] } : s;
}
export function removeTabs(s: TabSession, ids: string[]): TabSession {
  const removed = new Set(ids);
  const tabs = s.tabs.filter(t => !removed.has(t.id));
  const recent = s.recent.filter(id => !removed.has(id));
  const index = s.tabs.findIndex(t => t.id === s.activeId);
  const activeId = s.activeId && !removed.has(s.activeId) ? s.activeId : recent[0] ?? tabs[Math.min(Math.max(0, index), tabs.length - 1)]?.id ?? null;
  return { tabs, activeId, recent: activeId ? [activeId, ...recent.filter(id => id !== activeId)] : [] };
}
interface ReaderTabs extends TabSession {
  closed: ReadingTab[];
  captureTabId: string | null;
  open: (articleId: number, background?: boolean, metadata?: { title: string; feedId?: number }) => void;
  activate: (id: string) => void;
  close: (ids: string[], remember?: boolean) => void;
  reopen: () => void;
  cycle: (delta: number) => void;
  update: (id: string, patch: Partial<ReadingState>) => void;
  metadata: (id: string, title: string, feedId: number) => void;
  setCapture: (id: string | null) => void;
}
let initial = empty();
try { initial = restoreTabSession(localStorage.getItem(READER_SESSION_KEY)); } catch { /* optional storage */ }
export const useReaderTabs = create<ReaderTabs>((set, get) => ({
  ...initial, closed: [], captureTabId: null,
  open: (articleId, background = false, metadata) => {
    const s = get();
    if (s.captureTabId || !Number.isSafeInteger(articleId) || articleId <= 0) return;
    const existing = s.tabs.find(t => t.articleId === articleId);
    if (existing) { if (!background) set(activateTab(s, existing.id)); return; }
    const tab: ReadingTab = { id: `rss-${articleId}-${crypto.randomUUID()}`, articleId, title: metadata?.title ?? "", feedId: metadata?.feedId, reading: defaultReadingState(), restored: false };
    const next = { tabs: [...s.tabs, tab], activeId: s.activeId, recent: s.recent };
    set(background ? next : activateTab(next, tab.id));
  },
  activate: id => { if (!get().captureTabId) set(activateTab(get(), id)); },
  close: (ids, remember = true) => {
    const s = get();
    if (s.captureTabId && ids.includes(s.captureTabId)) return;
    const closing = s.tabs.filter(t => ids.includes(t.id));
    const next = removeTabs(s, ids);
    set({ ...(remember && next.activeId && next.activeId !== s.activeId ? activateTab(next, next.activeId) : next), closed: remember ? [...closing.reverse(), ...s.closed].slice(0, 20) : s.closed });
  },
  reopen: () => {
    const s = get();
    if (s.captureTabId || !s.closed.length) return;
    const [last, ...closed] = s.closed;
    const existing = s.tabs.find(t => t.articleId === last.articleId);
    const tab = { ...last, id: `rss-${last.articleId}-${crypto.randomUUID()}`, restored: true };
    set({ ...activateTab({ ...s, tabs: existing ? s.tabs : [...s.tabs, tab] }, existing?.id ?? tab.id), closed });
  },
  cycle: delta => {
    const s = get();
    if (!s.tabs.length || s.captureTabId) return;
    const index = s.tabs.findIndex(t => t.id === s.activeId);
    s.activate(s.tabs[(index + delta + s.tabs.length) % s.tabs.length].id);
  },
  update: (id, patch) => set(s => ({ tabs: s.tabs.map(t => t.id === id ? { ...t, reading: { ...t.reading, ...patch } } : t) })),
  metadata: (id, title, feedId) => set(s => ({ tabs: s.tabs.map(t => t.id === id && (t.title !== title || t.feedId !== feedId) ? { ...t, title, feedId } : t) })),
  setCapture: captureTabId => set({ captureTabId }),
}));
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() { try { localStorage.setItem(READER_SESSION_KEY, serializeTabSession(useReaderTabs.getState())); } catch { /* optional storage */ } }
useReaderTabs.subscribe(() => { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 150); });
if (typeof window !== "undefined") { window.addEventListener("pagehide", persist); window.addEventListener("beforeunload", persist); }
