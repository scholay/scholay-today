// Production components; isolated in-memory IPC/storage, no user data or network.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/newsreader";
import "../src/styles.css";
import "../src/hot/hot.css";
const values = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string) => {
  if (["list_folders", "list_structured_documents", "list_articles"].includes(command)) return [];
  throw Error(`Fixture blocked external action: ${command}`);
} } });
const { default: FilesBoard } = await import("../src/library/FilesBoard");
const { default: CalendarBoard } = await import("../src/calendar/CalendarBoard");
const { default: i18n } = await import("../src/i18n");
await i18n.changeLanguage("zh");
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
qc.setQueryData(["folders"], [{ id: 1, name: "不应出现的空目录", position: 0 }]);
qc.setQueryData(["structured-documents"], []);
qc.setQueryData(["articles", "calendar-year"], []);
document.documentElement.dataset.platform = "mac";
document.documentElement.dataset.palette = "paper";
document.documentElement.dataset.mode = "light";
function Preview() {
  const [view, setView] = useState<"files" | "year" | "history">("files");
  const [width, setWidth] = useState(1280);
  const [dark, setDark] = useState(false);
  return <QueryClientProvider client={qc}>
    <nav style={{ height: 46, display: "flex", alignItems: "center", gap: 16, padding: "0 16px", borderBottom: "1px solid var(--hair)", font: "13px var(--ui)" }}>
      <span>隔离验收</span>
      {(["files", "year", "history"] as const).map((key, i) => <button key={key} onClick={() => setView(key)}>{["文库", "学术年历", "昔日学术"][i]}</button>)}
      <button onClick={() => { document.documentElement.dataset.mode = dark ? "light" : "dark"; setDark(!dark); }}>{dark ? "浅色" : "深色"}</button>
      <button onClick={() => setWidth(width === 920 ? 1280 : 920)}>{width === 920 ? "宽窗口" : "窄窗口"}</button>
      <span>{width}px</span>
    </nav>
    <div style={{ width, maxWidth: "100%", height: "calc(100vh - 46px)", margin: "0 auto", border: "1px solid var(--hair)" }}>
      {view === "files" ? <FilesBoard active/> : <CalendarBoard active view={view}/>}
    </div>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
