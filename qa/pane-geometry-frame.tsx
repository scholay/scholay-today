import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ReaderViewOutlet, { readerViewKey } from "../src/components/ReaderViewOutlet";
import ResizeHandle from "../src/components/ResizeHandle";
import { fitPaneWidths, paneResizeMax, resizePaneWidths, type PaneWidths } from "../src/lib/paneGeometry";
import type { ReaderTab, AiFormatJob } from "../src/lib/aiFormatted";
import type { AiFormattedDraft } from "../src/types";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";
import "../src/components/reader-web-controls.css";

const blockedIpc: string[] = [];
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
  invoke: (command: string) => { blockedIpc.push(command); return Promise.reject(new Error("Synthetic fixture blocks native IPC")); },
} });
const { default: AIFormatted } = await import("../src/components/AIFormatted");
const { default: i18n } = await import("../src/i18n");
await i18n.changeLanguage("en");
await document.fonts.ready;
const bounds = { sidebar: { min: 200, max: 420 }, list: { min: 300, max: 560 } };
const sourceUrl = `https://example.invalid/synthetic/${"long-url-segment".repeat(100)}`;
const sourceText = `Synthetic raw capture, no real data. ${"A".repeat(2500)}\n${"Synthetic paragraph.\n".repeat(70)}`;
const source = { sourceUrl, sourceTitle: `Synthetic captured title ${"中文测试".repeat(25)}`, sourceText, capturedAt: "2026-08-30T12:00:00Z", charCount: sourceText.length, truncated: false, warnings: [] };
const draft: AiFormattedDraft = { articleId: 1, captureId: "synthetic-layout", ...source, sourceCharCount: sourceText.length, sourceTruncated: false, generatedAt: source.capturedAt, model: "synthetic-no-provider", language: "zh", markdown: `---\ntitle: Synthetic\nsource: ${sourceUrl}\n---\n# Synthetic document\n\n| First | Second |\n| --- | --- |\n| ${"Table cell".repeat(200)} | Only synthetic text |\n\n${sourceText}` };
const job: AiFormatJob = { runId: 1, phase: "failed", captureId: "synthetic-layout", error: null, source };
const noAction = () => {};
const root = createRoot(document.getElementById("root")!);
let iteration = 0;
let latest: PaneWidths = fitPaneWidths(window.innerWidth, 248, 388, bounds);
let persisted: { pane: string; width: number }[] = [];

function Harness({ sidebar, list, surface }: { sidebar: number; list: number; surface: string }) {
  const viewport = window.innerWidth;
  const [snapshot, setSnapshot] = useState<PaneWidths | null>(null);
  const displayed = snapshot ?? fitPaneWidths(viewport, sidebar, list, bounds);
  latest = displayed;
  const mode: ReaderTab = surface === "reader" || surface === "web" ? surface : "formatted";
  const resize = (pane: "sidebar" | "list", value: number) => {
    const widths = resizePaneWidths(viewport, displayed, pane, value, bounds);
    setSnapshot(widths);
    persisted.push({ pane, width: pane === "sidebar" ? widths.sidebarWidth : widths.listWidth });
  };
  return <div className="app-shell" style={{ "--col-sidebar": `${displayed.sidebarWidth}px`, "--col-list": `${displayed.listWidth}px`, "--ai-width": "560px" } as CSSProperties}>
    <main className="window">
      <aside className="sidebar">
        <div className="sb-brand"><svg className="sb-brand-mark" viewBox="0 0 22 22"><rect width="22" height="22" rx="5" fill="currentColor"/></svg><span className="sb-brand-name">Papr</span></div>
        <button className="sidebar-search"><span>⌕</span>Search feeds & articles<kbd>⌘K</kbd></button>
        <div className="sidebar-scroll">{Array.from({ length: 45 }, (_, index) => <div key={index} className={`sb-item ${index === 40 ? "active" : ""}`} tabIndex={0}><span className="sb-ico">○</span><span className="sb-label">{`Synthetic sidebar item ${index} ${"long".repeat(80)}`}</span><span className="sb-count">999</span></div>)}</div>
      </aside>
      <section className="list">
        <header className="list-header"><h2 className="list-title"><span className="list-title-text">{`Very long synthetic list name ${"中文标题".repeat(35)}`}</span><span className="list-title-meta"><span className="count">999 articles</span><span className="list-translate-toggle"><button className="list-translate-btn">Original</button><button className="list-translate-btn on">Translated</button></span></span></h2><div className="list-meta"><button className="list-meta-btn">Unread only</button><button className="list-meta-btn">Newest first</button><button className="list-meta-btn">Mark all read</button></div></header>
        <div className="list-scroll">{Array.from({ length: 40 }, (_, index) => <div className="art" key={index}><div className="art-title">{`Synthetic article ${index}: ${"长标题".repeat(20)}`}</div><div className="art-snippet">Synthetic preview only. No live article was loaded.</div></div>)}</div>
      </section>
      <section className="reader">
        <div className="reader-toolbar"><button className="tb-btn">☆</button><button className="tb-btn">◇</button><div className="reader-view-switch"><button>Reading</button><button>Web</button><button>AI formatted</button></div><button className="tb-btn" data-test-external>↗</button></div>
        <ReaderViewOutlet key={readerViewKey(1, mode)} articleId={1} mode={mode}
          renderReading={() => <div className="reader-scroll" data-test-reading><article className="article"><h1>Synthetic reading page</h1><div className="article-body"><p>{sourceText}</p></div></article></div>}
          renderWeb={() => <div className="reader-webview"><div className="reader-webview-bar"><div className="reader-web-navigation"><button>←</button><button>→</button><button>↻</button></div><span className="reader-webview-url">{sourceUrl}</span></div><div className="reader-webview-host">Synthetic native host: no native view is opened</div></div>}
          renderFormatted={() => <AIFormatted articleId={1} articleTitle="Synthetic article" hasUrl draft={surface === "capture" ? null : draft} loading={false} loadError={null} job={surface === "capture" ? job : null} language="zh" onLanguageChange={noAction} onGenerate={noAction} onOpenWeb={noAction} onReload={noAction} onDismissError={noAction} onToast={noAction}/>}/>
        <aside className="ai-drawer" aria-hidden="true"><button tabIndex={-1}>Off-canvas synthetic drawer</button></aside>
      </section>
      {(["sidebar", "list"] as const).map((pane) => <div key={pane} className="resize-handle-slot" style={{ left: pane === "sidebar" ? "var(--col-sidebar)" : "calc(var(--col-sidebar) + var(--col-list))" }}>
        <ResizeHandle width={pane === "sidebar" ? displayed.sidebarWidth : displayed.listWidth} side="right" min={bounds[pane].min} max={paneResizeMax(viewport, pane, bounds, displayed)} onResize={(value) => resize(pane, value)} label={`Resize ${pane}`}/>
      </div>)}
    </main>
  </div>;
}

