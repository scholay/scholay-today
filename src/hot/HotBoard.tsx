import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import Icon from "../components/Icon";
import BoardResizeHandles from "../components/BoardResizeHandles";
import { useBoardPanes } from "../hooks/useBoardPanes";
import { isMac } from "../lib/platform";
import { safePageViewUrl } from "../lib/pageViewState";
import { getHotSnapshot, listHotSources } from "./api";
import { HOT_FILTERS, HOT_POLL_MS, HOT_UI_KEY, hotError, hotTime, matchesHotFilter, matchesHotSearch, parseHotUi, sortHotSources, toggleHotFavorite } from "./helpers";
import type { HotItem, HotSnapshot, HotSource, HotUiState } from "./types";
import HotTabReader from "./HotTabReader";
import WorkspaceReadingTabs from "../components/WorkspaceReadingTabs";
import { useReadingGroups, type HotTab } from "../lib/readingGroups";
import { useReaderTabs } from "../lib/readerTabs";
import { useUi } from "../store";
import { hasBlockingOverlay } from "../lib/useBlockingOverlay";
import SourceAuthorization from "./SourceAuthorization";
import "./hot.css";

const kindLabel = { hot: "热榜", latest: "最新", daily: "每日" };
const snapshotKey = (id: string) => ["hot", "snapshot", id] as const;

function SnapshotStatus({ source, snapshot, loading, error, onRefresh }: { source: HotSource; snapshot?: HotSnapshot; loading: boolean; error: unknown; onRefresh: () => void }) {
  const failure = snapshot?.error || (error ? hotError(error) : null);
  return <div className={`hot-snapshot-status ${failure ? "has-error" : ""}`}>
    <span title={failure ?? (snapshot?.fetched_at ? `成功获取于 ${snapshot.fetched_at}` : "尚无本地快照")}>
      {loading ? <><span className="hot-spinner"/>更新中</> : failure ? <><Icon name="alert" size={12}/>{snapshot?.items.length ? "更新失败 · 保留缓存" : "暂时不可用"}</> : snapshot?.fetched_at ? <>{snapshot.stale ? "旧缓存 · " : ""}{hotTime(snapshot.fetched_at)}</> : "尚未获取"}
    </span>
    <button className="hot-icon-button" disabled={loading} onClick={onRefresh} aria-label={`刷新${source.name}`} title={failure ? `${failure}\n上次尝试：${hotTime(snapshot?.last_attempt_at ?? null)}` : "刷新此来源"}><Icon name="refresh" size={13}/></button>
  </div>;
}

