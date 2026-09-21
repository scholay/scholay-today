import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import Icon from "../components/Icon";
import { isMac } from "../lib/platform";
import { folderAncestors } from "../lib/folderTree";
import { useBoardPanes } from "../hooks/useBoardPanes";
import BoardResizeHandles from "../components/BoardResizeHandles";
import { cleanedCountForFolder, docsInScope, matchesLibraryQuery, populatedFolders, type LibraryScope } from "./helpers";
import { LIBRARY_EXAMPLES } from "./examples";
import StructuredReader from "./StructuredReader";
import WorkspaceReadingTabs from "../components/WorkspaceReadingTabs";
import { closeReadingTabs, useReadingGroups, type FileTab } from "../lib/readingGroups";
import { useReaderTabs } from "../lib/readerTabs";
import { hasBlockingOverlay } from "../lib/useBlockingOverlay";
import { useUi } from "../store";
import "./library.css";

function formatWhen(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function FilesBoard({ active }: { active: boolean }) {
  const folders = useQuery({ queryKey: ["folders"], queryFn: api.listFolders, enabled: active });
  const docs = useQuery({ queryKey: ["structured-documents"], queryFn: api.listStructuredDocuments, enabled: active });
  const folderList = folders.data ?? [];
  const allDocs = docs.data ?? [];
  const tree = useMemo(() => populatedFolders(allDocs, folderList), [allDocs, folderList]);
  const panes = useBoardPanes("files", true, active);
  const [chosenScope, setScope] = useState<LibraryScope | null>(null);
  const scope = chosenScope ?? (docs.isSuccess && !allDocs.length ? "examples" : "all");
  const [query, setQuery] = useState("");
  const tabs = useReadingGroups(s => s.tabs);
  const fileTabIds = tabs.filter(tab => tab.group === "files").map(tab => tab.id).join(",");
  const activeId = useReadingGroups(s => s.active.files);
  const scoped = useMemo(
    () => (scope === "examples" ? LIBRARY_EXAMPLES.map((example) => example.item) : docsInScope(allDocs, folderList, scope)).filter((doc) => matchesLibraryQuery(doc, query)),
    [allDocs, folderList, scope, query],
  );
  const selectedTab = tabs.find((tab): tab is FileTab => tab.group === "files" && tab.id === activeId);
  const selected = selectedTab?.item ?? null;
  const example = selectedTab?.example ? LIBRARY_EXAMPLES.find(entry => entry.item.articleId === selected?.articleId) : undefined;
  const unfiledCount = allDocs.filter((doc) => doc.folderId == null).length;

  useEffect(() => {
    if (typeof chosenScope === "number" && docs.isSuccess && folders.isSuccess && !tree.some((folder) => folder.id === chosenScope)) setScope("all");
    if (chosenScope === "unfiled" && docs.isSuccess && !unfiledCount) setScope("all");
  }, [chosenScope, tree, docs.isSuccess, folders.isSuccess, unfiledCount]);

  useEffect(() => {
    if (!docs.isSuccess) return;
    const current = useReadingGroups.getState().tabs;
    const missing = current.filter(tab => tab.group === "files" && !(tab.example ? LIBRARY_EXAMPLES.some(entry => entry.item.articleId === tab.item.articleId) : allDocs.some(item => item.articleId === tab.item.articleId)));
    if (missing.length) closeReadingTabs(missing.map(tab => tab.id), false);
    useReadingGroups.setState(state => ({ tabs: state.tabs.map(tab => {
      if (tab.group !== "files" || tab.example) return tab;
      const item = allDocs.find(item => item.articleId === tab.item.articleId);
      return item && item !== tab.item ? { ...tab, item, title: item.title } : tab;
    }) }));
  }, [docs.data, docs.isSuccess, fileTabIds]);
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      const ui = useUi.getState();
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || ui.modalOpen || ui.menuOpen || ui.aiOpen || hasBlockingOverlay() || useReaderTabs.getState().captureTabId) return;
      if ((event.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      if (!["j", "k"].includes(event.key) || !scoped.length) return;
      const index = scoped.findIndex(item => item.articleId === selected?.articleId);
      const next = index < 0 ? event.key === "j" ? 0 : scoped.length - 1 : Math.min(scoped.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)));
      event.preventDefault(); useReadingGroups.getState().openFile(scoped[next], scope === "examples");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, scoped, selected?.articleId, scope]);

  const scopeTitle = scope === "examples" ? "排版示例" : scope === "all" ? "全部已清洗" : scope === "unfiled" ? "未分类" : folderList.find((folder) => folder.id === scope)?.name ?? "清洗文库";

  return <section ref={panes.hostRef} style={panes.style} className="library-board files-board">
    <aside className="library-aside">
      {isMac && <div className="titlebar" data-tauri-drag-region />}
      <nav className="files-tree" aria-label="清洗文库目录">
        <button type="button" className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")}>
          <Icon name="inbox" size={15}/><span>全部已清洗</span><small>{allDocs.length}</small>
        </button>
        {unfiledCount > 0 && <button type="button" className={scope === "unfiled" ? "is-active" : ""} onClick={() => setScope("unfiled")}>
          <Icon name="file" size={15}/><span>未分类</span><small>{unfiledCount}</small>
        </button>}
        {tree.length > 0 && <p className="files-tree-label">文档目录</p>}
        {tree.map((folder) => {
          const depth = Math.min(folderAncestors(folder.id, folderList).length, 6);
          const count = cleanedCountForFolder(allDocs, folderList, folder.id);
          return <button key={folder.id} type="button" className={scope === folder.id ? "is-active" : ""}
            style={{ paddingLeft: 10 + depth * 14 }} onClick={() => setScope(folder.id)}>
            <Icon name="folder" size={15}/><span>{folder.name}</span><small>{count}</small>
          </button>;
        })}
        {docs.isSuccess && tree.length === 0 && <p className="files-tree-hint">清洗文档后，有内容的订阅目录会自动出现在这里。</p>}
        <div className="files-example-nav">
          <p className="files-tree-label">开始使用</p>
          <button type="button" className={scope === "examples" ? "is-active" : ""} onClick={() => setScope("examples")}>
            <Icon name="file" size={15}/><span>排版示例</span><small>{LIBRARY_EXAMPLES.length}</small>
          </button>
          <p className="files-tree-hint">内置示例独立展示，不计入已清洗文档。</p>
        </div>
      </nav>
    </aside>
    <section className="files-list" aria-label="已清洗文档">
      <div className="files-list-toolbar">
        <div className="files-list-heading"><h2>{scopeTitle}</h2><small>{scoped.length} 篇</small></div>
        <label className="files-search">
          <Icon name="search" size={13}/>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或来源" aria-label="搜索已清洗文档"/>
        </label>
      </div>
      {docs.isLoading && scope !== "examples" ? <p className="library-empty">正在读取清洗文库…</p>
        : docs.isError && scope !== "examples" ? <div className="library-empty" role="alert"><p>无法读取清洗文库。</p><button type="button" onClick={() => void docs.refetch()}>重试</button></div>
        : scoped.length === 0 ? <p className="library-empty">{query.trim() ? "没有匹配的标题、来源或目录，请尝试其他关键词。" : allDocs.length ? "这个目录下没有匹配的清洗文档。" : "还没有结构化清洗结果。通过 Agent 清洗后，文档会按订阅目录出现在这里。"}</p>
        : <ul>
          {scoped.map((doc) => <li key={doc.articleId}>
            <button type="button" aria-current={selected?.articleId === doc.articleId ? "true" : undefined} className={selected?.articleId === doc.articleId ? "is-active" : ""}
              onClick={event => useReadingGroups.getState().openFile(doc, scope === "examples", event.ctrlKey || event.metaKey)}
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); useReadingGroups.getState().openFile(doc, scope === "examples", true); } }}>
              <strong>{doc.title}</strong>
              <span>{[doc.folderName ?? "未分类", doc.feedTitle].join(" · ")}</span>
              <small>{scope === "examples" ? "示例文档" : `${doc.staleSchema ? "清洗规范待更新 · " : ""}${formatWhen(doc.cleanedAt)}`}<span> · {doc.words.toLocaleString()} 字</span></small>
            </button>
          </li>)}
        </ul>}
    </section>
    <section className="files-detail" aria-label="清洗正文">
      <WorkspaceReadingTabs group="files" active={active}/>
      <div id="reading-panel-files" className="reading-tab-panel" role="tabpanel" aria-label={selected?.title || "文库阅读区"} aria-labelledby={selectedTab ? `reading-tab-files-${selectedTab.id}` : undefined}>
        {selected && selectedTab ? <StructuredReader key={selectedTab.id} tab={selectedTab} item={selected} exampleDocument={example?.document}/>
          : <div className="files-empty-state"><Icon name="file" size={32}/><h2>把阅读留下来</h2><p>点击左侧文档，在标签中打开。切换目录和搜索不会关闭已打开的文档。</p>
            <button type="button" onClick={() => setScope("examples")}>浏览排版示例</button>
          </div>}
      </div>
    </section>
    {active && <BoardResizeHandles panes={panes} hasList label="文库" visible/>}
  </section>;
}
