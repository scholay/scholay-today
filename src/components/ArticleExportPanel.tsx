import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errorText } from "../lib/errors";
import Icon from "./Icon";
import "./integration-settings.css";
interface ExportResult { path: string; images: number; missingImages: number; blocks: number; warnings: string[]; captureId: string }
interface Props { articleId: number; source: "web" | "formatted" | "reading"; requestId: string | null; captureId: string | null; webReady: boolean; onClose: () => void; onToast: (message: string) => void }
export default function ArticleExportPanel({ articleId, source, requestId, captureId, webReady, onClose, onToast }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null), [includeAi, setIncludeAi] = useState(source === "formatted");
  async function run() {
    if (busy) return; setBusy(true); setError(""); setResult(null);
    try {
      const data = await invoke<ExportResult>("export_article_bundle", { articleId, source, requestId, captureId, includeAi });
      setResult(data); onToast(`图文包已保存 · ${data.images} 张图片${data.missingImages ? ` · ${data.missingImages} 张未保存` : ""}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="article-export-panel" aria-label="图文结构化导出">
    <header><strong>图文资料包</strong><button title={busy ? "关闭面板，导出将在后台继续" : "关闭导出面板"} aria-label="关闭导出面板" onClick={onClose}><Icon name="x" size={13}/></button></header>
    <p>{source === "web" ? "从当前已加载网页抓取正文和图片。" : source === "formatted" ? "使用这份 AI 整理稿对应的原文快照。" : "使用本地文章缓存；若只有摘要，请切到 Web 加载全文后导出。"}保存为 Markdown + JSON + 本地图片的 ZIP，可放入 Obsidian 离线阅读。</p>
    <div className="integration-actions"><button disabled={busy || (source === "web" && !webReady)} onClick={() => void run()}><Icon name="arrow-down" size={14}/>{busy ? "正在抓取 / 下载图片…" : result ? "重新导出" : "导出图文包"}</button>{source === "formatted" && <label><input type="checkbox" checked={includeAi} disabled={busy} onChange={(e) => setIncludeAi(e.target.checked)}/> 附带 AI 整理稿与图片索引</label>}</div>
    {source === "web" && !webReady && <p>等待原网页加载完成后即可导出。</p>}
    {busy && <p role="status">不调用 AI；图片最多等待 80 秒，未能下载的图片会列出原因。可以切换文章，任务会继续。</p>}
    {error && <p role="alert" className="integration-error">{error}</p>}
    {result && <div><p role="status">已保存：{result.blocks} 个内容块 · {result.images} 张本地图片{result.missingImages > 0 && ` · ${result.missingImages} 张缺图`}</p><button onClick={() => void revealItemInDir(result.path).catch((e) => setError(errorText(e)))}>在 Finder 中显示</button>{result.warnings.length > 0 && <details><summary>来源与完整性说明</summary><ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}</div>}
  </section>;
}
