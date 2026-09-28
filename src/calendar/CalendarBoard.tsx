import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { VerticalTimeline, VerticalTimelineElement } from "react-vertical-timeline-component";
import "react-vertical-timeline-component/style.min.css";
import Icon, { type IconName } from "../components/Icon";
import BoardResizeHandles from "../components/BoardResizeHandles";
import ResizeHandle from "../components/ResizeHandle";
import { useBoardPanes } from "../hooks/useBoardPanes";
import { isMac } from "../lib/platform";
import { reportError } from "../toast";
import { listCalendarEvents } from "../api";
import { adaptHistoryEvents, calendarProvenance, calendarProvenanceLabel, eventDisplayDay, filterByTag, historyOnDateKey, sortTimelineEvents, timelineDateLabel, yearOnDateKey } from "./adapters";
import { filterHistoryByTag, HISTORY_GROUPS, historyGroupFor } from "./historyGroups";
import { ALMANAC_MIN, CALENDAR_SPLIT_KEY, CALENDAR_YEAR_DETAIL_SPLIT_KEY, DETAIL_MIN, fitAlmanacWidth, parseAlmanacWidth, persistAlmanacWidth } from "./almanacSplit";
import historyEvents from "./historyEvents.json";
import { yearOfficialSeeds } from "./yearOfficialSeedSets";
import { attachOfficialBodyCache } from "./yearOfficialBodyCache";
import yearSeeds from "./yearSeeds.json";
import yearTalentSeeds from "./yearTalentSeeds.json";
import yearWindowSeeds from "./yearWindowSeeds.json";
import yearProgramSeeds from "./yearProgramSeeds.json";
import yearLocalSeeds from "./yearLocalSeeds.json";
import yearSocialSeeds from "./yearSocialSeeds.json";
import { cellMarks, habitsOnDateKey, isListedHabit, type YearHabit } from "./yearHabits";
import { eventFocusOnDate } from "./eventFocus";
import { explainTag } from "./tagGlossary";
import { nationalHolidays } from "./nationalHolidays";
import { growYearEvents, loadGrowSeeds, YEAR_GROUPS, yearCluster, type GrowSeed } from "./yearGrow";
import {
  MONTH_SHORT_LABELS,
  WEEKDAY_LABELS,
  dateKeyFromParts,
  historyMonthGrid,
  historyYearMonths,
  sameDateKey,
  shanghaiToday,
} from "./helpers";
import type { AlmanacMonth, CalendarDay, CalendarEvent, CalendarLayout, CalendarView, HistoryEvent } from "./types";
import "./calendar.css";

const HISTORY = adaptHistoryEvents(historyEvents as HistoryEvent[]);
// Hand-verified windows come first: dedup keeps the earliest match, and a harvested
// stub ("点击查看…") would otherwise outrank a notice whose window we actually checked.
const LEGACY_HARVESTED = attachOfficialBodyCache([
  ...(yearProgramSeeds as GrowSeed[]),
  ...(yearWindowSeeds as GrowSeed[]),
  ...(yearTalentSeeds as GrowSeed[]),
  ...(yearLocalSeeds as GrowSeed[]),
  ...(yearSocialSeeds as GrowSeed[]),
  ...(yearSeeds as GrowSeed[]),
]);

function officialSourceCount(seeds: readonly GrowSeed[]): number {
  return new Set(seeds.flatMap((seed) => {
    try { return [new URL(seed.article.url ?? "").hostname]; }
    catch { return []; }
  })).size;
}
/** Small dots, so a busy day can show every mark instead of a "+N" stub. */
const CELL_DOT_LIMIT = 8;
const CELL_TIP_LIMIT = 6;


function openSource(url: string) {
  const safe = /^https?:\/\//i.test(url) ? url : null;
  if (safe) void openUrl(safe).catch(reportError);
}

function SourceLinks({ sources }: { sources: { label: string; url: string }[] }) {
  if (sources.length === 0) return null;
  return <div className="calendar-sources">
    {sources.map((source) => <button key={source.url} type="button" className="calendar-source" onClick={() => openSource(source.url)}>{source.label}</button>)}
  </div>;
}

function eventSourceLinks(payload: CalendarEvent["payload"]): { label: string; url: string }[] {
  const links = [
    ...(payload.sourceUrl ? [{ label: payload.sourceName ? `原文 · ${payload.sourceName}` : "打开原文", url: payload.sourceUrl }] : []),
    ...(payload.sources ?? []),
  ];
  return links.filter((source, index) => source.url && links.findIndex((item) => item.url === source.url) === index);
}

function MediaPreview({ event }: { event: CalendarEvent }) {
  const media = event.payload.media;
  // Candidates can remain recorded in source work without silently becoming a
  // public visual. Only an explicitly cleared asset enters the interface.
  if (!media || media.reuseStatus !== "cleared") return null;
  return <figure className={`calendar-media calendar-media--${media.fit ?? "cover"}`}>
    <button type="button" onClick={() => openSource(media.sourcePage)} aria-label={`打开图片来源：${media.credit}`}>
      <img src={media.imageUrl} alt={media.alt} loading="lazy" />
    </button>
    <figcaption>{media.credit}<span aria-hidden="true"> · </span><button type="button" onClick={() => openSource(media.sourcePage)}>图源</button></figcaption>
  </figure>;
}

