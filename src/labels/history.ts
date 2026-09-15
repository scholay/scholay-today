import { LABEL_SOURCES, parseLabelCache, type LabelRow, type LabelSnapshot } from "./helpers";
import { editionStart, type EditionPage, type LabelEdition } from "./editions";

export const LABEL_HISTORY_DB = "scholay-label-history";
export const HISTORY_QUERY_LIMIT = 5000;
export interface LabelCapture extends LabelSnapshot { id: string; sourceId: string; at: number }
export interface HistoryStats { count: number; firstAt: number | null; lastAt: number | null }
export interface HistoryResult { captures: LabelCapture[]; total: number }
export interface LabelInsight extends LabelRow {
  key: string; sourceId: string; firstAt: number; lastAt: number; observations: number;
  firstRank: number; bestRank: number; period: string;
}

/** Fixed projection: a history record never contains browser session data. */
export function makeCapture(sourceId: string, snapshot: LabelSnapshot): LabelCapture | null {
  const safe = parseLabelCache(JSON.stringify({ [sourceId]: snapshot }))[sourceId];
  if (!safe) return null;
  const at = Date.parse(safe.capturedAt), capturedAt = new Date(at).toISOString();
  return { ...safe, capturedAt, id: `${sourceId}:${capturedAt}`, sourceId, at };
}

/** Latest metric is an observation, not an interval sum or comparable traffic. */
export function aggregateCaptures(captures: LabelCapture[]): LabelInsight[] {
  const result = new Map<string, LabelInsight>();
  for (const capture of [...captures].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const seen = new Set<string>();
    for (const row of capture.rows) {
      const key = JSON.stringify([capture.sourceId, row.kind, row.term]);
      if (seen.has(key)) continue;
      seen.add(key);
      const old = result.get(key);
      result.set(key, { ...row, key, sourceId: capture.sourceId, firstAt: old?.firstAt ?? capture.at,
        lastAt: capture.at, observations: (old?.observations ?? 0) + 1,
        firstRank: old?.firstRank ?? row.rank, bestRank: Math.min(old?.bestRank ?? row.rank, row.rank), period: capture.period });
    }
  }
  return [...result.values()];
}

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(new Error("本地快照读取失败"));
});
function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("本机历史存储不可用")); return; }
    let blocked = false;
    const req = indexedDB.open(LABEL_HISTORY_DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("captures")) {
        const store = req.result.createObjectStore("captures", { keyPath: "id" });
        store.createIndex("time", "at");
        store.createIndex("sourceTime", ["sourceId", "at"]);
      }
      const editions = req.result.createObjectStore("editions", { keyPath: "id" });
      editions.createIndex("time", "start");
      editions.createIndex("sourceTime", ["sourceId", "start"]);
      // Add a compact derived index; every original capture stays untouched.
      const cursor = req.transaction!.objectStore("captures").openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const raw = cursor.result.value, safe = makeCapture(raw.sourceId, raw);
        if (safe) upsertEdition(editions, safe);
        cursor.result.continue();
      };
    };
    req.onsuccess = () => { if (blocked) { req.result.close(); return; } req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(new Error("本机历史存储无法打开；已有缓存未清除"));
    req.onblocked = () => { blocked = true; reject(new Error("历史库正在被另一窗口占用，请重开应用后重试")); };
  });
}
function upsertEdition(store: IDBObjectStore, capture: LabelCapture) {
  const start = editionStart(capture.at), id = `${capture.sourceId}:${start}`;
  const old = store.get(id);
  old.onsuccess = () => {
    if (!old.result || old.result.capture.at < capture.at) store.put({ id, sourceId: capture.sourceId, start, capture });
  };
}
export async function saveLabelCaptures(captures: LabelCapture[]): Promise<void> {
  const db = await openHistory();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["captures", "editions"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error("快照未能写入本机历史，已有历史未清除"));
      const newest = new Map<string, LabelCapture>();
      for (const input of captures) {
        const safe = makeCapture(input.sourceId, input);
        if (safe) {
          tx.objectStore("captures").put(safe);
          const key = `${safe.sourceId}:${editionStart(safe.at)}`;
          if (!newest.has(key) || newest.get(key)!.at < safe.at) newest.set(key, safe);
        }
      }
      for (const capture of newest.values()) upsertEdition(tx.objectStore("editions"), capture);
    });
  } finally { db.close(); }
}
/** Page by whole eight-hour slots, not by providers/rows. This avoids a large
 * all-history read and keeps older editions reachable without date filters. */
