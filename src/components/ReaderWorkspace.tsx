import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useReaderTabs } from "../lib/readerTabs";
import { useUi } from "../store";
import { enqueuePageView } from "../lib/pageViewQueue";
import { acceptReaderPageEvent, forgetReaderPage } from "../lib/readerPageSession";
import { isPageViewStatusEvent, safePageViewUrl } from "../lib/pageViewState";
import { isPageViewZoomEvent } from "../lib/pageViewZoom";
import { useFormatJobs } from "../lib/formatJobs";
import { hasBlockingOverlay, useBlockingOverlay } from "../lib/useBlockingOverlay";
import * as api from "../api";
import Reader from "./Reader";
import FeedAvatar from "./FeedAvatar";
import Icon from "./Icon";
import ContextMenu from "./ContextMenu";
import "./reader-tabs.css";

export default function ReaderWorkspace({ active, onToast, onCaptureBusyChange }: { active: boolean; onToast: (message: string) => void; onCaptureBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const tabs = useReaderTabs(s => s.tabs);
  const activeId = useReaderTabs(s => s.activeId);
  const captureTabId = useReaderTabs(s => s.captureTabId);
  const busy = captureTabId !== null;
  const jobs = useFormatJobs(s => s.jobs);
  const [loadingPages, setLoadingPages] = useState<Record<string, boolean>>({});
  const modal = useUi(s => s.modalOpen);
  const menu = useUi(s => s.menuOpen);
  const overlay = useBlockingOverlay();
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds });
  const strip = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ x: number; y: number; id?: string } | null>(null);
  const tab = tabs.find(item => item.id === activeId) ?? null;

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);
  useEffect(() => { if (!active) setContext(null); }, [active]);
  useEffect(() => {
    return useReaderTabs.subscribe((next, prev) => {
      for (const closed of prev.tabs.filter(item => !next.tabs.some(t => t.id === item.id))) {
        forgetReaderPage(closed.id);
        setLoadingPages(s => { const next = { ...s }; delete next[closed.id]; return next; });
        void enqueuePageView(() => api.closePageView(closed.id)).catch(() => {});
      }
    });
  }, []);
  useEffect(() => {
    const status = listen("page-view-status", ({ payload }) => {
      if (!isPageViewStatusEvent(payload) || !acceptReaderPageEvent(payload) || !["loading", "loaded"].includes(payload.phase)) return;
      const url = safePageViewUrl(payload.url);
      if (url) useReaderTabs.getState().update(payload.viewId!, { webUrl: url });
      setLoadingPages(s => ({ ...s, [payload.viewId!]: payload.phase === "loading" }));
    });
    const zoom = listen("page-view-zoom", ({ payload }) => {
      if (isPageViewZoomEvent(payload) && acceptReaderPageEvent(payload)) useReaderTabs.getState().update(payload.viewId!, { zoom: payload.factor, zoomMode: payload.mode });
    });
    const evicted = listen<{ viewId: string; requestId: string; instance: number; url: string; factor: number; mode: "fit" | "manual" }>("page-view-evicted", ({ payload }) => {
      if (!payload || !acceptReaderPageEvent(payload)) return;
      const url = safePageViewUrl(payload.url);
      if (url && isPageViewZoomEvent(payload)) useReaderTabs.getState().update(payload.viewId, { webUrl: url, zoom: payload.factor, zoomMode: payload.mode });
      forgetReaderPage(payload.viewId);
      setLoadingPages(s => { const next = { ...s }; delete next[payload.viewId]; return next; });
    });
    return () => { for (const pending of [status, zoom, evicted]) void pending.then(fn => fn()).catch(() => {}); };
  }, []);
  useEffect(() => {
    // Validate restored metadata with bounded local reads, retaining tabs on
    // transient errors. Only an explicit NotFound removes a saved article.
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
  useEffect(() => {
    const enabled = active && !modal && !menu && !overlay && !busy;
    void invoke("set_reader_shortcuts", { enabled }).catch(() => {});
    const run = (action: string) => {
      if (!enabled || hasBlockingOverlay()) return;
      const s = useReaderTabs.getState();
      if (action === "close" && s.activeId) s.close([s.activeId]);
      if (action === "reopen") s.reopen();
      if (action === "next") s.cycle(1);
      if (action === "previous") s.cycle(-1);
    };
    const key = (e: KeyboardEvent) => {
      if (!enabled || hasBlockingOverlay() || e.isComposing || e.altKey || e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const action = mod && !e.shiftKey && e.key.toLowerCase() === "w" ? "close"
        : mod && e.shiftKey && e.key.toLowerCase() === "t" ? "reopen"
        : e.ctrlKey && e.key === "Tab" ? e.shiftKey ? "previous" : "next" : null;
      if (action) { e.preventDefault(); e.stopPropagation(); run(action); }
    };
    const listener = listen<string>("reader-tab-shortcut", event => run(event.payload));
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, [active, modal, menu, overlay, busy]);
  const close = (id: string) => useReaderTabs.getState().close([id]);
  return <div className="reader-workspace">
    {tabs.length > 0 && <div className="reader-tabbar">
      <div ref={strip} className="reader-tabs" role="tablist" aria-label={t("readerTabs.label")}>
        {tabs.map(item => {
          const feed = feeds.data?.find(f => f.id === item.feedId);
          return <div className={`reader-tab ${item.id === activeId ? "is-active" : ""}`} key={item.id} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(item.id); } }} onContextMenu={event => { event.preventDefault(); if (!busy) setContext({ x: event.clientX, y: event.clientY, id: item.id }); }}>
            <button type="button" role="tab" id={`tab-${item.id}`} aria-selected={item.id === activeId} aria-controls="reading-tab-panel" tabIndex={item.id === activeId ? 0 : -1} disabled={busy} title={item.title} onClick={() => useReaderTabs.getState().activate(item.id)} onKeyDown={event => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const s = useReaderTabs.getState();
                if (event.key === "Home" || event.key === "End") s.activate(s.tabs[event.key === "Home" ? 0 : s.tabs.length - 1].id);
                else s.cycle(event.key === "ArrowRight" ? 1 : -1);
                requestAnimationFrame(() => document.getElementById(`tab-${useReaderTabs.getState().activeId}`)?.focus());
              }
            }}>
              {loadingPages[item.id] || ["opening", "capturing", "formatting"].includes(jobs[item.articleId]?.phase) ? <span className="reader-web-spinner" aria-label={t("common.loading")}/> : <FeedAvatar title={feed?.title ?? item.title} faviconUrl={feed?.faviconUrl} seed={item.feedId ?? item.articleId} style={{ width: 17, height: 17, fontSize: 10 }}/>}
              <span>{item.title || t("common.loading")}</span>
            </button>
            <button type="button" className="reader-tab-close" disabled={captureTabId === item.id} title={t("readerTabs.close")} aria-label={`${t("readerTabs.close")} ${item.title}`} onClick={() => close(item.id)}><Icon name="x" size={12}/></button>
          </div>;
        })}
      </div>
      <button type="button" className="reader-tabs-overflow" aria-label={t("readerTabs.allTabs")} disabled={busy} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setContext({ x: r.right - 220, y: r.bottom }); }}><Icon name="chevron-down" size={14}/></button>
    </div>}
    {context && <ContextMenu x={context.x} y={context.y} onClose={() => setContext(null)} items={context.id ? [
      { label: t("readerTabs.close"), onClick: () => close(context.id!) },
      { label: t("readerTabs.closeOthers"), onClick: () => useReaderTabs.getState().close(tabs.filter(t => t.id !== context.id).map(t => t.id)) },
      { label: t("readerTabs.closeRight"), onClick: () => useReaderTabs.getState().close(tabs.slice(tabs.findIndex(t => t.id === context.id) + 1).map(t => t.id)) },
      { separator: true },
      { label: t("readerTabs.closeAll"), onClick: () => useReaderTabs.getState().close(tabs.map(t => t.id)) },
    ] : tabs.map(item => ({ label: `${item.id === activeId ? "✓ " : ""}${item.title || t("common.loading")}`, onClick: () => useReaderTabs.getState().activate(item.id) }))}/>}
    <div id="reading-tab-panel" className="reading-tab-panel" role="tabpanel" aria-labelledby={tab ? `tab-${tab.id}` : undefined} onPointerDown={() => { if (active && tab?.restored) useReaderTabs.getState().activate(tab.id); }} onWheel={() => { if (active && tab?.restored) useReaderTabs.getState().activate(tab.id); }}>
      <Reader key={tab?.id ?? "empty"} tab={tab} active={active} onToast={onToast} onCaptureBusyChange={value => { useReaderTabs.getState().setCapture(value ? tab?.id ?? null : null); onCaptureBusyChange?.(value); }}/>
    </div>
  </div>;
}
