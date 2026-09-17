import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import Icon from "../components/Icon";
import MarkdownOutline from "../components/MarkdownOutline";
import { formattedMarkdownFilename, prepareObsidianMarkdown, splitMarkdownFrontmatter } from "../lib/aiFormatted";
import { downloadFile } from "../lib/download";
import { imageDataUrl } from "../lib/imageBytes";
import { capturedImageSources, renderMarkdown } from "../lib/markdown";
import { activeMarkdownHeading, prepareMarkdownReading, type MarkdownHeading } from "../lib/markdownReading";
import { safePageViewUrl } from "../lib/pageViewState";
import { reportError, toast } from "../toast";
import type { StructuredListItem } from "../types";
import "../components/ai-formatted.css";

function formatWhen(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN");
}

export default function StructuredReader({ item }: { item: StructuredListItem }) {
  const { t } = useTranslation();
  const stored = useQuery({
    queryKey: ["structured", item.articleId],
    queryFn: () => api.articleStructuredDocument(item.articleId),
  });
  const structured = stored.data?.articleId === item.articleId && stored.data.cleaned ? stored.data : null;
  const markdown = structured?.markdown?.trim() ?? "";
  const [display, setDisplay] = useState<"preview" | "source">("preview");
  const parts = useMemo(() => splitMarkdownFrontmatter(markdown), [markdown]);
  const images = useMemo(() => capturedImageSources(parts.body), [parts.body]);
  const reading = useMemo(
    () => prepareMarkdownReading(renderMarkdown(prepareObsidianMarkdown(parts.body), images), item.articleId),
    [parts.body, images, item.articleId],
  );
  const html = reading.html;
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
  const outlineId = `library-outline-${item.articleId}`;
  const captureId = structured?.captureId;
  const sourceUrl = safePageViewUrl(structured?.sourceUrl ?? item.url);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const measure = () => setWide(section.getBoundingClientRect().width >= 760);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(section);
    return () => resize.disconnect();
  }, [item.articleId]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const body = bodyRef.current;
    if (!scroll || !body || display !== "preview") return;
    const nodes = reading.headings.map((heading) => body.querySelector<HTMLElement>(`#${heading.id}`));
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scroll.getBoundingClientRect().top + 28;
      const maxScroll = scroll.scrollHeight - scroll.clientHeight;
      const index = activeMarkdownHeading(nodes.map((node) => node?.getBoundingClientRect().top ?? Infinity), line, maxScroll > 1 && scroll.scrollTop >= maxScroll - 2);
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

  useEffect(() => {
    if (display !== "preview" || !markdown || !captureId || !bodyRef.current) return;
    let alive = true;
    const queue = Array.from(bodyRef.current.querySelectorAll<HTMLImageElement>("img[data-captured-src]"));
    const load = async () => {
      while (alive && queue.length) {
        const img = queue.shift()!;
        const src = img.dataset.capturedSrc!;
        try {
          const bytes = await api.fetchCapturedImage(item.articleId, captureId, src);
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
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, load));
    return () => { alive = false; };
  }, [html, captureId, display, item.articleId, markdown, t]);

  const closeOutline = () => { setOutlineExpanded(false); outlineButtonRef.current?.focus(); };
  const navigateHeading = (heading: MarkdownHeading) => {
    const target = bodyRef.current?.querySelector<HTMLElement>(`#${heading.id}`);
    const scroll = scrollRef.current;
    if (!target || !scroll) return;
    scroll.scrollTo({
      top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 22,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    setActiveId(heading.id);
    target.focus({ preventScroll: true });
    if (!wide) setOutlineExpanded(false);
  };
  const onLinkClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const target = safePageViewUrl(anchor.getAttribute("href"));
    if (target) void openUrl(target).catch(reportError);
  };
  const copy = async () => {
    if (!markdown) return;
    try { await navigator.clipboard.writeText(markdown); toast.show(t("aiFormatted.copied")); }
    catch (cause) { reportError(cause); }
  };

  return <section ref={sectionRef} className="ai-formatted files-reader" aria-label={item.title} aria-busy={stored.isFetching}>
    <header className="files-reader-head">
      <div>
        <h1>{item.title}</h1>
        <p>{[item.folderName, item.feedTitle, formatWhen(structured?.cleanedAt ?? item.cleanedAt)].filter(Boolean).join(" · ")}</p>
      </div>
      {sourceUrl && <button type="button" onClick={() => void openUrl(sourceUrl).catch(reportError)}>打开原文</button>}
    </header>
    <div className="ai-formatted-toolbar">
      {hasOutline && <button ref={outlineButtonRef} type="button" className="md-outline-toggle" aria-expanded={showOutline} aria-controls={outlineId} onClick={() => setOutlineExpanded(!showOutline)}><Icon name="list" size={14}/>{t("aiFormatted.outline")}</button>}
      <div className="ai-formatted-display" role="group" aria-label={t("aiFormatted.display")}>
        <button type="button" aria-pressed={display === "preview"} onClick={() => setDisplay("preview")}>{t("aiFormatted.preview")}</button>
        <button type="button" disabled={!markdown} aria-pressed={display === "source"} onClick={() => setDisplay("source")}>{t("aiFormatted.source")}</button>
      </div>
      <div className="ai-formatted-tools">
        <button type="button" className="ai-format-icon" disabled={!markdown} title={t("aiFormatted.copy")} aria-label={t("aiFormatted.copy")} onClick={() => void copy()}><Icon name="copy" size={14}/></button>
        <button type="button" className="ai-format-icon" disabled={!markdown} title={t("aiFormatted.download")} aria-label={t("aiFormatted.download")} onClick={() => {
          if (markdown) downloadFile(markdown, formattedMarkdownFilename(item.title, item.articleId), "text/markdown;charset=utf-8");
        }}><Icon name="arrow-down" size={15}/></button>
      </div>
    </div>
    {stored.isLoading ? <p className="library-empty">正在打开清洗文档…</p>
      : stored.isError ? <p className="library-empty">无法读取这篇清洗文档。</p>
      : !markdown ? <p className="library-empty">这篇记录还没有可阅读的 Markdown。</p>
      : <div className={`ai-formatted-layout${wide ? " md-wide" : " md-compact"}`}>
        {showOutline && <>
          {!wide && <button type="button" className="md-outline-backdrop" aria-label={t("aiFormatted.closeOutline")} onClick={closeOutline}/>}
          <MarkdownOutline id={outlineId} items={reading.outline} activeId={activeId} onNavigate={navigateHeading} onClose={closeOutline}/>
        </>}
        <div ref={scrollRef} className="reader-scroll ai-formatted-scroll">
          <article className="article reader-content">
            {structured && <div className="reader-structured" role="note">
              <Icon name="sparkle" size={12}/>
              <span>
                {t(`reader.structuredSource.${structured.sourceKind}`, { defaultValue: t("reader.structuredSource.unknown") })}
                {" · "}
                {t("reader.structuredStats", { words: structured.words ?? item.words, images: structured.images ?? item.images })}
              </span>
              {(structured.truncated ? [t("reader.structuredTruncated")] : []).concat(structured.warnings ?? []).map((warning) => (
                <small key={warning}>{warning}</small>
              ))}
            </div>}
            {display === "preview"
              ? <div ref={bodyRef} className="article-body ai-formatted-body" onClick={onLinkClick} dangerouslySetInnerHTML={previewMarkup}/>
              : <textarea className="ai-formatted-source" readOnly spellCheck={false} aria-label={t("aiFormatted.source")} value={markdown}/>}
            <p className="ai-format-footnote">{t("aiFormatted.structuredHint")}</p>
          </article>
        </div>
      </div>}
  </section>;
}
