import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listFolders } from "../api";
import * as integration from "../lib/integrations";
import { descendantIds, folderAncestors, orderedFolders } from "../lib/folderTree";
import { errorText } from "../lib/errors";
import Icon from "./Icon";
import ConfirmDialog from "./ConfirmDialog";
import "./integration-settings.css";

const labels: Record<string, string> = { unconfigured: "未配置", configured: "已配置 · 待验证", verified: "在线验证通过", expired: "授权已失效", unknown: "暂时无法验证", authorizing: "正在授权", challenge: "平台要求验证" };

export function PlatformSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["platform-status"], queryFn: async () => {
    const next = await integration.platformStatus();
    const previous = qc.getQueryData<integration.PlatformStatus[]>(["platform-status"]);
    // A configuration-only poll must not erase an explicit successful probe.
    // Keep its visible timestamp for five minutes; expiry/logout still wins.
    return next.map((p) => {
      const old = previous?.find((item) => item.id === p.id);
      return p.status === "configured" && p.service === "available" && old?.status === "verified" && old.lastVerifiedAt && Date.now() - Date.parse(old.lastVerifiedAt) < 300000
        ? { ...p, status: old.status, lastVerifiedAt: old.lastVerifiedAt } : p;
    });
  }, refetchInterval: 15000 });
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState(false), [secret, setSecret] = useState("");
  const [logout, setLogout] = useState(false);
  async function action(platform: string, action: string) {
    if (busy) return; setBusy(platform); setError("");
    try {
      const result = await integration.platformAction(platform, action, action === "save" ? secret : null);
      setSecret("");
      if (action === "save") setEditing(false);
      if (result.id) qc.setQueryData<integration.PlatformStatus[]>(["platform-status"], (old) => old?.map((p) => p.id === result.id ? result : p));
      else await query.refetch();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); setSecret(""); }
  }
  return <div className="integration-settings">
    <p className="settings-group-desc">统一管理订阅平台的授权。网页账号登录、接口授权与抓取状态分别检查；私人邮件不在这里接入。</p>
    {query.isLoading && <p role="status">正在检查本机连接器…</p>}
    {query.isError && <p role="alert">无法检查平台状态，请稍后重试。</p>}
    {query.data?.map((p) => <section className="integration-card" key={p.id}>
      <header><div><h3>{p.name}</h3><small>{p.method}</small></div><span className={`integration-status ${p.status === "verified" ? "verified" : ""}`}>{labels[p.status] ?? p.status}</span></header>
      <p>{p.detail}</p>
      <div className="integration-facts"><span>连接器：{p.service === "available" ? "可用" : p.service === "offline" ? "离线" : "待检查"}</span>{p.lastVerifiedAt && <span>最近验证：{new Date(p.lastVerifiedAt).toLocaleString()}</span>}{!!p.lastSyncAt && <span>最近抓取：{new Date(p.lastSyncAt * 1000).toLocaleString()} · {p.lastSyncStatus}</span>}</div>
      <div className="integration-actions">
        <button disabled={!!busy} onClick={() => p.id === "zhihu" ? setEditing(!editing) : void action(p.id, "authorize")}><Icon name="globe" size={14}/>{p.id === "zhihu" ? "配置 / 更换授权" : "扫码 / 管理授权"}</button>
        <button disabled={!!busy} onClick={() => void action(p.id, "verify")}><Icon name="refresh" size={14}/>{busy === p.id ? "正在处理…" : p.id === "zhihu" ? "在线验证" : "检查连接与抓取"}</button>
        {p.id === "zhihu" && p.status !== "unconfigured" && <button disabled={!!busy} onClick={() => setLogout(true)}>解除授权</button>}
      </div>
      {p.id === "zhihu" && editing && <form className="integration-secret" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void action("zhihu", "save"); }}><label>Access Secret<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder="只保存到系统凭证库，不写入订阅数据库"/></label><button disabled={!!busy || !secret.trim()}>验证并保存</button></form>}
    </section>)}
    <section className="integration-card"><h3>普通 RSS 与 AI 服务</h3><p>普通 RSS 无需统一登录。AI 模型、接口地址和密钥继续在「高级」中配置；本次新增图文导出不依赖 AI。</p></section>
    {error && <p className="integration-error" role="alert">{error}</p>}
    {logout && <ConfirmDialog title="解除知乎授权" message="仅移除本机知乎 CLI 的授权。已有订阅和缓存文章保留，新的知乎内容将无法继续抓取。" confirmLabel="解除授权" onConfirm={() => { setLogout(false); void action("zhihu", "logout"); }} onClose={() => setLogout(false)}/>}
  </div>;
}

