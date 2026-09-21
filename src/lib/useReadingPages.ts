import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import { enqueuePageView } from "./pageViewQueue";
import { acceptReaderPageEvent, forgetReaderPage } from "./readerPageSession";
import { isPageViewStatusEvent, safePageViewUrl } from "./pageViewState";
import { isPageViewZoomEvent } from "./pageViewZoom";
import { useReaderTabs, type ReadingState } from "./readerTabs";
import { useReadingGroups } from "./readingGroups";

/** One application-level observer. Hidden readers must still save URL/zoom;
 * closure retires the identity before a slow, queued native open completes. */
export function useReadingPages() {
  useEffect(() => {
    const update = (id: string, patch: Partial<ReadingState>) => {
      if (id.startsWith("rss-")) useReaderTabs.getState().update(id, patch);
      else useReadingGroups.getState().update(id, patch);
    };
    const retired = (id: string) => {
      forgetReaderPage(id);
      useReadingGroups.setState(s => { const loading = { ...s.loading }; delete loading[id]; return { loading }; });
    };
    const cleanup = (next: { tabs: { id: string }[] }, prev: { tabs: { id: string }[] }) => {
      const remaining = new Set(next.tabs.map(t => t.id));
      for (const tab of prev.tabs) if (!remaining.has(tab.id)) {
        retired(tab.id);
        if (tab.id.startsWith("rss-") || tab.id.startsWith("hot-")) void enqueuePageView(() => api.closePageView(tab.id)).catch(() => {});
      }
    };
    const stopRss = useReaderTabs.subscribe(cleanup);
    const stopContent = useReadingGroups.subscribe(cleanup);
    const status = listen("page-view-status", ({ payload }) => {
      if (!isPageViewStatusEvent(payload) || !acceptReaderPageEvent(payload) || !["loading", "loaded"].includes(payload.phase)) return;
      const url = safePageViewUrl(payload.url);
      if (url) update(payload.viewId!, { webUrl: url });
      useReadingGroups.getState().setLoading(payload.viewId!, payload.phase === "loading");
    });
    const zoom = listen("page-view-zoom", ({ payload }) => {
      if (isPageViewZoomEvent(payload) && acceptReaderPageEvent(payload)) update(payload.viewId!, { zoom: payload.factor, zoomMode: payload.mode });
    });
    const evicted = listen<{ viewId: string; requestId: string; instance: number; url: string; factor: number; mode: "fit" | "manual" }>("page-view-evicted", ({ payload }) => {
      if (!payload || !acceptReaderPageEvent(payload)) return;
      const url = safePageViewUrl(payload.url);
      if (url && isPageViewZoomEvent(payload)) update(payload.viewId, { webUrl: url, zoom: payload.factor, zoomMode: payload.mode });
      retired(payload.viewId);
    });
    return () => { stopRss(); stopContent(); for (const pending of [status, zoom, evicted]) void pending.then(stop => stop()).catch(() => {}); };
  }, []);
}
