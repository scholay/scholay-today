import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import { enqueuePageView } from "../lib/pageViewQueue";
import { formatPageZoom, isPageViewZoomEvent, type PageZoomAction, type PageViewZoomEvent } from "../lib/pageViewZoom";
import Icon from "./Icon";

const initialZoom = { requestId: "", factor: 1, mode: "fit" as const };

/** Fit-to-pane plus explicit zoom. Native child pages have no IPC hotkeys. */
export default function WebZoomControls({ disabled = false, requestId }: { disabled?: boolean; requestId?: string }) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState<PageViewZoomEvent>(initialZoom);

  useEffect(() => {
    setZoom(initialZoom);
    if (!requestId) return;
    let cancelled = false;
    const unlisten = listen("page-view-zoom", ({ payload }) => {
      if (cancelled || !isPageViewZoomEvent(payload) || payload.requestId !== requestId) return;
      setZoom(payload);
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, [requestId]);

  const run = (action: PageZoomAction) => {
    if (disabled || !requestId) return;
    void enqueuePageView(async () => {
      const next = await api.setPageViewZoom(action);
      if (isPageViewZoomEvent(next) && next.requestId === requestId) setZoom(next);
    }).catch(() => {});
  };

  const label = formatPageZoom(zoom.factor);
  return <div className="reader-web-zoom" role="group" aria-label={t("reader.webZoom")}>
    <button type="button" title={t("reader.webZoomOut")} aria-label={t("reader.webZoomOut")} disabled={disabled} onClick={() => run("out")}><Icon name="minus" size={14}/></button>
    <button type="button" className="reader-web-zoom-factor" title={t("reader.webZoomReset")} aria-label={t("reader.webZoomReset", { percent: label })} disabled={disabled} onClick={() => run("reset")}>{label}</button>
    <button type="button" title={t("reader.webZoomIn")} aria-label={t("reader.webZoomIn")} disabled={disabled} onClick={() => run("in")}><Icon name="plus" size={14}/></button>
    <button type="button" className="reader-web-zoom-fit" title={t("reader.webZoomFit")} aria-label={t("reader.webZoomFit")} aria-pressed={zoom.mode === "fit"} disabled={disabled} onClick={() => run("fit")}>{t("reader.webZoomFitShort")}</button>
  </div>;
}
