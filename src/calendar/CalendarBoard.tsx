import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { VerticalTimeline, VerticalTimelineElement } from "react-vertical-timeline-component";
import "react-vertical-timeline-component/style.min.css";
import Icon from "../components/Icon";
import BoardResizeHandles from "../components/BoardResizeHandles";
import ResizeHandle from "../components/ResizeHandle";
import { useBoardPanes } from "../hooks/useBoardPanes";
import { isMac } from "../lib/platform";
import { reportError } from "../toast";
import { adaptHistoryEvents, eventDisplayDay, filterByTag, historyOnDateKey, sortTimelineEvents, tagHeat, timelineDateLabel, yearOnDateKey } from "./adapters";
import { ALMANAC_MIN, CALENDAR_SPLIT_KEY, DETAIL_MIN, fitAlmanacWidth, parseAlmanacWidth, persistAlmanacWidth } from "./almanacSplit";
import historyEvents from "./historyEvents.json";
import yearSeeds from "./yearSeeds.json";
import yearTalentSeeds from "./yearTalentSeeds.json";
import yearWindowSeeds from "./yearWindowSeeds.json";
import yearProgramSeeds from "./yearProgramSeeds.json";
import yearLocalSeeds from "./yearLocalSeeds.json";
import yearSocialSeeds from "./yearSocialSeeds.json";
import { cellMarks, habitsOnDateKey, yearHabits, type YearHabit } from "./yearHabits";
import { eventFocusOnDate } from "./eventFocus";
import { explainTag } from "./tagGlossary";
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
const HARVESTED = [...(yearProgramSeeds as GrowSeed[]), ...(yearWindowSeeds as GrowSeed[]), ...(yearTalentSeeds as GrowSeed[]), ...(yearLocalSeeds as GrowSeed[]), ...(yearSocialSeeds as GrowSeed[]), ...(yearSeeds as GrowSeed[])];
/** Small dots, so a busy day can show every mark instead of a "+N" stub. */
const CELL_DOT_LIMIT = 8;
const EVIDENCE_PREVIEW = 8;
const CELL_TIP_LIMIT = 6;

function dateKeyLabel(dateKey: string): string {
  const [month, day] = dateKey.split("-").map(Number);
  return `${month} 月 ${day} 日`;
}

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
    {events.map((event, index) => <VerticalTimelineElement
      key={event.id}
      id={event.id}
      date={timelineDateLabel(event)}
      visible
      icon={<span className="calendar-timeline-dot" data-tone={index % 4} />}
      iconStyle={{ background: "transparent", boxShadow: "none" }}
      contentStyle={{ background: "transparent", boxShadow: "none", padding: 0 }}
      contentArrowStyle={{ display: "none" }}
      onTimelineElementClick={() => onSelect(event)}
    >
      <EventCard event={event} active={focused === event.id} />
    </VerticalTimelineElement>)}
  </VerticalTimeline>;
}

function spanTone(kind: "start" | "end" | "through" | "point", tone?: number | null): number | null {
  if (tone != null) return tone;
  if (kind === "start") return 0;
  if (kind === "end") return 1;
  if (kind === "through") return 0.5;
  return null;
}

