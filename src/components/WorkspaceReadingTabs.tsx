import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useReaderTabs } from "../lib/readerTabs";
import { useFormatJobs } from "../lib/formatJobs";
import { useUi } from "../store";
import { hasBlockingOverlay, useBlockingOverlay } from "../lib/useBlockingOverlay";
import { activateReadingTab, activeReadingId, closeReadingTabs, cycleReadingTabs, READING_GROUP_LABELS, reopenReadingTab, tabCloseTargets, useReadingGroups, type GroupedTab, type ReadingGroup } from "../lib/readingGroups";
import * as api from "../api";
import FeedAvatar from "./FeedAvatar";
import Icon from "./Icon";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import "./reader-tabs.css";

/** A single presentation / interaction implementation, placed in each board's
 * reading column. Only the visible board installs the native/DOM shortcuts. */
export default function WorkspaceReadingTabs({ group, active }: { group: ReadingGroup; active: boolean }) {
  const { t } = useTranslation();
  const rss = useReaderTabs(s => s.tabs);
  const rssId = useReaderTabs(s => s.activeId);
  const capture = useReaderTabs(s => s.captureTabId);
  const extra = useReadingGroups(s => s.tabs);
  const ids = useReadingGroups(s => s.active);
  const loading = useReadingGroups(s => s.loading);
  const jobs = useFormatJobs(s => s.jobs);
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds, enabled: active && group === "rss" && rss.length > 0 });
  const modal = useUi(s => s.modalOpen);
  const menu = useUi(s => s.menuOpen);
  const ai = useUi(s => s.aiOpen);
  const overlay = useBlockingOverlay();
  const strip = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ x: number; y: number; id?: string } | null>(null);
  const tabs: GroupedTab[] = group === "rss" ? rss.map(tab => ({ ...tab, group: "rss" })) : extra.filter(tab => tab.group === group);
  const selectedId = group === "rss" ? rssId : ids[group];
  const tabElementId = (id: string) => `reading-tab-${group}-${id}`;
  useEffect(() => {
    if (!active) { setContext(null); return; }
    const revealCurrent = () => {
      const current = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
      current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    revealCurrent();
    if (!strip.current || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(revealCurrent);
    resize.observe(strip.current);
    return () => resize.disconnect();
  }, [active, selectedId, tabs.length]);
  useEffect(() => {
    if (!active) return;
    const enabled = !modal && !menu && !ai && !overlay && !capture;
    void invoke("set_reader_shortcuts", { enabled }).catch(() => {});
    const run = (action: string) => {
      const ui = useUi.getState();
      if (!enabled || ui.modalOpen || ui.menuOpen || ui.aiOpen || hasBlockingOverlay() || useReaderTabs.getState().captureTabId) return;
      if (action === "close") { const id = activeReadingId(group); if (id) closeReadingTabs([id]); }
      if (action === "reopen") reopenReadingTab(group);
      if (action === "next") cycleReadingTabs(group, 1);
      if (action === "previous") cycleReadingTabs(group, -1);
    };
    const key = (event: KeyboardEvent) => {
      if (!enabled || event.defaultPrevented || event.isComposing || event.altKey || hasBlockingOverlay()) return;
      const mod = event.ctrlKey || event.metaKey;
      const action = mod && !event.shiftKey && event.key.toLowerCase() === "w" ? "close"
        : mod && event.shiftKey && event.key.toLowerCase() === "t" ? "reopen"
        : event.ctrlKey && event.key === "Tab" ? event.shiftKey ? "previous" : "next" : null;
      if (action) { event.preventDefault(); event.stopPropagation(); run(action); }
    };
    const pending = listen<string>("reader-tab-shortcut", event => run(event.payload));
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      void pending.then(stop => stop()).catch(() => {});
      void invoke("set_reader_shortcuts", { enabled: false }).catch(() => {});
    };
  }, [active, group, modal, menu, ai, overlay, capture]);

  const activateWithFocus = (id: string) => {
    const target = tabs.find(tab => tab.id === id);
    if (!target) return;
    activateReadingTab(id);
    requestAnimationFrame(() => document.getElementById(tabElementId(id))?.focus());
  };
  const contextItems = (): MenuEntry[] => {
    if (context?.id) return [
      { label: t("readerTabs.close"), onClick: () => closeReadingTabs(tabCloseTargets(context.id!, "close")) },
      { label: t("readerTabs.closeOthers"), onClick: () => closeReadingTabs(tabCloseTargets(context.id!, "others")) },
      { label: t("readerTabs.closeRight"), onClick: () => closeReadingTabs(tabCloseTargets(context.id!, "right")) },
      { separator: true },
      { label: t("readerTabs.closeAll"), onClick: () => closeReadingTabs(tabCloseTargets(context.id!, "all")) },
    ];
    return tabs.map(tab => ({ label: `${tab.id === selectedId ? "✓ " : ""}${tab.title || t("common.loading")}`, onClick: () => activateReadingTab(tab.id) }));
  };
  return <>
    <div className="reader-tabbar workspace-reader-tabbar" aria-label={`${READING_GROUP_LABELS[group]}阅读标签`}>
      <div className="reader-tabs" ref={strip} role="tablist" aria-label={t("readerTabs.label")}>
        {tabs.map(tab => {
              const feed = tab.group === "rss" ? feeds.data?.find(item => item.id === tab.feedId) : undefined;
              const busy = loading[tab.id] || tab.group === "rss" && ["opening", "capturing", "formatting"].includes(jobs[tab.articleId]?.phase);
              return <div key={tab.id} className={`reader-tab${tab.id === selectedId ? " is-active" : ""}`}
                onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeReadingTabs([tab.id]); } }}
                onContextMenu={event => { event.preventDefault(); if (!capture) setContext({ x: event.clientX, y: event.clientY, id: tab.id }); }}>
                <button type="button" role="tab" id={tabElementId(tab.id)} aria-selected={tab.id === selectedId} aria-controls={`reading-panel-${group}`} tabIndex={tab.id === selectedId || (!selectedId && tab.id === tabs[0]?.id) ? 0 : -1} disabled={!!capture} title={tab.title} onClick={() => activateReadingTab(tab.id)}
                  onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const index = tabs.findIndex(item => item.id === tab.id);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                    activateWithFocus(tabs[next].id);
                  }}>
                  {busy ? <span className="reader-web-spinner" aria-label={t("common.loading")}/> : tab.group === "rss" ? <FeedAvatar title={feed?.title ?? tab.title} faviconUrl={feed?.faviconUrl} seed={tab.feedId ?? tab.articleId} style={{ width: 17, height: 17, fontSize: 10 }}/>
                    : <Icon name={tab.group === "files" ? "file" : "globe"} size={15}/>}
                  <span>{tab.title || t("common.loading")}</span>
                </button>
                <button type="button" className="reader-tab-close" disabled={capture === tab.id} aria-label={`${t("readerTabs.close")} ${tab.title}`} title={t("readerTabs.close")} onClick={() => closeReadingTabs([tab.id])}><Icon name="x" size={12}/></button>
              </div>;
        })}
      </div>
      <button type="button" className="reader-tabs-overflow" disabled={!!capture || !tabs.length} aria-label={t("readerTabs.allTabs")} title={t("readerTabs.allTabs")} aria-haspopup="menu" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setContext({ x: rect.right - 260, y: rect.bottom }); }}><Icon name="list" size={15}/></button>
    </div>
    {context && active && <ContextMenu x={context.x} y={context.y} items={contextItems()} onClose={() => setContext(null)}/>}
  </>;
}
