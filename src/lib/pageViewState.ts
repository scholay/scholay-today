export type PageViewPhase = "loading" | "loaded" | "blocked" | "download";
export interface PageViewStatusEvent {
  requestId: string;
  url: string;
  phase: PageViewPhase;
}
export type PageViewAction = "back" | "forward" | "reload";
export interface PageViewState {
  requestId: string;
  articleId: number;
  originalUrl: string;
  currentUrl: string | null;
  created: boolean;
  loading: boolean;
  waiting: boolean;
  error: "create" | "control" | null;
  notice: "download" | null;
  noticeUrl: string | null;
}

/** External-open actions must never accept a custom/local executable scheme. */
export function safePageViewUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export function createPageViewState(requestId: string, articleId: number, originalUrl: string): PageViewState {
  return {
    requestId, articleId, originalUrl, currentUrl: safePageViewUrl(originalUrl),
    created: false, loading: true, waiting: false, error: null, notice: null, noticeUrl: null,
  };
}

export function pageViewForArticle(state: PageViewState | null, articleId: number | undefined, originalUrl: string | null): PageViewState | null {
  return state && state.articleId === articleId && state.originalUrl === originalUrl ? state : null;
}

/** A previous article's redirected URL must never leak into this article's Open action. */
export function pageViewExternalUrl(state: PageViewState | null, articleId: number | undefined, originalUrl: string | null): string | null {
  return pageViewForArticle(state, articleId, originalUrl)?.currentUrl ?? safePageViewUrl(originalUrl);
}

export function markPageViewCreated(state: PageViewState | null, requestId: string): PageViewState | null {
  return state?.requestId === requestId ? { ...state, created: true } : state;
}

export function startPageViewWait(state: PageViewState | null, requestId: string): PageViewState | null {
  return state?.requestId === requestId
    ? { ...state, loading: true, waiting: false, error: null, notice: null, noticeUrl: null }
    : state;
}

/** Twenty seconds without Finished is "still waiting", not proof of a failed site. */
export function markPageViewWaiting(state: PageViewState | null, requestId: string): PageViewState | null {
  return state?.requestId === requestId && state.loading ? { ...state, waiting: true } : state;
}

export function markPageViewError(state: PageViewState | null, requestId: string, error: "create" | "control"): PageViewState | null {
  return state?.requestId === requestId
    ? { ...state, created: error === "create" ? false : state.created, loading: false, waiting: false, error, notice: null, noticeUrl: null }
    : state;
}

/** At most one actionable banner; loading, waiting and blocked frames have none. */
export function pageViewBanner(state: PageViewState | null): "create" | "control" | "download" | null {
  return state?.error ?? state?.notice ?? null;
}

/** Dismissing a banner must not navigate, restart loading or change the address. */
export function dismissPageViewNotice(state: PageViewState | null, requestId: string): PageViewState | null {
  return state?.requestId === requestId ? { ...state, error: null, notice: null, noticeUrl: null } : state;
}

export function isPageViewStatusEvent(value: unknown): value is PageViewStatusEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<PageViewStatusEvent>;
  return typeof event.requestId === "string" && typeof event.url === "string"
    && ["loading", "loaded", "blocked", "download"].includes(event.phase ?? "");
}

export function applyPageViewStatus(state: PageViewState | null, event: unknown): PageViewState | null {
  if (!state || !isPageViewStatusEvent(event) || state.requestId !== event.requestId) return state;
  // Native security still rejects the request. Subframes/custom schemes are
  // routine browser noise, not a visible warning or a failed main page.
  if (event.phase === "blocked") return state;
  if (event.phase === "download") {
    if (state.error) return state;
    // A download target is not the address currently shown in the native view.
    return { ...state, notice: "download", noticeUrl: safePageViewUrl(event.url) };
  }
  const currentUrl = safePageViewUrl(event.url);
  if (!currentUrl) return state;
  return {
    ...state, currentUrl, loading: event.phase === "loading", waiting: false, error: null,
    notice: null, noticeUrl: null,
  };
}
