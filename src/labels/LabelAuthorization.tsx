import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../components/Icon";
import HotPageView from "../hot/HotPageView";
import type { HotPageViewState } from "../hot/hotPageViewState";
import { credentialText, LABEL_SOURCES, labelTime, type CredentialStatus, type LabelProbe } from "./helpers";

type Source = typeof LABEL_SOURCES[number];
export default function LabelAuthorization({ source, active, onClose, onSaved }: { source: Source; active: boolean; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<CredentialStatus>();
  const [browser, setBrowser] = useState(false);
  const [page, setPage] = useState<HotPageViewState | null>(null);
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void invoke<CredentialStatus>("get_label_credential_status", { sourceId: source.id }).then(value => { if (!cancelled) setStatus(value); }).catch(() => { if (!cancelled) setNotice("系统安全存储暂不可访问，请检查系统授权提示。"); });
    return () => { cancelled = true; };
  }, [source.id]);
  const run = async (task: () => Promise<void>) => {
    if (busy || !active) return;
    setBusy(true); setNotice("");
    try { await task(); } catch (error) { if (alive.current) setNotice(typeof error === "string" ? error : "授权操作未完成，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  };
  const openLogin = () => void run(async () => {
    await invoke("restore_label_credentials", { sourceId: source.id });
    if (alive.current) { setBrowser(true); setNotice("请在官方页面完成扫码或验证，然后点击「保存授权」。"); }
  });
  const save = () => void run(async () => {
    if (!page) return;
    const value = await invoke<CredentialStatus>("save_label_browser_credentials", { sourceId: source.id, requestId: page.requestId });
    if (alive.current) { setStatus(value); setBrowser(false); setPage(null); setNotice("Cookie 已保存到系统安全存储。请关闭授权面板同步验证；保存本身不代表已登录。"); onSaved(); }
  });
  const importCookie = () => void run(async () => {
    // The native command persists in Keychain/Credential Manager; never in localStorage.
    const value = await invoke<CredentialStatus>("import_label_cookie", { sourceId: source.id, cookie });
    if (alive.current) { setCookie(""); setStatus(value); setNotice("Cookie 已安全保存，下次同步将自动复用；服务器会话过期后需更新。"); onSaved(); }
  });
  const loginEntry = () => void run(async () => {
    if (!page) return;
    const result = await invoke<LabelProbe>("probe_label_page", { sourceId: source.id, requestId: page.requestId, action: "login", term: null, kind: null });
    if (alive.current) setNotice(result.clicked ? "已打开官方登录入口，请在下方完成验证。" : "请使用下方官方页面提供的登录入口；不会替你提交验证码或接受授权条款。");
  });
  return <section className="label-authorization" aria-label={`${source.name}授权管理`}>
    <header className="label-panel-heading"><div><small>平台授权 · 本机安全存储</small><h2>{source.name}</h2></div><button className="hot-icon-button" onClick={onClose} aria-label="关闭授权管理"><Icon name="x" size={16}/></button></header>
    <div className="label-auth-summary"><strong>{credentialText(status)}</strong>{status?.savedAt && <small>保存于 {labelTime(new Date(status.savedAt * 1000).toISOString())} · {status.count} 个未过期 Cookie</small>}<p>扫码一次，后续自动复用。服务端仍可能让会话失效；我们不延长 Cookie 有效期，也不读取密码或私信。</p></div>
    <div className="label-auth-actions">
      {!browser ? <button className="hot-action" disabled={busy || !active} onClick={openLogin}><Icon name="globe" size={14}/>扫码 / 登录授权</button> : <><button className="hot-action" disabled={busy || !page?.created || page.loading} onClick={save}>保存授权</button><button disabled={busy || !page?.created || page.loading} onClick={loginEntry}>打开登录入口</button><button onClick={() => { setBrowser(false); setPage(null); }}>返回管理</button></>}
    </div>
    {notice && <p className="label-notice" role="status">{notice}</p>}
    {browser ? <div className="label-auth-browser"><HotPageView viewId="labels-page" url={source.url} active={active} onStateChange={setPage}/></div> : <div className="label-auth-form">
      <details><summary>已有 Cookie？直接粘贴保存</summary><p>支持 Cookie 请求头或浏览器导出的 Cookie JSON 数组。仅接受当前平台域名，内容只写入系统安全存储。</p><label><span className="sr-only">{source.name} Cookie</span><textarea aria-label={`${source.name} Cookie`} autoComplete="off" spellCheck={false} value={cookie} maxLength={131072} onChange={event => setCookie(event.target.value)} placeholder="Cookie: name=value; …"/></label><button className="hot-action" disabled={busy || !active || !cookie.trim()} onClick={importCookie}>安全保存 Cookie</button></details>
      <details><summary>数据权限与授权范围</summary><p>{source.access}</p><p>仅同步已适配的标签榜单，不读取创作收益、作品、私信或个人资料。Mac 使用钥匙串，Windows 使用凭据管理器；凭据不会进入 RSS、AI、MCP 或导出文件。</p><p>七个平台当前采用 Cookie 会话。未验证可用的 API 不提供占位密钥输入框。</p></details>
      {status?.configured && <div className="label-forget"><button disabled={busy} onClick={() => setConfirmForget(!confirmForget)}>清除本机保存的授权…</button>{confirmForget && <><p>仅删除本应用的安全备份，不会注销平台或清空浏览器登录状态。</p><button disabled={busy} onClick={() => void run(async () => { await invoke("forget_label_credentials", { sourceId: source.id }); if (alive.current) { setStatus({ configured: false, count: 0, savedAt: null, expired: false, persistent: true }); setConfirmForget(false); setNotice("已删除安全存储中的授权备份；需要时可重新保存。"); onSaved(); } })}>确认清除备份</button></>}</div>}
    </div>}
  </section>;
}