/** Keep discovery method, source authority, and date review visible but quiet. */
function ProvenanceBadge({ event }: { event: CalendarEvent }) {
  const provenance = calendarProvenance(event);
  return <small
    className="calendar-provenance"
    data-origin={provenance.origin}
    data-tier={provenance.sourceTier}
    data-verification={provenance.verification}
    title={`来源追溯：${calendarProvenanceLabel(provenance)}${provenance.reviewedAt ? `（核验于 ${provenance.reviewedAt}）` : ""}`}
  >{calendarProvenanceLabel(provenance)}</small>;
}

function TimelinePane({
  events,
  focused,
  onSelect,
}: {
  events: CalendarEvent[];
  focused: string | null;
  onSelect: (event: CalendarEvent) => void;
}) {
  if (events.length === 0) return <p className="calendar-empty">这个标签下暂时没有事件。</p>;
  return <VerticalTimeline animate={false} layout="1-column-left" lineColor="var(--cal-line)" className="calendar-timeline">
    {events.map((event) => <VerticalTimelineElement
      key={event.id}
      id={event.id}
      date={timelineDateLabel(event)}
      visible
      icon={<span className="calendar-timeline-dot" data-tone={eventTone(event)} />}
      iconStyle={{ background: "transparent", boxShadow: "none" }}
      contentStyle={{ background: "transparent", boxShadow: "none", padding: 0 }}
      contentArrowStyle={{ display: "none" }}
      onTimelineElementClick={() => onSelect(event)}
    >
      <EventCard event={event} active={focused === event.id} />
    </VerticalTimelineElement>)}
  </VerticalTimeline>;
}

/** One stable visual language for a category everywhere: mark, card, and icon. */
function tagTone(tag: string, fallback = "neutral"): string {
  const group = yearCluster(tag);
  if (group === "节假日") return "holiday";
  if (group === "培养节点") return "campus";
  if (group === "学术会议") return "conference";
  if (group === "自然科学基金") return "science";
  if (group === "人文社科基金") return "humanities";
  if (group === "国家科技项目") return "national";
  if (group === "地方科研项目") return "local";
  if (group === "人才计划") return "talent";
  if (group === "博士后项目") return "postdoc";
  if (group === "国际科研机会") return "international";
  if (group === "学术出版") return "publishing";
  if (group === "科研岗位") return "career";
  return fallback;
}

function eventTone(event: CalendarEvent): string {
  return tagTone(event.tags[0] ?? "", event.source === "history" ? "history" : "neutral");
}

function tagIcon(tag: string): IconName {
  const group = yearCluster(tag);
  if (group === "节假日") return "clock";
  if (group === "培养节点") return "folder";
  if (group === "学术会议" || group === "国际科研机会") return "globe";
  if (group === "自然科学基金" || group === "国家科技项目") return "sparkle";
  if (group === "人文社科基金" || group === "学术出版") return "file";
  if (group === "地方科研项目") return "pin";
  if (group === "人才计划") return "star";
  if (group === "博士后项目") return "bookmark";
  if (group === "科研岗位") return "inbox";
  return "tag";
}

/** Visible colour and compact pictogram; the native tooltip retains the label. */
function CategoryIcon({ tag }: { tag: string }) {
  return <span className="calendar-category-icon" role="img" aria-label={tag} title={tag} data-tone={tagTone(tag, "history")}>
    <Icon name={tagIcon(tag)} size={12}/>
  </span>;
}

function spanTone(kind: "start" | "end" | "through" | "point", tone?: number | null): number | null {
  if (tone != null) return tone;
  if (kind === "start") return 0;
  if (kind === "end") return 1;
  if (kind === "through") return 0.5;
  return null;
}

/** Colour walks green → yellow → red only when one tag is selected. */
function Dot({ kind, soft, tone, scale }: { kind: "start" | "end" | "through" | "point"; soft?: boolean; tone?: number | null; scale?: boolean }) {
  const t = scale ? spanTone(kind, tone) : null;
  return <i
    className={`calendar-dot is-${kind}${soft ? " is-evidence" : " is-habit"}${t != null ? " is-span" : ""}`}
    style={t != null ? { "--span-t": String(t) } as CSSProperties : undefined}
    aria-hidden
  />;
}

function ribbonKind(habit: YearHabit): "start" | "end" | "through" | "point" {
  if (habit.starts) return "start";
  if (habit.ends) return "end";
  if (habit.tone != null) return "through";
  return "point";
}

/**
 * The calendar is a planning surface, not a duplicate source list.  A ribbon
 * therefore names the cleaned tag-level pattern and only labels its opening
 * or a single-day point.  The full evidence remains in the selected-day pane.
 */
