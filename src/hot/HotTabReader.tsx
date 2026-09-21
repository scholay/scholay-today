import { useRef } from "react";
import Icon from "../components/Icon";
import { useReadingGroups, type HotTab } from "../lib/readingGroups";
import { useContentScroll } from "../lib/useContentScroll";
import { hotTime } from "./helpers";
import HotPageView from "./HotPageView";

const kindLabel = { hot: "热榜", latest: "最新", daily: "每日" };
export default function HotTabReader({ tab, active }: { tab: HotTab; active: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useContentScroll(scrollRef, tab.id, "rssScroll", tab.display === "summary");
  const { item, source } = tab;
  return <>
    <div className="hot-reader-toolbar" role="group" aria-label="热榜阅读模式">
      <span>{source.name}</span>
      <button type="button" aria-pressed={tab.display === "summary"} onClick={() => useReadingGroups.getState().setHotDisplay(tab.id, "summary")}>摘要</button>
      <button type="button" aria-pressed={tab.display === "web"} onClick={() => useReadingGroups.getState().setHotDisplay(tab.id, "web")}>Web</button>
    </div>
    {tab.display === "web" ? <HotPageView key={tab.id} viewId={tab.id} url={item.url} active={active}/>
      : <div ref={scrollRef} className="hot-detail-scroll">
        <article className="hot-article">
          <div className="hot-article-meta"><span>{source.name}</span>{item.rank > 0 && <span>#{item.rank}</span>}<span>{kindLabel[source.kind]}</span></div>
          <h1>{item.title}</h1>
          {item.heat && <p className="hot-article-heat">{item.heat}</p>}
          {item.description ? <p className="hot-description">{item.description}</p> : <p className="hot-no-description">此榜单未提供正文摘要</p>}
          <button className="hot-action" onClick={() => useReadingGroups.getState().setHotDisplay(tab.id, "web")}><Icon name="globe" size={15}/>浏览原网页</button>
          <div className="hot-source-info"><div>来源网址</div><p>{item.url}</p>{item.published_at && <><div>发布时间</div><p>{hotTime(item.published_at)}</p></>}<div>本地快照</div><p>{hotTime(tab.fetchedAt)}</p></div>
        </article>
        <details className="hot-attribution"><summary>来源说明</summary><p>{source.description}</p><p>{source.homepage}</p><p>{source.project} · {source.project_url}</p><p>各站榜单独立排序；热度指标不能跨站直接比较。</p></details>
      </div>}
  </>;
}
