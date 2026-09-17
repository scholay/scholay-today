import { useState } from "react";
import { createRoot } from "react-dom/client";
import WorkspaceSwitcher, { type Workspace } from "../src/components/WorkspaceSwitcher";
import "@fontsource-variable/inter-tight";
import "../src/styles.css";
import "../src/hot/hot.css";
import "../src/workspace.css";

// Isolated frontend fixture: no feed data, credentials or native IPC is used.
function Fixture() {
  const [workspace, change] = useState<Workspace>("year");
  const [dark, setDark] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div style={{ padding: 24 }}>
    <button onClick={() => { document.documentElement.dataset.mode = dark ? "light" : "dark"; setDark(!dark); }}>切换明暗</button>
    <button onClick={() => setBusy(!busy)}>切换捕获锁定</button>
    <p>活动栏 + 子功能标题条</p>
    <div className="workspace-host" style={{ height: 280, border: "1px solid var(--hair)" }}>
      <WorkspaceSwitcher workspace={workspace} captureBusy={busy} onChange={change}/>
      <div className="workspace-panels">
        <aside className="sidebar">
          <div className="titlebar" data-tauri-drag-region/>
          <div style={{ margin: 12, color: "var(--muted)" }}>当前工作区：{workspace}</div>
        </aside>
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
