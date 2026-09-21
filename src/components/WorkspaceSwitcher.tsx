import Icon, { type IconName } from "./Icon";

export type Workspace = "rss" | "hot" | "labels" | "year" | "history";

export interface WorkspaceChoice {
  value: Workspace;
  label: string;
  icon: IconName | "logo";
  panel: string;
  group: number;
}

export const WORKSPACE_CHOICES: WorkspaceChoice[] = [
  { value: "rss", label: "RSS", icon: "logo", panel: "workspace-rss-panel", group: 0 },
  { value: "hot", label: "热榜", icon: "globe", panel: "workspace-hotboard-panel", group: 1 },
  { value: "labels", label: "标签", icon: "tag", panel: "workspace-hotboard-panel", group: 1 },
  { value: "year", label: "学术年历", icon: "clock", panel: "workspace-calendar-panel", group: 2 },
  { value: "history", label: "昔日学术", icon: "bookmark", panel: "workspace-calendar-panel", group: 2 },
];

export const WORKSPACE_GROUPS = [0, 1, 2].map((group) => WORKSPACE_CHOICES.filter((choice) => choice.group === group));

export function workspaceMeta(workspace: Workspace): WorkspaceChoice {
  return WORKSPACE_CHOICES.find((choice) => choice.value === workspace)
    ?? WORKSPACE_CHOICES.find((choice) => choice.value === "rss")
    ?? WORKSPACE_CHOICES[0];
}

export function isTrendsWorkspace(workspace: Workspace): boolean {
  return workspace === "hot" || workspace === "labels";
}

export function isCalendarWorkspace(workspace: Workspace): boolean {
  return workspace === "year" || workspace === "history";
}

export function parseWorkspace(raw: string | null): Workspace {
  if (raw === "hotboard") return "hot";
  if (raw === "calendar") return "year";
  if (raw === "home") return "rss";
  return WORKSPACE_CHOICES.some((choice) => choice.value === raw) ? raw as Workspace : "rss";
}

function WorkspaceMark({ icon, size }: { icon: WorkspaceChoice["icon"]; size: number }) {
  if (icon === "logo") {
    return <img className="workspace-logo" src="/scholay-logo.png" alt="" width={size} height={Math.round(size * 25 / 24)} />;
  }
  return <Icon name={icon} size={size} />;
}

/** Host chrome: the current feature mark plus a Cursor-style activity rail. */
export default function WorkspaceSwitcher({ workspace, captureBusy, onChange, onOpenSettings }: {
  workspace: Workspace;
  captureBusy: boolean;
  onChange: (workspace: Workspace) => void;
  onOpenSettings?: () => void;
}) {
  const modifier = typeof document !== "undefined" && document.documentElement.dataset.platform === "mac" ? "⌘" : "Ctrl+";
  const current = workspaceMeta(workspace);
  let shortcut = 1;
  return <>
    <div className="workspace-chrome">
      <div className="workspace-title-brand" aria-label={current.label}>
        <WorkspaceMark icon={current.icon} size={14}/>
        <span>{current.label}</span>
      </div>
      {captureBusy && <span className="workspace-capture-status" role="status">正在捕获当前网页…</span>}
    </div>
    <nav className="workspace-rail" aria-label="工作区">
      <div className="workspace-rail-drag" data-tauri-drag-region />
      {WORKSPACE_GROUPS.map((group) => <div key={group[0].value} className="workspace-rail-group">
        {group.map((choice) => {
          const index = shortcut++;
          return <button key={choice.value} type="button"
            aria-pressed={workspace === choice.value} aria-controls={choice.panel}
            disabled={captureBusy} title={`${choice.label} · ${modifier}${index}`}
            onClick={() => onChange(choice.value)}>
            <WorkspaceMark icon={choice.icon} size={18}/>
            <span className="workspace-rail-label">{choice.label}</span>
          </button>;
        })}
      </div>)}
      <div className="workspace-rail-foot">
        <button type="button" className="workspace-rail-settings" title={`设置 · ${modifier},`}
          aria-label={`设置 · ${modifier},`} onClick={onOpenSettings}>
          <Icon name="settings" size={18}/>
        </button>
      </div>
    </nav>
  </>;
}
