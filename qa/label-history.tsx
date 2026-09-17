import { useState } from "react";
import { createRoot } from "react-dom/client";
import BoardResizeHandles from "../src/components/BoardResizeHandles";
import { useBoardPanes } from "../src/hooks/useBoardPanes";
import LabelTimeline from "../src/labels/LabelTimeline";
import LabelInsights from "../src/labels/LabelInsights";
import { makeCapture } from "../src/labels/history";
import { EDITION_MS, groupEditions } from "../src/labels/editions";
import "@fontsource-variable/inter-tight";
import "../src/styles.css";
import "../src/hot/hot.css";
import "../src/labels/labels.css";
import "../src/workspace.css";

// Visual fixture only: synthetic observations, no Tauri/network/credential APIs.
const now = Date.now();
const captures = Array.from({ length: 80 }, (_, i) => makeCapture("douyin", { capturedAt: new Date(now - i * EDITION_MS).toISOString(), period: "演示榜单", rows: [
  { term: "知识正在被更多人看见", kind: "抖音实时热点", rank: i + 1, metric: "123万", metricLabel: "热点指数" },
  { term: "大学里的科研生活", kind: "抖音实时热点", rank: 2, metric: "100万", metricLabel: "热点指数" },
  { term: "从一张星空照片认识宇宙", kind: "抖音飙升热点", rank: 1, metric: "88万", metricLabel: "热点指数" },
  { term: "博物馆里的新发现", kind: "抖音飙升热点", rank: 2, metric: "70万", metricLabel: "热点指数" },
] })!);
function Fixture() {
  const panes = useBoardPanes("labels", true, true);
  const [selection, setSelection] = useState("latest"), [dark, setDark] = useState(true);
  const editions = groupEditions(captures);
  const shown = (selection === "latest" ? editions[0] : editions.find(item => String(item.start) === selection))!.captures;
  return <><div style={{ height: 32, font: "12px var(--ui)", padding: 7, color: "var(--muted)" }}>布局预览 · 演示数据（不写入应用） <button onClick={() => { document.documentElement.dataset.mode = dark ? "light" : "dark"; setDark(!dark); }}>切换明暗</button></div>
    <section ref={panes.hostRef} style={{ ...panes.style, height: "calc(100vh - 32px)" }} className="hot-workspace is-source label-workspace">
      <aside className="hot-sidebar"><div className="label-sidebar-heading">标签与趋势</div><nav className="hot-source-nav"><button>全部平台</button><button className="is-active">抖音</button><button>哔哩哔哩</button><button>知乎</button></nav></aside>
      <header className="hot-workspace-toolbar"><div className="hot-breadcrumb"><span>标签</span><strong>抖音</strong></div></header>
      <LabelTimeline editions={editions} selection={selection} loading={false} loadingMore={false} hasMore={false} error="" onSelect={setSelection} onMore={() => {}}/>
      <section className="hot-detail"><div className="label-native-detail"><LabelInsights captures={shown} loading={false} onCopy={() => {}} onOriginal={() => {}}/></div></section>
      <BoardResizeHandles panes={panes} hasList label="标签"/>
    </section></>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
