import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import Icon from "../components/Icon";
import { isMac } from "../lib/platform";
import { folderAncestors, orderedFolders } from "../lib/folderTree";
import { cleanedCountForFolder, docsInScope, matchesLibraryQuery, type LibraryScope } from "./helpers";
import StructuredReader from "./StructuredReader";
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
  const tree = orderedFolders(folderList);
  const [scope, setScope] = useState<LibraryScope>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const scoped = useMemo(
    () => docsInScope(allDocs, folderList, scope).filter((doc) => matchesLibraryQuery(doc, query)),
    [allDocs, folderList, scope, query],
  );
  const selected = allDocs.find((doc) => doc.articleId === selectedId) ?? null;
  const unfiledCount = allDocs.filter((doc) => doc.folderId == null).length;

  useEffect(() => {
    if (selectedId != null || scoped.length === 0) return;
    setSelectedId(scoped[0].articleId);
  }, [scoped, selectedId]);

  return <div className="library-board files-board">
    <aside className="library-aside">
      {isMac && <div className="titlebar" data-tauri-drag-region />}
      <nav className="files-tree" aria-label="清洗文库目录">
        <button type="button" className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")}>
          <Icon name="inbox" size={15}/><span>全部已清洗</span><small>{allDocs.length}</small>
        </button>
        <button type="button" className={scope === "unfiled" ? "is-active" : ""} onClick={() => setScope("unfiled")}>
          <Icon name="file" size={15}/><span>未分类</span><small>{unfiledCount}</small>
        </button>
        <p className="files-tree-label">订阅目录</p>
        {tree.map((folder) => {
          const depth = Math.min(folderAncestors(folder.id, folderList).length, 6);
          const count = cleanedCountForFolder(allDocs, folderList, folder.id);
          return <button key={folder.id} type="button" className={scope === folder.id ? "is-active" : ""}
            style={{ paddingLeft: 10 + depth * 14 }} onClick={() => setScope(folder.id)}>
            <Icon name="folder" size={15}/><span>{folder.name}</span><small>{count}</small>
          </button>;
        })}
        {tree.length === 0 && <p className="library-empty">还没有文件夹。RSS 侧栏里的目录会同步到这里。</p>}
      </nav>
    </aside>
    <section className="files-list" aria-label="已清洗文档">
      <div className="files-list-toolbar">
        <label className="files-search">
          <Icon name="search" size={13}/>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或来源" aria-label="搜索已清洗文档"/>
        </label>
      </div>
      {docs.isLoading ? <p className="library-empty">正在读取清洗文库…</p>
        : scoped.length === 0 ? <p className="library-empty">{allDocs.length ? "这个目录下没有匹配的清洗文档。" : "还没有结构化清洗结果。通过 Agent 清洗后，文档会按订阅目录出现在这里。"}</p>
        : <ul>
          {scoped.map((doc) => <li key={doc.articleId}>
            <button type="button" className={selected?.articleId === doc.articleId ? "is-active" : ""} onClick={() => setSelectedId(doc.articleId)}>
              <strong>{doc.title}</strong>
              <span>{[doc.folderName ?? "未分类", doc.feedTitle].join(" · ")}</span>
              <small>{doc.staleSchema ? "待更新 · " : ""}{formatWhen(doc.cleanedAt)}</small>
            </button>
          </li>)}
        </ul>}
    </section>
    <section className="files-detail" aria-label="清洗正文">
      {selected ? <StructuredReader item={selected}/> : <p className="library-empty">从中间栏选择一篇已清洗的文档查看结构化正文。</p>}
    </section>
  </div>;
}
