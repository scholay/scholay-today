import { useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon";
import { LABEL_SOURCES, labelTime } from "./helpers";
import { aggregateCaptures, type LabelCapture, type LabelInsight } from "./history";

export default function LabelInsights({ captures, loading, onCopy, onOriginal }: {
  captures: LabelCapture[]; loading: boolean; onCopy: (term: string) => void; onOriginal: (url: string) => void;
}) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  useEffect(() => setLimits({}), [captures]);
  const entries = useMemo(() => aggregateCaptures(captures), [captures]);
  const groups = new Map<string, { sourceId: string; kind: string; rows: LabelInsight[] }>();
  for (const row of entries) {
    const key = JSON.stringify([row.sourceId, row.kind]);
    if (!groups.has(key)) groups.set(key, { sourceId: row.sourceId, kind: row.kind, rows: [] });
    groups.get(key)!.rows.push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => LABEL_SOURCES.findIndex(item => item.id === a.sourceId) - LABEL_SOURCES.findIndex(item => item.id === b.sourceId));
  for (const item of ordered) item.rows.sort((a, b) => a.rank - b.rank || a.term.localeCompare(b.term));
  return <div className="label-insights" aria-busy={loading}>
    <div className="label-insight-grid">{ordered.map(item => {
      const source = LABEL_SOURCES.find(value => value.id === item.sourceId)!;
      const groupKey = JSON.stringify([item.sourceId, item.kind]), limit = limits[groupKey] ?? 50;
      return <section className="label-insight-card" key={groupKey} aria-label={source.name + " · " + item.kind}>
        <header><span className="label-platform-mark">{source.mark}</span><div><h2>{item.kind}</h2><small>{source.name} · {item.rows.length} 个标签</small></div><button title="查看平台来源" aria-label={"查看" + source.name + "来源"} onClick={() => onOriginal(source.url)}><Icon name="open" size={13}/></button></header>
        <div className="label-insight-card-scroll">{item.rows.slice(0, limit).map(row => <details className="label-insight-row" key={row.key}>
          <summary><span className={"hot-rank " + (row.rank <= 3 ? "is-top" : "")}>{row.rank}</span><span className="label-insight-term"><strong>{row.term}</strong><small>{row.metric ? row.metricLabel + " " + row.metric : "平台未提供流量值"}</small></span><Icon name="chevron-down" size={12}/></summary>
          <div className="label-insight-expanded"><dl><dt>平台周期</dt><dd>{row.period || "平台未提供"}</dd><dt>采集时间</dt><dd>{labelTime(new Date(row.lastAt).toISOString())}</dd><dt>榜内排名</dt><dd>#{row.rank}</dd></dl><p>{source.description}</p><button onClick={() => onCopy(row.term)}><Icon name="copy" size={12}/>复制标签</button></div>
        </details>)}{item.rows.length > limit && <button className="label-load-history" onClick={() => setLimits(old => ({ ...old, [groupKey]: limit + 50 }))}>显示更多（{limit} / {item.rows.length}）</button>}</div>
      </section>;
    })}</div>
    {!entries.length && <div className="hot-empty"><Icon name="tag" size={28}/><p>{loading ? "正在读取标签…" : "这一期暂无标签数据"}</p></div>}
  </div>;
}
