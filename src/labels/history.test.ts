import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_QUERY_LIMIT, aggregateCaptures, labelHistoryStats, latestLabelCaptures, makeCapture, migrateLabelCache, readLabelHistory, saveLabelCaptures } from "./history";
import { type LabelSnapshot } from "./helpers";

const at = Date.parse("2026-09-08T02:00:00Z");
const snapshot = (time = at, rank = 4, metric = "100万"): LabelSnapshot => ({ capturedAt: new Date(time).toISOString(), period: "平台当前榜单", rows: [{ term: "学术交流", kind: "抖音实时热点", rank, metric, metricLabel: "热点指数" }] });
const capture = (time = at, rank = 4, metric = "100万") => makeCapture("douyin", snapshot(time, rank, metric))!;
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());

describe("append-only local label history", () => {
  it("migrates the original timestamp idempotently and survives database close/reopen", async () => {
    await migrateLabelCache({ douyin: snapshot() });
    await migrateLabelCache({ douyin: snapshot() });
    expect(await labelHistoryStats("all")).toEqual({ count: 1, firstAt: at, lastAt: at });
    expect((await readLabelHistory("douyin", at, at + 1)).captures[0].at).toBe(at);
    expect((await latestLabelCaptures()).douyin.capturedAt).toBe(new Date(at).toISOString());
  });
  it("keeps unchanged observations at different times and never replaces previous history", async () => {
    await saveLabelCaptures([capture(), capture(at + 600_000), capture(at + 1200_000, 2, "110万")]);
    const result = await readLabelHistory("douyin", at, at + 1200_001);
    expect(result.total).toBe(3);
    expect(result.captures.map(item => item.at)).toEqual([at + 1200_000, at + 600_000, at]);
    expect((await latestLabelCaptures()).douyin.rows[0].rank).toBe(2);
  });
  it("filters source and inclusive-start/exclusive-end ranges without cross-platform merging", async () => {
    const b = makeCapture("bilibili", { ...snapshot(at + 10), rows: [{ term: "学术交流", kind: "热门关键词", rank: 1, metric: "1W", metricLabel: "内容指数" }] })!;
    await saveLabelCaptures([capture(), capture(at + 20), b]);
    expect((await readLabelHistory("douyin", at, at + 20)).total).toBe(1);
    expect((await readLabelHistory("all", at, at + 20)).total).toBe(2);
    expect((await labelHistoryStats("bilibili")).count).toBe(1);
    expect((await readLabelHistory("douyin", at + 100, at + 200)).captures).toEqual([]);
    expect(await readLabelHistory("all", at, at)).toEqual({ captures: [], total: 0 });
  });
  it("projects public fields only and rejects empty or invalid observations", async () => {
    const raw = { ...snapshot(), cookie: "SECRET", auth: "signed_in", rows: [{ ...snapshot().rows[0], token: "SECRET" }] };
    await migrateLabelCache({ douyin: raw });
    const result = await readLabelHistory("all", at, at + 1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|cookie|token|signed_in/);
    expect(makeCapture("douyin", { ...snapshot(), rows: [] })).toBeNull();
    expect(makeCapture("unknown", snapshot())).toBeNull();
    expect(makeCapture("douyin", { ...snapshot(), capturedAt: "invalid" })).toBeNull();
    await migrateLabelCache({ douyin: { ...snapshot(), rows: [] } });
    expect((await labelHistoryStats("all")).count).toBe(1);
  });
  it("reports unavailable storage without pretending a snapshot was saved", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveLabelCaptures([capture()])).rejects.toThrow("不可用");
  });
  it("bounds range reads but retains all snapshots and reports the full match count", async () => {
    await saveLabelCaptures(Array.from({ length: HISTORY_QUERY_LIMIT + 1 }, (_, index) => capture(at + index)));
    const result = await readLabelHistory("all", at, at + HISTORY_QUERY_LIMIT + 1);
    expect(result.total).toBe(HISTORY_QUERY_LIMIT + 1);
    expect(result.captures).toHaveLength(HISTORY_QUERY_LIMIT);
    expect(result.captures[0].at).toBe(at + HISTORY_QUERY_LIMIT);
    expect((await labelHistoryStats("all")).count).toBe(HISTORY_QUERY_LIMIT + 1);
  }, 15_000);
  it("keeps native periods, latest metrics and seen counts without invented traffic sums", () => {
    const early = capture(at, 4, "100万"), late = capture(at + 600_000, 2, "110万");
    early.rows.push({ ...early.rows[0] }); // A duplicated DOM row is one observation.
    const [row] = aggregateCaptures([late, early]);
    expect(row).toMatchObject({ observations: 2, firstRank: 4, rank: 2, bestRank: 2, metric: "110万", firstAt: at, lastAt: at + 600_000 });
    const differentKind = capture(); differentKind.rows[0].kind = "抖音飙升热点";
    expect(aggregateCaptures([early, differentKind])).toHaveLength(2);
  });
  it("never interprets missing platform values as zero", () => {
    const z = makeCapture("zhihu", { ...snapshot(), rows: [{ term: "学术交流", kind: "知乎热题", rank: 1, metric: "", metricLabel: "" }] })!;
    expect(aggregateCaptures([capture(), z])).toHaveLength(2);
    expect(aggregateCaptures([z])[0].metric).toBe("");
  });
});
