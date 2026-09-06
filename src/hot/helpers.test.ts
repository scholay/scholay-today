import { describe, expect, it } from "vitest";
import { createHotRequestQueue, DEFAULT_HOT_UI, matchesHotFilter, matchesHotSearch, parseHotUi, sortHotSources, toggleHotFavorite } from "./helpers";
import type { HotItem, HotSource } from "./types";

const source = (id: string, region: "china" | "global" = "china", category = "tech"): HotSource => ({ id, region, category, name: id, kind: "hot", homepage: "https://example.invalid", description: "Synthetic", project: "Synthetic", project_url: "https://example.invalid", refresh_secs: 600, auth_kind: null, auth_url: null });
const item: HotItem = { id: "one", title: "Open source 科技", description: "Synthetic local snapshot", url: "https://example.invalid", rank: 1, heat: null, published_at: null };

describe("independent hot board state and local filtering", () => {
  it("tolerates invalid or old workspace values without adopting mail/RSS state", () => {
    expect(parseHotUi("mail")).toEqual(DEFAULT_HOT_UI);
    expect(parseHotUi('{"filter":"invalid","favorites":["a","a",5],"paused":true,"sourceId":7}')).toMatchObject({ filter: "all", favorites: ["a"], paused: true, sourceId: null });
  });
  it("filters regional and category metadata, not RSS selection", () => {
    expect(matchesHotFilter(source("a"), "tech")).toBe(true);
    expect(matchesHotFilter(source("a", "global", "finance"), "china")).toBe(false);
    expect(matchesHotFilter(source("a", "china", "生活"), "life")).toBe(true);
  });
  it("searches only supplied cached title/description", () => {
    expect(matchesHotSearch(item, "SOURCE 科技")).toBe(true);
    expect(matchesHotSearch(item, "missing")).toBe(false);
    expect(matchesHotSearch(item, " ")).toBe(true);
  });
  it("pins stably without mutating source data", () => {
    const sources = [source("a"), source("b"), source("c")];
    expect(sortHotSources(sources, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(toggleHotFavorite(["a"], "a")).toEqual([]);
  });
});

describe("bounded hot source request queue", () => {
  it("never dispatches more than four requests concurrently", async () => {
    const queue = createHotRequestQueue(4);
    let active = 0, maximum = 0;
    const pending = Array.from({ length: 15 }, () => queue(async () => {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--; return 1;
    }));
    expect(await Promise.all(pending)).toHaveLength(15);
    expect(maximum).toBe(4);
  });
  it("skips queued requests cancelled when a workspace becomes inactive", async () => {
    const queue = createHotRequestQueue(1);
    let release!: () => void;
    const first = queue(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    let called = false;
    const second = queue(async () => { called = true; }, controller.signal);
    const rejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await Promise.resolve(); release(); await first; await rejection;
    expect(called).toBe(false);
  });
  it("also skips cancellation after assigning a free slot but before dispatch", async () => {
    const queue = createHotRequestQueue(4);
    const controller = new AbortController();
    let called = false;
    const request = queue(async () => { called = true; }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
  });
});