function spanWord(kind: "start" | "end" | "through" | "point"): string | null {
  if (kind === "start") return "起";
  if (kind === "end") return "止";
  if (kind === "through") return "中";
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

function HabitCard({ habit, active, scale, onSelect, onSelectEvent, focusedId }: { habit: YearHabit; active: boolean; scale?: boolean; onSelect?: () => void; onSelectEvent?: (event: CalendarEvent) => void; focusedId?: string | null }) {
  const years = habit.years.length === 1 ? `${habit.years[0]} 年` : `${habit.years[0]}–${habit.years[habit.years.length - 1]} 年`;
  const spanKind = habit.starts ? "start" : habit.ends ? "end" : "through";
  return <article className={`calendar-card calendar-habit${habit.habit ? " is-habit" : ""}${active ? " is-focused" : ""}${onSelect ? " is-interactive" : ""}`} onClick={event => { if (!(event.target as HTMLElement).closest("button,a")) onSelect?.(); }}>
    <header>
      <small>{habit.habit ? "惯例" : "依据"}</small>
      <span className="calendar-chip">{habit.tag}</span>
      {habit.tone != null && <span className="calendar-span-label"><Dot kind={spanKind} tone={habit.tone} scale={scale} />{spanWord(spanKind)}</span>}
      <small>依据 {habit.evidence.length} 条 · {years}</small>
    </header>
    <h3>{onSelect ? <button type="button" className="calendar-card-select" aria-pressed={active} onClick={onSelect}>{habit.title}</button> : habit.title}</h3>
    <p className="calendar-scope">{habit.habit ? "每年这个时候出现得比较密，真实条目只当作依据。" : "还只有零星依据，先记在这一天。"}</p>
    <ul className="calendar-evidence">
      {habit.evidence.slice(0, EVIDENCE_PREVIEW).map((event) => <li key={event.id}>
        {onSelectEvent
          ? <button type="button" className="calendar-evidence-select" aria-pressed={focusedId === event.id} onClick={() => onSelectEvent(event)}>{event.start.year} · {event.title}<small>{timelineDateLabel(event)}</small></button>
          : <span>{event.start.year} · {event.title}</span>}
        {event.payload.sourceUrl && <button type="button" className="calendar-source" onClick={() => openSource(event.payload.sourceUrl!)}>查看来源</button>}
      </li>)}
    </ul>
    {habit.evidence.length > EVIDENCE_PREVIEW && <p className="calendar-scope">还有 {habit.evidence.length - EVIDENCE_PREVIEW} 条依据。</p>}
  </article>;
}

function TagGlossary({ tag, view }: { tag: string; view: CalendarView }) {
  const sense = explainTag(tag, view);
  const eyebrow = sense.kind === "group"
    ? "标签组"
    : sense.kind === "member" && sense.group
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
  return <article className={`calendar-card${active ? " is-focused" : ""}${onSelect ? " is-interactive" : ""}`} onClick={e => { if (!(e.target as HTMLElement).closest("button,a")) onSelect?.(); }}>
    <header>
      {event.source === "history" && <small>{event.start.year} 年</small>}
      {event.tags.map((tag) => <span key={tag} className="calendar-chip">{tag}</span>)}
      {event.kind === "span" && event.end?.day != null && <small className="calendar-span-label"><Dot kind="start" scale />{event.start.month} 月 {event.start.day} 日 <Dot kind="end" scale />{event.end.month} 月 {event.end.day} 日</small>}
      {event.approximate && <small>约</small>}
      {payload.meta && event.kind !== "span" && <small>{payload.meta}</small>}
      {payload.importance && <small>{payload.importance} 级</small>}
      {payload.eventType && <small>{payload.eventType}</small>}
    </header>
    <h3>{onSelect ? <button type="button" className="calendar-card-select" aria-pressed={active} onClick={onSelect}>{event.title}</button> : event.title}</h3>
    {payload.body && <p>{payload.body}</p>}
    {payload.factSummary && <p>{payload.factSummary}</p>}
    {payload.scope && <p className="calendar-scope">{payload.scope}</p>}
    {payload.historicalSignificance && <p className="calendar-scope">{payload.historicalSignificance}</p>}
    {payload.sourceUrl && <SourceLinks sources={[{ label: payload.sourceName || "查看来源", url: payload.sourceUrl }]} />}
    {payload.sources && <SourceLinks sources={payload.sources} />}
  </article>;
}

function HabitTimeline({ habits, focused, scale, onSelect }: { habits: YearHabit[]; focused: string | null; scale?: boolean; onSelect: (habit: YearHabit) => void }) {
  if (habits.length === 0) return <p className="calendar-empty">这个标签下暂时没有依据。</p>;
  return <VerticalTimeline animate={false} layout="1-column-left" lineColor="var(--cal-line)" className="calendar-timeline">
    {habits.map((habit, index) => <VerticalTimelineElement
      key={habit.id}
      id={habit.id}
      date={dateKeyLabel(habit.dateKey)}
      visible
      icon={<span className="calendar-timeline-dot" data-tone={index % 4} />}
      iconStyle={{ background: "transparent", boxShadow: "none" }}
      contentStyle={{ background: "transparent", boxShadow: "none", padding: 0 }}
      contentArrowStyle={{ display: "none" }}
      onTimelineElementClick={() => onSelect(habit)}
    >
      <HabitCard habit={habit} active={focused === habit.id} scale={scale} />
    </VerticalTimelineElement>)}
  </VerticalTimeline>;
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

function CellTip({ habits, items }: { habits: YearHabit[]; items: CalendarEvent[] }) {
  const yearLines = habits.slice(0, CELL_TIP_LIMIT);
  const historyLines = items.slice(0, CELL_TIP_LIMIT);
  const extra = habits.length > 0 ? habits.length - yearLines.length : items.length - historyLines.length;
  if (yearLines.length === 0 && historyLines.length === 0) return null;
  return <span className="calendar-cell-tip" role="tooltip">
    {yearLines.map((habit) => {
      const phase = habitPhase(habit);
      return <span key={habit.id}>
        <b>{habit.habit ? "惯例" : "依据"}{phase ? ` · ${phase}` : ""}</b>
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
    const raw = yearMode ? habitsOnDateKey(events, cell.dateKey) : [];
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
        const settled = yearMode ? marks.filter((mark) => mark.habit).length : 0;
        const overflow = markCount - CELL_DOT_LIMIT;
        const label = yearMode
          ? `${cell.month}月${cell.day}日${settled ? `，${settled}条惯例` : ""}${markCount - settled ? `，${markCount - settled}组依据` : ""}`
          : `${cell.month}月${cell.day}日${markCount ? `，${markCount}条` : ""}`;
        return <button key={`${cell.year}-${cell.dateKey}-${cell.inMonth ? "in" : "out"}`} type="button" className={`${active ? "is-active" : ""}${isToday ? " is-today" : ""}${cell.inMonth ? "" : " is-out"}${settled ? " has-habit" : ""}${focus.related ? " is-related" : ""}${focus.start ? " is-range-start" : ""}${focus.end ? " is-range-end" : ""}`} data-date={cell.inMonth ? cell.dateKey : undefined} aria-pressed={active} aria-label={`${label}${focus.related ? `，已高亮${focusLabel || "区间"}` : ""}`} onClick={() => onSelectDay(day)}>
          <span className="calendar-day-num">{cell.day}</span>
          {focusLabel && <span className="calendar-focus-label">{focusLabel}</span>}
          {cell.dateKey === "02-29" && cell.inMonth && <span className="calendar-leap">闰</span>}
          {markCount > 0 && <span className="calendar-dots" aria-hidden>
            {yearMode
              ? marks.slice(0, CELL_DOT_LIMIT).map((mark) => <Dot key={mark.id} kind={mark.kind} tone={mark.tone} scale={scale} soft={!mark.habit} />)
              : items.slice(0, CELL_DOT_LIMIT).map((event, index) => <i key={event.id} data-tone={index % 4} className={event.approximate ? "is-approx" : ""} />)}
            {overflow > 0 && <em className="calendar-more">+{overflow}</em>}
          </span>}
          {markCount > 0 && <CellTip habits={habits} items={items} />}
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
  const [almanacPref, setAlmanacPref] = useState(() => {
    try { return parseAlmanacWidth(localStorage.getItem(CALENDAR_SPLIT_KEY)); }
    catch { return parseAlmanacWidth(null); }
  });
  const splitRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const alignTo = useRef<AlmanacMonth | null>({ year: today.year, month: today.month });
  const grown = useQuery({ queryKey: ["articles", "calendar-year"], queryFn: loadGrowSeeds, enabled: active });
  const yearEvents = useMemo(() => growYearEvents([...(grown.data ?? []), ...HARVESTED]), [grown.data]);
  const pool = view === "year" ? yearEvents : HISTORY;
  const poolHabits = useMemo(() => view === "year" ? yearHabits(pool) : [], [pool, view]);
  const tags = useMemo(() => view === "year" ? [] : tagHeat(pool), [pool, view]);
  const yearGroups = useMemo(() => {
    if (view !== "year") return [];
    const countFor = (name: string) => yearHabits(filterByTag(pool, name)).length;
    return YEAR_GROUPS.map(({ group, members }) => ({
      group,
      count: countFor(group),
      members: members
        .map((name) => ({ tag: name, count: countFor(name) }))
        .filter((item) => item.count > 0)
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "zh")),
    })).filter((item) => item.count > 0);
  }, [pool, view]);
  const visible = useMemo(() => filterByTag(pool, tag), [pool, tag]);
  const months = useMemo(() => historyYearMonths(today.year), [today.year]);
  const selectedDayEvents = useMemo(() => (
    view === "history" ? historyOnDateKey(visible, selected.dateKey) : yearOnDateKey(visible, selected.dateKey)
  ), [selected.dateKey, view, visible]);
  const selectedHabits = useMemo(() => view === "year" ? habitsOnDateKey(visible, selected.dateKey) : [], [selected.dateKey, view, visible]);
  const timelineEvents = useMemo(() => sortTimelineEvents(visible), [visible]);
  const timelineHabits = useMemo(() => view === "year" ? yearHabits(visible) : [], [view, visible]);
  const focused = railEventId;
  const split = fitAlmanacWidth(splitWidth, almanacPref);

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
      const todayId = view === "year"
        ? habitsOnDateKey(visible, today.dateKey)[0]?.id
        : historyOnDateKey(visible, today.dateKey)[0]?.id;
      if (layout === "timeline" && todayId) document.getElementById(todayId)?.scrollIntoView({ block: "center" });
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
    setOpenGroup(next ? yearCluster(next) : null);
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
  };

  const selectHabit = (habit: YearHabit) => {
    const [month, day] = habit.dateKey.split("-").map(Number);
    setSelected({ year: today.year, month, day, dateKey: habit.dateKey });
    setRailEventId(habit.id);
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
    setAlmanacPref(width);
    persistAlmanacWidth(width);
  };

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el || layout !== "almanac") return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
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
    detailRef.current?.scrollTo({ top: 0 });
  }, [tag]);

  useLayoutEffect(() => {
    if (layout !== "timeline") return;
    const id = view === "year" ? selectedHabits[0]?.id : selectedDayEvents[0]?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [layout, selectedDayEvents, selectedHabits, tag, view]);

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

  return <section ref={panes.hostRef} style={panes.style} className={`hot-workspace calendar-workspace is-${view} is-${layout}`} aria-label={view === "history" ? "昔日学术" : "学术年历"}>
    {isMac && <div className="titlebar" data-tauri-drag-region />}
    <aside className="hot-sidebar" aria-label="日历标签">
      <div className="hot-section-label">{view === "year" ? "标签组" : "按热度"}</div>
      <div className="hot-source-nav" aria-label="事件标签">
        <button type="button" className={tag === null ? "is-active" : ""} onClick={() => chooseTag(null)}>
          <Icon name="tag" size={14}/><span>全部</span><small>{view === "year" ? poolHabits.length : pool.length}</small>
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
          : tags.map((item) => <button key={item.tag} type="button" className={tag === item.tag ? "is-active" : ""} onClick={() => chooseTag(item.tag)}>
            <Icon name="tag" size={14}/><span>{item.tag}</span><small>{item.count}</small>
          </button>)}
      </div>
      <div className="hot-sidebar-foot">{layout === "timeline" ? "按发生时间往下读" : view === "year" ? "1–12 月 · 真实条目是依据，多了成为惯例" : "366 天 · 点一天看同月同日"}</div>
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
        <h2>{layout === "timeline" ? "时间轴" : view === "history" ? "昔日学术" : "学术年历"}</h2>
        <nav className="calendar-layout-switch" aria-label="右侧视图">
          <button type="button" aria-pressed={layout === "almanac"} onClick={() => chooseLayout("almanac")}><Icon name="grid" size={13}/>月历</button>
          <button type="button" aria-pressed={layout === "timeline"} onClick={() => chooseLayout("timeline")}><Icon name="list" size={13}/>时间轴</button>
        </nav>
        {focusedEvents.length > 0 && <button type="button" className="calendar-clear-focus" onClick={clearFocus}>取消高亮</button>}
        <button type="button" className="calendar-jump-today" onClick={goToday}>回到今天</button>
      </div>
      {layout === "almanac" ? <div ref={splitRef} className="calendar-split" style={{ "--cal-almanac-width": `${split.almanacWidth}px` } as CSSProperties}>
        <div
          ref={scrollerRef}
          className={`calendar-almanac${view === "history" ? " is-history" : ""}${focusedEvents.length ? " is-focusing" : ""}`}
        >
          {months.map((pane) => <MonthPane key={`${view}-${pane.year}-${pane.month}`} pane={pane} today={today} selected={selected} events={visible} yearMode={view === "year"} scale={view === "year" && tag != null} focusEvents={focusedEvents} onSelectDay={selectDay} />)}
        </div>
        {splitWidth > 0 && <div className="resize-handle-slot" style={{ left: split.almanacWidth }}>
          <ResizeHandle visible width={split.almanacWidth} side="right" min={Math.min(ALMANAC_MIN, split.almanacWidth)} max={Math.max(split.almanacWidth, splitWidth - Math.min(DETAIL_MIN, splitWidth))} onResize={resizeAlmanac} label="调整月历宽度"/>
        </div>}
        <section ref={detailRef} className="calendar-detail" aria-label="详情">
          {tag && <TagGlossary tag={tag} view={view} />}
          <h2>{view === "history" ? `昔日学术 · ${selected.month} 月 ${selected.day} 日` : `学术年历 · ${selected.month} 月 ${selected.day} 日`}</h2>
          <p className="calendar-lead">{view === "history"
            ? selectedDayEvents.length ? `这一天在历史上有 ${selectedDayEvents.length} 条。` : "这一天暂时没有收录。"
            : selectedHabits.length
              ? `这一天有 ${selectedHabits.filter((habit) => habit.habit).length} 条惯例、${selectedHabits.length} 组依据。`
              : grown.isFetching
                ? "正在从订阅里长依据…"
                : yearEvents.length === 0
                  ? "还没长出依据。桌面端打开后，会从基金申报、国际截止日期和会议日历往上长。"
                  : "这一天还没有依据。点有标记的日子。"}</p>
          {focusedEvents.length > 0 && <div className="calendar-focus-summary" aria-label="高亮事件日期" aria-live="polite">
            {focusedEvents.map(event => <div key={event.id}>
              <span>{event.title}</span>
              <button type="button" onClick={() => revealDate(dateKeyFromParts(event.start.month, eventDisplayDay(event)))}>{event.kind === "span" ? "起：" : "日期："}{event.start.month} 月 {eventDisplayDay(event)} 日{event.approximate ? "（约）" : ""}</button>
              {event.kind === "span" && event.end?.day != null && <button type="button" onClick={() => revealDate(dateKeyFromParts(event.end!.month, event.end!.day!))}>止：{event.end.month} 月 {event.end.day} 日</button>}
            </div>)}
          </div>}
          {view === "history"
            ? selectedDayEvents.length === 0
              ? <p className="calendar-empty">换一天看看同月同日还发生过什么。</p>
              : selectedDayEvents.map((event) => <EventCard key={event.id} event={event} active={focused === event.id} onSelect={() => highlightEvents([event], event.id)} />)
            : selectedHabits.length === 0
              ? <p className="calendar-empty">{yearEvents.length === 0 ? "校历骨架已经拿掉，只留订阅里能稳定长出来的申报和会议。" : "换一个有标记的日期。"}</p>
              : selectedHabits.map((habit) => <HabitCard key={habit.id} habit={habit} active={focused === habit.id || habit.evidence.some(event => event.id === focused)} scale={tag != null} focusedId={focused} onSelect={() => highlightEvents(habit.evidence, habit.id)} onSelectEvent={event => highlightEvents([event], event.id)} />)}
        </section>
      </div> : <section className="calendar-timeline-wrap" aria-label="时间轴">
        <p className="calendar-lead">{view === "year"
          ? timelineHabits.length ? `按月日排列，共 ${timelineHabits.length} 组依据。` : "这个标签下暂时没有依据。"
          : timelineEvents.length ? `按发生先后排列，共 ${timelineEvents.length} 条。` : "这个标签下暂时没有事件。"}</p>
        {view === "year"
          ? <HabitTimeline habits={timelineHabits} focused={focused} scale={tag != null} onSelect={selectHabit} />
          : <TimelinePane events={timelineEvents} focused={focused} onSelect={selectTimelineEvent} />}
      </section>}
    </main>
    {active && <BoardResizeHandles panes={panes} hasList={false} label="日历"/>}
  </section>;
}
