import Icon, { type IconName } from "./Icon";
import { APP_NAME } from "./Brand";

export type Workspace = "rss" | "hotboard" | "labels";

const choices: { value: Workspace; label: string; icon: IconName }[] = [
  { value: "rss", label: "RSS", icon: "rss" },
  { value: "hotboard", label: "热榜", icon: "globe" },
  { value: "labels", label: "标签", icon: "tag" },
];

/** The host owns selection and shortcuts. Every mounted workspace uses the
 * same title-strip branding and full-width segmented buttons. */
export default function WorkspaceSwitcher({ workspace, captureBusy, onChange }: {
  workspace: Workspace;
  captureBusy: boolean;
  onChange: (workspace: Workspace) => void;
}) {
  const modifier = typeof document !== "undefined" && document.documentElement.dataset.platform === "mac" ? "⌘" : "Ctrl+";
  return <div className="workspace-switcher">
    <div className="workspace-title-brand" aria-label={APP_NAME}>
      <img className="app-brand-logo" src="/scholay-logo.png" alt="" width={14} height={15}/>
      <span>{APP_NAME}</span>
    </div>
    <div className="workspace-tabs" role="group" aria-label="工作区">
      {choices.map((choice, index) => <button key={choice.value} type="button"
        aria-pressed={workspace === choice.value} aria-controls={`workspace-${choice.value}-panel`}
        disabled={captureBusy} title={`${choice.label} · ${modifier}${index + 1}`}
        onClick={() => onChange(choice.value)}>
        <Icon name={choice.icon} size={13}/><span>{choice.label}</span>
      </button>)}
    </div>
    {captureBusy && <span className="workspace-capture-status" role="status">正在捕获当前网页…</span>}
  </div>;
}
