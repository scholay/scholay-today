import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ReaderViewOutlet, { readerSummaryKey, readerViewKey } from "../src/components/ReaderViewOutlet";
import type { ReaderTab, AiFormatJob } from "../src/lib/aiFormatted";
import type { AiFormattedDraft } from "../src/types";
import "../src/styles.css";
import "../src/components/reader-web-controls.css";

// Install before importing AIFormatted (whose i18n dependency attempts a
// startup language sync). This fixture cannot touch a native backend.
const blockedIpc: string[] = [];
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
  invoke: (command: string) => { blockedIpc.push(command); return Promise.reject(new Error("Synthetic fixture blocks native IPC")); },
} });
const { default: AIFormatted } = await import("../src/components/AIFormatted");
const { default: i18n } = await import("../src/i18n");
await i18n.changeLanguage("en");

const source = { sourceUrl: "https://example.invalid/synthetic-page", sourceTitle: "Synthetic captured page", sourceText: "Synthetic source text. No real article or user data.", capturedAt: "2026-08-30T12:00:00Z", charCount: 52, truncated: false, warnings: [] };
const node = document.getElementById("fixture")!;
const root = createRoot(node);
const failures: string[] = [];
const duplicateKeyErrors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (/same key|unique ["']?key|two children/i.test(text)) duplicateKeyErrors.push(text);
  originalError(...args);
};
let transitions = 0;
const noAction = () => {};

function Harness({ articleId, mode, iteration }: { articleId: number; mode: ReaderTab; iteration: number }) {
  const draft: AiFormattedDraft | null = iteration % 3 === 0 ? { articleId, captureId: `synthetic-${articleId}`, sourceUrl: source.sourceUrl, sourceTitle: source.sourceTitle, sourceText: source.sourceText, capturedAt: source.capturedAt, generatedAt: source.capturedAt, model: "synthetic-no-provider", language: "zh", markdown: "---\ntitle: Synthetic\n---\n# Synthetic document\n\nNo provider was called.", sourceCharCount: source.charCount, sourceTruncated: false, warnings: [] } : null;
  const job: AiFormatJob = { runId: iteration, phase: iteration % 2 ? "failed" : "formatting", captureId: `synthetic-${articleId}`, error: iteration % 2 ? "Synthetic failure" : null, source };
  return <div className="reader" style={{ height: "100%" }}>
    <div className="reader-toolbar">Selected: {mode} · article {articleId}</div>
    <ReaderViewOutlet key={readerViewKey(articleId, mode)} articleId={articleId} mode={mode}
      renderReading={() => <div className="reader-scroll" data-test-reading="true">Synthetic reading pane</div>}
      renderWeb={() => <div className="reader-webview"><div className="reader-webview-bar">Synthetic web controls</div><div className="reader-webview-host">Synthetic native host</div></div>}
      renderFormatted={() => <AIFormatted articleId={articleId} articleTitle="Synthetic article" hasUrl draft={draft} loading={false} loadError={null} job={draft ? null : job} language="zh" onLanguageChange={noAction} onReformat={noAction} onRetry={noAction} onToast={noAction}/>}/>
    <aside key={readerSummaryKey(articleId)} data-test-summary="true">Synthetic sibling summary drawer</aside>
  </div>;
}

for (let iteration = 0; iteration < 240; iteration++) {
  const mode = (["formatted", "web", "formatted", "reader"] as const)[iteration % 4];
  const articleId = 1 + Math.floor(iteration / 4) % 5;
  flushSync(() => root.render(<Harness articleId={articleId} mode={mode} iteration={iteration}/>));
  const panes = node.querySelectorAll(".ai-formatted, .reader-webview, [data-test-reading]");
  const aiPanes = node.querySelectorAll(".ai-formatted").length;
  const outlets = node.querySelectorAll(".reader-view-content");
  const valid = panes.length === 1 && aiPanes === (mode === "formatted" ? 1 : 0)
    && outlets.length === 1 && outlets[0].getAttribute("data-reader-view") === mode
    && outlets[0].getAttribute("data-reader-article") === String(articleId)
    && node.querySelectorAll("[data-test-summary]").length === 1;
  if (!valid) failures.push(`transition ${iteration}: mode=${mode}, panes=${panes.length}, AI=${aiPanes}, outlets=${outlets.length}`);
  // Change real AIFormatted local state before unmounting it, recreating the
  // Markdown-selected stale panel seen in the reported screenshot.
  if (mode === "formatted") {
    const markdown = node.querySelectorAll<HTMLButtonElement>(".ai-formatted-display button")[1];
    if (markdown && !markdown.disabled) flushSync(() => markdown.click());
  }
  const outlet = node.querySelector<HTMLElement>(".reader-view-content")!;
  const style = getComputedStyle(outlet);
  if (style.minHeight !== "0px" || style.overflow !== "hidden") failures.push(`transition ${iteration}: outlet is not height-bounded`);
  transitions++;
}
flushSync(() => root.unmount());
if (node.childElementCount !== 0) failures.push("Root unmount left stale DOM behind");
if (duplicateKeyErrors.length) failures.push(`${duplicateKeyErrors.length} duplicate-key React errors`);
if (blockedIpc.some((command) => /ai_format|capture_page/.test(command))) failures.push("A forbidden AI/capture request was attempted");
console.error = originalError;
const result = { passed: failures.length === 0, transitions, failures, duplicateKeyErrors, blockedIpc };
Object.assign(window, { __PAPR_READER_OUTLET_QA__: result });
document.getElementById("results")!.textContent = JSON.stringify(result, null, 2);
document.title = `${result.passed ? "PASS" : "FAIL"} — ${transitions} real React DOM transitions`;
document.documentElement.dataset.result = result.passed ? "pass" : "fail";
