import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { MarkdownHeading } from "../lib/markdownReading";

export default function MarkdownOutline({ id, items, activeId, onNavigate, onClose }: {
  id: string;
  items: MarkdownHeading[];
  activeId: string | null;
  onNavigate: (heading: MarkdownHeading) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !active) return;
    const row = active.getBoundingClientRect();
    const box = nav.getBoundingClientRect();
    // Scroll this rail only, never scrollIntoView on the outer application.
    if (row.top < box.top + 42) nav.scrollTop += row.top - box.top - 42;
    else if (row.bottom > box.bottom - 12) nav.scrollTop += row.bottom - box.bottom + 12;
  }, [activeId]);

  const list = (nodes: MarkdownHeading[]) => <ol>{nodes.map(item => <li key={item.id}>
    <button type="button" data-level={item.level} aria-current={activeId === item.id ? "location" : undefined}
      aria-label={t("aiFormatted.headingLevel", { level: item.level, title: item.text })}
      title={item.text} onClick={() => onNavigate(item)}>{item.text}</button>
    {item.children.length > 0 && list(item.children)}
  </li>)}</ol>;
  return <nav id={id} ref={navRef} className="md-outline" aria-label={t("aiFormatted.outline")}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="md-outline-header"><span>{t("aiFormatted.outline")}</span><button type="button" onClick={onClose} aria-label={t("aiFormatted.closeOutline")}>×</button></div>
    {list(items)}
  </nav>;
}
