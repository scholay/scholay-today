import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReaderTabs } from "../lib/readerTabs";
import { useReadingPages } from "../lib/useReadingPages";
import * as api from "../api";
import Reader from "./Reader";
import WorkspaceReadingTabs from "./WorkspaceReadingTabs";

export default function ReaderWorkspace({ active, onToast, onCaptureBusyChange }: { active: boolean; onToast: (message: string) => void; onCaptureBusyChange?: (busy: boolean) => void }) {
  const tabs = useReaderTabs(s => s.tabs);
  const activeId = useReaderTabs(s => s.activeId);
  const qc = useQueryClient();
  const tab = tabs.find(item => item.id === activeId) ?? null;
  // RSS remains mounted for the app lifetime, including in other workspaces.
  useReadingPages();
  useEffect(() => {
    // Validate restored metadata with bounded local reads. Only explicit
    // NotFound prunes a tab; transient database failures retain the session.
    let stopped = false;
    const queue = [...useReaderTabs.getState().tabs];
    const load = async () => {
      while (!stopped && queue.length) {
        const item = queue.shift()!;
        try {
          const article = await qc.fetchQuery({ queryKey: ["article", item.articleId], queryFn: () => api.getArticle(item.articleId) });
          if (!stopped) useReaderTabs.getState().metadata(item.id, article.title, article.feedId);
        } catch (error) {
          if (!stopped && typeof error === "object" && error !== null && "code" in error && error.code === "articleNotFound") useReaderTabs.getState().close([item.id], false);
        }
      }
    };
    void Promise.all([load(), load(), load()]);
    return () => { stopped = true; };
  }, [qc]);
  return <div className="reader-workspace">
    <WorkspaceReadingTabs group="rss" active={active}/>
    <div id="reading-panel-rss" className="reading-tab-panel" role="tabpanel" aria-label={tab?.title || "RSS 阅读区"} aria-labelledby={tab ? `reading-tab-rss-${tab.id}` : undefined}
      onPointerDown={() => { if (active && tab?.restored) useReaderTabs.getState().activate(tab.id); }} onWheel={() => { if (active && tab?.restored) useReaderTabs.getState().activate(tab.id); }}>
      <Reader key={tab?.id ?? "empty"} tab={tab} active={active} onToast={onToast} onCaptureBusyChange={value => { useReaderTabs.getState().setCapture(value ? tab?.id ?? null : null); onCaptureBusyChange?.(value); }}/>
    </div>
  </div>;
}
