import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import CalendarBoard from "./calendar/CalendarBoard";
import FilesBoard from "./library/FilesBoard";
import TrendsWorkspace from "./hot/TrendsWorkspace";
import WorkspaceSwitcher, { isCalendarWorkspace, isTrendsWorkspace, parseWorkspace, WORKSPACE_CHOICES, type Workspace } from "./components/WorkspaceSwitcher";
import { saveTrendsSection } from "./hot/trendsSection";
import { stepUiScale } from "./lib/uiScale";
import { useUi } from "./store";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { hasBlockingOverlay, useBlockingOverlay } from "./lib/useBlockingOverlay";
import "./workspace.css";

const WORKSPACE_KEY = "papr.workspace.v2";
const OPEN_SETTINGS = "papr-open-settings";

function loadWorkspace(): Workspace {
  try { return parseWorkspace(localStorage.getItem(WORKSPACE_KEY)); }
  catch { return "rss"; }
}

export function requestOpenSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS));
}

/** RSS stays mounted at its real dimensions: local reader/AI state and virtual
 *  list scroll survive. Only the active workspace may own the native page. */
export default function WorkspaceApp() {
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
  const [filesVisited, setFilesVisited] = useState(workspace === "files");
  const [hotVisited, setHotVisited] = useState(isTrendsWorkspace(workspace));
  const [calendarVisited, setCalendarVisited] = useState(isCalendarWorkspace(workspace));
  const [captureBusy, setCaptureBusy] = useState(false);
  const modalOpen = useUi(s => s.modalOpen);
  const menuOpen = useUi(s => s.menuOpen);
  const blockingOverlay = useBlockingOverlay();
  const [hotQueries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false, staleTime: Infinity } } }));
  const trendsOpen = isTrendsWorkspace(workspace);
  const calendarOpen = isCalendarWorkspace(workspace);
  const activateRss = useCallback(() => setWorkspace("rss"), []);
  const chooseWorkspace = useCallback((next: Workspace) => {
    if (captureBusy) return;
    if (next === "files") setFilesVisited(true);
    if (isTrendsWorkspace(next)) {
      setHotVisited(true);
      saveTrendsSection(next === "labels" ? "labels" : "hot");
    }
    if (isCalendarWorkspace(next)) setCalendarVisited(true);
    setWorkspace(next);
  }, [captureBusy]);
  useEffect(() => {
    try { localStorage.setItem(WORKSPACE_KEY, workspace); } catch { /* Optional preference only. */ }
  }, [workspace]);
  useEffect(() => {
    const enabled = !captureBusy && !modalOpen && !menuOpen && !blockingOverlay;
    void invoke("set_workspace_shortcuts", { enabled }).catch(() => {});
    const pending = listen<string>("workspace-shortcut", event => {
      const next = WORKSPACE_CHOICES[Number(event.payload) - 1];
      if (enabled && !hasBlockingOverlay() && next) chooseWorkspace(next.value);
    });
    return () => { void pending.then(stop => stop()).catch(() => {}); };
  }, [captureBusy, modalOpen, menuOpen, blockingOverlay, chooseWorkspace]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || captureBusy || modalOpen || menuOpen || hasBlockingOverlay()) return;
      const next = WORKSPACE_CHOICES[Number(event.key) - 1];
      if (next) {
        event.preventDefault();
        chooseWorkspace(next.value);
        return;
      }
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        useUi.getState().setUiScale(stepUiScale(useUi.getState().uiScale, 1));
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        useUi.getState().setUiScale(stepUiScale(useUi.getState().uiScale, -1));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        useUi.getState().setUiScale("100");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureBusy, modalOpen, menuOpen, chooseWorkspace]);

  return <div className="workspace-host">
    <WorkspaceSwitcher workspace={workspace} captureBusy={captureBusy} onChange={chooseWorkspace} onOpenSettings={requestOpenSettings}/>
    <div className="workspace-panels">
      <div id="workspace-rss-panel" className={`workspace-panel ${workspace !== "rss" ? "is-inactive" : ""}`} role="region" aria-label="RSS" aria-hidden={workspace !== "rss"} inert={workspace !== "rss"}>
        <App active={workspace === "rss"} onCaptureBusyChange={setCaptureBusy} onRequestActivate={activateRss}/>
      </div>
      <div id="workspace-files-panel" className={`workspace-panel ${workspace !== "files" ? "is-inactive" : ""}`} role="region" aria-label="文库" aria-hidden={workspace !== "files"} inert={workspace !== "files"}>
        {filesVisited && <FilesBoard active={workspace === "files"}/>}
      </div>
      <div id="workspace-hotboard-panel" className={`workspace-panel ${trendsOpen ? "" : "is-inactive"}`} role="region" aria-label={workspace === "labels" ? "标签" : "热榜"} aria-hidden={!trendsOpen} inert={!trendsOpen}>
        {hotVisited && <QueryClientProvider client={hotQueries}><TrendsWorkspace active={trendsOpen} section={workspace === "labels" ? "labels" : "hot"}/></QueryClientProvider>}
      </div>
      <div id="workspace-calendar-panel" className={`workspace-panel ${calendarOpen ? "" : "is-inactive"}`} role="region" aria-label={workspace === "history" ? "昔日学术" : "学术年历"} aria-hidden={!calendarOpen} inert={!calendarOpen}>
        {calendarVisited && <CalendarBoard active={calendarOpen} view={workspace === "history" ? "history" : "year"}/>}
      </div>
    </div>
  </div>;
}
