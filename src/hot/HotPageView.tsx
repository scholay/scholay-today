import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import Icon from "../components/Icon";
import { enqueuePageView, nextPageViewRequestId } from "../lib/pageViewQueue";
import { isPageViewStatusEvent, safePageViewUrl, type PageViewAction } from "../lib/pageViewState";
import { reportError } from "../toast";
import { applyHotPageViewStatus, createHotPageViewState, hotPageViewForUrl, updateHotPageView, waitForHotPageView, type HotPageViewState } from "./hotPageViewState";
import "../components/reader-web-controls.css";
import "./hot-page-view.css";

export interface HotPageViewProps {
  url: string;
  active: boolean;
  onClose?: () => void;
}

/** An independent source-page viewer. It neither selects an RSS article nor
 * starts extraction, translation, capture, or an AI request. */
export default function HotPageView({ url, active, onClose }: HotPageViewProps) {
  const { t } = useTranslation();
  const sourceUrl = safePageViewUrl(url);
  const [state, setState] = useState<HotPageViewState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const controllerRef = useRef<{ requestId: string; run: (action: PageViewAction) => void } | null>(null);
  const current = hotPageViewForUrl(state, sourceUrl);
  const externalUrl = safePageViewUrl(current?.currentUrl ?? sourceUrl);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || !sourceUrl || !host) return;
    const requestId = nextPageViewRequestId("hot");
    let cancelled = false;
    let open = false;
    let unlisten: UnlistenFn | undefined;
    let waitTimer: number | undefined;
    const bounds = () => {
      const rect = host.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    };
    const clearWaitTimer = () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      waitTimer = undefined;
    };
    const armWaitTimer = () => {
      clearWaitTimer();
      waitTimer = window.setTimeout(() => {
        if (!cancelled && activeRef.current) setState((value) => waitForHotPageView(value, requestId));
      }, 20_000);
    };
    const beginWaiting = () => {
      setState((value) => updateHotPageView(value, requestId, { loading: true, waiting: false, error: null, downloadUrl: null }));
      armWaitTimer();
    };
    controllerRef.current = {
      requestId,
      run: (action) => {
        if (cancelled || !activeRef.current || !open) return;
        beginWaiting();
        void enqueuePageView(async () => {
          if (cancelled || !activeRef.current || !open) return;
          try {
            if (action === "reload") await api.reloadPageView();
            else await api.navigatePageViewHistory(action);
          } catch {
            if (!cancelled && activeRef.current) {
              clearWaitTimer();
              setState((value) => updateHotPageView(value, requestId, { loading: false, waiting: false, error: "control" }));
            }
          }
        });
      },
    };
    setState(createHotPageViewState(requestId, sourceUrl));

    // Both workspaces enqueue cleanup before replacement setup. This shared
    // queue also handles a slow, already-running open before the old close.
    void enqueuePageView(async () => {
      if (cancelled || !activeRef.current) return;
      try {
        const removeListener = await listen<api.PageViewStatusEvent>("page-view-status", ({ payload }) => {
          if (cancelled || !activeRef.current || !isPageViewStatusEvent(payload) || payload.requestId !== requestId) return;
          if ((payload.phase === "loading" || payload.phase === "loaded") && !safePageViewUrl(payload.url)) return;
          setState((value) => applyHotPageViewStatus(value, payload));
          if (payload.phase === "loading") armWaitTimer();
          else if (payload.phase === "loaded") clearWaitTimer();
        });
        if (cancelled || !activeRef.current) { removeListener(); return; }
        unlisten = removeListener;
        armWaitTimer();
        await api.openPageView(sourceUrl, bounds(), requestId);
        open = true;
        if (cancelled || !activeRef.current) {
          await api.closePageView().catch(() => {});
          return;
        }
        // A fast loaded event may precede the open response. Creation must not
        // put an already-loaded page back into a permanent loading state.
        setState((value) => updateHotPageView(value, requestId, { created: true }));
      } catch {
        clearWaitTimer();
        unlisten?.();
        unlisten = undefined;
        if (!cancelled && activeRef.current) {
          setState((value) => updateHotPageView(value, requestId, { created: false, loading: false, waiting: false, error: "create" }));
        }
        await api.closePageView().catch(() => {});
      }
    });

    const sync = () => {
      if (!open || cancelled || !activeRef.current) return;
      void enqueuePageView(async () => {
        if (open && !cancelled && activeRef.current) await api.setPageViewBounds(bounds());
      }).catch(() => {});
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    return () => {
      cancelled = true;
      clearWaitTimer();
      unlisten?.();
      unlisten = undefined;
      if (controllerRef.current?.requestId === requestId) controllerRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void enqueuePageView(() => api.closePageView()).catch(() => {});
    };
  }, [active, sourceUrl, attempt]);

  const run = (action: PageViewAction) => {
    if (activeRef.current) controllerRef.current?.run(action);
  };
  const retry = () => { if (activeRef.current) setAttempt((value) => value + 1); };
  const externalOpen = (target: string | null) => {
    const safe = safePageViewUrl(target);
    if (activeRef.current && safe) void openUrl(safe).catch(reportError);
  };

  return (
    <section className="reader-webview hot-page-view" aria-label={t("reader.webMode")} data-hot-page-view>
      <div className="reader-webview-bar">
        <div className="reader-web-navigation" role="group" aria-label={t("reader.webNavigation")}>
          <button type="button" title={t("reader.webBack")} aria-label={t("reader.webBack")} disabled={!active || !current?.created} onClick={() => run("back")}><Icon name="chevron-right" size={15} className="reader-web-back-icon"/></button>
          <button type="button" title={t("reader.webForward")} aria-label={t("reader.webForward")} disabled={!active || !current?.created} onClick={() => run("forward")}><Icon name="chevron-right" size={15}/></button>
          <button type="button" title={t("reader.webReload")} aria-label={t("reader.webReload")} disabled={!active || !sourceUrl || (!current?.created && !!current?.loading && !current.waiting)} onClick={() => current?.created ? run("reload") : retry()}><Icon name="refresh" size={14}/></button>
        </div>
        <span className="reader-webview-url" title={externalUrl ?? undefined}>{externalUrl ?? t("reader.webUnsafeUrl")}</span>
        {current?.loading && <span className="reader-web-loading" role="status" title={current.waiting ? t("reader.webWaitingHint") : t("common.loading")} aria-label={current.waiting ? t("reader.webWaitingShort") : t("common.loading")}><span className="reader-web-spinner" aria-hidden="true"/>{current.waiting && <span>{t("reader.webWaitingShort")}</span>}</span>}
        <div className="reader-web-navigation">
          <button type="button" title={t("reader.tbOpenInBrowser")} aria-label={t("reader.tbOpenInBrowser")} disabled={!active || !externalUrl} onClick={() => externalOpen(externalUrl)}><Icon name="open" size={15}/></button>
          {onClose && <button type="button" title={t("common.close")} aria-label={t("common.close")} disabled={!active} onClick={onClose}><Icon name="x" size={15}/></button>}
        </div>
      </div>
      {current && (current.error || current.downloadUrl) && <div className="reader-web-notice" role={current.error ? "alert" : "status"}>
        <span>{t(current.error === "create" ? "reader.webviewUnavailable" : current.error === "control" ? "reader.webControlUnavailable" : "reader.webDownloadHint")}</span>
        {current.error ? <button type="button" disabled={!active} onClick={retry}>{t("reader.retryWebpage")}</button> : <button type="button" disabled={!active} onClick={() => externalOpen(current.downloadUrl)}>{t("reader.webOpenDownload")}</button>}
        <button type="button" className="reader-web-notice-close" disabled={!active} title={t("common.close")} aria-label={t("common.close")} onClick={() => setState((value) => updateHotPageView(value, current.requestId, { error: null, downloadUrl: null }))}><Icon name="x" size={14}/></button>
      </div>}
      <div className="reader-webview-host" ref={hostRef} aria-busy={!!current?.loading}/>
    </section>
  );
}