const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
const near = (a: number, b: number) => Math.abs(a - b) < 1;
function runCase(sidebar: number, list: number, surface: string) {
  persisted = [];
  flushSync(() => root.render(<Harness key={++iteration} sidebar={sidebar} list={list} surface={surface}/>));
  if (surface === "source") flushSync(() => document.querySelectorAll<HTMLButtonElement>(".ai-formatted-display button")[1].click());
  document.querySelectorAll<HTMLDetailsElement>(".ai-format-metadata details, details.ai-format-metadata").forEach((details) => { details.open = true; });
  document.querySelector<HTMLElement>(".sb-item.active")!.scrollIntoView({ block: "nearest" });
  document.querySelector<HTMLElement>(".list-translate-btn:last-child")!.focus();
  document.querySelector<HTMLElement>("[data-test-external]")!.focus();
  document.querySelector<HTMLTextAreaElement>(".ai-formatted-source")?.focus();
  const failures: string[] = [];
  for (const selector of ["html", "body", "#root", ".app-shell", ".window"]) {
    const node = document.querySelector<HTMLElement>(selector)!;
    node.scrollLeft = 200;
    if (node.scrollLeft !== 0) failures.push(`${selector} can horizontally scroll (${node.scrollLeft})`);
  }
  const s = rect(".sidebar"), l = rect(".list"), r = rect(".reader");
  if (!near(s.left, 0) || !near(s.right, l.left) || !near(l.right, r.left) || !near(r.right, window.innerWidth)) failures.push(`pane edges escaped viewport: ${[s.left, s.right, l.left, l.right, r.left, r.right].join(",")}`);
  if (!near(s.width, latest.sidebarWidth) || !near(l.width, latest.listWidth) || !near(r.width, latest.readerWidth)) failures.push("pane DOM differs from production geometry");
  for (const selector of [".sb-brand", ".sidebar-search"]) {
    const edge = rect(selector);
    if (edge.left < s.left + 10 || edge.right > s.right) failures.push(`${selector} lost its sidebar inset`);
  }
  document.querySelectorAll<HTMLElement>(".list-translate-btn, .list-meta-btn").forEach((button) => {
    const edge = button.getBoundingClientRect();
    if (edge.left < l.left || edge.right > l.right) failures.push(`list control clipped: ${button.textContent}`);
  });
  if (document.querySelectorAll(".reader-view-content").length !== 1) failures.push("reader has multiple mounted view outlets");
  if (persisted.length) failures.push("viewport/layout changes persisted a preference");
  if (blockedIpc.some((command) => command !== "set_setting")) failures.push("unexpected native IPC attempted");
  return { failures };
}

function runDrag() {
  const failures = runCase(420, 560, "source").failures;
  const before = { ...latest };
  const beforeEdge = rect(".list").right;
  const separator = document.querySelector<HTMLElement>('[aria-label="Resize list"]')!;
  flushSync(() => separator.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: beforeEdge })));
  flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { clientX: beforeEdge - 20 })));
  flushSync(() => window.dispatchEvent(new PointerEvent("pointerup")));
  if (!near(rect(".list").right, beforeEdge - 20)) failures.push("list right edge did not follow the pointer by -20px");
  if (!near(latest.sidebarWidth, before.sidebarWidth)) failures.push("drag restored/changed the non-dragged sidebar width");
  if (!near(latest.readerWidth, before.readerWidth + 20)) failures.push("reader did not receive the freed width");
  if (persisted.length !== 1 || persisted[0].pane !== "list") failures.push("drag persisted more than the explicit list preference");
  return { failures };
}
Object.assign(window, { __PAPR_PANE_FRAME__: { runCase, runDrag, blockedIpc } });
