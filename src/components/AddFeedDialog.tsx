import { useMutation, useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import { useArticleActions } from "../hooks/articleActions";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { errorText } from "../lib/errors";
import { NO_AUTOCORRECT } from "../lib/inputProps";
import { reportError } from "../toast";
import type { DiscoveryResult } from "../types";
import Icon from "./Icon";

const WECHRSS_ENDPOINT = "http://127.0.0.1:8080";

interface Props {
  onClose: () => void;
  onToast: (msg: string) => void;
  /** Feed URL to prefill the dialog with — set by a `papr://` deep link. */
  initialUrl?: string;
}

/** Subscribe to an RSS source by URL or discovery result. */
export default function AddFeedDialog({ onClose, onToast, initialUrl }: Props) {
  const { t, i18n } = useTranslation();
  const actions = useArticleActions();
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef);

  // ── RSS subscription state ──
  const [url, setUrl] = useState(initialUrl ?? "");
  const [folderId, setFolderId] = useState<number | null>(null);
  const folders = useQuery({ queryKey: ["folders"], queryFn: api.listFolders });
  // Experimental, optional helper: reachability only. Authentication, cookies
  // and account state remain in the local WechRss service, never in Papr.
  const wechatConnector = useQuery({
    queryKey: ["wechat-connector-status"],
    queryFn: api.wechatConnectorStatus,
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  // A `papr://subscribe` deep link can arrive while the dialog is already
  // open (the user opened it manually first). `useState(initialUrl)` only
  // reads the prop on mount, so without this the new feed URL would be
  // silently dropped. Sync prop changes so the prefilled URL stays visible.
  useEffect(() => {
    if (initialUrl) {
      setUrl(initialUrl);
    }
  }, [initialUrl]);

  // Returning from the local WechRss page after a QR scan should update the
  // status immediately. This listener exists only while Add Feed is open.
  useEffect(() => {
    const checkAgain = () => void wechatConnector.refetch();
    window.addEventListener("focus", checkAgain);
    return () => window.removeEventListener("focus", checkAgain);
  }, [wechatConnector.refetch]);

  // ── discovery (feature F6): debounced search of the curated directory
  // plus a live page scrape when the query looks like a URL. ──
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(url.trim()), 280);
    return () => window.clearTimeout(handle);
  }, [url]);

  const discovery = useQuery({
    queryKey: ["discover", debounced, i18n.language],
    queryFn: () => api.searchFeedDirectory(debounced, i18n.language),
    // Only search once there's a meaningful query; the scrape can be slow.
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });

  // Group directory results by category; live page-scrape results (no
  // category) are kept in their own leading group.
  const grouped = useMemo(() => {
    const results = discovery.data ?? [];
    const scraped: DiscoveryResult[] = [];
    const byCategory = new Map<string, DiscoveryResult[]>();
    for (const r of results) {
      if (!r.fromDirectory || !r.category) {
        scraped.push(r);
      } else {
        const list = byCategory.get(r.category) ?? [];
        list.push(r);
        byCategory.set(r.category, list);
      }
    }
    return { scraped, byCategory };
  }, [discovery.data]);

  const add = useMutation({
    mutationFn: (target: string) => api.addFeed(target, folderId),
    onSuccess: (feed) => {
      // Adding a feed touches only the article-bearing caches — refreshing
      // unrelated ones (AI summaries, settings, storage) is wasted work.
      actions.refreshAfterBulk();
      onToast(t("addFeed.subscribed", { title: feed.title }));
      onClose();
    },
  });

  const submit = () => {
    if (url.trim() && !add.isPending) add.mutate(url.trim());
  };

  /** Subscribe directly from a discovery result row. */
  const subscribeResult = (r: DiscoveryResult) => {
    if (!add.isPending) add.mutate(r.feedUrl);
  };

  // Escape closes the dialog from anywhere inside it, not just the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const showDiscovery = debounced.length >= 2;
  const hasResults =
    grouped.scraped.length > 0 || grouped.byCategory.size > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-add-feed"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="addfeed-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="addfeed-dialog-title">{t("addFeed.title")}</h2>

        <p className="modal-hint">{t("addFeed.hint")}</p>
        <section className="wechat-feed-entry" aria-labelledby="wechat-feed-entry-title">
          <div className="wechat-feed-entry-head">
            <div>
              <strong id="wechat-feed-entry-title">{t("addFeed.wechatTitle")}</strong>
              <span className="wechat-experimental">{t("addFeed.wechatExperimental")}</span>
            </div>
            <div className="wechat-connector-status" role="status" aria-live="polite">
              <span
                className={`wechat-status-dot ${wechatConnector.data?.reachable ? "is-online" : ""}`}
                aria-hidden="true"
              />
              <span>
                {wechatConnector.isPending
                  ? t("addFeed.wechatChecking")
                  : wechatConnector.data?.reachable
                    ? t("addFeed.wechatOnline")
                    : t("addFeed.wechatOffline")}
              </span>
              <button
                type="button"
                className={`wechat-status-refresh ${wechatConnector.isFetching ? "spinning" : ""}`}
                disabled={wechatConnector.isFetching}
                aria-label={t("addFeed.wechatRefreshStatus")}
                title={t("addFeed.wechatRefreshStatus")}
                onClick={() => void wechatConnector.refetch()}
              >
                <Icon name="refresh" size={12} />
              </button>
            </div>
          </div>
          <p>{t("addFeed.wechatHint")}</p>
          <div className="wechat-feed-entry-actions">
            <button
              type="button"
              className="s-btn"
              onClick={() =>
                void openUrl(wechatConnector.data?.endpoint ?? WECHRSS_ENDPOINT).catch(reportError)
              }
            >
              <Icon name="open" size={12} />
              {wechatConnector.data?.reachable
                ? t("addFeed.wechatRescan")
                : t("addFeed.wechatConnect")}
            </button>
            <button
              type="button"
              className="s-btn"
              onClick={() => {
                urlRef.current?.focus();
                urlRef.current?.select();
              }}
            >
              <Icon name="rss" size={12} />
              {t("addFeed.wechatPasteRss")}
            </button>
          </div>
        </section>
        <input
          ref={urlRef}
          className="modal-input"
          type="text"
          autoFocus
          placeholder={t("addFeed.discoverPlaceholder")}
          aria-label={t("addFeed.urlLabel")}
          {...NO_AUTOCORRECT}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            // Ignore the Enter that only confirms an IME candidate.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
        />

        {/* Discovery results — curated directory + live page scrape. */}
        {showDiscovery && (
          <div className="discover-results" role="listbox">
            {discovery.isLoading && (
              <div className="discover-empty">
                {t("addFeed.discoverSearching")}
              </div>
            )}
            {/* A failed search must not masquerade as "no feeds found". */}
            {!discovery.isLoading && discovery.isError && (
              <div className="discover-empty">
                {t("addFeed.discoverError")}
              </div>
            )}
            {!discovery.isLoading && !discovery.isError && !hasResults && (
              <div className="discover-empty">
                {t("addFeed.discoverNoResults")}
              </div>
            )}
            {grouped.scraped.length > 0 && (
              <div className="discover-group">
                <div className="discover-group-label">
                  {t("addFeed.discoverFromPage")}
                </div>
                {grouped.scraped.map((r) => (
                  <DiscoverRow
                    key={r.feedUrl}
                    result={r}
                    disabled={add.isPending}
                    onSubscribe={() => subscribeResult(r)}
                    addLabel={t("addFeed.discoverAdd")}
                  />
                ))}
              </div>
            )}
            {[...grouped.byCategory.entries()].map(([cat, rows]) => (
              <div className="discover-group" key={cat}>
                <div className="discover-group-label">{cat}</div>
                {rows.map((r) => (
                  <DiscoverRow
                    key={r.feedUrl}
                    result={r}
                    disabled={add.isPending}
                    onSubscribe={() => subscribeResult(r)}
                    addLabel={t("addFeed.discoverAdd")}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {(folders.data?.length ?? 0) > 0 && (
          <select
            className="s-select"
            style={{ width: "100%" }}
            aria-label={t("addFeed.folderLabel")}
            value={folderId ?? ""}
            onChange={(e) =>
              setFolderId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">{t("addFeed.noFolder")}</option>
            {folders.data!.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        {add.isError && (
          <div className="modal-error">{errorText(add.error)}</div>
        )}

        <div className="modal-actions">
          <button className="s-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="s-btn primary"
            onClick={submit}
            disabled={!url.trim() || add.isPending}
          >
            <Icon name="plus" size={12} />
            {add.isPending ? t("addFeed.adding") : t("addFeed.subscribe")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One discovery result row with a quick-subscribe button. */
function DiscoverRow({
  result,
  disabled,
  onSubscribe,
  addLabel,
}: {
  result: DiscoveryResult;
  disabled: boolean;
  onSubscribe: () => void;
  addLabel: string;
}) {
  return (
    <div className="discover-row" role="option" aria-selected={false}>
      <div className="discover-text">
        <span className="discover-title">{result.title}</span>
        {result.description && (
          <span className="discover-desc">{result.description}</span>
        )}
        {!result.description && (
          <span className="discover-desc discover-url">{result.feedUrl}</span>
        )}
      </div>
      <button
        className="s-btn discover-add"
        onClick={onSubscribe}
        disabled={disabled}
        aria-label={`${addLabel} — ${result.title}`}
      >
        <Icon name="plus" size={11} />
        {addLabel}
      </button>
    </div>
  );
}
