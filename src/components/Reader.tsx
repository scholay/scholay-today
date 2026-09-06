import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../api";
import { LANGUAGES } from "../i18n";
import { useUi, PANEL_BOUNDS } from "../store";
import { usePlayer } from "../player";
import { useTranslationJobs } from "../translation";
import { useArticleActions } from "../hooks/articleActions";
import { renderMarkdown } from "../lib/markdown";
import { downloadBlob, imageFilename } from "../lib/download";
import { imageDataUrl } from "../lib/imageBytes";
import { loadReaderViewPreference, resolveReaderViewMode, saveReaderViewPreference, type ReaderViewMode } from "../lib/readerViewMode";
import { DEFAULT_FORMAT_LANGUAGE, isCurrentCapture, readerTabForArticle, settleAiFormatJob, type AiFormatJob, type AiFormatLanguage, type AiFormatSource } from "../lib/aiFormatted";
import { errorText } from "../lib/errors";
import { enqueuePageView, nextPageViewRequestId } from "../lib/pageViewQueue";
import { applyPageViewStatus, createPageViewState, dismissPageViewNotice, isPageViewStatusEvent, markPageViewCreated, markPageViewError, markPageViewWaiting, pageViewBanner, pageViewExternalUrl, pageViewForArticle, safePageViewUrl, startPageViewWait, type PageViewAction, type PageViewState } from "../lib/pageViewState";
import { fullDate } from "../lib/feedMeta";
import { isMac } from "../lib/platform";
import { reportError, toast } from "../toast";
import { tagColor } from "../lib/tagColors";
import type { ArticleDetail, PageCapture } from "../types";
import AIFormatted from "./AIFormatted";
import ArticleExportPanel from "./ArticleExportPanel";
import ReaderViewOutlet, { readerSummaryKey, readerViewKey } from "./ReaderViewOutlet";
import Icon from "./Icon";
import TagPicker from "./TagPicker";
import ResizeHandle from "./ResizeHandle";
import HighlightLayer from "./HighlightLayer";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import Lightbox from "./Lightbox";
import "./reader-web-controls.css";

interface Props {
  workspaceSwitch?: React.ReactNode;
  onToast: (msg: string) => void;
  /** Keep RSS state mounted while suspending its native page and new actions. */
  active?: boolean;
  /** Only page capture blocks workspace switching, never model generation. */
  onCaptureBusyChange?: (busy: boolean) => void;
}

function youtubeId(url: string | null): string | null {
  if (!url) return null;
  const m =
    url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : null;
}

function needsImageProxy(src: string): boolean {
  try {
    const host = new URL(src).hostname.toLowerCase();
    return host === "cdnfile.sspai.com" || host === "rssfile.sspai.com";
  } catch {
    return false;
  }
}

/** Plain, entity-decoded text of an HTML body — for the reading-time estimate.
 *  A bare `replace(/<[^>]+>/g, " ")` tag-strip leaves HTML entities intact, so
 *  `Tom &amp; Jerry &mdash; done` would be counted as 5 words / 28 chars when
 *  the real text ("Tom & Jerry — done") is 4 words / 18 chars — inflating the
 *  estimate on entity-heavy articles. Parsing into an inert document decodes
 *  every entity (`&amp;` → `&`, `&mdash;` → `—`) and drops markup cleanly. */
function bodyPlainText(html: string): string {
  if (!html) return "";
  // DOMParser documents are inert — nothing here executes or loads.
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** True when the body opens with its own visual media (image / video / iframe)
 *  before any real text. Such an article already leads with a strong visual, so
 *  prepending the list-thumbnail hero on top of it just shows a second, often
 *  unrelated image — the exact complaint in issue #97, where the body starts
 *  with a `<video>` cover while the feed's `media:thumbnail` is a different png.
 *  Walking in document order (media element before the first non-whitespace text
 *  node) is what the plain `body.includes(imageUrl)` guard can't catch, since
 *  the hero image and the body's lead media are distinct URLs here. */
function bodyLeadsWithMedia(html: string): boolean {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim().length > 0) return false;
    } else if (node instanceof Element) {
      if (["IMG", "VIDEO", "IFRAME", "PICTURE"].includes(node.tagName)) return true;
    }
  }
  return false;
}

/** CJK ideographs + Japanese kana + Korean Hangul — scripts read by the
 *  character, not the whitespace-delimited word. */
const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;
/** Global-flagged variant of `CJK_CHAR` for stripping every CJK glyph. */
const CJK_CHAR_GLOBAL = new RegExp(CJK_CHAR.source, "gu");

/** Estimate reading time in minutes for an article body's plain text.
 *
 *  A mixed-script estimate: CJK scripts have no word spacing, so they are
 *  counted by the character (~480 chars/min); latin-script text is counted by
 *  the whitespace-delimited word (~220 wpm). The two contributions are *summed*
 *  — the previous `Math.max(words/220, chars/480)` always lost for English
 *  (a 1000-word article spans ~5500 chars, so `chars/480` ≈ 11 dwarfed the
 *  true `words/220` ≈ 4.5), inflating every latin-script article ~2-3×. */
function estimateReadMinutes(text: string): number {
  let cjkChars = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjkChars++;
  }
  // Words, with CJK characters stripped so they are not also counted as
  // single-character "words" by the latin path.
  const latinWords = text
    .replace(CJK_CHAR_GLOBAL, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const minutes = cjkChars / 480 + latinWords / 220;
  return Math.max(2, Math.round(minutes));
}

/** Decode a URL fragment, tolerating a malformed `%` escape. A real-world
 *  anchor can carry a literal percent (`#100%-growth`, `#section-50%`), which
 *  is not a valid escape sequence — `decodeURIComponent` throws `URIError` on
 *  it. The bare value still works as an `id` lookup, so fall back to it rather
 *  than letting the throw escape the click handler and kill the link. */
function decodeFragment(frag: string): string {
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag;
  }
}

/** Pull the in-page fragment out of a link click, or null if it isn't one.
 *
 *  Two shapes count as in-page: a bare `#frag` href, and — because the body
 *  HTML is sanitized with the article's URL as the rewrite base — an absolute
 *  `https://site/article#frag` that resolves to the very article being read.
 *  `sourceUrl` is the article's own URL, used to recognise that second case.
 */
function inPageFragment(raw: string, sourceUrl: string | null): string | null {
  if (raw[0] === "#") return decodeFragment(raw.slice(1));
  if (!sourceUrl) return null;
  try {
    const u = new URL(raw);
    const b = new URL(sourceUrl);
    if (u.hash && u.origin === b.origin && u.pathname === b.pathname) {
      return decodeFragment(u.hash.slice(1));
    }
  } catch {
    /* not a parseable absolute URL — treat as external */
  }
  return null;
}

/** Build a click handler for links inside injected HTML (article body, AI
 *  summary). In-page anchor links (footnotes, tables of contents) scroll to
 *  their target within the reader; everything else opens in the external
 *  browser — a bare <a> click would otherwise navigate the Tauri webview away
 *  from the app entirely (or, for a fragment link, to a bogus `app://…#frag`). */
