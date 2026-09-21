// Production components with synthetic, in-memory IPC only. This preview
// cannot read or modify the user's database, browser profile or AI accounts.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArticleDetail, AiFormattedDraft, Feed } from "../src/types";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/newsreader";
import "../src/styles.css";

const storage = new Map<string, string>([["pref.readerViewMode", "web"], ["language", "zh"], ["papr.workspace.v2", "rss"]]);
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear(), key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; } } });
const titles = ["AI 如何改变科学发现", "多模态模型的新进展", "科研工具的下一站", "从数据走向新的发现", "本周值得关注的论文", "让知识连接起来", "开放科学的下一步", "新的研究工作流", "关于人工智能的思考", "科学与技术的交汇点", "理解复杂世界的新方法", "探索未知的边界"];
const paragraphs = ["从提出假设到验证结果，人工智能正在进入科学研究的每一个环节。真正的变化，是研究者与工具之间新的协作方式。", "AI 正在成为研究者进行文献分析的重要助手。通过自然语言处理和语义理解，它能够从海量文献中提取关键信息、建立知识关联，并帮助研究者发现被忽视的联系。", "在实验设计方面，通过对已有数据的学习，研究者能够提出新的实验假设、推荐合适的实验方案，并在虚拟环境中进行初步验证。", "工具让探索变得更加容易，而提出问题、验证证据和分享知识，仍然需要研究者作出判断。"];
const feeds: Feed[] = ["Nature", "MIT Technology Review", "机器之心", "Science"].map((title, i) => ({ id: i + 1, feedUrl: `https://example.invalid/feed/${i}`, siteUrl: "https://example.invalid/", title, description: null, faviconUrl: null, folderId: 1, sourceType: "rss", lastFetchedAt: null, fetchError: null, unreadCount: 3, refreshIntervalMin: null, autoTranslate: false, openMode: "reader" }));
const articles: ArticleDetail[] = titles.map((title, i) => ({ id: i + 1, feedId: i % 4 + 1, feedTitle: feeds[i % 4].title, sourceType: "rss", title, author: null, url: `https://example.invalid/article/${i + 1}`, contentHtml: paragraphs.concat(paragraphs).map(p => `<p>${p}</p>`).join(""), snippet: paragraphs[i % 4], extractedHtml: null, imageUrl: null, publishedAt: "2026-09-21T08:00:00Z", isRead: false, isStarred: false, readLater: false, aiSummary: null, translatedHtml: null, translatedLang: null, enclosures: [], tags: [] }));
const drafts: AiFormattedDraft[] = articles.map(a => ({ articleId: a.id, captureId: `fixture-${a.id}`, sourceUrl: a.url!, sourceTitle: a.title, capturedAt: "2026-09-21T08:00:00Z", generatedAt: "2026-09-21T08:05:00Z", model: "预览文档", language: "zh", markdown: `# ${a.title}\n\n${paragraphs[0]}\n\n## 从工具到研究伙伴\n\n${paragraphs[1]}\n\n${paragraphs[2]}\n\n> 更好的工具，让研究者有时间提出更好的问题。\n\n## 新的研究工作流\n\n${paragraphs[3]}\n\n${paragraphs[1]}\n\n## 仍需回答的问题\n\n${paragraphs[2]}\n\n${paragraphs[3]}`, sourceText: paragraphs.join("\n"), sourceCharCount: 500, sourceTruncated: false, warnings: [] }));
let sequence = 0;
const callbacks = new Map<number, (value: any) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const pages = new Map<string, { requestId: string; instance: number; url: string }>();
const emit = (event: string, payload: any) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); };
const matching = (args: any) => articles.filter(a => (!args.unreadOnly || !a.isRead) && (args.query?.kind !== "feed" || a.feedId === args.query.value) && (args.query?.kind !== "starred" || a.isStarred) && (args.query?.kind !== "later" || a.readLater));
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: (_: string, id: number) => listeners.delete(id) } });
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (fn: (value: any) => void) => { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") { const id = ++sequence; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    if (command === "list_feeds") return feeds;
    if (command === "list_folders") return [{ id: 1, name: "人工智能", sortOrder: 0 }];
    if (command === "smart_counts") return { all: articles.length, unread: articles.filter(a => !a.isRead).length, today: articles.length, starred: articles.filter(a => a.isStarred).length, readLater: articles.filter(a => a.readLater).length };
    if (command === "list_articles") return matching(args).slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
    if (command === "article_index") { const index = matching(args).findIndex(a => a.id === args.articleId); return index >= 0 ? index : null; }
    if (command === "get_article") { const a = articles.find(a => a.id === args.id); if (!a) throw { code: "articleNotFound" }; return { ...a }; }
    if (command === "get_ai_formatted") return drafts.find(d => d.articleId === args.articleId) ?? null;
    if (command === "article_structured_document" || command === "get_setting") return null;
    if (["list_tags", "list_highlights", "list_searches", "get_pending_deep_links"].includes(command)) return [];
    if (command === "mark_read" || command === "mark_starred" || command === "mark_read_later") { const a = articles.find(a => a.id === args.id); if (a) { if (command === "mark_read") a.isRead = args.read; if (command === "mark_starred") a.isStarred = args.starred; if (command === "mark_read_later") a.readLater = args.value; } return; }
    if (command === "open_page_view") { const old = pages.get(args.viewId); const page = old ?? { requestId: args.requestId, instance: ++sequence, url: args.resumeUrl ?? args.url }; pages.set(args.viewId, page); emit("page-view-status", { ...page, viewId: args.viewId, phase: "loaded" }); return !!old; }
    if (command === "close_page_view") { pages.delete(args.viewId); return; }
    if (command === "set_page_view_zoom") return { requestId: args.requestId, viewId: args.viewId, instance: pages.get(args.viewId)?.instance, factor: 1, mode: "fit" };
    if (/^(set_|refresh_tray|plugin:|page_view_)/.test(command)) return;
    throw Error(`Preview blocks external action: ${command}`);
  },
} });
const { default: i18n } = await import("../src/i18n");
await i18n.changeLanguage("zh");
const { useReaderTabs } = await import("../src/lib/readerTabs");
const { useUi } = await import("../src/store");
const { default: WorkspaceApp } = await import("../src/WorkspaceApp");
const { defaultReadingState } = await import("../src/lib/readerTabs");
const { ErrorBoundary } = await import("../src/components/ErrorBoundary");
useUi.setState({ mode: "light", palette: "paper", query: { kind: "folder", value: 1 }, queryLabel: "人工智能", sidebarWidth: 220, listWidth: 330, prefs: { ...useUi.getState().prefs, startupView: "last", markReadOnOpen: false, markReadOnScroll: false, hideReadOnStartup: false } });
const tabs = articles.slice(0, 4).map(a => ({ id: `rss-${a.id}-fixture`, articleId: a.id, title: a.title, feedId: a.feedId, restored: true, reading: { ...defaultReadingState(), mode: (a.id === 1 ? "formatted" : a.id === 2 ? "web" : "reader") as "formatted" | "web" | "reader" } }));
useReaderTabs.setState({ tabs, activeId: tabs[0].id, recent: [tabs[0].id] });
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } });
for (const a of articles) { qc.setQueryData(["article", a.id], a); qc.setQueryData(["ai-formatted", a.id], drafts[a.id - 1]); qc.setQueryData(["structured", a.id], null); }
document.documentElement.dataset.platform = "mac";
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={qc}><ErrorBoundary><WorkspaceApp/></ErrorBoundary></QueryClientProvider>);
// Read-only status is exposed for browser QA; interactions use production UI.
Object.assign(window, { __RSS_TAB_FIXTURE__: { synthetic: true, status: () => ({ tabs: useReaderTabs.getState().tabs.map(t => ({ id: t.articleId, mode: t.reading.mode })), activeId: useUi.getState().selectedArticleId, nativeCount: pages.size }) } });