export function AgentSettings({ onToast }: { onToast: (message: string) => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["library-status"], queryFn: integration.libraryStatus });
  const folderQuery = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const folders = orderedFolders(folderQuery.data ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const s = query.data;
  async function run(work: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError("");
    try { await work(); await Promise.all([query.refetch(), qc.invalidateQueries({ queryKey: ["folders"] })]); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <div className="integration-settings">
    <section className="integration-card"><h3>本机 MCP 服务</h3><p>智能体通过 stdio 连接正在运行的 scholay tody。仅本机访问，不开放网络端口，不暴露密钥或任意命令执行。</p>
      {s ? <><label className="integration-toggle"><span>启用 MCP</span><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void run(() => integration.libraryPermissions(e.target.checked, s.writable))}/></label><label className="integration-toggle"><span>允许修改订阅和目录</span><input type="checkbox" checked={s.writable} disabled={busy || !s.enabled} onChange={(e) => void run(() => integration.libraryPermissions(s.enabled, e.target.checked))}/></label>
      <small>移除订阅只会隐藏并停止抓取，文章保留；彻底清空资料不向 MCP 开放。</small>
      <details className="integration-config" open><summary>连接配置 · 可复制到支持本机 MCP 的智能体</summary><pre>{JSON.stringify(s.configuration, null, 2)}</pre><button onClick={() => void navigator.clipboard.writeText(JSON.stringify(s.configuration, null, 2)).then(() => onToast("MCP 配置已复制")).catch(() => setError("无法写入剪贴板"))}><Icon name="copy" size={14}/>复制配置</button></details></> : <p role="status">{query.isError ? "无法读取本机服务状态" : "正在读取…"}</p>}
    </section>
    <section className="integration-card"><h3>目录层级</h3><p>选择上级目录即可移动，文章和订阅 ID 不变。当前目录名称在整个资料库中保持唯一。</p>
      <div className="integration-folder-list">{folders.map((f) => {const descendants = descendantIds(f.id, folders); return <label className="integration-folder" key={f.id}><span title={f.name} style={{ paddingLeft: Math.min(folderAncestors(f.id, folders).length, 5) * 10 }}>{f.name}</span><select aria-label={`${f.name}的上级目录`} value={f.parentId ?? ""} disabled={busy} onChange={(e) => void run(() => integration.libraryApply([{ action: "move_folder", id: f.id, parent_id: e.target.value ? Number(e.target.value) : null }], false, s?.revision ?? null))}><option value="">顶层目录</option>{folders.filter((p) => !descendants.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;})}</div>
    </section>
    <section className="integration-card"><h3>已移除的订阅 <small>{s?.archived.length ?? 0}</small></h3><p>这里的订阅不再刷新。恢复后仍使用原来的文章、收藏和阅读记录。</p>{s?.archived.map((f) => <div className="integration-folder" key={f.id}><span>{f.title}<small> · {f.articles} 篇</small></span><button disabled={busy} onClick={() => void run(() => integration.libraryApply([{ action: "restore_feed", id: f.id }]))}>恢复订阅</button></div>)}</section>
    <section className="integration-card"><h3>最近操作</h3>{s?.history.length ? <ol className="integration-history">{s.history.map((h) => <li key={h.id}><span>{h.actor === "mcp" ? "智能体" : h.actor === "desktop" ? "桌面" : h.actor} · {h.actions.map((a) => a.action).join("、")}</span><small>{h.createdAt} UTC</small></li>)}</ol> : <p>暂时没有目录操作记录。</p>}</section>
    {error && <p className="integration-error" role="alert">{error}</p>}
  </div>;
}
