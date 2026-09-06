import type { HotFilter, HotItem, HotSource, HotUiState } from "./types";

export const HOT_UI_KEY = "papr.hotboard.ui.v1";
export const HOT_POLL_MS = 10 * 60 * 1000;
export const HOT_FILTERS: { id: HotFilter; label: string }[] = [
  { id: "all", label: "全部" }, { id: "china", label: "国内" }, { id: "global", label: "海外" },
  { id: "tech", label: "科技" }, { id: "finance", label: "财经" }, { id: "life", label: "生活" },
];
export const DEFAULT_HOT_UI: HotUiState = { filter: "all", favorites: [], favoritesOnly: false, paused: false, cardLimit: 5, sourceId: null, itemId: null, view: "overview", search: "" };

export function parseHotUi(raw: string | null): HotUiState {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_HOT_UI, favorites: [] };
    const value = parsed as Partial<HotUiState>;
    return {
      filter: HOT_FILTERS.some((item) => item.id === value.filter) ? value.filter! : "all",
      favorites: Array.isArray(value.favorites) ? [...new Set(value.favorites.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 150))] : [],
      favoritesOnly: value.favoritesOnly === true, paused: value.paused === true,
      cardLimit: value.cardLimit === 8 ? 8 : 5,
      sourceId: typeof value.sourceId === "string" ? value.sourceId : null,
      itemId: typeof value.itemId === "string" ? value.itemId : null,
      view: value.view === "source" ? "source" : "overview",
      search: typeof value.search === "string" ? value.search.slice(0, 300) : "",
    };
  } catch { return { ...DEFAULT_HOT_UI, favorites: [] }; }
}

export function matchesHotFilter(source: HotSource, filter: HotFilter): boolean {
  if (filter === "all") return true;
  if (filter === "china" || filter === "global") return source.region === filter;
  const categories: Record<"tech" | "finance" | "life", string[]> = {
    tech: ["tech", "technology", "科技", "技术", "ai", "developer"],
    finance: ["finance", "business", "财经", "金融", "商业"],
    life: ["life", "lifestyle", "culture", "生活", "文化", "娱乐"],
  };
  return categories[filter].includes(source.category.toLocaleLowerCase());
}

export function matchesHotSearch(item: HotItem, search: string): boolean {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = `${item.title}\n${item.description ?? ""}`.toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

export function sortHotSources(sources: HotSource[], favorites: string[]): HotSource[] {
  const order = new Map(favorites.map((id, index) => [id, index]));
  return sources.map((source, index) => ({ source, index })).sort((a, b) =>
    (order.get(a.source.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.source.id) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
  ).map(({ source }) => source);
}

export function toggleHotFavorite(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

export function hotError(cause: unknown): string {
  return typeof cause === "string" && cause.trim() ? cause : cause instanceof Error ? cause.message : "暂时无法获取此来源";
}

export function hotTime(value: string | null): string {
  if (!value) return "尚未获取";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Native requests cannot be aborted after dispatch, but queued requests can.
 *  Inactive workspaces cancel their observers so no queued network work starts. */
export function createHotRequestQueue(concurrency = 4) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const drain = () => {
    while (active < concurrency && waiting.length) waiting.shift()!();
  };
  return <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    waiting.push(() => {
      if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
      active++;
      Promise.resolve().then(() => {
        // Cancellation can arrive after this slot was assigned but before
        // this microtask actually dispatches native IPC.
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        return task();
      }).then(resolve, reject).finally(() => { active--; drain(); });
    });
    drain();
  });
}