function PlannerRibbon({ habit, scale }: { habit: YearHabit; scale?: boolean }) {
  const kind = ribbonKind(habit);
  const label = habit.title === habit.tag ? habit.tag : habit.title;
  const showLabel = kind === "start" || kind === "point";
  const tone = scale ? spanTone(kind, habit.tone) : null;
  return <span
    className={`calendar-ribbon is-${kind}${habit.habit ? " is-habit" : " is-evidence"}${tone != null ? " is-scaled" : ""}`}
    data-tone={eventTone(habit.evidence[0] ?? { tags: [habit.tag], source: "year" } as CalendarEvent)}
    style={tone != null ? { "--span-t": String(tone) } as CSSProperties : undefined}
    title={label}
  >
    <span>{showLabel ? label : "\u00a0"}</span>
  </span>;
}

function TagGlossary({ tag, view }: { tag: string; view: CalendarView }) {
  const sense = explainTag(tag, view);
  const eyebrow = sense.kind === "group"
    ? "标签组"
    : sense.kind === "member" && sense.group
      ? sense.group
      : sense.kind === "history" && sense.group
        ? sense.group
        : sense.kind === "history"
          ? "昔日学术"
        : sense.kind === "field"
          ? "学科"
          : "标签";
  return <aside className="calendar-glossary" aria-label={`${tag} 的解释`}>
    <small>{eyebrow}</small>
    <h3>{tag}</h3>
    <p>{sense.definition}</p>
  </aside>;
}

function EventCard({ event, active, onSelect }: { event: CalendarEvent; active: boolean; onSelect?: () => void }) {
  const { payload } = event;
  const media = event.payload.media?.reuseStatus === "cleared";
  const dateLabel = event.source === "history" ? String(event.start.year) : `${event.start.month}/${event.start.day}`;
  const [expanded, setExpanded] = useState(false);
  const summary = payload.summary ?? payload.factSummary ?? payload.body ?? payload.scope ?? payload.historicalSignificance;
  const sourceLinks = eventSourceLinks(payload);
  const hasBody = Boolean(payload.body?.trim());
  const hasMore = hasBody || sourceLinks.length > 0 || Boolean(payload.scope || payload.historicalSignificance || payload.factSummary);
  const showSummary = Boolean(summary) && (!expanded || !hasBody || summary !== payload.body);
  const toggleDetails = () => setExpanded((current) => !current);
  return <article className={`calendar-card${media ? " has-media" : ""}${active ? " is-focused" : ""}${onSelect ? " is-interactive" : ""}${expanded ? " is-expanded" : " is-collapsed"}`} data-tone={eventTone(event)} onClick={e => { if (!(e.target as HTMLElement).closest("button,a")) onSelect?.(); }}>
    <aside className="calendar-card-stamp" aria-label={event.source === "history" ? `${event.start.year} 年` : `${event.start.month} 月 ${event.start.day} 日`}>
      <time>{dateLabel}</time>
      <span className="calendar-card-icons">{event.tags.map((tag) => <CategoryIcon key={tag} tag={tag}/>)}</span>
    </aside>
    {media && <MediaPreview event={event} />}
    <div className="calendar-card-content">
      <header>
        {event.source === "year" && <ProvenanceBadge event={event} />}
        {event.kind === "span" && event.end?.day != null && <small className="calendar-span-label"><Dot kind="start" scale />{event.start.month} 月 {event.start.day} 日 <Dot kind="end" scale />{event.end.month} 月 {event.end.day} 日</small>}
        {event.approximate && <small>约</small>}
        {payload.meta && event.kind !== "span" && <small>{payload.meta}</small>}
        {payload.importance && <span className="calendar-meta-icon" role="img" aria-label={`${payload.importance} 级`} title={`${payload.importance} 级`}><Icon name="star" size={12}/></span>}
        {payload.eventType && <span className="calendar-meta-icon" role="img" aria-label={payload.eventType} title={payload.eventType}><Icon name="focus" size={12}/></span>}
      </header>
      <div className="calendar-card-title-row">
        <h3>{onSelect ? <button type="button" className="calendar-card-select" aria-pressed={active} onClick={onSelect}>{event.title}</button> : event.title}</h3>
        {hasMore && <button type="button" className="calendar-card-disclosure" aria-expanded={expanded} aria-label={`${expanded ? "折叠" : "展开"}：${event.title}`} onClick={toggleDetails}>
          <span>{expanded ? "收起" : "展开"}</span><Icon name="chevron-down" size={13}/>
        </button>}
      </div>
      {showSummary && <p className="calendar-card-summary">{summary}</p>}
      {expanded && <div className="calendar-card-details">
        {hasBody && <section className="calendar-card-detail-block">
          <small>正文</small>
          <p className="calendar-card-body">{payload.body}</p>
          {payload.bodyTruncated && <p className="calendar-card-body-cache-note">正文缓存过长已截断，请打开官网原文阅读完整内容。</p>}
        </section>}
        {!hasBody && event.source === "year" && sourceLinks.length > 0 && <p className="calendar-card-missing-body">本地尚未缓存正文，可打开官网原文阅读。</p>}
        {payload.factSummary && summary !== payload.factSummary && <section className="calendar-card-detail-block">
          <small>事实摘要</small>
          <p>{payload.factSummary}</p>
        </section>}
        {payload.scope && <section className="calendar-card-detail-block">
          <small>适用范围</small>
          <p className="calendar-scope">{payload.scope}</p>
        </section>}
        {payload.historicalSignificance && <section className="calendar-card-detail-block">
          <small>学术意义</small>
          <p className="calendar-scope">{payload.historicalSignificance}</p>
        </section>}
        {sourceLinks.length > 0 && <section className="calendar-card-detail-block calendar-card-source-block">
          <small>原文链接</small>
          <SourceLinks sources={sourceLinks} />
        </section>}
      </div>}
    </div>
  </article>;
}

