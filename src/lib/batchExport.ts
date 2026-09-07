import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ArticleQuery, ArticleSummary } from "../types";
import { errorText } from "./errors";
import { toast } from "../toast";

export const MAX_BATCH_ARTICLES = 200;
export type ExportArticle = Pick<ArticleSummary, "id" | "title">;
export interface ExportOptions { includeImages: boolean; fetchMissing: boolean }
export interface ExportPreview { articleId: number; title?: string; sourceKind?: string; hasMarkdown?: boolean; images?: number; needsFetch?: boolean; empty?: boolean; error: string | null }
export interface ExportItem { articleId: number; title: string; folder: string | null; images: number; missingImages: number; warnings: string[]; error: string | null; retryable: boolean }
export interface BatchResult { path: string; total: number; successful: number; retryIds: number[]; items: ExportItem[] }
export interface BatchProgress { done: number; total: number; title: string; phase: string }
interface BatchState {
  scope: string; mode: boolean; selected: ExportArticle[];
  open: boolean; targets: ExportArticle[]; running: boolean;
  progress: BatchProgress | null; result: BatchResult | null; error: string;
  options: ExportOptions;
  changeScope: (scope: string) => void;
  setMode: (mode: boolean) => void;
  toggle: (article: ExportArticle) => void;
  replaceSelection: (articles: ExportArticle[]) => void;
  review: () => void;
  setOpen: (open: boolean) => void;
}
export const batchScope = (query: ArticleQuery, unreadOnly: boolean) => `${JSON.stringify(query)}|${unreadOnly}`;
export function uniqueArticles(articles: ExportArticle[]): ExportArticle[] {
  return [...new Map(articles.map(a => [a.id, { id: a.id, title: a.title }])).values()];
}
export const useBatchExport = create<BatchState>((set, get) => ({
  scope: "", mode: false, selected: [], open: false, targets: [], running: false,
  progress: null, result: null, error: "", options: { includeImages: true, fetchMissing: false },
  changeScope: scope => { if (get().scope !== scope) set({ scope, mode: false, selected: [] }); },
  setMode: mode => set({ mode, selected: mode ? get().selected : [] }),
  toggle: article => set(s => ({ selected: s.selected.some(a => a.id === article.id)
    ? s.selected.filter(a => a.id !== article.id)
    : s.selected.length < MAX_BATCH_ARTICLES ? [...s.selected, { id: article.id, title: article.title }] : s.selected })),
  replaceSelection: articles => set({ selected: uniqueArticles(articles).slice(0, MAX_BATCH_ARTICLES) }),
  review: () => {
    if (get().running) { set({ open: true }); return; }
    if (!get().selected.length) return;
    set({ open: true, targets: [...get().selected], result: null, progress: null, error: "", options: { includeImages: true, fetchMissing: false } });
  },
  setOpen: open => set({ open }),
}));

/** Not owned by a component: closing the panel, changing feeds or moving to
 *  Trends doesn't cancel the invocation or lose progress/results. */
export async function runBatchExport(options: ExportOptions, retry = false) {
  const state = useBatchExport.getState();
  if (state.running) return;
  const ids = retry ? state.result?.retryIds ?? [] : state.targets.map(a => a.id);
  if (!ids.length) return;
  const channel = new Channel<BatchProgress>();
  channel.onmessage = progress => useBatchExport.setState({ progress });
  useBatchExport.setState({ running: true, error: "", options, progress: { done: 0, total: ids.length, title: "准备资料包", phase: "prepare" } });
  try {
    const result = await invoke<BatchResult>("export_article_bundles", { articleIds: ids, options, onProgress: channel });
    useBatchExport.setState({ result });
    toast.show(`图文包已保存 · ${result.successful}/${result.total} 篇${result.retryIds.length ? ` · ${result.retryIds.length} 篇有未完成项` : ""}`);
  } catch (error) {
    useBatchExport.setState({ error: errorText(error) });
    toast.error("批量导出未完成，请打开导出面板查看原因");
  } finally {
    useBatchExport.setState({ running: false });
  }
}

export function previewLabel(row?: ExportPreview) {
  if (!row) return "正在检查本地资料…";
  if (row.error) return row.error;
  if (row.empty) return "尚无正文";
  const kind = row.hasMarkdown ? "Markdown 已缓存" : row.needsFetch ? "RSS 缓存 · 可能仅摘要" : "网页正文已缓存";
  return `${kind}${row.images ? ` · ${row.images} 张图` : ""}`;
}
