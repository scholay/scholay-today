import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AiFormattedDraft } from "../types";
import { capturedSourceForPreview, formattedMarkdownFilename, isAiFormatBusy, isAiFormatLanguage, prepareObsidianMarkdown, splitMarkdownFrontmatter, type AiFormatJob, type AiFormatLanguage } from "../lib/aiFormatted";
import { renderMarkdown } from "../lib/markdown";
import { safePageViewUrl } from "../lib/pageViewState";
import { downloadFile } from "../lib/download";
import { reportError } from "../toast";
import Icon from "./Icon";
import "./ai-formatted.css";

export function AiFormatLanguageSelect({ value, onChange, disabled = false }: { value: AiFormatLanguage; onChange: (language: AiFormatLanguage) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return <select className="ai-format-language" value={value} disabled={disabled} aria-label={t("aiFormatted.language")} title={t("aiFormatted.language")} onChange={(event) => {
    if (isAiFormatLanguage(event.target.value)) onChange(event.target.value);
  }}>
    <option value="zh">简体中文</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
  </select>;
}

interface Props {
  articleId: number;
  articleTitle: string;
  hasUrl: boolean;
  draft: AiFormattedDraft | null;
  loading: boolean;
  loadError: string | null;
  job: AiFormatJob | null;
  language: AiFormatLanguage;
  onLanguageChange: (language: AiFormatLanguage) => void;
  /** Re-open, re-capture and format the current source as one pipeline. */
  onReformat: () => void;
  /** The only recovery action after loading, capture or formatting fails. */
  onRetry: () => void;
  onToast: (message: string) => void;
}

export default function AIFormatted({ articleId, articleTitle, hasUrl, draft, loading, loadError, job, language, onLanguageChange, onReformat, onRetry, onToast }: Props) {
  const { t, i18n } = useTranslation();
  const [display, setDisplay] = useState<"preview" | "source">("preview");
  const busy = isAiFormatBusy(job);
  const error = job?.error ?? loadError;
  const capturedOnly = capturedSourceForPreview(Boolean(draft), job);
  const capturedUrl = safePageViewUrl(capturedOnly?.sourceUrl);
  const parts = useMemo(() => splitMarkdownFrontmatter(draft?.markdown ?? ""), [draft?.markdown]);
  // AI output is untrusted. Callouts only become ordinary Markdown; all
  // generated HTML still goes through the app's existing allowlist sanitizer.
  const html = useMemo(() => renderMarkdown(prepareObsidianMarkdown(parts.body)), [parts.body]);
  const sourceUrl = safePageViewUrl(draft?.sourceUrl);
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(i18n.language);
  };
  const copy = async () => {
    if (!draft) return;
    try { await navigator.clipboard.writeText(draft.markdown); onToast(t("aiFormatted.copied")); }
    catch (cause) { reportError(cause); }
  };
  const onLinkClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const target = safePageViewUrl(anchor.getAttribute("href"));
    if (target) void openUrl(target).catch(reportError);
  };

  return <section className="ai-formatted" aria-label="AI formatted" aria-busy={busy || loading}>
    <div className="ai-formatted-toolbar">
      <div className="ai-formatted-display" role="group" aria-label={t("aiFormatted.display")}>
        <button type="button" aria-pressed={display === "preview"} onClick={() => setDisplay("preview")}>{t("aiFormatted.preview")}</button>
        <button type="button" disabled={!draft} aria-pressed={display === "source"} onClick={() => setDisplay("source")}>{t("aiFormatted.source")}</button>
      </div>
      <div className="ai-formatted-tools">
        <AiFormatLanguageSelect value={language} onChange={onLanguageChange} disabled={busy}/>
        {draft && !error && <button type="button" className="ai-format-action" disabled={busy || loading} title={t("aiFormatted.regenerateHint")} onClick={onReformat}><Icon name="sparkle" size={13}/>{t("aiFormatted.regenerate")}</button>}
        <button type="button" className="ai-format-icon" disabled={!draft} title={t("aiFormatted.copy")} aria-label={t("aiFormatted.copy")} onClick={() => void copy()}><Icon name="copy" size={14}/></button>
        <button type="button" className="ai-format-icon" disabled={!draft} title={t("aiFormatted.download")} aria-label={t("aiFormatted.download")} onClick={() => {
          if (draft) downloadFile(draft.markdown, formattedMarkdownFilename(draft.sourceTitle || articleTitle, articleId), "text/markdown;charset=utf-8");
        }}><Icon name="arrow-down" size={15}/></button>
      </div>
    </div>
    <div className="reader-scroll ai-formatted-scroll">
      <article className="article reader-content">
        {busy && job && <div className="ai-format-progress" role="status"><span className="reader-web-spinner" aria-hidden="true"/><span>{t(job.phase === "opening" ? "aiFormatted.opening" : job.phase === "capturing" ? "aiFormatted.capturing" : "aiFormatted.formatting")}{draft && ` · ${t("aiFormatted.previousKept")}`}{job.source && <small>{job.source.sourceUrl} · {t("aiFormatted.characters", { count: job.source.charCount })}{job.source.truncated && <span className="ai-format-truncated"> · {t("aiFormatted.truncatedHint")}</span>}</small>}</span></div>}
        {error && <div className="ai-format-error" role="alert"><div><strong>{t("aiFormatted.failed")}</strong><p>{error}</p>{draft && <p>{t("aiFormatted.previousKept")}</p>}</div><button type="button" className="ai-format-retry" onClick={onRetry}><Icon name="refresh" size={13}/>{t("common.retry")}</button></div>}
        {loading && !draft && !busy && <div className="ai-format-progress" role="status"><span className="reader-web-spinner" aria-hidden="true"/>{t("common.loading")}</div>}
        {draft ? <>
          <details className="ai-format-metadata">
            <summary><span>{t("aiFormatted.metadata")}</span><span className="ai-format-source-label" title={sourceUrl ?? undefined}>{sourceUrl ?? draft.sourceTitle}</span>{draft.sourceTruncated && <span className="ai-format-truncated">{t("aiFormatted.truncated")}</span>}</summary>
            <dl>
              <dt>{t("aiFormatted.page")}</dt><dd>{draft.sourceTitle}</dd>
              <dt>{t("aiFormatted.url")}</dt><dd>{sourceUrl ? <button type="button" onClick={() => void openUrl(sourceUrl).catch(reportError)}>{sourceUrl}</button> : draft.sourceUrl}</dd>
              <dt>{t("aiFormatted.capturedAt")}</dt><dd>{date(draft.capturedAt)}</dd>
              <dt>{t("aiFormatted.generatedAt")}</dt><dd>{date(draft.generatedAt)}</dd>
              <dt>{t("aiFormatted.model")}</dt><dd>{draft.model} · {draft.language}</dd>
              <dt>{t("aiFormatted.capturedText")}</dt><dd>{t("aiFormatted.characters", { count: draft.sourceCharCount })}{draft.sourceTruncated && ` · ${t("aiFormatted.truncatedHint")}`}</dd>
            </dl>
            {draft.warnings.length > 0 && <ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            {parts.frontmatter !== null && <details><summary>Frontmatter</summary><pre>{parts.frontmatter}</pre></details>}
            <details><summary>{t("aiFormatted.capturedText")}</summary><pre>{draft.sourceText}</pre></details>
          </details>
          {display === "preview" ? <div className="article-body ai-formatted-body" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: html }}/> : <textarea className="ai-formatted-source" readOnly spellCheck={false} aria-label={t("aiFormatted.source")} value={draft.markdown}/>}
          <p className="ai-format-footnote">{t("aiFormatted.reviewHint")}</p>
        </> : capturedOnly ? <div className="ai-formatted-capture-preview">
          <h2 className="ai-format-status-title">{capturedOnly.sourceTitle || articleTitle}</h2>
          {!busy && <p className="ai-format-captured-hint">{t("aiFormatted.capturedHint")}</p>}
          <div className="ai-format-metadata">
            <dl>
              <dt>{t("aiFormatted.url")}</dt><dd>{capturedUrl ? <button type="button" onClick={() => void openUrl(capturedUrl).catch(reportError)}>{capturedUrl}</button> : capturedOnly.sourceUrl}</dd>
              <dt>{t("aiFormatted.capturedAt")}</dt><dd>{date(capturedOnly.capturedAt)}</dd>
              <dt>{t("aiFormatted.capturedText")}</dt><dd>{t("aiFormatted.characters", { count: capturedOnly.charCount })}{capturedOnly.truncated && <span className="ai-format-truncated"> · {t("aiFormatted.truncatedHint")}</span>}</dd>
            </dl>
            {capturedOnly.warnings.length > 0 && <ul>{capturedOnly.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          </div>
          <textarea className="ai-formatted-source" readOnly spellCheck={false} aria-label={t("aiFormatted.capturedText")} value={capturedOnly.sourceText}/>
        </div> : !loading && !error && <div className="ai-formatted-empty">
          <h2 className="ai-format-status-title">{job?.source?.sourceTitle || articleTitle}</h2>
          <p>{hasUrl ? t("aiFormatted.emptyHint") : t("reader.noOriginalUrl")}</p>
        </div>}
      </article>
    </div>
  </section>;
}