export async function readLabelEditions(sourceId: string, before = 8.64e15, limit = 30): Promise<EditionPage> {
  const db = await openHistory();
  try {
    const { index, range } = scope(db.transaction("editions").objectStore("editions"), sourceId, -8.64e15, before);
    return await new Promise<EditionPage>((resolve, reject) => {
      const editions: LabelEdition[] = [], req = index.openCursor(range, "prev");
      req.onerror = () => reject(new Error("无法读取标签历史"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve({ editions, hasMore: false }); return; }
        const raw = cursor.value, capture = makeCapture(raw.sourceId, raw.capture);
        if (capture) {
          const start = editionStart(capture.at);
          if (editions.at(-1)?.start !== start) {
            if (editions.length >= Math.max(1, Math.min(100, limit))) { resolve({ editions, hasMore: true }); return; }
            editions.push({ start, captures: [] });
          }
          editions.at(-1)!.captures.push(capture);
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }
}
export async function migrateLabelCache(cache: Record<string, LabelSnapshot>): Promise<void> {
  const captures = Object.entries(cache).flatMap(([id, snapshot]) => { const value = makeCapture(id, snapshot); return value ? [value] : []; });
  // Idempotent by platform + original capture timestamp; never date old data as new.
  await saveLabelCaptures(captures);
}
function scope(store: IDBObjectStore, sourceId: string, from = -8.64e15, to = 8.64e15) {
  return sourceId === "all"
    ? { index: store.index("time"), range: IDBKeyRange.bound(from, to, false, true) }
    : { index: store.index("sourceTime"), range: IDBKeyRange.bound([sourceId, from], [sourceId, to], false, true) };
}
export async function readLabelHistory(sourceId: string, from: number, to: number): Promise<HistoryResult> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { captures: [], total: 0 };
  const db = await openHistory();
  try {
    const { index, range } = scope(db.transaction("captures").objectStore("captures"), sourceId, from, to);
    const total = request(index.count(range));
    const captures = new Promise<LabelCapture[]>((resolve, reject) => {
      const values: LabelCapture[] = [], req = index.openCursor(range, "prev");
      req.onerror = () => reject(new Error("本地快照读取失败"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || values.length === HISTORY_QUERY_LIMIT) { resolve(values); return; }
        const value = makeCapture(cursor.value.sourceId, cursor.value);
        if (value) values.push(value);
        cursor.continue();
      };
    });
    const [rows, count] = await Promise.all([captures, total]);
    return { captures: rows, total: count };
  } finally { db.close(); }
}
export async function labelHistoryStats(sourceId: string): Promise<HistoryStats> {
  const db = await openHistory();
  try {
    const { index, range } = scope(db.transaction("captures").objectStore("captures"), sourceId);
    const [count, first, last] = await Promise.all([request(index.count(range)), request(index.openCursor(range)), request(index.openCursor(range, "prev"))]);
    return { count, firstAt: first?.value.at ?? null, lastAt: last?.value.at ?? null };
  } finally { db.close(); }
}
export async function latestLabelCaptures(): Promise<Record<string, LabelSnapshot>> {
  const db = await openHistory();
  try {
    const store = db.transaction("captures").objectStore("captures");
    const captures = await Promise.all(LABEL_SOURCES.filter(item => item.adapter).map(async item => {
      const { index, range } = scope(store, item.id);
      const cursor = await request(index.openCursor(range, "prev"));
      const safe = cursor && makeCapture(item.id, cursor.value);
      return safe ? [item.id, safe] as const : null;
    }));
    return Object.fromEntries(captures.filter(item => item !== null));
  } finally { db.close(); }
}
