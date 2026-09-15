import { useState } from "react";
import { createRoot } from "react-dom/client";
import WorkspaceSwitcher, { type Workspace } from "../src/components/WorkspaceSwitcher";
import "@fontsource-variable/inter-tight";
import "../src/styles.css";
import "../src/hot/hot.css";
import "../src/workspace.css";

// Isolated frontend fixture: no feed data, credentials or native IPC is used.
function Fixture() {
  const [workspace, change] = useState<Workspace>("labels");
  const [dark, setDark] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div style={{ padding: 24 }}>
    <button onClick={() => { document.documentElement.dataset.mode = dark ? "light" : "dark"; setDark(!dark); }}>切换明暗</button>
    <button onClick={() => setBusy(!busy)}>切换捕获锁定</button>
    <p>标题栏文字对齐（200px 侧栏）</p>
    <div style={{ display: "grid", gridTemplateColumns: "200px 160px", gridTemplateRows: "38px 110px", position: "relative", font: "13px/1.5 var(--ui)" }}>
      <aside className="sidebar" style={{ gridColumn: 1, gridRow: "1 / -1" }}>
        <div className="titlebar" data-tauri-drag-region/>
        <div className="workspace-sidebar-heading"><WorkspaceSwitcher workspace={workspace} captureBusy={busy} onChange={change}/></div>
      </aside>
      <header className="hot-workspace-toolbar"><div className="hot-breadcrumb"><span>标签</span><strong>抖音</strong></div></header>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginTop: 24 }}>
      {[200, 248, 320].map((width) => <div key={width}>
        <p>{width}px 侧栏</p>
        <aside className="sidebar" style={{ width, height: 300, border: "1px solid var(--hair)", borderRadius: 10 }}>
          <div className="titlebar" data-tauri-drag-region />
          <div className="workspace-sidebar-heading"><WorkspaceSwitcher workspace={workspace} captureBusy={busy} onChange={change}/></div>
          <div style={{ margin: 12, color: "var(--muted)" }}>当前工作区：{workspace}</div>
        </aside>
      </div>)}
    </div>
    <p>沉浸阅读工具栏</p>
    <div className="reader-toolbar"><WorkspaceSwitcher workspace={workspace} captureBusy={busy} onChange={change}/></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
