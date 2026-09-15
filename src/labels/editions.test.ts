import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITION_MS, editionDay, editionHours, editionStart, groupEditions } from "./editions";
import { LABEL_HISTORY_DB, labelHistoryStats, makeCapture, readLabelEditions, saveLabelCaptures } from "./history";
const base = Date.parse("2026-09-07T16:00:00Z"); // Beijing Sep 8, midnight.
const capture = (at: number, term = "学术", sourceId = "douyin") => makeCapture(sourceId, { capturedAt: new Date(at).toISOString(), period: "当前榜单", rows: [{ term, rank: 1, metric: "100", metricLabel: "", kind: sourceId === "douyin" ? "抖音实时热点" : "热门关键词" }] })!;
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
describe("three fixed editions per Beijing day", () => {
  it("has exact half-open 00/08/16 boundaries and rolls over midnight/year end", () => {
    expect(Array.from({ length: 24 }, (_, h) => editionStart(base + h * 3600000)).filter((value, i, all) => all.indexOf(value) === i)).toEqual([base, base + EDITION_MS, base + 2 * EDITION_MS]);
    expect(editionStart(base + EDITION_MS - 1)).toBe(base);
    expect(editionStart(base + EDITION_MS)).toBe(base + EDITION_MS);
    expect([0, 1, 2].map(i => editionHours(base + i * EDITION_MS))).toEqual(["00:00–08:00", "08:00–16:00", "16:00–24:00"]);
    expect(editionDay(editionStart(Date.parse("2026-12-31T16:00:00Z")))).toBe("2027-01-01");
  });
  it("uses the last provider observation within each slot and leaves missing times empty", () => {
    const values = groupEditions([capture(base + 200, "新"), capture(base + 10, "旧"), capture(base + 2 * EDITION_MS)]);
    expect(values).toHaveLength(2);
    expect(values[0].start).toBe(base + 2 * EDITION_MS);
    expect(values[1].captures[0].rows[0].term).toBe("新");
  });
  it("replaces only the compact same-slot view while retaining all originals, even with unsorted input", async () => {
    await saveLabelCaptures([capture(base + 200, "新"), capture(base + 10, "旧")]);
    await saveLabelCaptures([capture(base + 20, "迟到的旧记录")]);
    expect((await readLabelEditions("douyin")).editions).toHaveLength(1);
    expect((await readLabelEditions("douyin")).editions[0].captures[0].rows[0].term).toBe("新");
    expect((await labelHistoryStats("douyin")).count).toBe(3);
  });
  it("pages across whole slots without duplicates or dropping other providers at the page boundary", async () => {
    await saveLabelCaptures(Array.from({ length: 5 }, (_, i) => [capture(base + i * EDITION_MS), capture(base + i * EDITION_MS, "B站", "bilibili")]).flat());
    const first = await readLabelEditions("all", undefined, 2);
    expect(first.hasMore).toBe(true); expect(first.editions.map(item => item.captures.length)).toEqual([2, 2]);
    const second = await readLabelEditions("all", first.editions.at(-1)!.start, 2);
    const last = await readLabelEditions("all", second.editions.at(-1)!.start, 2);
    expect(last.hasMore).toBe(false);
    expect(new Set([...first.editions, ...second.editions, ...last.editions].map(item => item.start)).size).toBe(5);
    expect((await readLabelEditions("douyin")).editions.every(item => item.captures.length === 1)).toBe(true);
  });
  it("migrates the version-1 database without deleting captures or changing timestamps", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(LABEL_HISTORY_DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore("captures", { keyPath: "id" });
        store.createIndex("time", "at"); store.createIndex("sourceTime", ["sourceId", "at"]);
        store.put(capture(base + 100, "旧")); store.put(capture(base + 200, "新")); store.put(capture(base + EDITION_MS));
      };
      req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
    });
    const result = await readLabelEditions("douyin");
    expect(result.editions).toHaveLength(2);
    expect(result.editions[1].captures[0].at).toBe(base + 200);
    expect((await labelHistoryStats("douyin")).count).toBe(3);
  });
});
