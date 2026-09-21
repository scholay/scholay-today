import { isPageViewStatusEvent, safePageViewUrl } from "../lib/pageViewState";

export function isBaiduVerificationUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "wappass.baidu.com" && url.pathname.startsWith("/static/captcha/");
  } catch { return false; }
}

/** Verification tokens belong to the embedded browser's session. Send the
 * original destination to an external browser, never that transient URL. */
export function hotExternalUrl(original: string | null, current: string | null): string | null {
  return safePageViewUrl(isBaiduVerificationUrl(current) ? original : current ?? original);
}

/** A source webpage is not an RSS article and never enters the article store. */
export interface HotPageViewState {
  requestId: string;
  originalUrl: string;
  currentUrl: string;
  created: boolean;
  loading: boolean;
  waiting: boolean;
  error: "create" | "control" | null;
  downloadUrl: string | null;
}

export function createHotPageViewState(requestId: string, url: string): HotPageViewState {
  return { requestId, originalUrl: url, currentUrl: url, created: false, loading: true, waiting: false, error: null, downloadUrl: null };
}

export function hotPageViewForUrl(state: HotPageViewState | null, url: string | null): HotPageViewState | null {
  return state?.originalUrl === url ? state : null;
}

export function updateHotPageView(
  state: HotPageViewState | null,
  requestId: string,
  patch: Partial<Pick<HotPageViewState, "created" | "loading" | "waiting" | "error" | "downloadUrl">>,
): HotPageViewState | null {
  return state?.requestId === requestId ? { ...state, ...patch } : state;
}

export function waitForHotPageView(state: HotPageViewState | null, requestId: string): HotPageViewState | null {
  return state?.requestId === requestId && state.loading ? { ...state, waiting: true } : state;
}

export function applyHotPageViewStatus(state: HotPageViewState | null, event: unknown): HotPageViewState | null {
  if (!state || !isPageViewStatusEvent(event) || state.requestId !== event.requestId || event.phase === "blocked") return state;
  if (event.phase === "download") {
    // A download is a separate explicit action, never a navigation or a file
    // fetched on the user's behalf. Unsafe targets remain silent.
    const downloadUrl = safePageViewUrl(event.url);
    return state.error || !downloadUrl ? state : { ...state, downloadUrl };
  }
  const currentUrl = safePageViewUrl(event.url);
  if (!currentUrl) return state;
  return { ...state, currentUrl, loading: event.phase === "loading", waiting: false, error: null, downloadUrl: null };
}
