import { useEffect, useState, type FormEvent } from "react";
import Icon from "../components/Icon";
import { safePageViewUrl } from "../lib/pageViewState";
import { getHotAuthStatus, saveHotApiToken } from "./api";
import type { HotAuthStatus, HotSource } from "./types";

export default function SourceAuthorization({ source, onClose, onBrowse, onRefresh }: { source: HotSource; onClose: () => void; onBrowse: (url: string) => void; onRefresh: () => void }) {
  const [status, setStatus] = useState<HotAuthStatus | null>(null);
  // This value is deliberately confined to this mounted form. Never persist
  // it in workspace state, query data, localStorage, errors or logs.
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getHotAuthStatus(source.id).then((value) => { if (!cancelled) setStatus(value); }).catch(() => { if (!cancelled) setError("无法读取授权状态，请稍后重新打开。"); });
    return () => { cancelled = true; };
  }, [source.id]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !token.trim() || !status?.supported) return;
    setSaving(true); setError(null);
    try {
      await saveHotApiToken(source.id, token.trim());
      setStatus({ configured: true, supported: true });
      setJustSaved(true);
    } catch { setError("保存未完成，请检查本机凭证库权限后重试。"); }
    finally { setToken(""); setSaving(false); }
  };
  const homepage = safePageViewUrl(source.homepage);
  const authUrl = safePageViewUrl(source.auth_url);
  return <section className="hot-authorization" aria-label={`${source.name}授权设置`}>
    <header><h1>{source.name} · 登录 / 授权</h1><button className="hot-icon-button" aria-label="关闭授权说明" disabled={saving} onClick={onClose}><Icon name="x" size={16}/></button></header>
    <p>在官方网站手动登录，用于浏览原网页。网页 Cookie 不会自动共享给本地榜单抓取。</p>
    <button className="hot-action" disabled={!homepage || saving} onClick={() => homepage && onBrowse(homepage)}><Icon name="globe" size={15}/>打开官方网站登录</button>
    <h2>榜单 API 授权</h2>
    {source.auth_kind === "api_token" ? <>
      <p>使用此来源的开发者 API 令牌，不是网页登录密码。{authUrl && <button className="hot-inline-link" disabled={saving} onClick={() => onBrowse(authUrl)}>打开官方申请页<Icon name="open" size={12}/></button>}</p>
      {status?.configured && <p className="hot-auth-configured">{justSaved ? "已保存到凭证库 · 待刷新验证。若刚获取失败，请约 2 分钟后刷新验证。" : "已配置令牌（保存不代表验证成功）"}</p>}
      <form onSubmit={(event) => void save(event)} autoComplete="off">
        <label className="hot-token-field">API Token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096} disabled={saving || !status?.supported} placeholder={status?.configured ? "输入新令牌以替换；不会显示现有令牌" : "输入开发者 API Token"}/></label>
        <p className="hot-auth-storage">仅保存到本机凭证库；仅请求 Product Hunt 榜单时发送给该平台。保存不会联网验证。</p>
        <div className="hot-auth-actions"><button className="hot-action" type="submit" disabled={saving || !token.trim() || !status?.supported}>{saving ? "正在保存…" : "保存到凭证库"}</button>{status?.configured && <button type="button" className="hot-action" disabled={saving} onClick={onRefresh}>刷新榜单验证</button>}</div>
      </form>
      {!status && !error && <small>正在读取本机授权状态…</small>}
      {status && !status.supported && <p>当前版本不支持此来源的 API 授权。</p>}
    </> : <p>此来源目前使用公开榜单端点，未配置开发者授权流程。网页登录不保证公开端点的抓取恢复。</p>}
    {error && <p role="alert" className="hot-auth-error">{error}</p>}
  </section>;
}