function MonthTitle({ month }: { month: number }) {
  return <h3 className="calendar-month-title">
    <b>{month} 月</b>
    <em>{MONTH_SHORT_LABELS[month - 1]}</em>
  </h3>;
}

function habitPhase(habit: YearHabit) {
  if (habit.starts && habit.ends) return "起止";
  if (habit.starts) return "起";
  if (habit.ends) return "止";
  if (habit.tone != null) return "中";
  return "";
}

function CellTip({ habits, items, month, day }: { habits: YearHabit[]; items: CalendarEvent[]; month: number; day: number }) {
  const yearLines = habits.slice(0, CELL_TIP_LIMIT);
  const historyLines = items.slice(0, CELL_TIP_LIMIT);
  const extra = habits.length > 0 ? habits.length - yearLines.length : items.length - historyLines.length;
  if (yearLines.length === 0 && historyLines.length === 0) return null;
  return <span className="calendar-cell-tip" role="tooltip">
    <small>{month} 月 {day} 日</small>
    {yearLines.map((habit) => {
      const phase = habitPhase(habit);
      return <span key={habit.id}>
        <b>{habit.habit ? "惯例" : habit.evidence.every((event) => event.tags.includes("培养节点")) ? "通知" : "节假日"}{phase ? ` · ${phase}` : ""}</b>
        <em>{habit.tag}</em>
        {habit.title !== habit.tag ? habit.title : ""}
      </span>;
    })}
    {historyLines.map((event) => <span key={event.id}>
      <b>{event.start.year}</b>
      {event.title}
    </span>)}
    {extra > 0 && <small>还有 {extra} 条</small>}
  </span>;
}

