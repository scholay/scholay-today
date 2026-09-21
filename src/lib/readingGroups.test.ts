// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { useReaderTabs } from "./readerTabs";
import { activateReadingTab, closeReadingTabs, cycleReadingTabs, emptyGroupSession, groupedReadingTabs, readingTabsFor, reopenReadingTab, restoreGroupSession, serializeGroupSession, tabCloseTargets, useReadingGroups } from "./readingGroups";
import { LIBRARY_EXAMPLES } from "../library/examples";
import type { HotItem, HotSource } from "../hot/types";

const source: HotSource = { id: "news", name: "News", kind: "hot", region: "global", category: "tech", description: "Public metadata", homepage: "https://example.invalid", project: "Fixture", project_url: "https://example.invalid/docs", refresh_secs: 600, auth_kind: "api_token", auth_url: "https://example.invalid/auth" };
const item = (n: number): HotItem => ({ id: String(n), title: `Hot ${n}`, url: `https://example.invalid/${n}`, description: "Summary", heat: "10", rank: n, published_at: null });
const file = (n = 0) => LIBRARY_EXAMPLES[n].item;
beforeEach(() => {
  useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null });
  useReadingGroups.setState({ ...emptyGroupSession(), closed: [], loading: {} });
});
it("keeps canonical RSS state, deduplicates per group, and background opens never activate", () => {
  useReaderTabs.getState().open(1);
  const rss = useReaderTabs.getState().activeId;
  useReadingGroups.getState().openFile(file(), true, true);
  useReadingGroups.getState().openFile(file(), true, true);
  useReadingGroups.getState().openHot(source, item(1), null, true);
  useReadingGroups.getState().openHot(source, item(1), null, true);
  expect(groupedReadingTabs().map(t => t.group)).toEqual(["rss", "files", "hot"]);
  expect(useReadingGroups.getState().active).toEqual({ files: null, hot: null });
  expect(useReaderTabs.getState().activeId).toBe(rss);
  expect(readingTabsFor("rss").map(t => t.id)).toEqual([rss]);
  expect(readingTabsFor("files")).toHaveLength(1);
  expect(readingTabsFor("hot")).toHaveLength(1);
});
it("reading actions never emit the retired cross-workspace navigation event", () => {
  const activated = vi.fn(); window.addEventListener("scholay-activate-reading-group", activated);
  useReadingGroups.getState().openFile(file(), true);
  const id = useReadingGroups.getState().active.files!;
  useReadingGroups.getState().openHot(source, item(1));
  activateReadingTab(id); closeReadingTabs([id]); reopenReadingTab("files");
  expect(activated).not.toHaveBeenCalled();
  window.removeEventListener("scholay-activate-reading-group", activated);
});
it("close-right and close-others stay within their workspace and recover its own MRU", () => {
  useReadingGroups.getState().openHot(source, item(1));
  useReaderTabs.getState().open(1);
  useReadingGroups.getState().openFile(file(), true);
  const f1 = useReadingGroups.getState().active.files!;
  useReadingGroups.getState().openFile(file(1), true);
  const f2 = useReadingGroups.getState().active.files!;
  useReadingGroups.getState().openFile(file(2), true);
  const f3 = useReadingGroups.getState().active.files!;
  activateReadingTab(f1); activateReadingTab(f3); closeReadingTabs([f3]);
  expect(useReadingGroups.getState().active.files).toBe(f1);
  const order = groupedReadingTabs();
  expect(order.map(t => t.group)).toEqual(["rss", "files", "files", "hot"]);
  expect(tabCloseTargets(f1, "right")).toEqual([f2]);
  closeReadingTabs(tabCloseTargets(f1, "others"));
  expect(readingTabsFor("files").map(t => t.id)).toEqual([f1]);
  expect(readingTabsFor("rss")).toHaveLength(1); expect(readingTabsFor("hot")).toHaveLength(1);
  closeReadingTabs([f1]); expect(readingTabsFor("files")).toHaveLength(0);
  expect(useReadingGroups.getState().active.files).toBeNull();
});
it("restores only the requested workspace with independent state and fresh native identity", () => {
  useReaderTabs.getState().open(1);
  const rss = useReaderTabs.getState().tabs[0];
  useReaderTabs.getState().update(rss.id, { rssScroll: 42, mode: "reader" });
  useReadingGroups.getState().openHot(source, item(1), null, false, "web");
  const hot = useReadingGroups.getState().tabs[0];
  useReadingGroups.getState().update(hot.id, { webUrl: "https://example.invalid/latest", zoom: 1.4 });
  closeReadingTabs([rss.id]); closeReadingTabs([hot.id]); reopenReadingTab("rss");
  expect(useReaderTabs.getState().tabs[0].id).not.toBe(rss.id);
  expect(useReaderTabs.getState().tabs[0].reading.rssScroll).toBe(42);
  expect(useReadingGroups.getState().tabs).toHaveLength(0);
  reopenReadingTab("rss"); expect(useReadingGroups.getState().tabs).toHaveLength(0);
  reopenReadingTab("hot");
  const restored = useReadingGroups.getState().tabs[0];
  expect(restored.id).not.toBe(hot.id); expect(restored.reading.zoom).toBe(1.4);
});
it("closing the last local tab leaves an empty reader without changing any other workspace", () => {
  useReaderTabs.getState().open(1);
  const rss = useReaderTabs.getState().activeId!;
  activateReadingTab(rss);
  useReadingGroups.getState().openHot(source, item(1));
  const hot = useReadingGroups.getState().active.hot!;
  useReadingGroups.getState().openFile(file(), true);
  closeReadingTabs([useReadingGroups.getState().active.files!]);
  expect(useReadingGroups.getState().active.files).toBeNull();
  expect(useReadingGroups.getState().active.hot).toBe(hot);
  closeReadingTabs([hot]);
  expect(useReadingGroups.getState().active.hot).toBeNull();
  expect(useReaderTabs.getState().activeId).toBe(rss);
});
it("close others activates the retained local background tab and validation does not add closed history", () => {
  useReadingGroups.getState().openHot(source, item(1));
  const hot = useReadingGroups.getState().active.hot;
  useReadingGroups.getState().openFile(file(1), true);
  useReadingGroups.getState().openFile(file(), true, true);
  const fileId = useReadingGroups.getState().tabs.find(t => t.group === "files" && t.item.articleId === file().articleId)!.id;
  closeReadingTabs(tabCloseTargets(fileId, "others"));
  expect(useReadingGroups.getState().active.files).toBe(fileId);
  expect(useReadingGroups.getState().active.hot).toBe(hot);
  closeReadingTabs([fileId], false);
  expect(useReadingGroups.getState().active.files).toBeNull();
  expect(useReadingGroups.getState().closed).toHaveLength(1);
});
it("close-all affects only the target workspace, including when others were more recently used", () => {
  useReaderTabs.getState().open(1); activateReadingTab(useReaderTabs.getState().activeId!);
  useReaderTabs.getState().open(2);
  const rss2 = useReaderTabs.getState().activeId!;
  useReadingGroups.getState().openHot(source, item(1));
  const hot = useReadingGroups.getState().active.hot!;
  activateReadingTab(rss2);
  closeReadingTabs(tabCloseTargets(rss2, "all"));
  expect(useReaderTabs.getState().tabs).toHaveLength(0);
  expect(useReaderTabs.getState().activeId).toBeNull();
  expect(useReadingGroups.getState().active.hot).toBe(hot);
  expect(readingTabsFor("hot")).toHaveLength(1);
});
it("keeps 20 run-local closed records per workspace, including legacy RSS closes", () => {
  for (let n = 1; n <= 24; n++) { useReaderTabs.getState().open(n); useReaderTabs.getState().close([useReaderTabs.getState().activeId!]); }
  expect(useReadingGroups.getState().closed).toHaveLength(20);
  for (let n = 1; n <= 24; n++) { useReadingGroups.getState().openHot(source, item(n)); closeReadingTabs([useReadingGroups.getState().active.hot!]); }
  expect(useReadingGroups.getState().closed).toHaveLength(40);
  for (let n = 0; n < 22; n++) reopenReadingTab("rss");
  expect(useReaderTabs.getState().tabs.map(t => t.articleId)).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i));
  expect(useReadingGroups.getState().closed).toHaveLength(20);
  expect(readingTabsFor("hot")).toHaveLength(0);
  expect(serializeGroupSession(useReadingGroups.getState())).not.toContain('"closed"');
});
it("cycles only within the selected workspace and wraps in both directions", () => {
  useReaderTabs.getState().open(1);
  useReaderTabs.getState().open(2);
  const rssIds = useReaderTabs.getState().tabs.map(tab => tab.id);
  useReadingGroups.getState().openFile(file(), true, true);
  useReadingGroups.getState().openHot(source, item(1), null, true);
  cycleReadingTabs("rss", 1); expect(useReaderTabs.getState().activeId).toBe(rssIds[0]);
  cycleReadingTabs("rss", -1); expect(useReaderTabs.getState().activeId).toBe(rssIds[1]);
  expect(useReadingGroups.getState().active).toEqual({ files: null, hot: null });
  cycleReadingTabs("files", 1); expect(useReadingGroups.getState().active.files).not.toBeNull();
  expect(useReadingGroups.getState().active.hot).toBeNull();
  expect(useReaderTabs.getState().activeId).toBe(rssIds[1]);
});
it("capture locks cross-group activation, foreground/background opens, restore and atomic bulk close", () => {
  useReaderTabs.getState().open(1); useReadingGroups.getState().openFile(file(), true);
  const id = useReaderTabs.getState().activeId!; useReaderTabs.getState().setCapture(id);
  const before = groupedReadingTabs();
  useReadingGroups.getState().openHot(source, item(1)); activateReadingTab(before[1].id);
  closeReadingTabs(before.map(t => t.id)); reopenReadingTab("files");
  expect(groupedReadingTabs()).toEqual(before);
  expect(readingTabsFor("hot")).toHaveLength(0);
});
it("restores independent sessions and scroll, ignoring obsolete folding state and credentials", () => {
  useReadingGroups.getState().openFile(file(), true);
  const id = useReadingGroups.getState().active.files!;
  useReadingGroups.getState().update(id, { markdownDisplay: "source", markdownSourceScroll: 72, outline: false });
  useReadingGroups.getState().openHot({ ...source, token: "do-not-save" } as HotSource, item(1), null, false, "web");
  const serialized = serializeGroupSession(useReadingGroups.getState());
  expect(serialized).not.toMatch(/do-not-save|auth_kind|auth_url/);
  const restored = restoreGroupSession(JSON.stringify({ ...JSON.parse(serialized), collapsed: { rss: true, files: true, hot: true } }));
  expect(restored.tabs.map(t => t.group)).toEqual(["files", "hot"]);
  expect(restored.tabs[0].id).not.toBe(id);
  expect(restored.tabs[0].reading).toMatchObject({ markdownDisplay: "source", markdownSourceScroll: 72, outline: false });
  expect(restored.active.files).toBe(restored.tabs[0].id);
  expect(serializeGroupSession(restored)).not.toContain('"collapsed"');
});
it("ignores malformed sessions, duplicate identities and unsafe native URLs", () => {
  expect(restoreGroupSession("broken").tabs).toEqual([]);
  useReadingGroups.getState().openHot(source, item(1));
  const data = JSON.parse(serializeGroupSession(useReadingGroups.getState()));
  data.tabs.push(data.tabs[0], { ...data.tabs[0], item: { ...item(2), url: "javascript:alert(1)" } });
  data.tabs[0].reading = { webUrl: "https://secret:pass@example.invalid", zoom: 999, rssScroll: -9 };
  const restored = restoreGroupSession(JSON.stringify(data));
  expect(restored.tabs).toHaveLength(1);
  expect(restored.tabs[0].reading).toMatchObject({ webUrl: null, zoom: 3, rssScroll: 0 });
});