export default function HotBoard({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const [ui, setUi] = useState<HotUiState>(() => {
    try { return parseHotUi(localStorage.getItem(HOT_UI_KEY)); } catch { return parseHotUi(null); }
  });
  const tabs = useReadingGroups(s => s.tabs);
  const activeId = useReadingGroups(s => s.active.hot);
  const selectedTab = tabs.find((tab): tab is HotTab => tab.group === "hot" && tab.id === activeId);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const previousActivity = useRef({ active, paused: ui.paused });
  const sourcesQuery = useQuery({ queryKey: ["hot", "sources"], queryFn: listHotSources, enabled: active, staleTime: Infinity, retry: 0 });
  const sources = sourcesQuery.data ?? [];
  const orderedSources = useMemo(() => sortHotSources(sources, ui.favorites), [sources, ui.favorites]);
  const filteredSources = orderedSources.filter((source) => matchesHotFilter(source, ui.filter) && (!ui.favoritesOnly || ui.favorites.includes(source.id)));
  const selectedSource = ui.view === "source" ? sources.find((source) => source.id === ui.sourceId) : undefined;
  const panes = useBoardPanes("hotboard", !ui.readerHidden, active);
  const requestedSources = selectedSource ? [selectedSource] : filteredSources;
  const snapshots = useQueries({ queries: requestedSources.map((source) => ({
    queryKey: snapshotKey(source.id),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const cached = await getHotSnapshot(source.id, false, signal);
      if (!signal.aborted && cached.items.length > 0) qc.setQueryData(snapshotKey(source.id), cached);
      // Poll cache age before asking the backend to fetch. Daily sources must
      // not be force-refreshed merely because the foreground timer ticked.
      return !ui.paused && (cached.stale || cached.status === "never")
        ? getHotSnapshot(source.id, true, signal) : cached;
    },
    enabled: active, staleTime: Infinity, retry: 0,
    refetchInterval: active && !ui.paused ? HOT_POLL_MS : false as const,
    refetchIntervalInBackground: false,
  })) });
  const bySource = new Map<string, UseQueryResult<HotSnapshot>>(requestedSources.map((source, index) => [source.id, snapshots[index]]));

  useEffect(() => {
    try { localStorage.setItem(HOT_UI_KEY, JSON.stringify(ui)); } catch { /* Read-only storage must not break browsing. */ }
  }, [ui]);
  useEffect(() => {
    const previous = previousActivity.current;
    if (!active || (ui.paused && !previous.paused)) void qc.cancelQueries({ queryKey: ["hot", "snapshot"] });
    else if (!previous.active || (previous.paused && !ui.paused)) {
      // Re-entering the foreground or resuming should check cache age now,
      // not wait another ten minutes. This invokes the cache-first queryFn.
      void qc.invalidateQueries({ queryKey: ["hot", "snapshot"], refetchType: "active" });
    }
    if (!active) setAuthorizationOpen(false);
    previousActivity.current = { active, paused: ui.paused };
  }, [active, ui.paused, qc]);

  const patchUi = (patch: Partial<HotUiState>) => setUi((current) => ({ ...current, ...patch }));
  const favorite = (id: string) => setUi((current) => ({ ...current, favorites: toggleHotFavorite(current.favorites, id) }));
  const showOverview = () => { setAuthorizationOpen(false); patchUi({ view: "overview", sourceId: null, itemId: null }); };
  const showSource = (source: HotSource) => {
    setAuthorizationOpen(false);
    patchUi({ sourceId: source.id, view: "source" });
  };
  const openItem = (source: HotSource, item: HotItem, background = false) => {
    if (!background) { setAuthorizationOpen(false); patchUi({ readerHidden: false }); }
    useReadingGroups.getState().openHot(source, item, bySource.get(source.id)?.data?.fetched_at, background);
  };
  const refreshSource = async (source: HotSource) => {
    if (!active) return;
    try {
      await qc.fetchQuery({ queryKey: snapshotKey(source.id), queryFn: ({ signal }) => getHotSnapshot(source.id, true, signal), staleTime: 0, retry: 0 });
    } catch { /* Each source owns its error; successful cards stay visible. */ }
  };
  const refreshVisible = () => { for (const source of requestedSources) void refreshSource(source); };
  const selectedResult = selectedSource ? bySource.get(selectedSource.id) : undefined;
  const selectedSnapshot = selectedResult?.data;
  const selectedItem = selectedTab?.source.id === selectedSource?.id ? selectedTab?.item : undefined;
  const selectedItems = selectedSnapshot?.items.filter((item) => matchesHotSearch(item, ui.search)) ?? [];
  const refreshing = snapshots.some((query) => query.isFetching);
  const matchingCards = filteredSources.filter((source) => !ui.search.trim() || bySource.get(source.id)?.data?.items.some((item) => matchesHotSearch(item, ui.search)));

  useEffect(() => {
    if (!active || !selectedSource) return;
    const key = (event: KeyboardEvent) => {
      const state = useUi.getState();
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || state.modalOpen || state.menuOpen || state.aiOpen || hasBlockingOverlay() || useReaderTabs.getState().captureTabId || authorizationOpen) return;
      if ((event.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      if (!["j", "k"].includes(event.key) || !selectedItems.length) return;
      const index = selectedItems.findIndex(item => item.id === selectedItem?.id);
      const next = index < 0 ? event.key === "j" ? 0 : selectedItems.length - 1 : Math.min(selectedItems.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)));
      event.preventDefault(); patchUi({ readerHidden: false }); useReadingGroups.getState().openHot(selectedSource, selectedItems[next], selectedSnapshot?.fetched_at);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, selectedSource, selectedItems, selectedItem?.id, selectedSnapshot?.fetched_at, authorizationOpen]);
  useEffect(() => { setAuthorizationOpen(false); }, [activeId]);

  return <section ref={panes.hostRef} style={panes.style} className={`hot-workspace hot-tabbed-workspace ${ui.readerHidden ? "is-reader-hidden" : ""} ${selectedSource ? "is-source" : "is-overview"}`} aria-label="独立热榜工作区">
    <aside className="hot-sidebar" aria-label="热榜来源">
      {isMac && <div className="titlebar" data-tauri-drag-region />}
      <nav className="hot-main-nav">
        <button className={!selectedSource && !ui.favoritesOnly ? "is-active" : ""} onClick={() => { showOverview(); patchUi({ favoritesOnly: false }); }}><Icon name="grid" size={15}/>概览<span>{sources.length}</span></button>
        <button className={ui.favoritesOnly ? "is-active" : ""} onClick={() => { showOverview(); patchUi({ favoritesOnly: !ui.favoritesOnly }); }}><Icon name="star" size={15}/>关注<span>{ui.favorites.length}</span></button>
      </nav>
      <div className="hot-section-label">来源</div>
      <div className="hot-source-nav">
        {filteredSources.map((source) => <button key={source.id} className={selectedSource?.id === source.id ? "is-active" : ""} onClick={() => showSource(source)} title={source.description}><Icon name={ui.favorites.includes(source.id) ? "star-fill" : "globe"} size={14}/><span>{source.name}</span><small>{kindLabel[source.kind]}</small></button>)}
        {!sourcesQuery.isPending && filteredSources.length === 0 && <p className="hot-nav-empty">{ui.favoritesOnly ? "在来源卡片上点击星标" : "此分类暂无来源"}</p>}
      </div>
      <div className="hot-sidebar-foot">独立本地缓存 · 不进入 RSS 或 AI</div>
    </aside>

    <header className="hot-workspace-toolbar" data-tauri-drag-region>
      <div className="hot-breadcrumb"><button onClick={showOverview}>概览</button>{selectedSource && <><Icon name="chevron-right" size={12}/><strong title={selectedSource.name}>{selectedSource.name}</strong></>}</div>
      <label className="hot-search"><Icon name="search" size={14}/><input aria-label="搜索热榜本地缓存" placeholder="搜索本地缓存" value={ui.search} onChange={(event) => patchUi({ search: event.target.value })}/>{ui.search && <button className="hot-icon-button" aria-label="清除热榜搜索" onClick={() => patchUi({ search: "" })}><Icon name="x" size={13}/></button>}</label>
      <button className={`hot-icon-button ${ui.paused ? "is-active" : ""}`} onClick={() => patchUi({ paused: !ui.paused })} aria-pressed={ui.paused} title={ui.paused ? "已暂停自动更新；点击恢复" : "前台每 10 分钟检查更新；点击暂停"} aria-label={ui.paused ? "恢复热榜自动更新" : "暂停热榜自动更新"}><Icon name={ui.paused ? "play" : "pause"} size={15}/></button>
      <button className={`hot-icon-button ${refreshing ? "is-spinning" : ""}`} disabled={refreshing || requestedSources.length === 0} onClick={refreshVisible} title="刷新当前来源" aria-label="刷新当前热榜"><Icon name="refresh" size={15}/></button>
      <button className="hot-reader-toggle" aria-expanded={!ui.readerHidden} aria-controls="hot-reading-area" onClick={() => { setAuthorizationOpen(false); patchUi({ readerHidden: !ui.readerHidden }); }} title={ui.readerHidden ? "展开阅读区，恢复之前的标签" : "收起阅读区，铺满热榜清单"}><Icon name="panel-left" size={15}/><span>{ui.readerHidden ? "展开阅读区" : "收起阅读区"}</span></button>
    </header>

    {!selectedSource ? <main className="hot-overview">
      <div className="hot-overview-heading"><h1>{ui.favoritesOnly ? "关注的热榜" : "今日热榜"}<span>{matchingCards.length} 个来源</span></h1><div className="hot-card-limit" aria-label="每个来源显示条数"><button className={ui.cardLimit === 5 ? "is-active" : ""} onClick={() => patchUi({ cardLimit: 5 })}>Top 5</button><button className={ui.cardLimit === 8 ? "is-active" : ""} onClick={() => patchUi({ cardLimit: 8 })}>Top 8</button></div></div>
      <nav className="hot-filters" aria-label="热榜分类">{HOT_FILTERS.map((filter) => <button key={filter.id} className={ui.filter === filter.id ? "is-active" : ""} aria-pressed={ui.filter === filter.id} onClick={() => patchUi({ filter: filter.id })}>{filter.label}</button>)}<span>{ui.paused ? "自动更新已暂停" : "前台每 10 分钟检查"}</span></nav>
      {sourcesQuery.isPending ? <div className="hot-empty">正在读取来源…</div> : sourcesQuery.isError ? <div className="hot-empty"><p>{hotError(sourcesQuery.error)}</p><button className="hot-action" onClick={() => void sourcesQuery.refetch()}>重试</button></div> : matchingCards.length === 0 ? <div className="hot-empty"><Icon name={ui.search ? "search" : "grid"} size={24}/><p>{ui.search ? "本地缓存中没有匹配结果" : ui.favoritesOnly ? "还没有关注来源" : "此分类暂无可用来源"}</p>{ui.search && <small>搜索不会向站点发送关键词</small>}</div> : <div className="hot-cards">
        {matchingCards.map((source) => {
          const query = bySource.get(source.id);
          const snapshot = query?.data;
          const items = snapshot?.items.filter((item) => matchesHotSearch(item, ui.search)).slice(0, ui.cardLimit) ?? [];
          return <section className="hot-card" key={source.id} aria-label={`${source.name}榜单`}>
            <header><button className="hot-card-title" onClick={() => showSource(source)}><span className="hot-source-mark">{source.name.slice(0, 1)}</span><span><strong>{source.name}</strong><small>{source.region === "china" ? "国内" : "海外"} · {kindLabel[source.kind]}</small></span></button><button className={`hot-icon-button ${ui.favorites.includes(source.id) ? "is-active" : ""}`} onClick={() => favorite(source.id)} aria-pressed={ui.favorites.includes(source.id)} aria-label={`${ui.favorites.includes(source.id) ? "取消关注" : "关注"}${source.name}`}><Icon name={ui.favorites.includes(source.id) ? "star-fill" : "star"} size={15}/></button></header>
            <ol className="hot-card-items">{items.map((item) => <li key={item.id}><button onClick={event => openItem(source, item, event.ctrlKey || event.metaKey)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openItem(source, item, true); } }}><span className={`hot-rank ${item.rank <= 3 ? "is-top" : ""}`}>{item.rank}</span><span className="hot-item-title">{item.title}</span>{item.heat && <small title={item.heat}>{item.heat}</small>}</button></li>)}</ol>
            {items.length === 0 && <div className="hot-card-empty">{query?.isFetching ? "正在获取榜单…" : snapshot?.status === "never" ? "尚无缓存，点击刷新获取" : snapshot?.status === "error" || query?.isError ? "此来源暂时不可用" : "暂无条目"}</div>}
            <footer><SnapshotStatus source={source} snapshot={snapshot} loading={query?.isFetching ?? false} error={query?.error} onRefresh={() => void refreshSource(source)}/><button className="hot-more" onClick={() => showSource(source)}>查看全部<Icon name="chevron-right" size={12}/></button></footer>
          </section>;
        })}
      </div>}
    </main> : <>
      <section className="hot-ranking" aria-label={`${selectedSource.name}完整榜单`}>
        <div className="hot-ranking-header"><div><h1>{selectedSource.name}</h1><p>{kindLabel[selectedSource.kind]} · {selectedSnapshot?.items.length ?? 0} 条</p></div><button className={`hot-icon-button ${ui.favorites.includes(selectedSource.id) ? "is-active" : ""}`} aria-label={`${ui.favorites.includes(selectedSource.id) ? "取消关注" : "关注"}${selectedSource.name}`} aria-pressed={ui.favorites.includes(selectedSource.id)} onClick={() => favorite(selectedSource.id)}><Icon name={ui.favorites.includes(selectedSource.id) ? "star-fill" : "star"} size={16}/></button></div>
        <SnapshotStatus source={selectedSource} snapshot={selectedSnapshot} loading={selectedResult?.isFetching ?? false} error={selectedResult?.error} onRefresh={() => void refreshSource(selectedSource)}/>
        <button className="hot-source-access" onClick={() => { patchUi({ readerHidden: false }); setAuthorizationOpen(true); }}><Icon name="globe" size={13}/>登录 / 授权</button>
        <div className="hot-ranking-scroll">{selectedItems.map((item) => <button key={item.id} className={`hot-ranking-item ${selectedItem?.id === item.id ? "is-selected" : ""}`} onClick={event => openItem(selectedSource, item, event.ctrlKey || event.metaKey)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openItem(selectedSource, item, true); } }} aria-current={selectedItem?.id === item.id ? "true" : undefined}><span className={`hot-rank ${item.rank <= 3 ? "is-top" : ""}`}>{item.rank}</span><span><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}<small>{item.heat || kindLabel[selectedSource.kind]}{item.published_at && ` · ${hotTime(item.published_at)}`}</small></span></button>)}{selectedItems.length === 0 && <div className="hot-empty"><p>{selectedResult?.isFetching ? "正在获取榜单…" : ui.search ? "没有匹配的缓存条目" : "暂无可显示的条目"}</p></div>}</div>
      </section>
    </>}
    {!ui.readerHidden && <section id="hot-reading-area" className="hot-detail" aria-label="热榜条目详情">
      <WorkspaceReadingTabs group="hot" active={active}/>
      <div id="reading-panel-hot" className="hot-tab-panel" role="tabpanel" aria-label={selectedTab?.title || "热榜阅读区"} aria-labelledby={selectedTab ? `reading-tab-hot-${selectedTab.id}` : undefined}>
        {authorizationOpen && selectedSource ? <div className="hot-detail-scroll"><SourceAuthorization key={selectedSource.id} source={selectedSource} onClose={() => setAuthorizationOpen(false)} onRefresh={() => void refreshSource(selectedSource)} onBrowse={target => {
          const url = safePageViewUrl(target);
          if (!url) return;
          useReadingGroups.getState().openHot(selectedSource, { id: url, title: `${selectedSource.name} · 来源网页`, url, rank: 0, description: selectedSource.description, heat: null, published_at: null }, null, false, "web");
          setAuthorizationOpen(false);
        }}/></div> : selectedTab ? <HotTabReader key={selectedTab.id} tab={selectedTab} active={active}/>
          : <div className="reading-workspace-empty"><Icon name="globe" size={28}/><h2>打开一条热榜，接着读</h2><p>点击左侧条目打开标签。切换来源不会关闭已打开的内容。</p></div>}
      </div>
    </section>}
    {active && <BoardResizeHandles panes={panes} hasList={!ui.readerHidden} label="热榜" visible/>}
  </section>;
}
