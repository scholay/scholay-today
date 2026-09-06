// Synthetic UI only: no databases, Tauri IPC, saved preferences, or AI calls.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import WorkspaceSwitcher from "../src/components/WorkspaceSwitcher";
import ArticleListControls from "../src/components/ArticleListControls";
import en from "../src/locales/en.json";
import zh from "../src/locales/zh.json";
import ja from "../src/locales/ja.json";
import "@fontsource-variable/inter-tight";
import "../src/styles.css";
import "../src/hot/hot.css";
import "../src/workspace.css";

const i18n = createInstance();
await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } } });
document.documentElement.dataset.platform = "mac";
document.documentElement.dataset.palette = "paper";
const root = createRoot(document.getElementById("fixture")!);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
let sortCalls = 0, filterCalls = 0, markCalls = 0, workspaceCalls = 0;
const failures: string[] = [];
let cases = 0;
function render(sidebar: number, list: number, hot: boolean, busy = false) {
  flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <div style={{ display: "grid", gridTemplateColumns: `${sidebar}px ${list}px 400px`, width: sidebar + list + 400, height: 400, position: "relative", border: "1px solid var(--hair)" }}>
      <aside className={hot ? "hot-sidebar" : "sidebar"} style={{ gridRow: 1 }}>
        <div className="titlebar" data-tauri-drag-region><span style={{ letterSpacing: 6, color: "#e87055" }}>●●●</span></div>
        <div className="workspace-sidebar-heading"><WorkspaceSwitcher workspace={hot ? "hotboard" : "rss"} captureBusy={busy} onChange={() => workspaceCalls++}/></div>
        <div className="sidebar-search">Search articles</div>
        <div className="sb-section-title">LIBRARY · SYNTHETIC</div>
      </aside>
      <section className="list"><div className="list-header" data-tauri-drag-region>
        <ArticleListControls sortOldest={false} unreadOnly={false} onToggleSort={() => sortCalls++} onToggleUnreadOnly={() => filterCalls++} onMarkAll={() => markCalls++}/>
        <h1 className="list-title"><span className="list-title-text">微信公众号·科研精选</span><span className="list-title-meta"><span className="count">60+ articles</span></span></h1>
      </div><div className="art"><div className="art-title">Synthetic article · only toolbar layout is under test</div></div></section>
      <section className="reader"><div className="reader-toolbar"><WorkspaceSwitcher workspace="rss" captureBusy={false} onChange={() => {}}/></div><p>Immersive toolbar sample — brand stays hidden here.</p></section>
    </div>
  </I18nextProvider>));
}
render(200, 322, false);
await document.fonts.ready;
for (const mode of ["light", "dark"]) for (const language of ["en", "zh", "ja"]) {
  document.documentElement.dataset.mode = mode;
  await i18n.changeLanguage(language);
  for (const sidebar of [200, 420]) for (const list of [300, 388, 560]) for (const hot of [false, true]) {
    render(sidebar, list, hot); await frame(); cases++;
    const label = `${mode}/${language}/${sidebar}/${list}/${hot ? "hot" : "rss"}`;
    const fail = (message: string) => failures.push(`${label}: ${message}`);
    const pane = document.querySelector("aside")!.getBoundingClientRect();
    const tabs = document.querySelector("aside .workspace-tabs")!;
    const bounds = tabs.getBoundingClientRect();
    if (bounds.left < pane.left + 80 || bounds.right > pane.right - 7 || bounds.top < pane.top || bounds.bottom > pane.top + 38) fail("workspace tabs overflow the title strip");
    for (const button of tabs.querySelectorAll("button")) {
      const r = button.getBoundingClientRect();
      if (r.right > bounds.right || r.left < bounds.left || r.top < bounds.top || r.bottom > bounds.bottom) fail("workspace button overflow");
      if (!button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) fail("workspace button blocked by drag region");
    }
    const header = document.querySelector(".list-header")!.getBoundingClientRect();
    const title = document.querySelector(".list-title")!.getBoundingClientRect();
    if (Math.abs(title.top - header.top - 38) > 1) fail("title no longer begins under 38px strip");
    let previousRight = header.left;
    for (const button of document.querySelectorAll(".list-meta button")) {
      const r = button.getBoundingClientRect();
      if (r.left < previousRight || r.right > header.right || r.bottom > title.top || r.top < header.top) fail("list controls overlap or leave title strip");
      previousRight = r.right;
      if (!button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) fail("list button not clickable");
    }
    if (getComputedStyle(document.querySelector(".reader-toolbar .workspace-brand")!).display !== "none") fail("immersive toolbar contains duplicate brand");
  }
}
document.documentElement.dataset.mode = new URLSearchParams(location.search).get("dark") ? "dark" : "light";
await i18n.changeLanguage("en"); render(200, 322, false); await frame();
for (const button of document.querySelectorAll<HTMLButtonElement>(".list-meta button")) button.click();
document.querySelectorAll<HTMLButtonElement>("aside .workspace-tabs button")[1].click();
if ([sortCalls, filterCalls, markCalls, workspaceCalls].some(count => count !== 1)) failures.push("action callback wiring failed");
render(200, 322, false, true); await frame();
for (const button of document.querySelectorAll<HTMLButtonElement>("aside .workspace-tabs button")) button.click();
if (workspaceCalls !== 1) failures.push("capture-busy switch did not remain disabled");
render(200, 322, false); await frame();
document.getElementById("results")!.textContent = JSON.stringify({ passed: failures.length === 0, cases, syntheticActionChecks: 5, failures }, null, 2);
document.title = `${failures.length ? "FAIL" : "PASS"} — ${cases} title-strip layouts`;
