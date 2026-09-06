import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import HotBoard from "./hot/HotBoard";
import WorkspaceSwitcher, { type Workspace } from "./components/WorkspaceSwitcher";
import "./workspace.css";

const WORKSPACE_KEY = "papr.workspace.v2";
function loadWorkspace(): Workspace {
  try { return localStorage.getItem(WORKSPACE_KEY) === "hotboard" ? "hotboard" : "rss"; }
  catch { return "rss"; }
}

/** RSS stays mounted at its real dimensions: local reader/AI state and virtual
 *  list scroll survive. Only the active workspace may own the native page. */
export default function WorkspaceApp() {
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
  const [hotVisited, setHotVisited] = useState(workspace === "hotboard");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [hotQueries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false, staleTime: Infinity } } }));
  const activateRss = useCallback(() => setWorkspace("rss"), []);
  const chooseWorkspace = useCallback((next: Workspace) => {
    if (captureBusy) return;
    if (next === "hotboard") setHotVisited(true);
    setWorkspace(next);
  }, [captureBusy]);
  useEffect(() => {
    try { localStorage.setItem(WORKSPACE_KEY, workspace); } catch { /* Optional preference only. */ }
  }, [workspace]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || captureBusy) return;
      if (event.key === "1" || event.key === "2") {
        event.preventDefault();
        chooseWorkspace(event.key === "1" ? "rss" : "hotboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureBusy, chooseWorkspace]);

  const workspaceSwitch = <WorkspaceSwitcher workspace={workspace} captureBusy={captureBusy} onChange={chooseWorkspace}/>;
  return <div className="workspace-host">
    <div className="workspace-panels">
      <div id="workspace-rss-panel" className={`workspace-panel ${workspace !== "rss" ? "is-inactive" : ""}`} role="region" aria-label="RSS" aria-hidden={workspace !== "rss"} inert={workspace !== "rss"}>
        <App active={workspace === "rss"} onCaptureBusyChange={setCaptureBusy} onRequestActivate={activateRss} workspaceSwitch={workspaceSwitch}/>
      </div>
      <div id="workspace-hotboard-panel" className={`workspace-panel ${workspace !== "hotboard" ? "is-inactive" : ""}`} role="region" aria-label="热榜" aria-hidden={workspace !== "hotboard"} inert={workspace !== "hotboard"}>
        {hotVisited && <QueryClientProvider client={hotQueries}><HotBoard active={workspace === "hotboard"} workspaceSwitch={workspaceSwitch}/></QueryClientProvider>}
      </div>
    </div>
  </div>;
}