function makeLinkClickHandler(sourceUrl: string | null) {
  return (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    const raw = link.getAttribute("href");
    if (!raw) return;
    e.preventDefault();

    const hash = inPageFragment(raw, sourceUrl);
    if (hash != null) {
      if (hash === "") return; // bare `#` — no element to reach
      const root = link.closest(".article-body, .ai-prose");
      // getElementById can't be scoped to the body, so match by id or the
      // legacy `<a name>` form within the rendered content.
      const target = root?.querySelector(
        `[id="${CSS.escape(hash)}"], a[name="${CSS.escape(hash)}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    openUrl(link.href).catch(() => {});
  };
}

export default function Reader({ onToast, active = true, onCaptureBusyChange, workspaceSwitch }: Props) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const captureBusyRef = useRef(false);
  const captureBusyChangeRef = useRef(onCaptureBusyChange);
  captureBusyChangeRef.current = onCaptureBusyChange;
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const actions = useArticleActions(toast.error);
  const id = useUi((s) => s.selectedArticleId);
  const focusMode = useUi((s) => s.focusMode);
  const setFocusMode = useUi((s) => s.setFocusMode);
  const aiOpen = useUi((s) => s.aiOpen);
  const setAiOpen = useUi((s) => s.setAiOpen);
  const markReadOnOpen = useUi((s) => s.prefs.markReadOnOpen);
  const markReadOnScroll = useUi((s) => s.prefs.markReadOnScroll);
  const showReadingTime = useUi((s) => s.prefs.showReadingTime);
  const defaultOpenMode = useUi((s) => s.prefs.defaultOpenMode);

  const [scrolled, setScrolled] = useState(false);
  // Which body to show when an extraction exists follows the default open
  // mode: "reader" (the default) shows the feed's own content and extraction
  // is opt-in via the toolbar button; "extracted" shows the full text.
  const [showExtracted, setShowExtracted] = useState(
    defaultOpenMode === "extracted",
  );
  const [showTranslation, setShowTranslation] = useState(false);
  // A manual Reading/Web choice wins across articles, feed defaults and restarts.
  // A fresh install resolves to Web; global/per-feed modes remain remembered
  // configuration, and URL-less items fall back to Reading without erasing it.
  const [readerViewPreference, setReaderViewPreference] = useState(loadReaderViewPreference);
  const [automaticViewMode, setAutomaticViewMode] = useState<{ articleId: number; mode: ReaderViewMode } | null>(null);
  // AI is a per-article overlay, never a value written over Reading/Web memory.
  const [formattedArticleId, setFormattedArticleId] = useState<number | null>(null);
  const [formatLanguage, setFormatLanguage] = useState<AiFormatLanguage>(DEFAULT_FORMAT_LANGUAGE);
  const [formatJobs, setFormatJobs] = useState<Record<number, AiFormatJob>>({});
  const formatRunRef = useRef(0);
  // One claim per native page/run prevents Strict Mode or repeated loaded
  // events from starting the same capture twice.
  const formatCaptureClaimRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captureBusyRef.current = false;
      captureBusyChangeRef.current?.(false);
    };
  }, []);
  const setViewMode = useCallback((mode: ReaderViewMode) => {
    if (!activeRef.current) return;
    setFormattedArticleId(null);
    // Leaving an AI page while its hidden browser is only opening is a cancel,
    // not an error. A capture already in IPC remains locked until its finally.
    if (id != null) {
      setFormatJobs((jobs) => {
        const job = jobs[id];
        if (job?.phase !== "opening") return jobs;
        const next = { ...jobs };
        delete next[id];
        return next;
      });
    }
    setReaderViewPreference(mode);
    saveReaderViewPreference(mode);
  }, [id]);
  const [pageViewState, setPageViewState] = useState<PageViewState | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const pageViewControllerRef = useRef<{
    requestId: string;
    articleId: number;
    originalUrl: string;
    run: (action: PageViewAction) => void;
    capture: () => Promise<PageCapture>;
    sync: () => void;
  } | null>(null);
  const [webOpenAttempt, setWebOpenAttempt] = useState(0);
  const [tagPick, setTagPick] = useState<{ x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    // Set when the right-click landed on an article image / over a text
    // selection, so the menu can offer image- and copy-specific actions.
    imageUrl?: string;
    selection?: string;
  } | null>(null);
  // Full-screen image viewer: the article's image srcs + the one to open on
  // (issue #87). Null when closed.
  const [lightbox, setLightbox] = useState<{ srcs: string[]; index: number } | null>(
    null,
  );
  useEffect(() => {
    if (active) return;
    // These may portal outside the hidden RSS pane. Preserve reading/AI state,
    // but never leave an RSS context menu or lightbox over another workspace.
    setTagPick(null);
    setCtxMenu(null);
    setLightbox(null);
  }, [active]);
  const [heroBroken, setHeroBroken] = useState(false);
  // data: URL of a hero image recovered through the backend after the webview
  // failed to load it directly (see the body-image retry effect below). A data:
  // URL (not blob:) so the bytes stay inline and survive the webview dropping
  // blob backing data under memory pressure — the same fix as body images.
  const [heroDataUrl, setHeroDataUrl] = useState<string | null>(null);
  const [proxiedBody, setProxiedBody] = useState<{
    source: string;
    html: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Host element the native original-page child webview is positioned over.
  const pageHostRef = useRef<HTMLDivElement>(null);
  // Article id we already auto-marked read via scroll, so a flurry of scroll
  // events near the foot doesn't fire `setRead` repeatedly before the
  // optimistic cache patch lands.
  const scrollMarkedRef = useRef<number | null>(null);
  const playTrack = usePlayer((s) => s.play);
  const playingSrc = usePlayer((s) => (s.playing ? s.track?.src : null));

  const article = useQuery({
    queryKey: ["article", id],
    queryFn: () => api.getArticle(id as number),
    enabled: id != null,
  });
  const a: ArticleDetail | undefined = article.data;
  // Reading a saved local draft is not generation and sends no page to AI.
  const formattedQuery = useQuery({
    queryKey: ["ai-formatted", id],
    queryFn: () => api.getAiFormatted(id as number),
    enabled: id != null,
  });
  const formattedDraft = formattedQuery.data?.articleId === id ? formattedQuery.data : null;
  const formatJob = id != null ? formatJobs[id] ?? null : null;
  const formatBusy = formatJob?.phase === "opening" || formatJob?.phase === "capturing" || formatJob?.phase === "formatting";

  // Feed list, so the article's source feed can be checked for its per-feed
  // auto-translate flag. Shared cache key with the sidebar — no extra fetch.
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds });
  const autoTranslateFeed = !!(
    a && feeds.data?.find((f) => f.id === a.feedId)?.autoTranslate
  );
  // Effective open mode (issue #110): the feed's own setting, falling back to
  // the global default. `undefined` while the article or feed list is still
  // loading, so the open-mode/auto-extract effects below don't fire before the
  // feed's own setting is known.
  const feedOpenMode =
    a && feeds.data
      ? feeds.data.find((f) => f.id === a.feedId)?.openMode ?? null
      : undefined;
  const openMode =
    feedOpenMode === undefined ? undefined : feedOpenMode ?? defaultOpenMode;
  const viewMode = resolveReaderViewMode(
    readerViewPreference,
    automaticViewMode?.articleId === a?.id ? automaticViewMode?.mode : openMode,
    Boolean(a?.url),
  );
  const readerTab = readerTabForArticle(viewMode, formattedArticleId, a?.id);
  const readerTabRef = useRef(readerTab);
  readerTabRef.current = readerTab;

  const readMinutes = useMemo(() => {
    return estimateReadMinutes(bodyPlainText(a?.extractedHtml || a?.contentHtml || ""));
    // Recompute when the body changes — including after full-text extraction
    // replaces the short feed snippet, which keeps the same article id.
  }, [a?.extractedHtml, a?.contentHtml]);

  // Reset scroll + extraction view on article change.
  useEffect(() => {
    setShowExtracted(useUi.getState().prefs.defaultOpenMode === "extracted");
    setShowTranslation(false);
    setPageViewState(null);
    setFormattedArticleId(null);
    // Opening/capturing belongs to the page that owned the native view. A
    // model request may continue and save to its originating article, but a
    // pre-capture run must not survive an article switch.
    setFormatJobs((jobs) => {
      let changed = false;
      const next = { ...jobs };
      for (const [articleId, job] of Object.entries(jobs)) {
        if (Number(articleId) !== id && (job.phase === "opening" || job.phase === "capturing")) {
          delete next[Number(articleId)];
          changed = true;
        }
      }
      return changed ? next : jobs;
    });
    setScrolled(false);
    setTagPick(null);
    setHeroBroken(false);
    setHeroDataUrl(null);
    scrollMarkedRef.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [id]);

  // Apply the effective open mode once the article (and the feed list) is
  // available — declared after the reset above so it wins the same commit.
  // Applied once per article, so the toolbar toggles keep working afterwards
  // and a feeds refetch never yanks the view back.
  const openModeAppliedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!a || openMode === undefined || openModeAppliedRef.current === a.id)
      return;
    openModeAppliedRef.current = a.id;
    setAutomaticViewMode({ articleId: a.id, mode: openMode === "web" ? "web" : "reader" });
    if (openMode !== "web" || !a.url) setShowExtracted(openMode === "extracted");
  }, [a, openMode]);

  // Drive the native original-page child webview (page_view.rs) while in web
  // mode. It floats above the DOM, so we measure the host rect and keep the
  // webview aligned to it across window/sidebar resizes. Switching articles
  // keeps the manual mode and replaces the child view with the new article URL.
  const articleUrl = a?.url ?? null;
  const currentPageView = pageViewForArticle(pageViewState, a?.id, articleUrl);
  const currentPageUrl = pageViewExternalUrl(pageViewState, a?.id, articleUrl);
  const externalArticleUrl = readerTab === "formatted" ? safePageViewUrl(formatJob?.source?.sourceUrl) ?? safePageViewUrl(formattedDraft?.sourceUrl) ?? articleUrl : readerTab === "web" ? currentPageUrl : articleUrl;
  const webViewOpening = currentPageView?.loading ?? false;
  const webBanner = pageViewBanner(currentPageView);
  const nativeFormatActive = readerTab === "formatted" && (formatJob?.phase === "opening" || formatJob?.phase === "capturing");
  const nativePageNeeded = readerTab === "web" || nativeFormatActive;
  // Anything that floats over the reading area must suspend the page view: the
  // child webview floats above the whole DOM, so it would otherwise occlude a
  // covering modal (subscribe / settings / explore — issue #54), a context
  // menu raised over the reader (issue #74), the tag picker, or the AI drawer
  // that slides over the reader's right edge. We *hide* the webview rather than
  // tear it down, so dismissing the overlay reveals the already-loaded page
  // instantly instead of reloading it (the bounds keep syncing while hidden,
  // below).
  const modalOpen = useUi((s) => s.modalOpen);
  const menuOpen = useUi((s) => s.menuOpen);
  const overlayOpen = modalOpen || menuOpen || aiOpen || tagPick != null;
  // Read the latest value inside the lifecycle effect without making it a
  // dependency — overlays toggle visibility (below), never the webview's life.
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;

  // Webview lifecycle: Web owns a visible page; AI opening/capturing owns the
  // same native page invisibly. Keeping this lifecycle alive across Web -> AI
  // lets us capture exactly what the user was viewing instead of reloading it.
  useEffect(() => {
    const host = pageHostRef.current;
    if (!active || !nativePageNeeded || !articleUrl || !host || !a) return;

    const requestId = nextPageViewRequestId("reader");
    const bounds = () => {
      // The exclusive ReaderViewOutlet replaces the Web host with the hidden
      // AI host. Always measure the current ref so the native child survives
      // that hand-off without retaining the detached element's rectangle.
      const r = (pageHostRef.current ?? host).getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    let open = false;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let waitTimer: number | undefined;
    const clearWaitTimer = () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      waitTimer = undefined;
    };
    const armWaitTimer = () => {
      clearWaitTimer();
      waitTimer = window.setTimeout(() => {
        if (!cancelled && activeRef.current) setPageViewState((state) => markPageViewWaiting(state, requestId));
      }, 20_000);
    };
    const beginWaiting = () => {
      setPageViewState((state) => startPageViewWait(state, requestId));
      armWaitTimer();
    };
    const sync = () => {
      if (open && !cancelled && activeRef.current) {
        void enqueuePageView(async () => {
          if (open && !cancelled && activeRef.current) await api.setPageViewBounds(bounds());
        }).catch(() => {});
      }
    };
    pageViewControllerRef.current = {
      requestId, articleId: a.id, originalUrl: articleUrl,
      capture: () => {
        // Capture shares the native lifecycle queue, but AI generation does
        // not. A slow model must never hold up another article's page view.
        return enqueuePageView(async () => {
          if (cancelled || !activeRef.current || !open) throw new Error(t("aiFormatted.captureUnavailable"));
          return api.capturePageView(a.id, requestId);
        });
      },
      run: (action) => {
        if (cancelled || !activeRef.current || !open) return;
        beginWaiting();
        // History/reload use the same queue as close/open. A queued action
        // cannot accidentally operate on the next article's replacement view.
        void enqueuePageView(async () => {
          if (cancelled || !activeRef.current || !open) return;
          try {
            if (action === "reload") await api.reloadPageView();
            else await api.navigatePageViewHistory(action);
          } catch {
            if (!cancelled && activeRef.current) {
              clearWaitTimer();
              setPageViewState((state) => markPageViewError(state, requestId, "control"));
            }
          }
        });
      },
      sync,
    };
    setPageViewState(createPageViewState(requestId, a.id, articleUrl));
    void enqueuePageView(async () => {
      if (cancelled || !activeRef.current) return;
      try {
        // Subscribe before open: the native view may emit loading/loaded
        // before its IPC command resolves, especially for cached pages.
        const removeListener = await listen<api.PageViewStatusEvent>("page-view-status", ({ payload }) => {
          if (cancelled || !activeRef.current || !isPageViewStatusEvent(payload) || payload.requestId !== requestId) return;
          if ((payload.phase === "loading" || payload.phase === "loaded") && !safePageViewUrl(payload.url)) return;
          setPageViewState((state) => applyPageViewStatus(state, payload));
          if (payload.phase === "loading") armWaitTimer();
          else if (payload.phase === "loaded") clearWaitTimer();
          // blocked subframes stay silent; downloads may show one dismissible
          // action, but neither stops/fails the main document's load.
        });
        if (cancelled || !activeRef.current) { removeListener(); return; }
        unlisten = removeListener;
        armWaitTimer();
        // A page created for AI is hidden in the same native command, before
        // it can paint over the formatted surface. Ordinary Web stays visible.
        const initiallyVisible = readerTabRef.current === "web" && !overlayOpenRef.current;
        await api.openPageView(articleUrl, bounds(), requestId, initiallyVisible);
        open = true;
        if (cancelled || !activeRef.current) {
          await api.closePageView().catch(() => {});
          return;
        }
        // Creation does not mean the webpage finished. Only a matching
        // loaded event clears loading; a timer merely offers a waiting hint.
        setPageViewState((state) => markPageViewCreated(state, requestId));
        sync();
        await api.setPageViewVisible(readerTabRef.current === "web" && !overlayOpenRef.current).catch(() => {});
      } catch {
        clearWaitTimer();
        unlisten?.();
        unlisten = undefined;
        if (!cancelled && activeRef.current) setPageViewState((state) => markPageViewError(state, requestId, "create"));
        await api.closePageView().catch(() => {});
      }
    });

    return () => {
      cancelled = true;
      clearWaitTimer();
      unlisten?.();
      unlisten = undefined;
      if (pageViewControllerRef.current?.requestId === requestId) pageViewControllerRef.current = null;
      void enqueuePageView(() => api.closePageView()).catch(() => {});
    };
  }, [active, nativePageNeeded, articleUrl, a?.id, webOpenAttempt]);

  // The DOM host changes when the exclusive outlet moves between Web and AI.
  // Rebind ResizeObserver to that current host while leaving the native view
  // itself alive, then keep its rectangle current during pane/window resizing.
  useEffect(() => {
    const host = pageHostRef.current;
    const controller = pageViewControllerRef.current;
    if (!active || !nativePageNeeded || !host || !controller) return;
    const sync = () => {
      if (pageViewControllerRef.current === controller) controller.sync();
    };
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [active, nativePageNeeded, readerTab, formatJob?.runId, articleUrl, a?.id]);

  const runPageViewAction = (action: PageViewAction) => {
    const controller = pageViewControllerRef.current;
    if (!activeRef.current || readerTab !== "web" || formatJob?.phase === "capturing" || controller?.articleId !== a?.id || controller?.originalUrl !== articleUrl) return;
    controller?.run(action);
  };

  // Visibility: toggle the webview as overlays come and go, without reloading.
  // No-op (backend-side) when no webview is open.
  useEffect(() => {
    if (!active || !nativePageNeeded || !articleUrl) return;
    const controller = pageViewControllerRef.current;
    void enqueuePageView(async () => {
      if (activeRef.current && controller && pageViewControllerRef.current === controller) {
        await api.setPageViewVisible(readerTabRef.current === "web" && !overlayOpenRef.current);
      }
    }).catch(() => {});
  }, [active, overlayOpen, readerTab, nativePageNeeded, articleUrl]);

  const clearFormatJob = (articleId: number, runId?: number) => {
    if (!mountedRef.current) return;
    setFormatJobs((jobs) => {
      const currentRunId = runId ?? jobs[articleId]?.runId;
      return currentRunId === undefined ? jobs : settleAiFormatJob(jobs, articleId, currentRunId, null);
    });
  };

  const generateFormatted = async (articleId: number, captureId: string, language: AiFormatLanguage, runId: number, source?: AiFormatSource) => {
    setFormatJobs((jobs) => ({ ...jobs, [articleId]: { runId, phase: "formatting", captureId, error: null, source } }));
    try {
      const draft = await api.aiFormatPage(articleId, captureId, language);
      if (draft.articleId !== articleId || draft.captureId !== captureId) throw new Error(t("aiFormatted.failed"));
      // Persisted results belong to the originating article even if the user
      // has moved on. Never change the newly selected article or its tab.
      await qc.cancelQueries({ queryKey: ["ai-formatted", articleId], exact: true });
      qc.setQueryData(["ai-formatted", articleId], draft);
      clearFormatJob(articleId, runId);
    } catch (cause) {
      if (!mountedRef.current) return;
      setFormatJobs((jobs) => settleAiFormatJob(jobs, articleId, runId, errorText(cause)));
    }
  };

  const beginFormatPipeline = (articleId: number, sourceUrl: string | null) => {
    const runId = ++formatRunRef.current;
    formatCaptureClaimRef.current = null;
    setFormatJobs((jobs) => ({
      ...jobs,
      [articleId]: sourceUrl
        ? { runId, phase: "opening", captureId: null, error: null }
        : { runId, phase: "failed", captureId: null, error: t("reader.noOriginalUrl") },
    }));
    return runId;
  };

  const captureAndFormat = async (articleId: number, runId: number, language: AiFormatLanguage) => {
    if (!activeRef.current || captureBusyRef.current) return;
    const controller = pageViewControllerRef.current;
    if (controller?.articleId !== articleId || controller.originalUrl !== articleUrl) {
      setFormatJobs((jobs) => settleAiFormatJob(jobs, articleId, runId, t("aiFormatted.captureUnavailable")));
      return;
    }
    captureBusyRef.current = true;
    captureBusyChangeRef.current?.(true);
    setFormatJobs((jobs) => jobs[articleId]?.runId === runId
      ? { ...jobs, [articleId]: { ...jobs[articleId], phase: "capturing", captureId: null, error: null } }
      : jobs);
    try {
      const capture = await controller.capture();
      if (!mountedRef.current || !activeRef.current || !isCurrentCapture(articleId, controller.requestId, useUi.getState().selectedArticleId, pageViewControllerRef.current?.requestId)) {
        clearFormatJob(articleId, runId);
        return;
      }
      if (capture.articleId !== articleId || !capture.captureId || !capture.text.trim() || !safePageViewUrl(capture.sourceUrl)) throw new Error(t("aiFormatted.captureUnavailable"));
      // The formatted tab has been visible throughout. Moving to formatting
      // releases the hidden native view; model work continues independently.
      void generateFormatted(articleId, capture.captureId, language, runId, {
        sourceUrl: capture.sourceUrl, sourceTitle: capture.sourceTitle,
        sourceText: capture.text, capturedAt: capture.capturedAt, warnings: capture.warnings,
        truncated: capture.truncated, charCount: capture.charCount,
      });
    } catch (cause) {
      if (!mountedRef.current || !activeRef.current || !isCurrentCapture(articleId, controller.requestId, useUi.getState().selectedArticleId, pageViewControllerRef.current?.requestId)) {
        clearFormatJob(articleId, runId);
        return;
      }
      setFormatJobs((jobs) => settleAiFormatJob(jobs, articleId, runId, errorText(cause)));
    } finally {
      captureBusyRef.current = false;
      captureBusyChangeRef.current?.(false);
    }
  };

  // Once the user has selected AI formatted, wait for the local saved-draft
  // lookup to settle. A saved document wins without reopening or re-spending;
  // a confirmed empty result starts the hidden Web -> capture -> AI pipeline.
  useEffect(() => {
    if (!active || readerTab !== "formatted" || !a) return;
    if (formattedQuery.isFetching) return;
    if (formattedQuery.isError) {
      if (formatJob?.phase === "opening") clearFormatJob(a.id, formatJob.runId);
      return;
    }
    if (formattedDraft) {
      if (formatJob?.phase === "opening") clearFormatJob(a.id, formatJob.runId);
      return;
    }
    if (!formatJob && articleUrl) beginFormatPipeline(a.id, articleUrl);
    // beginFormatPipeline deliberately creates the missing job; subsequent
    // renders stop here. Language cannot change while the job is busy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, readerTab, a?.id, articleUrl, formattedQuery.isFetching, formattedQuery.isError, formattedDraft?.articleId, formatJob?.runId, formatJob?.phase]);

  // A native creation/control failure is terminal for this automatic run. A
  // page that still has no Finished event ten seconds after the normal 20s
  // waiting hint also becomes recoverable via the single Retry action.
  useEffect(() => {
    if (readerTab !== "formatted" || formatJob?.phase !== "opening" || !currentPageView?.error || !a) return;
    setFormatJobs((jobs) => settleAiFormatJob(jobs, a.id, formatJob.runId, t("aiFormatted.captureUnavailable")));
  }, [readerTab, formatJob?.phase, formatJob?.runId, currentPageView?.error, a?.id, t]);
  useEffect(() => {
    if (readerTab !== "formatted" || formatJob?.phase !== "opening" || !currentPageView?.waiting || !a) return;
    const articleId = a.id;
    const runId = formatJob.runId;
    const timer = window.setTimeout(() => {
      setFormatJobs((jobs) => settleAiFormatJob(jobs, articleId, runId, t("aiFormatted.captureUnavailable")));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [readerTab, formatJob?.phase, formatJob?.runId, currentPageView?.waiting, a?.id, t]);

  // Capture only after the exact native instance reports Finished. A short
  // quiet period lets dynamic article bodies settle; any new loading event
  // cancels the timer. The claim is taken before IPC to guarantee one capture.
  useEffect(() => {
    if (!active || readerTab !== "formatted" || formatJob?.phase !== "opening" || !a || formattedQuery.isFetching || formattedQuery.isError || formattedDraft) return;
    const controller = pageViewControllerRef.current;
    if (!currentPageView?.created || currentPageView.loading || currentPageView.error || controller?.articleId !== a.id || controller.originalUrl !== articleUrl || controller.requestId !== currentPageView.requestId) return;
    const articleId = a.id;
    const runId = formatJob.runId;
    const claim = `${articleId}:${runId}:${controller.requestId}`;
    if (formatCaptureClaimRef.current === claim) return;
    const timer = window.setTimeout(() => {
      const liveController = pageViewControllerRef.current;
      if (!activeRef.current || useUi.getState().selectedArticleId !== articleId || readerTabRef.current !== "formatted" || liveController !== controller || formatCaptureClaimRef.current === claim) return;
      formatCaptureClaimRef.current = claim;
      void captureAndFormat(articleId, runId, formatLanguage);
    }, 700);
    return () => window.clearTimeout(timer);
    // captureAndFormat is intentionally guarded by the run/request claim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, readerTab, formatJob?.phase, formatJob?.runId, a?.id, articleUrl, formattedQuery.isFetching, formattedQuery.isError, formattedDraft?.articleId, currentPageView?.requestId, currentPageView?.created, currentPageView?.loading, currentPageView?.error, formatLanguage]);

  const openFormatted = () => {
    if (!activeRef.current || !a) return;
    // Hide an already-visible native page immediately; the lifecycle remains
    // alive when a new opening job is batched below, so its loaded DOM can be
    // captured without a reload or a flash over the AI surface.
    if (readerTab === "web" && pageViewControllerRef.current?.articleId === a.id) {
      void api.setPageViewVisible(false).catch(() => {});
    }
    setFormattedArticleId(a.id);
    if (articleUrl && !formattedDraft && !formatJob && !formattedQuery.isError) {
      beginFormatPipeline(a.id, articleUrl);
    }
  };

  const reformat = () => {
    if (!activeRef.current || !a || formatBusy) return;
    beginFormatPipeline(a.id, articleUrl);
  };

  const retryFormatted = () => {
    if (!activeRef.current || !a || formatBusy) return;
    if (formattedQuery.isError && !formatJob) {
      void formattedQuery.refetch();
      return;
    }
    if (formatJob?.phase === "failed" && formatJob.captureId) {
      const runId = ++formatRunRef.current;
      void generateFormatted(a.id, formatJob.captureId, formatLanguage, runId, formatJob.source);
      return;
    }
    beginFormatPipeline(a.id, articleUrl);
  };

  // Recover article-body images the webview fails to load, then hide the
  // stragglers. The webview sends no Referer (see sanitize.rs) — right for
  // blacklist-style hotlink protection (*.sinaimg.cn) but fatal on hosts that
  // *require* one (cdnfile.sspai.com 403s a bare request), and the webview
  // can't vary the value per host. So a failed image gets one retry through
  // the backend, which walks Referer fallbacks (fetch_image) and returns the
  // bytes; the <img> is swapped to an inline data: URL, with the original kept
  // in data-papr-src for the context-menu actions. A data: URL (not blob:) is
  // deliberate — WKWebView/WebView2 silently drop a blob:'s backing data under
  // memory pressure (e.g. layer recompositing while scrolling), so a recovered
  // image carried by a blob: vanishes when the user scrolls away and back; the
  // inline data: bytes always repaint. Images the backend can't recover are
  // hidden — a broken-image icon mid-article is just noise. Runs whenever the
  // body changes (article switch, extract toggle, extraction finishing).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const pageUrl = a?.url;
    const timers: number[] = [];
    let alive = true;
    const recover = async (img: HTMLImageElement) => {
      const src = img.getAttribute("src") || "";
      if (img.dataset.paprRetried || !/^https?:\/\//.test(src)) {
        img.style.display = "none";
        return;
      }
      img.dataset.paprRetried = "1";
      try {
        const buf = await api.fetchImage(src, pageUrl);
        if (!alive) return;
        img.dataset.paprSrc = src;
        img.src = imageDataUrl(src, buf);
      } catch {
        img.style.display = "none";
      }
    };
    const recoverIfBroken = (img: HTMLImageElement) => {
      if (img.dataset.paprRetried) return;
      if (img.complete && img.naturalWidth === 0) void recover(img);
    };
    const onError = (e: Event) => void recover(e.currentTarget as HTMLImageElement);
    const watched: HTMLImageElement[] = [];
    el.querySelectorAll("img").forEach((img) => {
      img.addEventListener("error", onError);
      watched.push(img);
      // Proxy-eligible images (少数派/CDN hosts that reject a bare no-referrer
      // request) are rewritten to data: URLs up front by the `proxiedBody`
      // effect, so don't fetch them again here — that duplicated the backend /
      // IPC / network work for every matched image. `onError` above stays as a
      // fallback; this only retries an image that had already failed before the
      // listener attached.
      recoverIfBroken(img);
    });
    // WKWebView can finish a parser-inserted image before React's effect
    // listener is attached, and in practice not every broken image reports
    // that state synchronously. A few delayed sweeps make the fallback
    // deterministic without retrying images that are still loading.
    [250, 1000, 2500].forEach((delay) => {
      timers.push(window.setTimeout(() => watched.forEach(recoverIfBroken), delay));
    });
    return () => {
      alive = false;
      timers.forEach(window.clearTimeout);
      watched.forEach((img) => img.removeEventListener("error", onError));
    };
  }, [readerTab, a?.id, a?.url, showExtracted, a?.extractedHtml, showTranslation, a?.translatedHtml]);

  // Same proactive proxy for the reader hero. These hosts need a Referer that
  // only the Rust fetch path can provide; waiting for `onError` leaves a broken
  // image visible in WKWebView on some builds.
  useEffect(() => {
    if (!a?.imageUrl || heroDataUrl || heroBroken || !needsImageProxy(a.imageUrl)) return;
    let alive = true;
    const articleId = a.id;
    api
      .fetchImage(a.imageUrl, a.url)
      .then((buf) => {
        if (!alive || useUi.getState().selectedArticleId !== articleId) return;
        setHeroDataUrl(imageDataUrl(a.imageUrl!, buf));
      })
      .catch(() => {
        if (!alive || useUi.getState().selectedArticleId !== articleId) return;
        setHeroBroken(true);
      });
    return () => {
      alive = false;
    };
  }, [a?.id, a?.imageUrl, a?.url, heroDataUrl, heroBroken]);

  // Mark as read once when an unread article is opened (if the user opted in).
  useEffect(() => {
    if (active && a && !a.isRead && markReadOnOpen) actions.setRead(a.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, a?.id]);

  // The extracted article id travels as the mutation variable, not via the
  // `a` closure: extraction is async and the user can switch articles before
  // it resolves. Keying onSuccess off the live `a` would invalidate the wrong
  // article (the extracted text never shows on return) and toast "full text
  // extracted" while reading an unrelated, un-extracted article.
  const extract = useMutation({
    mutationFn: (articleId: number) => api.extractFulltext(articleId),
    onSuccess: (_data, articleId) => {
      qc.invalidateQueries({ queryKey: ["article", articleId] });
      // Only the article still on screen should flip into the extracted view
      // and surface the toast.
      if (useUi.getState().selectedArticleId === articleId) {
        setShowExtracted(true);
        onToast(t("reader.fullTextExtracted"));
      }
    },
    onError: (e) => reportError(e),
  });

  // The default translation target + engine, switched inline from the toolbar
  // The default target language + engine come from Settings. The toolbar can
  // override them per translation, but only temporarily: the override is not
  // written back and resets to the default when switching articles. The article's
  // cached `translatedLang` (and any running job's `lang`) is compared against the
  // effective `targetLang` to decide whether a translation is current for it.
  const translateSetting = useQuery({
    queryKey: ["setting", "translate_target_lang"],
    queryFn: () => api.getSetting("translate_target_lang"),
  });
  const defaultLang = translateSetting.data || i18n.language;
  const engineSetting = useQuery({
    queryKey: ["setting", "translate_engine"],
    queryFn: () => api.getSetting("translate_engine"),
  });
  const defaultEngine = engineSetting.data || "llm";
  // `null` = follow the default; a string = a temporary per-article override.
  const [tmpLang, setTmpLang] = useState<string | null>(null);
  const [tmpEngine, setTmpEngine] = useState<string | null>(null);
  const targetLang = tmpLang ?? defaultLang;
  const engine = tmpEngine ?? defaultEngine;
  // Drop the temporary overrides when the article changes so each article opens
  // on the configured defaults.
  useEffect(() => {
    setTmpLang(null);
    setTmpEngine(null);
  }, [id]);

  // Background translation jobs run independently of this view, so several
  // articles can translate at once and switching away never interrupts one.
  const startTranslate = useTranslationJobs((s) => s.translate);
  const job = useTranslationJobs((s) => (id != null ? s.jobs[id] : undefined));

  const hasExtracted = !!a?.extractedHtml;
  const canTranslate = !!(a?.extractedHtml || a?.contentHtml);
  const baseBody =
    (showExtracted && a?.extractedHtml ? a.extractedHtml : a?.contentHtml) || "";
  const jobForTarget = job && job.lang === targetLang ? job : undefined;
  const translating = jobForTarget?.status === "translating";
  const cachedValid = !!a?.translatedHtml && a.translatedLang === targetLang;
  const translatedBody =
    jobForTarget?.html || (cachedValid ? a?.translatedHtml ?? "" : "");
  const hasTranslation = !!translatedBody;
  const showToggle = hasTranslation || translating;
  const body = showTranslation
    ? translatedBody ||
      (translating ? `<p><em>${t("reader.translating")}</em></p>` : baseBody)
    : baseBody;
  const displayBody = proxiedBody?.source === body ? proxiedBody.html : body;
  // A short body is a clue, not proof of truncation. Keep the copy tentative
  // and both follow-up actions manual; do not auto-navigate on this heuristic.
  const mayOnlyHaveSummary = useMemo(() => {
    if (!a?.url || a.sourceType !== "rss" || showTranslation) return false;
    if (showExtracted && a.extractedHtml) return false;
    return bodyPlainText(a.contentHtml || "").trim().length < 800;
  }, [a?.url, a?.sourceType, a?.contentHtml, a?.extractedHtml, showExtracted, showTranslation]);
  // Whether the body already opens with its own image/video — if so, the hero
  // thumbnail is suppressed to avoid a redundant top image (issue #97).
  const leadsWithMedia = useMemo(() => bodyLeadsWithMedia(baseBody), [baseBody]);

  // For hosts that require a Referer (notably 少数派's image CDN), proxy image
  // URLs before injecting the HTML. This avoids relying on WKWebView's image
  // error events for parser-inserted nodes, which are not reliable in release
  // builds. The fetched bytes are inlined as data: URLs (not blob:) so they
  // survive the webview dropping blob backing data while scrolling.
  useEffect(() => {
    if (!body) {
      setProxiedBody(null);
      return;
    }
    const doc = new DOMParser().parseFromString(body, "text/html");
    const imgs = Array.from(doc.body.querySelectorAll("img")).filter((img) => {
      const src = img.getAttribute("src") || "";
      return /^https?:\/\//.test(src) && needsImageProxy(src);
    });
    if (imgs.length === 0) {
      setProxiedBody(null);
      return;
    }

    let alive = true;
    Promise.all(
      imgs.map(async (img) => {
        const src = img.getAttribute("src") || "";
        try {
          const buf = await api.fetchImage(src, a?.url);
          if (!alive) return;
          img.dataset.paprSrc = src;
          img.setAttribute("src", imageDataUrl(src, buf));
          img.removeAttribute("srcset");
          img.removeAttribute("referrerpolicy");
        } catch {
          if (!alive) return;
          img.style.display = "none";
        }
      }),
    ).then(() => {
      if (alive) setProxiedBody({ source: body, html: doc.body.innerHTML });
    });

    return () => {
      alive = false;
    };
  }, [body, a?.url]);

  // When a translation finishes, refetch the article so its persisted
  // `translatedHtml` lands in the cache — the toggle then keeps working after
  // the in-memory job is gone (e.g. reopening the article in a later session).
  useEffect(() => {
    if (id == null || !job) return;
    if (job.status === "done") {
      qc.invalidateQueries({ queryKey: ["article", id] });
    } else if (job.status === "error") {
      // The translation failed (a toast already surfaced why) — drop back to the
      // original so the view isn't stuck on an empty "translating…" state.
      setShowTranslation(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job?.status]);

  // With an "extracted" open mode in effect, a summary-only feed item is
  // upgraded to the full page the moment it's opened, so the reader never
  // shows a two-line stub. Skipped when the feed already carries the whole
  // article, when there is no source URL to fetch, or once attempted for this
  // article — so a failed fetch isn't retried on every re-render.
  const autoExtractedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || openMode !== "extracted" || !a || !a.url || a.extractedHtml) return;
    if (autoExtractedRef.current === a.id || extract.isPending) return;
    // Measure the *decoded* text, not the raw markup. A bare `<[^>]+>` tag
    // strip leaves HTML entities intact, so an entity-heavy stub
    // (`&nbsp;`-padded copy, `&mdash;`/`&amp;` runs) is over-counted — a
    // genuinely short snippet can clear the 800-char bar and wrongly look
    // "complete", leaving the reader showing the very stub auto-extract is
    // meant to replace. `bodyPlainText` decodes entities and drops markup
    // cleanly, the same measurement the reading-time estimate already uses.
    // An explicit per-feed "extracted" skips the bar entirely — the user asked
    // for the page's own text even when the feed body looks complete.
    if (feedOpenMode !== "extracted") {
      const plain = bodyPlainText(a.contentHtml || "").trim();
      if (plain.length >= 800) return; // feed already delivers the full text
    }
    autoExtractedRef.current = a.id;
    extract.mutate(a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, a?.id, a?.extractedHtml, openMode, feedOpenMode]);

  // Per-feed auto-translate: when the article's source feed opts in, translate
  // it into the configured target the moment it opens. Fires once per article
  // (guarded by `autoTranslatedRef`), only when there's a body to translate and
  // a usable cached translation in the target language isn't already present —
  // so a feed left untouched still shows its original text, and reopening a
  // cached article doesn't re-spend an API call. The toolbar toggle still lets
  // the reader flip back to the original at any time.
  const autoTranslatedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !autoTranslateFeed || !a || !canTranslate) return;
    if (autoTranslatedRef.current === a.id) return;
    autoTranslatedRef.current = a.id;
    // A fresh cached translation for the target language needs no new job;
    // just surface it. Otherwise start a background translation.
    if (!(a.translatedHtml && a.translatedLang === targetLang)) {
      startTranslate(a.id, targetLang, engine);
    }
    setShowTranslation(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, a?.id, autoTranslateFeed, canTranslate, targetLang, engine]);

  // Mark the current article read once its foot is reached. Also fires for an
  // article short enough to need no scrolling at all (`scrollHeight` already
  // within `clientHeight`) — that case produces no `scroll` event, so without
  // a render-time check a fully-visible short article would never be marked
  // read despite "mark read on scroll" being on.
  const markReadIfAtFoot = useCallback(() => {
    const el = scrollRef.current;
    if (!activeRef.current || !el || !markReadOnScroll || !a || a.isRead) return;
    if (scrollMarkedRef.current === a.id) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      scrollMarkedRef.current = a.id;
      actions.setRead(a.id, true);
    }
  }, [active, markReadOnScroll, a, actions]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolled(el.scrollTop > 8);
    markReadIfAtFoot();
  };

  // A short article that fits the viewport never fires `scroll`, so check the
  // foot condition once the body has laid out (article switch, extract toggle,
  // extraction finishing). The check is deferred briefly so body images have a
  // chance to load — measuring `scrollHeight` before they do could read a
  // too-small height and mark a genuinely long article read prematurely. The
  // `scrollMarkedRef` guard keeps it idempotent.
  useEffect(() => {
    const timer = window.setTimeout(markReadIfAtFoot, 400);
    return () => window.clearTimeout(timer);
  }, [markReadIfAtFoot, showExtracted, a?.extractedHtml, a?.contentHtml]);


  const copyLink = () => {
    if (!a?.url) return;
    navigator.clipboard.writeText(a.url).then(() => onToast(t("reader.linkCopied")), () => {});
  };
  const copyText = (text: string, toastKey: string) => {
    navigator.clipboard.writeText(text).then(() => onToast(t(toastKey)), () => {});
  };
  // Save a feed image to disk. The bytes are fetched in Rust (not the webview)
  // so the request's Referer can walk the same hotlink-protection fallbacks
  // that let these images render at all (see fetch_image). The download itself
  // reuses the app's blob-anchor mechanism.
  const saveImage = async (url: string) => {
    try {
      const buf = await api.fetchImage(url, a?.url);
      downloadBlob(new Blob([buf]), imageFilename(url));
    } catch {
      toast.error(t("reader.imageSaveFailed"));
    }
  };
  const share = () => {
    if (!a?.url) return;
    if (navigator.share) {
      navigator.share({ title: a.title, url: a.url }).catch((e) => {
        // A user-cancelled share rejects with AbortError — only fall back to
        // copying the link on a genuine failure (e.g. share unsupported).
        if ((e as Error)?.name !== "AbortError") copyLink();
      });
    } else {
      copyLink();
    }
  };

  // Article-body clicks: an image opens the full-screen viewer (issue #87), with
  // the article's other images available for ← / → navigation; anything else
  // falls through to the link handler (in-page anchors, external links).
  const linkClick = makeLinkClickHandler(a?.url ?? null);
  const handleBodyClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
    const root = bodyRef.current;
    if (img && root?.contains(img)) {
      // Use the src the DOM actually renders — a proxied data: URL when the
      // original hotlink-protected host needed a Referer — and skip hidden /
      // broken images so the gallery matches what the reader shows.
      const imgs = Array.from(
        root.querySelectorAll<HTMLImageElement>("img"),
      ).filter(
        (im) => im.style.display !== "none" && (im.currentSrc || im.getAttribute("src")),
      );
      const index = imgs.indexOf(img);
      if (index >= 0) {
        e.preventDefault();
        setLightbox({ srcs: imgs.map((im) => im.currentSrc || im.src), index });
        return;
      }
    }
    linkClick(e);
  };

  if (id == null) {
    const kbd = {
      fontFamily: "var(--mono)",
      fontSize: 10,
      padding: "1px 5px",
      border: "1px solid var(--hair)",
      borderRadius: 3,
    };
    return (
      <div className="reader" role="main">
        {(isMac || (focusMode && workspaceSwitch)) && <div className="reader-toolbar" data-tauri-drag-region>{focusMode && workspaceSwitch}</div>}
        <div className="empty" style={{ flex: 1 }}>
          <div className="glyph">
            <Icon name="rss" size={22} />
          </div>
          <div>{t("reader.emptySelectArticle")}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted-2)" }}>
            {t("reader.emptyHintPrefix")} <kbd style={kbd}>J</kbd> /{" "}
            <kbd style={kbd}>K</kbd> {t("reader.emptyHintSuffix")}
          </div>
        </div>
      </div>
    );
  }

  // An article is selected but its detail isn't loaded yet — still fetching
  // or the fetch failed. Surface that explicitly instead of falling through
  // to the "select an article" empty state, which would be misleading.
  if (!a) {
    return (
      <div className="reader" role="main">
        {(isMac || (focusMode && workspaceSwitch)) && <div className="reader-toolbar" data-tauri-drag-region>{focusMode && workspaceSwitch}</div>}
        {article.isError ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="glyph">
              <Icon name="alert" size={22} />
            </div>
            <div>{t("reader.loadError")}</div>
            <button
              className="empty-retry"
              onClick={() => article.refetch()}
              disabled={article.isFetching}
            >
              <Icon name="refresh" size={12} />
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <div className="reader-scroll">
            <div className="article reader-content" aria-hidden="true">
              <div className="sk-line" style={{ width: "28%" }} />
              <div
                className="sk-line"
                style={{ width: "82%", height: 24, marginBottom: 18 }}
              />
              <div
                className="sk-line"
                style={{ width: "44%", marginBottom: 30 }}
              />
              {Array.from({ length: 9 }).map((_, i) => (
                <div
                  key={i}
                  className="sk-line"
                  style={{ width: i % 3 === 2 ? "58%" : "100%", height: 12 }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // `hasExtracted`, `canTranslate`, `body`, `displayBody` and the translation
  // state are computed above (before the early returns) so the image-proxy and
  // recovery effects can depend on them.

  // Translate into `lang` with `eng` and show the result. Defaults come from
  // Settings; the toolbar passes temporary overrides here (not persisted). Always
  // starts a fresh job (the store skips only a duplicate in-flight one).
  const run = (lang: string, eng: string) => {
    if (!canTranslate) return;
    startTranslate(a.id, lang, eng);
    setShowTranslation(true);
  };

  const ytId = a.sourceType === "youtube" ? youtubeId(a.url) : null;

  return (
    <div className="reader" role="main">
      <div
        className={`reader-toolbar ${scrolled ? "scrolled" : ""}`}
        {...(isMac && { "data-tauri-drag-region": true })}
      >
        {focusMode && workspaceSwitch}
        <button
          className={`tb-btn ${a.isStarred ? "on" : ""}`}
          onClick={() => actions.setStarred(a.id, !a.isStarred)}
          title={t("reader.tbStar")}
          aria-label={t("reader.tbStar")}
          aria-pressed={a.isStarred}
        >
          <Icon name={a.isStarred ? "star-fill" : "star"} size={16} />
        </button>
        <button
          className={`tb-btn ${a.readLater ? "on" : ""}`}
          onClick={() => actions.setReadLater(a.id, !a.readLater)}
          title={t("reader.tbReadLater")}
          aria-label={t("reader.tbReadLater")}
          aria-pressed={a.readLater}
        >
          <Icon name={a.readLater ? "bookmark-fill" : "bookmark"} size={16} />
        </button>
        <button
          className={`tb-btn ${a.tags.length > 0 ? "on" : ""}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTagPick((p) => (p ? null : { x: r.left, y: r.bottom + 6 }));
          }}
          title={t("reader.tbTags")}
          aria-label={t("reader.tbTags")}
          aria-haspopup="menu"
          aria-expanded={tagPick != null}
        >
          <Icon name="tag" size={16} />
        </button>
        <button
          className={`tb-btn ${hasExtracted && showExtracted ? "on" : ""} ${
            extract.isPending ? "spinning" : ""
          }`}
          onClick={() =>
            hasExtracted ? setShowExtracted((v) => !v) : extract.mutate(a.id)
          }
          // Extraction needs the source URL; without one (and nothing
          // extracted yet) the button can only error, so disable it.
          disabled={extract.isPending || (!hasExtracted && !a.url)}
          title={hasExtracted ? t("reader.tbToggleFullText") : t("reader.tbExtractFullText")}
          aria-label={hasExtracted ? t("reader.tbToggleFullText") : t("reader.tbExtractFullText")}
          aria-pressed={hasExtracted ? showExtracted : undefined}
          aria-busy={extract.isPending}
        >
          <Icon name="text" size={16} />
        </button>
        <button
          className="tb-btn"
          title={t("reader.tbShare")}
          aria-label={t("reader.tbShare")}
          onClick={share}
          disabled={!a.url}
        >
          <Icon name="share" size={16} />
        </button>
        <button
          className={`tb-btn ${showTranslation ? "on" : ""}`}
          title={t("reader.tbTranslate")}
          aria-label={t("reader.tbTranslate")}
          aria-pressed={showTranslation}
          disabled={!canTranslate}
          onClick={() =>
            // One click: translate with the default language + engine, or flip
            // back to the original. Switch engine/language inline on the toggle.
            showTranslation ? setShowTranslation(false) : run(targetLang, engine)
          }
        >
          <Icon name="globe" size={16} />
        </button>
        <HighlightLayer
          // A mode round-trip replaces the body DOM even for the same article;
          // remount to bind highlights to the new body, keeping export available.
          key={`highlights-${a.id}-${readerTab}`}
          articleId={a.id}
          bodyRef={bodyRef}
          bodyVersion={displayBody}
        />
        <div className="tb-btn spacer" />
        <div className="reader-view-switch" role="group" aria-label={t("reader.viewMode")}>
          <button
            type="button"
            className={readerTab === "reader" ? "active" : ""}
            title={t("reader.readingMode")}
            aria-pressed={readerTab === "reader"}
            disabled={formatJob?.phase === "capturing"}
            onClick={() => setViewMode("reader")}
          >
            <Icon name="text" size={13} />
            {t("reader.readingMode")}
          </button>
          <button
            type="button"
            className={readerTab === "web" ? "active" : ""}
            title={a.url ? t("reader.tbWebView") : t("reader.noOriginalUrl")}
            aria-label={t("reader.tbWebView")}
            aria-pressed={readerTab === "web"}
            disabled={!a.url || formatJob?.phase === "capturing"}
            onClick={() => setViewMode("web")}
          >
            <Icon name="eye" size={13} />
            {t("reader.webMode")}
          </button>
          <button
            type="button"
            className={readerTab === "formatted" ? "active" : ""}
            title={t("aiFormatted.tabHint")}
            aria-pressed={readerTab === "formatted"}
            disabled={formatJob?.phase === "capturing"}
            onClick={openFormatted}
          >
            <Icon name="sparkle" size={13}/>
            {t("aiFormatted.tab")}
          </button>
        </div>
        <button type="button" className={`tb-btn ${exportOpen ? "on" : ""}`} title="导出图文资料包（Markdown + 图片）" aria-label="导出图文资料包" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}><Icon name="arrow-down" size={16}/></button>
        {a.url && (
          <button
            className="tb-btn"
            title={t("reader.tbOpenInBrowser")}
            aria-label={t("reader.tbOpenInBrowser")}
            disabled={!externalArticleUrl}
            onClick={() => externalArticleUrl && openUrl(externalArticleUrl).catch(reportError)}
          >
            <Icon name="open" size={16} />
          </button>
        )}
      </div>

      {exportOpen && <ArticleExportPanel key={`${a.id}:${readerTab}`} articleId={a.id} source={readerTab === "reader" ? "reading" : readerTab} requestId={pageViewControllerRef.current?.articleId === a.id ? pageViewControllerRef.current.requestId : null} captureId={formattedDraft?.articleId === a.id ? formattedDraft.captureId : null} webReady={!!currentPageView?.created && !currentPageView.loading && !currentPageView.error} onClose={() => setExportOpen(false)} onToast={onToast}/>}

      <ReaderViewOutlet
        key={readerViewKey(a.id, readerTab)}
        articleId={a.id}
        mode={readerTab}
        renderFormatted={() => (
        <div className="ai-formatted-stage">
          <AIFormatted
            articleId={a.id}
            articleTitle={a.title}
            hasUrl={Boolean(a.url)}
            draft={formattedDraft}
            loading={formattedQuery.isLoading}
            loadError={formattedQuery.isError ? errorText(formattedQuery.error) : null}
            job={formatJob}
            language={formatLanguage}
            onLanguageChange={setFormatLanguage}
            onReformat={reformat}
            onRetry={retryFormatted}
            onToast={onToast}
          />
          {nativeFormatActive && <div className="ai-format-page-host" ref={pageHostRef} aria-hidden="true"/>}
        </div>
      )}
        renderWeb={() => (
        <div className="reader-webview">
          <div className="reader-webview-bar">
            <div className="reader-web-navigation" role="group" aria-label={t("reader.webNavigation")}>
              <button type="button" title={t("reader.webBack")} aria-label={t("reader.webBack")} disabled={!currentPageView?.created || formatJob?.phase === "capturing"} onClick={() => runPageViewAction("back")}><Icon name="chevron-right" size={15} className="reader-web-back-icon"/></button>
              <button type="button" title={t("reader.webForward")} aria-label={t("reader.webForward")} disabled={!currentPageView?.created || formatJob?.phase === "capturing"} onClick={() => runPageViewAction("forward")}><Icon name="chevron-right" size={15}/></button>
              <button type="button" title={t("reader.webReload")} aria-label={t("reader.webReload")} disabled={formatJob?.phase === "capturing" || (!currentPageView?.created && webViewOpening && !currentPageView?.waiting)} onClick={() => currentPageView?.created ? runPageViewAction("reload") : setWebOpenAttempt((attempt) => attempt + 1)}><Icon name="refresh" size={14}/></button>
            </div>
            <span className="reader-webview-url" title={currentPageUrl ?? undefined}>{currentPageUrl ?? t("reader.webUnsafeUrl")}</span>
            {webViewOpening && <span className="reader-web-loading" role="status" title={currentPageView?.waiting ? t("reader.webWaitingHint") : t("common.loading")} aria-label={currentPageView?.waiting ? t("reader.webWaitingShort") : t("common.loading")}><span className="reader-web-spinner" aria-hidden="true"/>{currentPageView?.waiting && <span>{t("reader.webWaitingShort")}</span>}</span>}
          </div>
          {webBanner && currentPageView && <div className="reader-web-notice" role={webBanner === "download" ? "status" : "alert"}>
            <span>{t(webBanner === "download" ? "reader.webDownloadHint" : webBanner === "create" ? "reader.webviewUnavailable" : "reader.webControlUnavailable")}</span>
            {webBanner === "download" && currentPageView.noticeUrl && <button type="button" onClick={() => {
              const target = safePageViewUrl(currentPageView.noticeUrl);
              if (target) void openUrl(target).catch(reportError);
            }}>{t("reader.webOpenDownload")}</button>}
            {webBanner !== "download" && <button type="button" onClick={() => setWebOpenAttempt((attempt) => attempt + 1)}>{t("reader.retryWebpage")}</button>}
            <button type="button" className="reader-web-notice-close" aria-label={t("common.close")} title={t("common.close")} onClick={() => setPageViewState((state) => dismissPageViewNotice(state, currentPageView.requestId))}><Icon name="x" size={14}/></button>
          </div>}
          {/* The native child webview (page_view.rs) floats over this host —
              it's not in the DOM, so this div only reserves the space. The
              effect below measures it and positions the webview to match. */}
          <div className="reader-webview-host" ref={pageHostRef} aria-busy={webViewOpening}/>
        </div>
      )}
        renderReading={() => (
      <div
        className="reader-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onContextMenu={(e) => {
          e.preventDefault();
          // Capture what the click landed on so the menu can add image- and
          // selection-specific actions (the native menu is suppressed app-wide;
          // see main.tsx).
          const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
          const sel = window.getSelection();
          const selection =
            sel && !sel.isCollapsed ? sel.toString().trim() : "";
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            // data-papr-src holds the real address when the image was
            // recovered through the backend and src is an inline data: URL.
            imageUrl: img?.dataset.paprSrc || img?.currentSrc || img?.getAttribute("src") || undefined,
            selection: selection || undefined,
          });
        }}
      >
        <article className="article reader-content" key={a.id}>
          <button
            type="button"
            className="article-feed"
            title={t("reader.viewAllFromFeed")}
            onClick={() =>
              useUi.getState().select({ kind: "feed", value: a.feedId }, a.feedTitle)
            }
          >
            <Icon name="rss" size={13} />
            {a.feedTitle}
          </button>
          <h1 className="article-title">{a.title}</h1>
          <div className="article-meta">
            {a.author && <span className="author">{a.author}</span>}
            {a.author && a.publishedAt && <span>·</span>}
            {a.publishedAt && <span>{fullDate(a.publishedAt)}</span>}
            {showReadingTime && (
              <>
                <span>·</span>
                <span>{t("reader.readMinutes", { count: readMinutes })}</span>
              </>
            )}
            {extract.isPending && (
              <>
                <span>·</span>
                <span>{t("reader.extractingFullText")}</span>
              </>
            )}
          </div>

          {mayOnlyHaveSummary && (
            <aside className="reader-summary-hint">
              <p>{t("reader.summaryOnlyHint")}</p>
              <div className="reader-summary-actions">
                <button type="button" onClick={() => setViewMode("web")}>
                  <Icon name="eye" size={14} />
                  {t("reader.readOriginalHere")}
                </button>
                <button
                  type="button"
                  disabled={extract.isPending}
                  onClick={() => hasExtracted ? setShowExtracted(true) : extract.mutate(a.id)}
                >
                  {extract.isPending ? t("reader.extractingFullText") : hasExtracted ? t("reader.showFullText") : t("reader.tbExtractFullText")}
                </button>
              </div>
            </aside>
          )}

          {a.tags.length > 0 && (
            <div className="article-tags">
              {a.tags.map((tag) => (
                <button
                  key={tag.id}
                  className="article-tag"
                  style={{ "--tag-c": tagColor(tag.color) } as React.CSSProperties}
                  onClick={() =>
                    useUi.getState().select({ kind: "tag", value: tag.id }, tag.name)
                  }
                >
                  <span className="tag-dot" />
                  {tag.name}
                </button>
              ))}
            </div>
          )}

          {ytId ? (
            <iframe
              style={{ width: "100%", aspectRatio: "16 / 9" }}
              // Privacy-enhanced host: YouTube sets no tracking cookies
              // until the viewer actually starts the video.
              src={`https://www.youtube-nocookie.com/embed/${ytId}`}
              title={a.title}
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          ) : (
            a.imageUrl &&
            !heroBroken &&
            // Skip the hero when the body already embeds the same image, so
            // feeds that repeat their lead image don't show it twice.
            !body.includes(a.imageUrl) &&
            // Also skip it when the body opens with its own image/video — the
            // article already leads with a visual, so a separate thumbnail on
            // top would just be a redundant (often mismatched) image (#97).
            !leadsWithMedia && (
              <img
                className="reader-hero"
                src={heroDataUrl ?? a.imageUrl}
                alt=""
                // The original URL when src is a recovered data: URL, so the
                // context-menu copy/save actions see a real address.
                data-papr-src={heroDataUrl ? a.imageUrl : undefined}
                // No Referer, for the same hotlink-protection reason feed-body
                // images are sanitized this way (e.g. *.sinaimg.cn 403s a
                // request carrying our origin). See `sanitize`.
                referrerPolicy="no-referrer"
                // Same recovery as body images: hosts that *require* a Referer
                // (cdnfile.sspai.com) 403 the direct load, so retry through
                // the backend's Referer-fallback fetch before giving up.
                onError={() => {
                  // A failing data: URL means the recovered bytes weren't a
                  // renderable image — don't loop, give up.
                  if (heroDataUrl) {
                    setHeroBroken(true);
                    return;
                  }
                  const articleId = a.id;
                  api
                    .fetchImage(a.imageUrl!, a.url)
                    .then((buf) => {
                      if (useUi.getState().selectedArticleId !== articleId) return;
                      setHeroDataUrl(imageDataUrl(a.imageUrl!, buf));
                    })
                    .catch(() => {
                      if (useUi.getState().selectedArticleId !== articleId) return;
                      setHeroBroken(true);
                    });
                }}
              />
            )
          )}

          {a.enclosures
            .filter((e) => e.mimeType?.startsWith("audio"))
            .map((e, i) => {
              const isPlaying = playingSrc === e.url;
              return (
                <button
                  className={`episode ${isPlaying ? "playing" : ""}`}
                  key={`a${i}`}
                  onClick={() =>
                    playTrack({
                      articleId: a.id,
                      title: a.title,
                      feedTitle: a.feedTitle,
                      src: e.url,
                    })
                  }
                >
                  <span className="episode-play">
                    <Icon name={isPlaying ? "pause" : "play"} size={15} />
                  </span>
                  <span className="episode-text">
                    {isPlaying
                      ? t("reader.episodePlaying")
                      : t("reader.episodePlay")}
                  </span>
                </button>
              );
            })}
          {a.enclosures
            .filter((e) => e.mimeType?.startsWith("video"))
            .map((e, i) => (
              <div className="enclosure" key={`v${i}`}>
                <video controls src={e.url} />
              </div>
            ))}

          {showToggle && (
            <div className="tr-toggle" role="group" aria-label={t("reader.tbTranslate")}>
              <button
                className={!showTranslation ? "on" : ""}
                aria-pressed={!showTranslation}
                onClick={() => setShowTranslation(false)}
              >
                {t("reader.original")}
              </button>
              <button
                className={showTranslation ? "on" : ""}
                aria-pressed={showTranslation}
                onClick={() => setShowTranslation(true)}
              >
                {t("reader.translation")}
              </button>
              {/* Temporary per-article switchers — change engine or language for
                  this translation only, without touching the configured defaults;
                  switching re-translates with the new choice straight away. */}
              <select
                className="s-select tr-sel"
                value={engine}
                aria-label={t("reader.translateEngine")}
                onChange={(e) => {
                  setTmpEngine(e.target.value);
                  run(targetLang, e.target.value);
                }}
              >
                <option value="llm">{t("reader.translateEngineLlm")}</option>
                <option value="google">Google</option>
                <option value="deepl">DeepL</option>
                <option value="bing">Bing</option>
              </select>
              <select
                className="s-select tr-sel"
                value={targetLang}
                aria-label={t("reader.translateTitle")}
                onChange={(e) => {
                  setTmpLang(e.target.value);
                  run(e.target.value, engine);
                }}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              {translating && (
                <span className="tr-progress">
                  {t("reader.translating")}
                  {jobForTarget && jobForTarget.total > 0 &&
                    ` ${jobForTarget.done}/${jobForTarget.total}`}
                </span>
              )}
            </div>
          )}

          <div
            className="article-body"
            ref={bodyRef}
            onClick={handleBodyClick}
            dangerouslySetInnerHTML={{
              __html: displayBody || `<p><em>${t("reader.noContent")}</em></p>`,
            }}
          />
        </article>
      </div>
      )}/>

      {active && lightbox && (
        <Lightbox
          srcs={lightbox.srcs}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}

      <AIDrawer
        // Keyed by article id so switching articles remounts the drawer:
        // its `text` state then re-initialises from the new article's
        // summary, rather than carrying the previous one's across.
        key={readerSummaryKey(a.id)}
        open={aiOpen}
        article={a}
        onClose={() => setAiOpen(false)}
      />

      {active && tagPick && (
        <TagPicker
          articleId={a.id}
          attached={a.tags.map((tg) => tg.id)}
          x={tagPick.x}
          y={tagPick.y}
          onClose={() => setTagPick(null)}
        />
      )}

      {active && ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            ...(ctxMenu.selection
              ? [
                  {
                    icon: "copy" as const,
                    label: t("reader.ctxCopy"),
                    onClick: () => copyText(ctxMenu.selection!, "reader.textCopied"),
                  },
                ]
              : []),
            ...(ctxMenu.imageUrl
              ? [
                  {
                    icon: "arrow-down" as const,
                    label: t("reader.ctxSaveImage"),
                    onClick: () => saveImage(ctxMenu.imageUrl!),
                  },
                  {
                    icon: "copy" as const,
                    label: t("reader.ctxCopyImageAddress"),
                    onClick: () =>
                      copyText(ctxMenu.imageUrl!, "reader.imageAddressCopied"),
                  },
                ]
              : []),
            ...(ctxMenu.selection || ctxMenu.imageUrl
              ? [{ separator: true as const }]
              : []),
            {
              icon: aiOpen ? "sparkle-fill" : "sparkle",
              label: t("reader.tbAiSummary"),
              onClick: () => setAiOpen(!aiOpen),
            },
            ...(canTranslate
              ? [
                  {
                    icon: "globe",
                    label: showTranslation
                      ? t("reader.tbShowOriginal")
                      : t("reader.tbTranslate"),
                    onClick: () =>
                      showTranslation
                        ? setShowTranslation(false)
                        : run(targetLang, engine),
                  },
                ]
              : []),
            { separator: true },
            ...(a.url
              ? [{ icon: "copy", label: t("reader.tbCopyLink"), onClick: copyLink }]
              : []),
            { separator: true },
            {
              icon: focusMode ? "eye-off" : "focus",
              label: t("reader.tbFocusMode"),
              onClick: () => setFocusMode(!focusMode),
            },
          ] as MenuEntry[]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function AIDrawer({
  open,
  article,
  onClose,
}: {
  open: boolean;
  article: ArticleDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const aiWidth = useUi((s) => s.aiWidth);
  // Initialised from the article's stored summary (if any). The parent keys
  // this component by article id, so a switch remounts it and re-runs this
  // initialiser — no separate "reset on article change" effect is needed.
  const [text, setText] = useState<string | null>(article.aiSummary);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // Identifies the latest summarize run. Closing the drawer mid-stream cancels
  // an effect run but the component stays mounted (it is only moved off-screen),
  // so the underlying request keeps streaming and its promise settles later.
  // Only the run whose generation still matches may touch `busy` on settle —
  // otherwise a stale run's `finally` would either wedge the drawer on the
  // loading state or clobber a newer run's `busy` flag.
  const runRef = useRef(0);

  // Generate a summary the first time the drawer opens for an article, and
  // again whenever the user hits Retry. `failed` is in the guard so a failed
  // run isn't silently re-attempted just because the drawer was reopened.
  useEffect(() => {
    if (!open || busy || text || failed) return;
    const run = ++runRef.current;
    let cancelled = false;
    // Whether the stream settled (resolved or rejected) on its own. If the
    // cleanup runs while this is still false, the drawer was closed mid-stream
    // — the accumulated `text` is then a truncated fragment.
    let settled = false;
    // An error raised inside the stream surfaces twice: once as an `error`
    // channel event (carrying the precise provider message) and again as the
    // command's rejected promise. Toast only the first so the user does not
    // see the same failure reported twice; the `.catch` still toasts for
    // failures that abort before streaming starts (no key, bad config) and so
    // never emit an `error` event.
    let sawErrorEvent = false;
    setBusy(true);
    setText("");
    api
      .aiSummarize(article.id, (ev) => {
        if (cancelled) return;
        if (ev.type === "delta") setText((s) => (s ?? "") + ev.data);
        else if (ev.type === "error") {
          sawErrorEvent = true;
          setFailed(true);
          toast.error(ev.data);
        }
      })
      .then(() => {
        if (!cancelled) qc.invalidateQueries({ queryKey: ["article", article.id] });
      })
      .catch((e) => {
        if (!cancelled && !sawErrorEvent) {
          setFailed(true);
          reportError(e);
        }
      })
      .finally(() => {
        settled = true;
        // Clear `busy` for the current run even if it was cancelled — the
        // component is still mounted, and leaving `busy` true would wedge the
        // drawer on the loading state. Skip if a newer run has superseded us.
        if (runRef.current === run) setBusy(false);
      });
    return () => {
      cancelled = true;
      // Closed mid-stream: the backend discards an interrupted generation
      // (it is never persisted), so drop the partial fragment held here too.
      // Reopening then re-generates from scratch instead of showing — and
      // permanently freezing on — a truncated half-summary.
      if (!settled) setText(article.aiSummary);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, article.id, retry]);

  const loading = busy && !text;
  const onRetry = () => {
    setText("");
    setFailed(false);
    setRetry((n) => n + 1);
  };
  // Parse + sanitize the summary only when the text changes, not on every
  // AIDrawer re-render (e.g. each open/close toggle).
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);

  return (
    <div
      className={`ai-drawer ${open ? "open" : ""}`}
      // A labelled complementary landmark so screen-reader users can jump
      // straight to the summary.
      role="complementary"
      aria-label={t("reader.aiSummaryTitle")}
      // When closed the drawer is only moved off-screen — `inert` keeps its
      // close button and content out of the tab order and the a11y tree.
      inert={!open}
    >
      {/* Left-edge handle: dragging left widens the drawer. Hidden from the
          a11y tree while the drawer is closed (the whole drawer is `inert`). */}
      <div className="resize-handle-slot resize-handle-slot--inline">
        <ResizeHandle
          width={aiWidth}
          side="left"
          min={PANEL_BOUNDS.ai.min}
          max={PANEL_BOUNDS.ai.max}
          onResize={(w) => useUi.getState().setPanel({ aiWidth: w })}
          label={t("reader.resizeAi")}
        />
      </div>
      <div className="ai-head">
        <span className="accent-ico">
          <Icon name="sparkle-fill" size={15} />
        </span>
        <h3>{t("reader.aiSummaryTitle")}</h3>
        <button
          className="tb-btn close"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="ai-body" aria-live="polite" aria-busy={busy}>
        {loading && (
          <div className="ai-loading">
            <span className="ai-dot" />
            <span className="ai-dot" />
            <span className="ai-dot" />
            <span style={{ marginLeft: 4 }}>{t("reader.aiReadingFullText")}</span>
          </div>
        )}
        {failed && !busy && (
          <div className="ai-error">
            <Icon name="alert" size={18} />
            <span>{t("reader.aiError")}</span>
            <button className="empty-retry" onClick={onRetry}>
              <Icon name="refresh" size={12} />
              {t("common.retry")}
            </button>
          </div>
        )}
        {text && !failed && (
          <>
            <div
              className="ai-prose"
              onClick={makeLinkClickHandler(article.url)}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <div
              style={{
                fontSize: 11,
                color: "var(--muted-2)",
                marginTop: 24,
                lineHeight: 1.5,
              }}
            >
              {t("reader.aiDisclaimer")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
