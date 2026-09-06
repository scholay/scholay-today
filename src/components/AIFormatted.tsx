import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AiFormattedDraft } from "../types";
import { capturedSourceForPreview, formattedMarkdownFilename, isAiFormatBusy, isAiFormatLanguage, prepareObsidianMarkdown, splitMarkdownFrontmatter, type AiFormatJob, type AiFormatLanguage } from "../lib/aiFormatted";
import { capturedImageSources, renderMarkdown } from "../lib/markdown";
import { fetchCapturedImage } from "../api";
import { imageDataUrl } from "../lib/imageBytes";
import { activeMarkdownHeading, prepareMarkdownReading, type MarkdownHeading } from "../lib/markdownReading";
import MarkdownOutline from "./MarkdownOutline";
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
  // The backend restored these links from protected capture placeholders;
  // every fetch also checks exact asset ownership against the stored snapshot.
  const images = useMemo(() => capturedImageSources(parts.body), [parts.body]);
  // AI output is untrusted. Callouts only become ordinary Markdown; all
  // generated HTML still goes through the app's existing allowlist sanitizer.
  const reading = useMemo(() => prepareMarkdownReading(renderMarkdown(prepareObsidianMarkdown(parts.body), images), articleId), [parts.body, images, articleId]);
  const html = reading.html;
  // Scroll-spy updates must not replace the body DOM: it owns hydrated image
  // URLs, the focused heading and the user's text selection.
  const previewMarkup = useMemo(() => ({ __html: html }), [html]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const outlineButtonRef = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(false);
  const [outlineExpanded, setOutlineExpanded] = useState<boolean | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const hasOutline = display === "preview" && reading.headings.length > 0;
  const showOutline = hasOutline && (outlineExpanded ?? wide);
  const outlineId = `md-outline-${articleId}`;
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const measure = () => setWide(section.getBoundingClientRect().width >= 760);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(section);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const scroll = scrollRef.current;
    const body = bodyRef.current;
    if (!scroll || !body || display !== "preview") return;
    const nodes = reading.headings.map(heading => body.querySelector<HTMLElement>(`#${heading.id}`));
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scroll.getBoundingClientRect().top + 28;
      const maxScroll = scroll.scrollHeight - scroll.clientHeight;
      const index = activeMarkdownHeading(nodes.map(node => node?.getBoundingClientRect().top ?? Infinity), line, maxScroll > 1 && scroll.scrollTop >= maxScroll - 2);
      setActiveId(reading.headings[index]?.id ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(body);
    resize.observe(scroll);
    scroll.addEventListener("scroll", schedule, { passive: true });
    body.addEventListener("load", schedule, true);
    update();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); scroll.removeEventListener("scroll", schedule); body.removeEventListener("load", schedule, true); };
  }, [reading, display]);
  const closeOutline = () => { setOutlineExpanded(false); outlineButtonRef.current?.focus(); };
  const navigateHeading = (heading: MarkdownHeading) => {
    const target = bodyRef.current?.querySelector<HTMLElement>(`#${heading.id}`);
    const scroll = scrollRef.current;
    if (!target || !scroll) return;
    scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 22,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    setActiveId(heading.id);
    target.focus({ preventScroll: true });
    if (!wide) setOutlineExpanded(false);
  };
  useEffect(() => {
    if (display !== "preview" || !draft || !bodyRef.current) return;
    let alive = true;
    const queue = Array.from(bodyRef.current.querySelectorAll<HTMLImageElement>("img[data-captured-src]"));
    const load = async () => {
      while (alive && queue.length) {
        const img = queue.shift()!;
        const src = img.dataset.capturedSrc!;
        try {
          const bytes = await fetchCapturedImage(articleId, draft.captureId, src);
          if (alive) img.src = imageDataUrl(src, bytes);
        } catch {
          if (!alive) return;
          const link = document.createElement("a");
          link.href = src;
          link.textContent = t("aiFormatted.imageUnavailable", { alt: img.alt || t("aiFormatted.image") });
          link.className = "ai-format-image-unavailable";
          img.replaceWith(link);
        }
      }
    };
    // Bounded concurrency; switching articles stops queued work and prevents
    // an old response from modifying the next article's DOM.
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, load));
    return () => { alive = false; };
  }, [html, articleId, draft?.captureId, display, t]);
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

  return <section ref={sectionRef} className="ai-formatted" aria-label={t("aiFormatted.tab")} aria-busy={busy || loading}>
    <div className="ai-formatted-toolbar">
      {hasOutline && <button ref={outlineButtonRef} type="button" className="md-outline-toggle" aria-expanded={showOutline} aria-controls={outlineId} onClick={() => setOutlineExpanded(!showOutline)}><Icon name="list" size={14}/>{t("aiFormatted.outline")}</button>}
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
    <div className={`ai-formatted-layout${wide ? " md-wide" : " md-compact"}`}>
      {showOutline && <>
        {!wide && <button type="button" className="md-outline-backdrop" aria-label={t("aiFormatted.closeOutline")} onClick={closeOutline}/>}
        <MarkdownOutline id={outlineId} items={reading.outline} activeId={activeId} onNavigate={navigateHeading} onClose={closeOutline}/>
      </>}
    <div ref={scrollRef} className="reader-scroll ai-formatted-scroll">
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
          {display === "preview" ? <div ref={bodyRef} className="article-body ai-formatted-body" onClick={onLinkClick} dangerouslySetInnerHTML={previewMarkup}/> : <textarea className="ai-formatted-source" readOnly spellCheck={false} aria-label={t("aiFormatted.source")} value={draft.markdown}/>}
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
    </div>
  </section>;
}
