import { beforeEach, describe, expect, it } from "vitest";
import { activateTab, defaultReadingState, removeTabs, restoreTabSession, serializeTabSession, useReaderTabs, type TabSession } from "./readerTabs";

const session = (): TabSession => ({ tabs: [1, 2, 3].map(articleId => ({ id: `rss-${articleId}`, articleId, title: `Article ${articleId}`, reading: defaultReadingState(), restored: false })), activeId: "rss-2", recent: ["rss-2", "rss-1", "rss-3"] });
describe("reading tab sessions", () => {
  beforeEach(() => useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null }));
  it("opens once and never steals focus or marks articles read when opening in background", () => {
    const s = useReaderTabs.getState(); s.open(1); const first = useReaderTabs.getState().activeId;
    s.open(2, true); s.open(1, true); s.open(2, true);
    expect(useReaderTabs.getState().tabs.map(t => t.articleId)).toEqual([1, 2]);
    expect(useReaderTabs.getState().activeId).toBe(first);
    s.open(2); expect(useReaderTabs.getState().tabs).toHaveLength(2);
    expect(useReaderTabs.getState().tabs.find(t => t.id === useReaderTabs.getState().activeId)?.articleId).toBe(2);
  });
  it("closes to the most recently used remaining tab, then an adjacent unvisited tab", () => {
    const s = session();
    expect(removeTabs(s, ["rss-2"]).activeId).toBe("rss-1");
    expect(removeTabs({ ...s, recent: [] }, ["rss-2"]).activeId).toBe("rss-3");
    expect(removeTabs(s, s.tabs.map(t => t.id))).toEqual({ tabs: [], activeId: null, recent: [] });
    expect(removeTabs(s, ["rss-3"]).activeId).toBe("rss-2");
  });
  it("cycles in visual order, while recency order stays independent", () => {
    useReaderTabs.setState(session());
    useReaderTabs.getState().cycle(1); useReaderTabs.getState().cycle(1);
    expect(useReaderTabs.getState().activeId).toBe("rss-1");
    expect(useReaderTabs.getState().recent).toEqual(["rss-1", "rss-3", "rss-2"]);
  });
  it("retains per-article views and scroll independently, without a tab-count limit", () => {
    const s = useReaderTabs.getState(); for (let i = 1; i <= 15; i++) s.open(i);
    const [a, b] = useReaderTabs.getState().tabs;
    s.update(a.id, { mode: "formatted", markdownScroll: 432, markdownDisplay: "source", outline: false });
    s.update(b.id, { mode: "reader", rssScroll: 765, translation: true });
    s.activate(a.id); s.activate(b.id);
    expect(useReaderTabs.getState().tabs).toHaveLength(15);
    expect(useReaderTabs.getState().tabs[0].reading).toMatchObject({ mode: "formatted", markdownScroll: 432, markdownDisplay: "source", outline: false });
    expect(useReaderTabs.getState().tabs[1].reading).toMatchObject({ mode: "reader", rssScroll: 765, translation: true });
  });
  it("restores metadata and modes with fresh native identities and no execution state", () => {
    const s = session(); s.tabs[1].reading.mode = "formatted";
    const restored = restoreTabSession(serializeTabSession(s));
    expect(restored.tabs.map(t => t.articleId)).toEqual([1, 2, 3]);
    expect(restored.tabs[1].id).toBe(restored.activeId);
    expect(restored.tabs[1].id).not.toBe(s.tabs[1].id);
    expect(restored.tabs.every(t => t.restored)).toBe(true);
    expect(restored.tabs[1].reading.mode).toBe("formatted");
    expect(activateTab(restored, restored.activeId!).tabs[1].restored).toBe(false);
  });
  it("validates persisted content, deduplicates articles and rejects private credential URLs", () => {
    expect(restoreTabSession("broken").tabs).toEqual([]);
    const restored = restoreTabSession(JSON.stringify({ version: 1, tabs: [{ articleId: -1 }, { articleId: 1, reading: { mode: "evil", rssScroll: -4, webUrl: "https://user:secret@example.com", zoom: 999 } }, { articleId: 1 }] }));
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0].reading).toMatchObject({ mode: null, rssScroll: 0, webUrl: null, zoom: 3 });
  });
  it("limits closed history to 20 and reopens with a fresh page identity", () => {
    const s = useReaderTabs.getState(); for (let i = 1; i <= 25; i++) s.open(i);
    const tabs = useReaderTabs.getState().tabs; s.close(tabs.map(t => t.id));
    expect(useReaderTabs.getState().closed).toHaveLength(20);
    s.reopen(); expect(useReaderTabs.getState().tabs[0].articleId).toBe(25);
    expect(useReaderTabs.getState().tabs[0].id).not.toBe(tabs[24].id);
  });
  it("locks navigation and the captured tab but permits closing other tabs", () => {
    useReaderTabs.setState(session()); const s = useReaderTabs.getState(); s.setCapture("rss-2");
    s.open(4); s.activate("rss-1"); s.cycle(1); s.close(["rss-2"]);
    expect(useReaderTabs.getState().activeId).toBe("rss-2"); expect(useReaderTabs.getState().tabs).toHaveLength(3);
    s.close(["rss-3"]); expect(useReaderTabs.getState().tabs).toHaveLength(2);
    s.setCapture(null); s.close(["rss-2"]); expect(useReaderTabs.getState().activeId).toBe("rss-1");
  });
});
