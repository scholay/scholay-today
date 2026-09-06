import Icon from "./Icon";
import Brand from "./Brand";

export type Workspace = "rss" | "hotboard";

/** The same control is hosted by each sidebar (and the immersive reader).
 * No local selection state or IDs: mounted, hidden workspaces stay independent. */
export default function WorkspaceSwitcher({ workspace, captureBusy, onChange }: {
  workspace: Workspace;
  captureBusy: boolean;
  onChange: (workspace: Workspace) => void;
}) {
  return <div className="workspace-switcher">
    <Brand className="workspace-brand"/>
    <div className="workspace-tabs" role="group" aria-label="工作区">
      <button aria-pressed={workspace === "rss"} aria-controls="workspace-rss-panel" onClick={() => onChange("rss")} disabled={captureBusy} title="RSS · ⌘1"><Icon name="rss" size={14}/>RSS</button>
      <button aria-pressed={workspace === "hotboard"} aria-controls="workspace-hotboard-panel" onClick={() => onChange("hotboard")} disabled={captureBusy} title="热榜 · ⌘2"><Icon name="globe" size={14}/>热榜</button>
    </div>
    {captureBusy && <span className="workspace-capture-status" role="status">正在捕获当前网页…</span>}
  </div>;
}