function MonthPane({
  pane,
  today,
  selected,
  events,
  yearMode,
  scale,
  focusEvents,
  onSelectDay,
}: {
  pane: AlmanacMonth;
  today: CalendarDay;
  selected: CalendarDay;
  events: CalendarEvent[];
  yearMode: boolean;
  scale?: boolean;
  focusEvents: CalendarEvent[];
  onSelectDay: (day: CalendarDay) => void;
}) {
  const grid = useMemo(() => historyMonthGrid(pane.year, pane.month), [pane.month, pane.year]);
  const cells = useMemo(() => grid.map((cell) => {
    const raw = yearMode ? habitsOnDateKey(events, cell.dateKey).filter(isListedHabit) : [];
    const habits = raw;
    const items = yearMode ? [] : historyOnDateKey(events, cell.dateKey);
    return { cell, habits, items, marks: yearMode ? cellMarks(habits) : [], rawCount: yearMode ? raw.length : items.length };
  }), [events, grid, yearMode]);
  const filled = cells.filter((entry) => entry.cell.inMonth && entry.rawCount > 0).length;
  const empty = filled === 0;
  const [forceOpen, setForceOpen] = useState(false);
  // Re-collapse once a tag change empties the month again.
  useEffect(() => { if (!empty) setForceOpen(false); }, [empty]);

  if (empty && !forceOpen) {
    return <section className="calendar-almanac-month is-collapsed" data-month={`${pane.year}-${pane.month}`} aria-label={`${pane.month} 月，这个标签下没有内容`}>
      <button type="button" className="calendar-month-collapsed" aria-expanded={false} onClick={() => setForceOpen(true)}>
        <MonthTitle month={pane.month} />
        <small>无内容</small>
        <Icon name="chevron-right" size={12}/>
      </button>
    </section>;
  }

  return <section className="calendar-almanac-month" data-month={`${pane.year}-${pane.month}`} aria-label={`${pane.month} 月`}>
    <div className="calendar-month-head">
      {empty
        ? <button type="button" className="calendar-month-collapsed is-open" aria-expanded onClick={() => setForceOpen(false)}>
          <MonthTitle month={pane.month} />
          <small>无内容</small>
          <Icon name="chevron-down" size={12}/>
        </button>
        : <MonthTitle month={pane.month} />}
    </div>
    <div className="calendar-weekdays" aria-hidden>
      {WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
    </div>
    <div className="calendar-month-grid">
      {cells.map(({ cell, habits, items, marks }) => {
        const day = { year: cell.year, month: cell.month, day: cell.day, dateKey: cell.dateKey };
        const active = sameDateKey(selected, day);
        const isToday = sameDateKey(today, day);
        const focus = eventFocusOnDate(focusEvents, cell.dateKey);
        const focusLabel = [focus.start ? "起" : "", focus.end ? "止" : "", focus.point ? "当日" : ""].filter(Boolean).join(" / ");
        const markCount = yearMode ? marks.length : items.length;
        const ribbons = yearMode ? habits.filter(isListedHabit) : [];
        const ribbonOverflow = ribbons.length - 2;
        const settled = yearMode ? habits.filter((habit) => habit.habit).length : 0;
        const holidayMarks = yearMode ? habits.filter((habit) => !habit.habit && habit.evidence.every((event) => event.tags.includes("节假日"))).length : 0;
        const noticeMarks = yearMode ? habits.filter((habit) => !habit.habit && habit.evidence.every((event) => event.tags.includes("培养节点"))).length : 0;
        const overflow = markCount - CELL_DOT_LIMIT;
        const label = yearMode
          ? `${cell.month}月${cell.day}日${settled ? `，${settled}条惯例` : ""}${holidayMarks ? `，${holidayMarks}个节假日` : ""}${noticeMarks ? `，${noticeMarks}条培养通知` : ""}`
          : `${cell.month}月${cell.day}日${markCount ? `，${markCount}条` : ""}`;
        return <button key={`${cell.year}-${cell.dateKey}-${cell.inMonth ? "in" : "out"}`} type="button" className={`${active ? "is-active" : ""}${isToday ? " is-today" : ""}${cell.inMonth ? "" : " is-out"}${settled ? " has-habit" : ""}${focus.related ? " is-related" : ""}${focus.start ? " is-range-start" : ""}${focus.end ? " is-range-end" : ""}`} data-date={cell.inMonth ? cell.dateKey : undefined} aria-pressed={active} aria-label={`${label}${focus.related ? `，已高亮${focusLabel || "区间"}` : ""}`} onClick={() => onSelectDay(day)}>
          <span className="calendar-day-num">{cell.day}</span>
          {focusLabel && <span className="calendar-focus-label">{focusLabel}</span>}
          {cell.dateKey === "02-29" && cell.inMonth && <span className="calendar-leap">闰</span>}
          {yearMode
            ? ribbons.length > 0 && <span className="calendar-ribbons" aria-hidden>
              {ribbons.slice(0, 2).map((habit) => <PlannerRibbon key={habit.id} habit={habit} scale={scale} />)}
              {ribbonOverflow > 0 && <em className="calendar-more">+{ribbonOverflow}</em>}
            </span>
            : markCount > 0 && <span className="calendar-dots" aria-hidden>
              {items.slice(0, CELL_DOT_LIMIT).map((event) => <i key={event.id} data-tone={eventTone(event)} className={event.approximate ? "is-approx" : ""} />)}
              {overflow > 0 && <em className="calendar-more">+{overflow}</em>}
            </span>}
          {markCount > 0 && <CellTip habits={habits} items={items} month={cell.month} day={cell.day} />}
        </button>;
      })}
    </div>
  </section>;
}

export default function CalendarBoard({ active, view }: { active: boolean; view: CalendarView }) {
  const today = useMemo(() => shanghaiToday(), []);
  const panes = useBoardPanes("calendar", false, active);
  const [layout, setLayout] = useState<CalendarLayout>("almanac");
  const [tag, setTag] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarDay>(today);
  const [focusedEvents, setFocusedEvents] = useState<CalendarEvent[]>([]);
  const [railEventId, setRailEventId] = useState<string | null>(null);
  const [splitWidth, setSplitWidth] = useState(0);
  const [historyAlmanacPref, setHistoryAlmanacPref] = useState(() => {
    try { return parseAlmanacWidth(localStorage.getItem(CALENDAR_SPLIT_KEY)); }
    catch { return parseAlmanacWidth(null); }
  });
  const [yearDetailPref, setYearDetailPref] = useState(() => {
    try { return parseAlmanacWidth(localStorage.getItem(CALENDAR_YEAR_DETAIL_SPLIT_KEY)); }
    catch { return parseAlmanacWidth(null); }
  });
  const splitRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const alignTo = useRef<AlmanacMonth | null>({ year: today.year, month: today.month });
  const storedOfficial = useQuery({ queryKey: ["calendar", "official-evidence"], queryFn: listCalendarEvents, enabled: active });
  // The bundled set is a deliberate offline fallback (including first launch
  // before setup can seed). Once the local store answers, it is authoritative.
  const officialSeeds = storedOfficial.data?.length ? storedOfficial.data : yearOfficialSeeds;
  const harvested = useMemo(() => [...officialSeeds, ...LEGACY_HARVESTED], [officialSeeds]);
  const reviewedOfficialSourceCount = useMemo(() => officialSourceCount(officialSeeds), [officialSeeds]);
  const grown = useQuery({ queryKey: ["articles", "calendar-year"], queryFn: loadGrowSeeds, enabled: active });
  const yearEvents = useMemo(
    () => [...nationalHolidays(today.year), ...growYearEvents([...harvested, ...(grown.data ?? [])])],
    [grown.data, harvested, today.year],
  );
  const pool = view === "year" ? yearEvents : HISTORY;
  const yearGroups = useMemo(() => {
    if (view !== "year") return [];
    const countFor = (name: string) => filterByTag(pool, name).length;
    return YEAR_GROUPS.map(({ group, members }) => ({
      group,
      count: countFor(group),
      members: members
        .map((name) => ({ tag: name, count: countFor(name) }))
        // A zero-count member is not a meaningful filter: selecting it makes
        // the planner look broken. It becomes visible as soon as audited data
        // for that node is present.
        .filter((item) => item.count > 0)
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "zh")),
    })).filter((item) => item.count > 0);
  }, [pool, view]);
  const historyGroups = useMemo(() => {
    if (view !== "history") return [];
    const countFor = (name: string) => filterHistoryByTag(pool, name).length;
    return HISTORY_GROUPS.map(({ group, members }) => ({
      group,
      count: countFor(group),
      members: members
        .map((name) => ({ tag: name, count: countFor(name) }))
        .filter((item) => item.count > 0)
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "zh")),
    })).filter((item) => item.count > 0);
  }, [pool, view]);
  const visible = useMemo(() => view === "history" ? filterHistoryByTag(pool, tag) : filterByTag(pool, tag), [pool, tag, view]);
  const months = useMemo(() => historyYearMonths(today.year), [today.year]);
  const selectedDayEvents = useMemo(() => (
    view === "history" ? historyOnDateKey(visible, selected.dateKey) : yearOnDateKey(visible, selected.dateKey)
  ), [selected.dateKey, view, visible]);
  // The year grid is the index; rendering every matching record beside it made
  // the first paint mount more than a thousand cards. Keep the detail pane a
  // true date detail so selecting a day changes both panes immediately.
  // Both workspaces use the right rail as an actual selected-date detail.
  // Keeping the old history feed there made one calendar click render every
  // later day and caused the visible card count to disagree with the date.
  const detailEvents = selectedDayEvents;
  const timelineEvents = useMemo(() => sortTimelineEvents(visible), [visible]);
  const focused = railEventId;
  // In 昔日学术 this is the compact right calendar rail; in 学术年历 it is
  // the compact right detail rail. Keeping separate preferences preserves both
  // reading and planning modes when a user resizes either one.
  const split = fitAlmanacWidth(splitWidth, view === "year" ? yearDetailPref : historyAlmanacPref);

  const monthStride = useCallback(() => {
    const pane = scrollerRef.current?.querySelector(".calendar-almanac-month");
    if (!pane || !scrollerRef.current) return 0;
    const styles = getComputedStyle(scrollerRef.current);
    const gap = Number.parseFloat(styles.rowGap || styles.gap) || 22;
    return pane.getBoundingClientRect().height + gap;
  }, []);

  const scrollMonths = useCallback((delta: number) => {
    const el = scrollerRef.current;
    const stride = monthStride();
    if (el && stride) el.scrollTop += delta * stride;
  }, [monthStride]);

  const clearFocus = useCallback(() => { setFocusedEvents([]); setRailEventId(null); }, []);

  const goToday = useCallback(() => {
    setSelected(today);
    setRailEventId(null);
    setFocusedEvents([]);
    alignTo.current = { year: today.year, month: today.month };
    requestAnimationFrame(() => {
      const todayId = historyOnDateKey(visible, today.dateKey)[0]?.id;
      if (view === "history" && layout === "timeline" && todayId) document.getElementById(todayId)?.scrollIntoView({ block: "center" });
    });
  }, [layout, today, view, visible]);

  const chooseLayout = (next: CalendarLayout) => {
    setLayout(next);
    setRailEventId(null);
    setFocusedEvents([]);
    if (next === "almanac") alignTo.current = { year: selected.year, month: selected.month };
  };

  useEffect(() => {
    setTag(null);
    setOpenGroup(null);
    setRailEventId(null);
    setFocusedEvents([]);
    setSelected(today);
    alignTo.current = { year: today.year, month: today.month };
  }, [today, view]);

  const chooseTag = (next: string | null) => {
    clearFocus();
    setTag(next);
    setOpenGroup(next ? (view === "history" ? historyGroupFor(next) : yearCluster(next)) : null);
  };

  const toggleGroup = (group: string) => {
    clearFocus();
    setTag(group);
    setOpenGroup((current) => (current === group && tag === group ? null : group));
  };

  const selectDay = (day: CalendarDay) => {
    setSelected(day);
    setRailEventId(null);
    setFocusedEvents([]);
  };

  const selectTimelineEvent = (event: CalendarEvent) => {
    const day = eventDisplayDay(event);
    setSelected({ year: today.year, month: event.start.month, day, dateKey: dateKeyFromParts(event.start.month, day) });
    setRailEventId(event.id);
    setFocusedEvents([event]);
  };

  const revealDate = (dateKey: string) => {
    const cell = scrollerRef.current?.querySelector<HTMLElement>(`[data-date="${dateKey}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const highlightEvents = (events: CalendarEvent[], id: string) => {
    if (railEventId === id) { clearFocus(); return; }
    setRailEventId(id);
    setFocusedEvents(events);
    const first = events[0];
    if (first) revealDate(dateKeyFromParts(first.start.month, eventDisplayDay(first)));
  };

  const resizeAlmanac = (width: number) => {
    if (view === "year") {
      setYearDetailPref(width);
      persistAlmanacWidth(width, CALENDAR_YEAR_DETAIL_SPLIT_KEY);
      return;
    }
    setHistoryAlmanacPref(width);
    persistAlmanacWidth(width);
  };

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const measure = () => {
      // Layout pixels: a bounding rect includes the application zoom.
      const width = el.clientWidth || el.getBoundingClientRect().width;
      if (width > 0) setSplitWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout]);

  useLayoutEffect(() => {
    if (layout !== "almanac") return;
    const el = scrollerRef.current;
    if (!el) return;
    const target = alignTo.current;
    if (target) {
      const pane = el.querySelector<HTMLElement>(`[data-month="${target.year}-${target.month}"]`);
      if (pane) el.scrollTop += pane.getBoundingClientRect().top - el.getBoundingClientRect().top;
      alignTo.current = null;
    }
  }, [layout, view]);

  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (!detail) return;
    detail.scrollTo({ top: 0 });
  }, [selected.dateKey, split.almanacWidth, splitWidth, tag, view]);

  useLayoutEffect(() => {
    if (view !== "history" || layout !== "timeline") return;
    const id = selectedDayEvents[0]?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [layout, selectedDayEvents, tag, view]);

  useEffect(() => {
    if (!active || layout !== "almanac") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], [role='separator']")) return;
      if (event.key === "Escape" && focusedEvents.length) {
        event.preventDefault();
        clearFocus();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        scrollMonths(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clearFocus, focusedEvents.length, layout, scrollMonths]);

  const surfaceTitle = view === "history" ? "昔日学术" : "学术年历";
  const almanacPane = <div
    ref={scrollerRef}
    className={`calendar-almanac${view === "history" ? " is-history" : " is-planner"}${focusedEvents.length ? " is-focusing" : ""}`}
  >
    {layout === "almanac"
      ? <section className="calendar-year-months" aria-label="年度月历">
          {view === "year" && <header><small>年度月历</small><span>{tag ? `${tag} · ${visible.length} 条` : `${visible.length} 条`}</span></header>}
          {months.map((pane) => <MonthPane key={`${view}-${pane.year}-${pane.month}`} pane={pane} today={today} selected={selected} events={visible} yearMode={view === "year"} scale={view === "year" && tag != null} focusEvents={focusedEvents} onSelectDay={selectDay} />)}
        </section>
      : <section className="calendar-timeline-wrap" aria-label={surfaceTitle}>
          <p className="calendar-lead">{timelineEvents.length ? `按发生先后排列，共 ${timelineEvents.length} 条。` : "这个标签下暂时没有事件。"}</p>
          <TimelinePane events={timelineEvents} focused={focused} onSelect={selectTimelineEvent} />
        </section>}
  </div>;

  return <section ref={panes.hostRef} style={panes.style} className={`hot-workspace calendar-workspace is-${view} is-${layout}`} aria-label={view === "history" ? "昔日学术" : "学术年历"}>
    {isMac && <div className="titlebar" data-tauri-drag-region />}
    <aside className="hot-sidebar" aria-label="日历标签">
      <div className="hot-section-label">标签组</div>
      <div className="hot-source-nav" aria-label="事件标签">
        <button type="button" className={tag === null ? "is-active" : ""} onClick={() => chooseTag(null)}>
          <Icon name="tag" size={14}/><span>全部</span><small>{pool.length}</small>
        </button>
        {view === "year"
          ? yearGroups.map((item) => {
            const open = openGroup === item.group;
            return <div key={item.group} className={`calendar-tag-group${open ? " is-open" : ""}`}>
              <button type="button" className={tag === item.group ? "is-active" : tag && yearCluster(tag) === item.group ? "is-current" : ""} aria-expanded={item.members.length > 0 ? open : undefined} onClick={() => toggleGroup(item.group)}>
                <Icon name="tag" size={14}/><span>{item.group}</span><small>{item.count}</small>
                {item.members.length > 0 && <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="calendar-tag-caret" />}
              </button>
              {open && item.members.map((member) => <button key={member.tag} type="button" className={`calendar-tag-member${tag === member.tag ? " is-active" : ""}`} onClick={() => chooseTag(member.tag)}>
                <span>{member.tag}</span><small>{member.count}</small>
              </button>)}
            </div>;
          })
          : historyGroups.map((item) => {
            const open = openGroup === item.group;
            return <div key={item.group} className={`calendar-tag-group${open ? " is-open" : ""}`}>
              <button type="button" className={tag === item.group ? "is-active" : tag && historyGroupFor(tag) === item.group ? "is-current" : ""} aria-expanded={item.members.length > 0 ? open : undefined} onClick={() => toggleGroup(item.group)}>
                <Icon name="tag" size={14}/><span>{item.group}</span><small>{item.count}</small>
                {item.members.length > 0 && <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="calendar-tag-caret" />}
              </button>
              {open && item.members.map((member) => <button key={member.tag} type="button" className={`calendar-tag-member${tag === member.tag ? " is-active" : ""}`} onClick={() => chooseTag(member.tag)}>
                <span>{member.tag}</span><small>{member.count}</small>
              </button>)}
            </div>;
          })}
      </div>
      <div className="hot-sidebar-foot">{view === "year"
        ? `官网证据库 ${officialSeeds.length} 条 · ${reviewedOfficialSourceCount} 个权威入口`
        : layout === "timeline" ? "按发生时间往下读" : "366 天 · 点一天跳到同月同日"}</div>
    </aside>
    <header className="hot-workspace-toolbar" data-tauri-drag-region>
      <span className="calendar-today-mark">今天 {today.month} 月 {today.day} 日 · 上海时区</span>
    </header>
    <main className="calendar-main">
      <div className="calendar-day-nav">
        {layout === "almanac" && <>
          <button type="button" className="hot-icon-button" aria-label="上一月" onClick={() => scrollMonths(-1)}><Icon name="arrow-up" size={14}/></button>
          <button type="button" className="hot-icon-button" aria-label="下一月" onClick={() => scrollMonths(1)}><Icon name="arrow-down" size={14}/></button>
        </>}
        <h2>{surfaceTitle}</h2>
        <nav className="calendar-layout-switch" aria-label="视图方式">
          <button type="button" aria-pressed={layout === "almanac"} onClick={() => chooseLayout("almanac")}><Icon name="grid" size={13}/>月历</button>
          <button type="button" aria-pressed={layout === "timeline"} onClick={() => chooseLayout("timeline")}><Icon name="list" size={13}/>时间轴</button>
        </nav>
        {focusedEvents.length > 0 && <button type="button" className="calendar-clear-focus" onClick={clearFocus}>取消高亮</button>}
        <button type="button" className="calendar-jump-today" onClick={goToday}>回到今天</button>
      </div>
      <div ref={splitRef} className="calendar-split" style={{ "--cal-almanac-width": `${split.almanacWidth}px`, "--cal-almanac-min": `${ALMANAC_MIN}px` } as CSSProperties}>
        {almanacPane}
        <section ref={detailRef} className={`calendar-detail${view === "year" ? " calendar-selection" : ""}`} aria-label={view === "year" ? "当前标签卡片" : "详情"}>
          {view === "year" ? <>
            {tag && <TagGlossary tag={tag} view={view} />}
              <header className="calendar-selection-heading">
                <small>当前标签</small>
                <h2>{tag ?? "全部"}</h2>
                <span>{visible.length} 条已收录 · {selected.month} 月 {selected.day} 日 {detailEvents.length} 条</span>
              </header>
              {focusedEvents.length > 0 && <div className="calendar-focus-summary" aria-label="高亮事件日期" aria-live="polite">
                {focusedEvents.map(event => <div key={event.id}>
                  <span>{event.title}</span>
                  <button type="button" onClick={() => revealDate(dateKeyFromParts(event.start.month, eventDisplayDay(event)))}>{event.kind === "span" ? "起：" : "日期："}{event.start.month} 月 {eventDisplayDay(event)} 日{event.approximate ? "（约）" : ""}</button>
                  {event.kind === "span" && event.end?.day != null && <button type="button" onClick={() => revealDate(dateKeyFromParts(event.end!.month, event.end!.day!))}>止：{event.end.month} 月 {event.end.day}</button>}
                </div>)}
              </div>}
              {detailEvents.length > 0
                ? detailEvents.map((event) => <EventCard key={event.id} event={event} active={focused === event.id} onSelect={() => highlightEvents([event], event.id)} />)
                : <p className="calendar-empty">这一天没有匹配卡片；请在月历中选择带标记的日期。</p>}
          </> : <>
          {tag && <TagGlossary tag={tag} view={view} />}
          <h2>{`昔日学术 · ${tag ?? "全部"}`}</h2>
          <p className="calendar-lead">{visible.length === 0
            ? "这个标签下暂时没有收录。"
            : `共 ${visible.length} 条，按月日排列。${selectedDayEvents.length ? `${selected.month} 月 ${selected.day} 日有 ${selectedDayEvents.length} 条。` : `${selected.month} 月 ${selected.day} 日暂时没有收录，已跳到之后最近的一天。`}`}</p>
          {focusedEvents.length > 0 && <div className="calendar-focus-summary" aria-label="高亮事件日期" aria-live="polite">
            {focusedEvents.map(event => <div key={event.id}>
              <span>{event.title}</span>
              <button type="button" onClick={() => revealDate(dateKeyFromParts(event.start.month, eventDisplayDay(event)))}>{event.kind === "span" ? "起：" : "日期："}{event.start.month} 月 {eventDisplayDay(event)} 日{event.approximate ? "（约）" : ""}</button>
              {event.kind === "span" && event.end?.day != null && <button type="button" onClick={() => revealDate(dateKeyFromParts(event.end!.month, event.end!.day!))}>止：{event.end.month} 月 {event.end.day} 日</button>}
            </div>)}
          </div>}
          {detailEvents.length > 0
            ? detailEvents.map((event) => <EventCard key={event.id} event={event} active={focused === event.id} onSelect={() => highlightEvents([event], event.id)} />)
            : <p className="calendar-empty">这一天没有匹配卡片；请在月历或时间轴中选择有标记的日期。</p>}
          </>}
        </section>
        {splitWidth > 0 && <div className="resize-handle-slot">
          <ResizeHandle visible width={split.almanacWidth} side={view === "year" ? "left" : "right"} min={Math.min(ALMANAC_MIN, split.almanacWidth)} max={Math.max(split.almanacWidth, splitWidth - Math.min(DETAIL_MIN, splitWidth))} onResize={resizeAlmanac} label={view === "year" ? "调整详情宽度" : "调整月历宽度"}/>
        </div>}
      </div>
    </main>
    {active && <BoardResizeHandles panes={panes} hasList={false} label="日历"/>}
  </section>;
}
