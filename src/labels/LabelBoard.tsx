import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon from "../components/Icon";
import BoardResizeHandles from "../components/BoardResizeHandles";
import { useBoardPanes } from "../hooks/useBoardPanes";
import LabelAuthorization from "./LabelAuthorization";
import LabelTimeline from "./LabelTimeline";
import LabelInsights from "./LabelInsights";
import { LABEL_AUTH_TEXT, LABEL_CACHE_KEY, LABEL_SOURCES, LABEL_UI_KEY, credentialText, parseLabelCache, parseLabelUi, type CredentialStatus, type LabelProbe } from "./helpers";
import { latestLabelCaptures, makeCapture, migrateLabelCache, saveLabelCaptures } from "./history";
import { EDITION_MS, editionStart, groupEditions } from "./editions";
import { useLabelEditions } from "./useLabelEditions";
import "../hot/hot.css";
import "./labels.css";

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
type State = { message: string; loading?: boolean; success?: boolean };

/** Platforms -> capture time -> grouped tags. Websites are authorization
 * surfaces only; history contains public ranking fields, never credentials. */
export default function LabelBoard({ active }: { active: boolean }) {
  const panes = useBoardPanes("labels", true, active);
  const [ui, setUi] = useState(() => parseLabelUi(read(LABEL_UI_KEY)));
  const [snapshots, setSnapshots] = useState(() => parseLabelCache(read(LABEL_CACHE_KEY)));
  const [states, setStates] = useState<Record<string, State>>({});
  const [credentials, setCredentials] = useState<Record<string, CredentialStatus>>({});
  const [authId, setAuthId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [authRevision, setAuthRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [historyReady, setHistoryReady] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [periodTick, setPeriodTick] = useState(0);
  const [selection, setSelection] = useState("latest");
  const cached = useRef(snapshots);
  cached.current = snapshots;
  const previousRefresh = useRef(refresh);
  const owner = useRef(0);
  const source = LABEL_SOURCES.find(item => item.id === ui.sourceId);
  const authSource = LABEL_SOURCES.find(item => item.id === authId);
  const patch = (value: Partial<typeof ui>) => setUi(old => ({ ...old, ...value }));
  const count = Object.values(snapshots).reduce((sum, snapshot) => sum + snapshot.rows.length, 0);
  const collecting = Object.values(states).some(state => state.loading);
  const history = useLabelEditions(ui.sourceId, active, historyReady, historyRevision);

  useEffect(() => { try { localStorage.setItem(LABEL_UI_KEY, JSON.stringify({ sourceId: ui.sourceId })); } catch { /* Preference is optional. */ } }, [ui.sourceId]);
  // Retain the small legacy latest-only cache as a fallback. IndexedDB is the
  // append-only history, avoiding localStorage quota and RSS schema changes.
  useEffect(() => { try { localStorage.setItem(LABEL_CACHE_KEY, JSON.stringify(snapshots)); } catch { /* Historical writes report their own errors. */ } }, [snapshots]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await migrateLabelCache(cached.current);
        const saved = await latestLabelCaptures();
        if (!cancelled) setSnapshots(old => ({ ...old, ...saved }));
      } catch { if (!cancelled) setNotice("历史库暂不可用；最近缓存仍可查看，请重开应用重试。"); }
      finally { if (!cancelled) { setHistoryReady(true); setHistoryRevision(value => value + 1); } }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    for (const item of LABEL_SOURCES) void invoke<CredentialStatus>("get_label_credential_status", { sourceId: item.id }).then(status => {
      if (!cancelled) setCredentials(old => ({ ...old, [item.id]: status }));
    }).catch(() => { /* Auth management provides actionable storage errors. */ });
    return () => { cancelled = true; };
  }, [active, authRevision]);

  useEffect(() => {
    const revision = ++owner.current;
    let cancelled = false;
    const current = () => !cancelled && revision === owner.current;
    const force = previousRefresh.current !== refresh;
    previousRefresh.current = refresh;
    setStates(old => Object.fromEntries(Object.entries(old).map(([id, state]) => [id, { ...state, loading: false }])));
    const run = async () => {
      await invoke("cancel_label_collection").catch(() => {});
      if (!active || authId || !current() || !historyReady) return;
      const targets = LABEL_SOURCES.filter(item => item.adapter && (ui.sourceId === "all" || item.id === ui.sourceId));
      for (const item of targets) {
        if (!current()) return;
        const last = cached.current[item.id];
        if (!force && last && editionStart(Date.parse(last.capturedAt)) === editionStart(Date.now())) continue;
        setStates(old => ({ ...old, [item.id]: { message: "后台同步中…", loading: true } }));
        try {
          const result = await invoke<LabelProbe>("collect_label_source", { sourceId: item.id });
          if (!current()) return;
          if (result.rows.length) {
            const safe = makeCapture(item.id, { rows: result.rows, period: result.period, capturedAt: new Date().toISOString() });
            if (!safe) throw new Error("invalid");
            // Preserve every successful observation, even if the ranking did
            // not change. A failed collection never creates an empty snapshot.
            let persisted = true;
            try { await saveLabelCaptures([safe]); } catch { persisted = false; }
            if (!current()) return;
            setSnapshots(old => ({ ...old, [item.id]: safe }));
            setHistoryRevision(value => value + 1);
            if (!persisted) setNotice("本次标签可查看，但历史保存失败；旧快照仍保留，请检查本机存储后重试。");
            setStates(old => ({ ...old, [item.id]: { message: persisted ? "已采集并保存快照" : "已采集 · 历史未保存", success: true } }));
          } else setStates(old => ({ ...old, [item.id]: { message: result.auth === "unknown" ? "未读到榜单 · 可重试或检查平台权限" : LABEL_AUTH_TEXT[result.auth] } }));
        } catch (error) {
          if (current()) setStates(old => ({ ...old, [item.id]: { message: typeof error === "string" ? error : "同步未完成，已保留上次标签" } }));
        }
      }
    };
    void run();
    return () => { cancelled = true; void invoke("cancel_label_collection").catch(() => {}); };
  }, [active, historyReady, ui.sourceId, authId, refresh, periodTick]);
  useEffect(() => {
    if (!active || authId) return;
    const wake = () => { if (document.visibilityState !== "hidden") setPeriodTick(value => value + 1); };
    const timer = window.setTimeout(wake, Math.max(100, editionStart(Date.now()) + EDITION_MS - Date.now() + 100));
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [active, authId, periodTick]);

  const choose = (id: string) => { patch({ sourceId: id, search: "", group: "全部" }); setSelection("latest"); setAuthId(null); setNotice(""); };
  const authorize = (id?: string) => { setAuthId(id ?? source?.id ?? "bilibili"); setNotice(""); };
  const selectTime = (id: string) => { setSelection(id); patch({ group: "全部", search: "" }); setAuthId(null); };
  const copy = async (term: string) => { try { await navigator.clipboard.writeText(term); setNotice("已复制标签文字"); } catch { setNotice("复制未完成，请重试"); } };
  const openOriginal = async (url: string) => { try { await openUrl(url); } catch { setNotice("系统浏览器未能打开来源页面"); } };
  const fallback = useMemo(() => groupEditions(Object.entries(snapshots).filter(([id]) => ui.sourceId === "all" || id === ui.sourceId).flatMap(([id, value]) => { const capture = makeCapture(id, value); return capture ? [capture] : []; })), [snapshots, ui.sourceId]);
  const editions = history.error && !history.editions.length ? fallback : history.editions;
  const edition = selection === "latest" ? editions[0] : editions.find(item => String(item.start) === selection);

  return <section ref={panes.hostRef} style={panes.style} className="hot-workspace is-source label-workspace" aria-label="标签工作区">
    <div className="titlebar" data-tauri-drag-region />
    <aside className="hot-sidebar">
      <div className="label-sidebar-heading"><Icon name="tag" size={15}/><strong>平台</strong></div>
      <nav className="hot-source-nav" aria-label="标签平台">
        <button className={ui.sourceId === "all" ? "is-active" : ""} onClick={() => choose("all")}><Icon name="list" size={17}/><span>全部平台</span><small>{count}</small></button>
        <div className="hot-section-label">平台 · 统一数据视图</div>
        {LABEL_SOURCES.map(item => <button key={item.id} className={item.id === ui.sourceId ? "is-active" : ""} aria-current={item.id === ui.sourceId ? "page" : undefined} onClick={() => choose(item.id)}><span className="label-platform-mark">{item.mark}</span><span>{item.name}</span><small>{states[item.id]?.loading ? "同步中" : snapshots[item.id]?.rows.length ?? (item.adapter ? "待同步" : "待适配")}</small></button>)}
      </nav>
      <div className="hot-sidebar-foot"><button className="label-text-button" onClick={() => authorize()}><Icon name="settings" size={13}/>平台授权管理</button><span>Cookie 保存在系统安全存储<br/>与 RSS、热榜数据分开</span></div>
    </aside>
    <header className="hot-workspace-toolbar">
      <div className="hot-breadcrumb"><strong>{source?.name ?? "全部平台"}</strong></div>
      <span className="label-auth-state" role="status">{collecting ? "后台同步中" : source ? (states[source.id]?.message ?? (snapshots[source.id] ? "本地快照" : source.adapter ? "等待同步" : "结构化适配待完成")) : "按平台与榜单分别展示"}</span>
      <button className="label-login-button" onClick={() => authorize()}>授权管理</button>
      <button className="hot-icon-button" disabled={!active || !historyReady || collecting || !!authId || (source && !source.adapter)} onClick={() => setRefresh(value => value + 1)} aria-label="同步标签并保存快照" title="同步标签并保存快照"><Icon name="refresh" size={14}/></button>
    </header>
    <LabelTimeline editions={editions} selection={selection} loading={history.loading} loadingMore={history.loadingMore} hasMore={history.hasMore} error={history.error} onSelect={selectTime} onMore={() => void history.loadMore()}/>
    <section className="hot-detail label-detail" aria-label="多类标签信息">
      {authSource && active ? <LabelAuthorization key={authSource.id} source={authSource} active={active} onSaved={() => { setAuthRevision(value => value + 1); previousRefresh.current = -1; }} onClose={() => { setAuthId(null); setRefresh(value => value + 1); }}/> : <div className="label-native-detail">
        {notice && <p className="label-notice" role="status">{notice}</p>}
        {source && !source.adapter && <p className="label-notice">{source.access}</p>}
        <LabelInsights captures={edition?.captures ?? []} loading={history.loading}
          onCopy={term => void copy(term)} onOriginal={url => void openOriginal(url)}/>
        {source && <div className="label-detail-auth"><span>{credentialText(credentials[source.id])}</span><button onClick={() => authorize(source.id)}>管理授权</button></div>}
      </div>}
    </section>
    {active && <BoardResizeHandles panes={panes} hasList label="标签"/>}
  </section>;
}
