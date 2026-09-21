import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import historyEvents from "./historyEvents.json";
import { adaptHistoryEvents, cellPoints, cellSpanFlags, dayPoints, eventDateKey, eventSortStamp, filterByTag, historyOnDateKey, sortTimelineEvents, spanCoversDateKey, spanProgressOnDateKey, tagHeat, timelineDateLabel, yearOnDateKey } from "./adapters";
import { ALMANAC_DEFAULT, ALMANAC_MIN, DETAIL_MIN, fitAlmanacWidth, parseAlmanacWidth } from "./almanacSplit";
import { MONTH_SHORT_LABELS, WEEKDAY_LABELS, almanacDayIndex, almanacPageLabel, dateKeyFromParts, eventsOnDate, historyMonthGrid, historyYearMonths, inferMonthDay, monthGrid, monthInPair, monthRange, pairMonths, pairOriginForDay, shanghaiCivilFromIso, shiftAlmanacPage, shiftDateKey } from "./helpers";
import { parseTrendsSection } from "../hot/trendsSection";
import type { HistoryEvent } from "./types";
import yearSeeds from "./yearSeeds.json";
import yearTalentSeeds from "./yearTalentSeeds.json";
import yearWindowSeeds from "./yearWindowSeeds.json";
import yearProgramSeeds from "./yearProgramSeeds.json";
import yearLocalSeeds from "./yearLocalSeeds.json";
import yearSocialSeeds from "./yearSocialSeeds.json";
import { cellMarks, habitsOnDateKey, yearHabits } from "./yearHabits";
import { explainTag, TAG_GLOSSARY, YEAR_GLOSSARY_TAGS } from "./tagGlossary";
import { acceptSpan, classifyYearCategory, classifyYearTags, growLaneForFeed, growLaneForFolder, growPlacement, growYearEvents, htmlToText, keepGrowArticle, needsDeepRead, parseBodyWindow, pickGrowQueries, spanDays, YEAR_GROUPS, yearCluster, type GrowSeed } from "./yearGrow";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const history = adaptHistoryEvents(historyEvents as HistoryEvent[]);

function packedYear() {
  return growYearEvents([
    ...(yearProgramSeeds as GrowSeed[]),
    ...(yearWindowSeeds as GrowSeed[]),
    ...(yearTalentSeeds as GrowSeed[]),
    ...(yearLocalSeeds as GrowSeed[]),
    ...(yearSocialSeeds as GrowSeed[]),
    ...(yearSeeds as GrowSeed[]),
  ]);
}

function seed(partial: Partial<GrowSeed["article"]> & { title: string }, lane = "科研申报"): GrowSeed {
  return {
    lane,
    article: {
      id: partial.id ?? Math.abs(partial.title.length * 17),
      feedTitle: partial.feedTitle ?? "中国大陆·基金申报（官方聚合）",
      title: partial.title,
      snippet: partial.snippet ?? "申报通知",
      url: partial.url ?? "https://www.nsfc.gov.cn/example",
      publishedAt: partial.publishedAt ?? "2026-09-16",
    },
  };
}

describe("academic calendar views", () => {
  it("grows the academic year from grant and meeting feeds, not a handwritten skeleton", () => {
    expect(growLaneForFolder("中国大陆·基金申报")).toBe("科研申报");
    expect(growLaneForFolder("国际基金·资助机会")).toBe("国际基金");
    expect(growLaneForFolder("学术会议·中文")).toBe("会议征稿");
    expect(growLaneForFolder("科研新闻")).toBeNull();
    expect(growLaneForFeed("国家自然科学基金委员会")).toBe("科研申报");
    expect(growLaneForFeed("NSF Upcoming Due Dates")).toBe("国际基金");
    expect(growLaneForFeed("科学网新闻RSS——通知公告")).toBe("科研申报");
    expect(pickGrowQueries(
      [{ id: 9, name: "中国大陆·基金申报", position: 0 }],
      [{ id: 109, title: "中国大陆·基金申报（官方聚合）", folderId: 9 } as never],
    )).toEqual([{ query: { kind: "folder", value: 9 }, lane: "科研申报" }]);
    expect(keepGrowArticle(seed({ title: "[知乎热榜] 内存暴涨的当下，2026 年开学装机" }).article, "科研申报")).toBe(false);
    expect(keepGrowArticle(seed({ title: "基金委通报31起科研不端和违规行为", feedTitle: "科学网新闻RSS——通知公告" }).article, "科研申报")).toBe(false);
    const grown = growYearEvents([
      seed({ id: 1, title: "[国自然] 关于发布医学科学部2026年度指南引导类原创探索计划项目指南的通告", publishedAt: "2026-09-15" }),
      seed({ id: 2, title: "[国自然] 关于发布医学科学部2026年度指南引导类原创探索计划项目指南的通告", publishedAt: "2026-09-16", feedTitle: "国家自然科学基金委员会" }),
      seed({ id: 3, title: "世新大學研討會 8/28論文摘要截稿", publishedAt: "2026-08-06" }, "会议征稿"),
      seed({ id: 4, title: "[知乎热榜] 如何评价清华大学宣布废除GPA排名", publishedAt: "2026-08-30" }),
    ]);
    expect(grown).toHaveLength(2);
    const nsfc = grown.find((event) => event.title.includes("医学科学部"));
    const cfp = grown.find((event) => event.title.includes("截稿"));
    expect(nsfc?.start).toEqual({ year: 2026, month: 9, day: 15 });
    expect(nsfc?.tags).toEqual(["自然科学基金", "国自然", "医学"]);
    expect(cfp?.start).toEqual({ year: 2026, month: 8, day: 28 });
    expect(cfp?.tags).toEqual(["学术会议", "Workshop/研讨会"]);
    const spanSeed = seed({ id: 5, title: "[ November 5, 2026 -  November 6, 2026] Conference or similar", publishedAt: "2026-09-01" }, "会议征稿");
    expect(classifyYearCategory(spanSeed.article, "会议征稿")).toBe("学术会议");
    expect(growPlacement(spanSeed.article)).toMatchObject({ kind: "span", meta: "会期", start: { year: 2026, month: 11, day: 5 }, end: { year: 2026, month: 11, day: 6 } });
    const span = growYearEvents([spanSeed])[0];
    expect(span.kind).toBe("span");
    expect(cellPoints([span], 2026, 11, 5)).toHaveLength(1);
    expect(cellPoints([span], 2026, 11, 6)).toHaveLength(1);
    expect(cellPoints([span], 2026, 11, 4)).toHaveLength(0);
    expect(cellSpanFlags([span], 2026, 11, 5).starts).toHaveLength(1);
    expect(cellSpanFlags([span], 2026, 11, 6).ends).toHaveLength(1);
    expect(growPlacement(seed({ title: "[ January 1, 2999 -  February 1, 2999] POSTPONED" }).article)).toMatchObject({ kind: "point" });
    expect(classifyYearTags(seed({ title: "[国科管] 关于发布国家科技重大专项指南的通知" }).article, "科研申报")).toEqual(["国家科技项目", "科技重大专项"]);
    expect(classifyYearTags(seed({ title: "CFPs on Artificial Intelligence", feedTitle: "CFPs on Artificial Intelligence : WikiCFP" }).article, "会议征稿")).toEqual(["学术会议", "国际会议", "人工智能"]);
    expect(classifyYearTags(seed({ title: "青年科学基金项目（A类）集中接收申报", feedTitle: "国家自然科学基金委员会" }).article, "科研申报")).toEqual(["人才计划", "杰青"]);
    expect(classifyYearTags(seed({ title: "优秀青年科学基金项目（海外）项目指南", feedTitle: "国家自然科学基金委员会" }).article, "科研申报")).toEqual(["人才计划", "海外优青"]);
    expect(classifyYearTags(seed({ title: "2016年度长江学者奖励计划人选推荐" }).article, "科研申报")).toEqual(["人才计划", "长江学者"]);
    expect(classifyYearTags(seed({ title: "2018年国家千人计划青年项目申报" }).article, "科研申报")).toEqual(["人才计划", "千人计划"]);
    expect(classifyYearTags(seed({ title: "NSF Upcoming Due Dates", feedTitle: "NSF Upcoming Due Dates" }).article, "国际基金")).toEqual(["国际科研机会", "国际基金"]);
    expect(classifyYearTags(seed({ title: "UKRI strategy virtual townhall", feedTitle: "Events – UKRI" }).article, "国际基金")).toEqual(["国际科研机会", "国际基金"]);
    expect(classifyYearTags(seed({ title: "SNSF Starting Grants 2026", feedTitle: "SNF RSS Feed - Call - EN" }).article, "国际基金")).toEqual(["国际科研机会", "国际基金"]);
    expect(classifyYearTags(seed({ title: "中国科学院特别研究助理资助项目申报" }).article, "科研申报")).toEqual(["科研岗位", "科研助理"]);
    expect(classifyYearTags(seed({ title: "关于发布国家重点研发计划“工业软件”重点专项项目申报指南的通知" }).article, "科研申报")).toEqual(["国家科技项目", "国家重点研发"]);
    expect(classifyYearTags(seed({ title: "国家艺术基金（一般项目）2026年度资助项目申报" }).article, "科研申报")[0]).toBe("人文社科基金");
    expect(classifyYearTags(seed({ title: "国家语委科研规划2025年选题指南项目申报" }).article, "科研申报")[0]).toBe("人文社科基金");
    expect(classifyYearTags(seed({ title: "中国科协青年科技人才培育工程博士生专项计划" }).article, "科研申报")[0]).toBe("人才计划");
    expect(classifyYearTags(seed({ title: "2026年度国家出版基金项目申报" }).article, "科研申报")[0]).toBe("人文社科基金");
    expect(classifyYearTags(seed({ title: "2025年度上海市自然科学基金项目申报" }).article, "科研申报")).toEqual(["地方科研项目", "省自然科学基金"]);
    expect(classifyYearTags(seed({ title: "2025年北京市社会科学基金项目申报公告" }).article, "科研申报")).toEqual(["人文社科基金", "省社科"]);
    expect(classifyYearTags(seed({ title: "面上项目列入2026年集中接收", feedTitle: "国家自然科学基金委员会" }).article, "科研申报")).toEqual(["自然科学基金", "面上项目"]);
    expect(classifyYearTags(seed({ title: "中国化学会第35届学术年会" }, "会议征稿").article, "会议征稿")).toEqual(["学术会议", "学会年会", "化学"]);
    expect(classifyYearTags(seed({ title: "2026年国家公派研究生（含联合培养博士生）网上申报" }).article, "科研申报")).toEqual(["国际科研机会", "国际交换"]);
    expect(classifyYearTags(seed({ title: "2026年国家公派高级研究学者、访问学者、博士后项目申报" }).article, "科研申报")).toEqual(["国际科研机会", "访问学者"]);
    expect(classifyYearTags(seed({ title: "2026年度湖南省自然科学基金项目申报" }).article, "科研申报")).toEqual(["地方科研项目", "省自然科学基金"]);
    expect(classifyYearTags(seed({ title: "宁波东方理工大学2026甬江论坛报名截止" }).article, "科研申报")).toEqual(["科研岗位", "教职"]);
    expect(classifyYearTags(seed({ title: "北京大学新医工研究生暑期学校" }, "会议征稿").article, "会议征稿")).toEqual(["学术会议", "暑期学校"]);
    expect(classifyYearTags(seed({ title: "中国博士后科学基金第79批面上资助申报" }).article, "科研申报")).toEqual(["博士后项目", "博士后基金"]);
    expect(classifyYearTags(seed({ title: "北京大学王选所青年论坛报名截止" }).article, "科研申报")).toEqual(["科研岗位", "教职"]);
    expect(yearCluster("杰青")).toBe("人才计划");
    expect(yearCluster("博士后")).toBe("博士后项目");
    expect(yearCluster("国家重点研发")).toBe("国家科技项目");
    expect(yearCluster("国际基金")).toBe("国际科研机会");
    expect(yearCluster("教育部人文社科")).toBe("人文社科基金");
    expect(yearCluster("语委")).toBe("人文社科基金");
    expect(yearCluster("国自然")).toBe("自然科学基金");
    expect(yearCluster("国社科")).toBe("人文社科基金");
    expect(YEAR_GROUPS.map((item) => item.group)).toEqual([
      "学术会议", "自然科学基金", "人文社科基金", "国家科技项目", "地方科研项目",
      "人才计划", "博士后项目", "国际科研机会", "学术出版", "科研岗位",
    ]);
    expect(YEAR_GROUPS.find((item) => item.group === "人才计划")?.members).toEqual(expect.arrayContaining(["杰青", "地方人才"]));
    expect(YEAR_GROUPS.find((item) => item.group === "自然科学基金")?.members).toEqual(expect.arrayContaining(["国自然", "面上项目", "联合基金"]));
    expect(YEAR_GROUPS.find((item) => item.group === "人文社科基金")?.members).toEqual(expect.arrayContaining(["国社科", "省社科", "语委"]));
    expect(YEAR_GROUPS.find((item) => item.group === "学术会议")?.members).toEqual(expect.arrayContaining(["国际会议", "国内会议", "学会年会"]));
    expect(YEAR_GROUPS.find((item) => item.group === "博士后项目")?.members).toEqual(expect.arrayContaining(["博士后基金", "香江学者"]));
    expect(YEAR_GROUPS.find((item) => item.group === "国家科技项目")?.members).toEqual(expect.arrayContaining(["国家重点研发", "科技重大专项"]));
    expect(cellPoints(grown, 2026, 9, 15).some((event) => event.title.includes("医学科学部"))).toBe(true);
    expect(inferMonthDay("2月底", 2026, 2)).toBe(28);
    expect(inferMonthDay("1月中下旬常见", 2026, 1)).toBe(20);
    expect(shanghaiCivilFromIso("2026-09-16")).toMatchObject({ year: 2026, month: 9, day: 16 });
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("growYearEvents");
    expect(board).toContain("loadGrowSeeds");
    expect(board).toContain("yearSeeds");
    expect(board).toContain("yearTalentSeeds");
    expect(board).toContain("yearLocalSeeds");
    expect(board).toContain("yearSocialSeeds");
    expect(board).not.toContain("YEAR_NODES");
    expect(board).not.toContain("yearNodes");
    const packed = packedYear();
    expect(packed.length).toBeGreaterThan(100);
    expect(packed.some((event) => event.tags.includes("国自然") && event.title.includes("指南"))).toBe(true);
    const yearTags = new Set(packed.flatMap((event) => event.tags));
    expect(yearTags.has("学术会议")).toBe(true);
    expect(yearTags.has("自然科学基金")).toBe(true);
    expect(yearTags.has("人文社科基金")).toBe(true);
    expect(yearTags.has("人才计划")).toBe(true);
    expect(yearTags.has("博士后项目")).toBe(true);
    expect(yearTags.has("国家科技项目")).toBe(true);
    expect(yearTags.has("国际科研机会")).toBe(true);
    expect(yearTags.has("地方科研项目")).toBe(true);
    expect(yearTags.has("国自然")).toBe(true);
    expect(yearTags.has("杰青")).toBe(true);
    expect(yearTags.has("优青")).toBe(true);
    expect(yearTags.has("海外优青")).toBe(true);
    expect(yearTags.has("长江学者")).toBe(true);
    expect(yearTags.has("千人计划")).toBe(true);
    expect(yearTags.has("国际基金")).toBe(true);
    expect(yearTags.has("艺术基金")).toBe(true);
    expect(yearTags.has("语委")).toBe(true);
    expect(yearTags.has("青年人才")).toBe(true);
    expect(yearTags.has("省自然科学基金")).toBe(true);
    expect(yearTags.has("省社科")).toBe(true);
    expect(yearTags.has("访问学者")).toBe(true);
    expect(yearTags.has("国际交换")).toBe(true);
    expect(yearTags.has("暑期学校")).toBe(true);
    expect(yearTags.has("教职")).toBe(true);
    expect(yearTags.has("出版基金")).toBe(true);
    expect(yearTags.has("NSF") || yearTags.has("UKRI") || yearTags.has("JST") || yearTags.has("DFG") || yearTags.has("SNF")).toBe(false);
    expect(yearTags.has("人工智能") || yearTags.has("哲学") || yearTags.has("社科")).toBe(true);
    expect([...yearTags].every((tag) => !/\d{4}|November|Tomorrow|January|October/.test(tag))).toBe(true);
    expect(yearTags.size).toBeGreaterThan(12);
    expect(yearTags.size).toBeLessThan(80);
    expect(packed.some((event) => event.start.year === 2026 && event.start.month === 9)).toBe(true);
    const sept16 = yearOnDateKey(packed, "09-16");
    expect(sept16.length).toBeGreaterThan(0);
    expect(sept16.every((event) => (
      eventDateKey(event) === "09-16"
      || (event.kind === "span" && event.end?.day != null && event.end.month === 9 && event.end.day === 16)
      || spanCoversDateKey(event, "09-16")
    ))).toBe(true);
    expect(packed.some((event) => event.kind === "span" && event.end != null)).toBe(true);
    expect(packed.every((event) => event.start.year <= 2100 && (event.end == null || event.end.year <= 2100))).toBe(true);
    expect(board).toContain("calendar-dot");
    expect(board).toContain("habitsOnDateKey");
  });
  it("puts day-precision history on the matching civil day only", () => {
    expect(history.length).toBeGreaterThan(500);
    expect(dateKeyFromParts(9, 17)).toBe("09-17");
    const raw = eventsOnDate(historyEvents as HistoryEvent[], "01-19");
    expect(raw.some((event) => event.title.includes("新视野号"))).toBe(true);
    const day = history.find((event) => event.title.includes("新视野号"));
    expect(day?.precision).toBe("day");
    expect(dayPoints(history, day!.start.year, day!.start.month, day!.start.day!).some((event) => event.title.includes("新视野号"))).toBe(true);
    expect(shiftDateKey("01-01", 2026, -1).dateKey).toBe("12-31");
  });
  it("treats 昔日学术 as 366 same-month-day cells, not a year timeline", () => {
    const onDay = historyOnDateKey(history, "01-19");
    expect(onDay.some((event) => event.title.includes("新视野号"))).toBe(true);
    expect(onDay.every((event) => event.start.month === 1 && event.start.day === 19)).toBe(true);
    expect(onDay.some((event) => event.start.year !== 2026)).toBe(true);
    expect(historyMonthGrid(2026, 2).some((cell) => cell.inMonth && cell.dateKey === "02-29")).toBe(true);
    expect(historyYearMonths(2026)).toEqual(Array.from({ length: 12 }, (_, index) => ({ year: 2026, month: index + 1 })));
    const keys = new Set<string>();
    for (const pane of historyYearMonths(2026)) {
      for (const cell of historyMonthGrid(pane.year, pane.month)) {
        if (cell.inMonth) keys.add(cell.dateKey);
      }
    }
    expect(keys.size).toBe(366);
    expect(keys.has("02-29")).toBe(true);
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("historyOnDateKey");
    expect(board).toContain("historyMonthGrid");
    expect(board).toContain("historyYearMonths");
    expect(board).toContain("calendar-split");
    expect(board).toContain("学术年历");
    expect(board).toContain("昔日学术");
    expect(board).toContain("标签组");
    expect(board).toContain("yearMode");
  });
  it("dates an item by when it happens, not by when the feed posted it", () => {
    // Conference feeds label the window and warn that the sort date is a harvest artifact.
    expect(parseBodyWindow("会议时间（非发布时间）：2026-11-27~2026-11-29 地点：云南", 2026))
      .toMatchObject({ start: { month: 11, day: 27 }, end: { month: 11, day: 29 }, meta: "会期" });
    expect(parseBodyWindow("会议时间（非发布时间）：2025年8月15日至8月17日 CCF 秀湖官网会议日历", 2026))
      .toMatchObject({ start: { year: 2025, month: 8, day: 15 }, end: { year: 2025, month: 8, day: 17 } });
    expect(parseBodyWindow("会议时间（非发布时间）：2025年9月19日 地点：北京", 2026))
      .toMatchObject({ start: { year: 2025, month: 9, day: 19 } });
    expect(parseBodyWindow("会议时间（非发布时间）：2025年9月19日 地点：北京", 2026)?.end).toBeUndefined();
    expect(parseBodyWindow("48th IBIMA Conference [Seville, Spain] [Nov 29, 2026 - Nov 30, 2026]", 2026))
      .toMatchObject({ start: { month: 11, day: 29 }, end: { month: 11, day: 30 } });
    expect(parseBodyWindow("Full Proposal Deadline Date: October 1, 2026 Program Guidelines: NSF 24-584", 2026))
      .toMatchObject({ start: { year: 2026, month: 10, day: 1 }, meta: "截止" });
    expect(parseBodyWindow("Program Guidelines: NSF 26-517 This is an NSF Program Announcements item.", 2026)).toBeNull();

    const harvested = seed({
      id: 41,
      title: "11月国际会议",
      snippet: "会议时间（非发布时间）：2026-11-27~2026-11-29 地点：云南 原列表未提供发布时间；RSS 排序日期为首次采集时间。",
      publishedAt: "2026-09-07",
    }, "会议征稿");
    expect(growPlacement(harvested.article)).toMatchObject({ kind: "span", start: { month: 11, day: 27 }, end: { month: 11, day: 29 } });

    // No usable date plus a harvest-time warning means we refuse to invent one.
    const undated = seed({
      id: 42,
      title: "某会议",
      snippet: "地点：北京 原列表未提供发布时间；RSS 排序日期为首次采集时间。",
      publishedAt: "2026-09-07",
    }, "会议征稿");
    expect(growPlacement(undated.article)).toBeNull();
    expect(growYearEvents([undated])).toHaveLength(0);

    // A raw grant notice carries its window in the body, not the title.
    const notice = seed({
      id: 43,
      title: "关于2027年度国家自然科学基金项目申请与结题等有关事项的通告",
      snippet: "官方来源：国家自然科学基金委员会 发布日期：2027-01-14 集中接收工作于2027年3月1日开始，3月20日16时截止。",
      publishedAt: "2027-02-20",
    });
    expect(growPlacement(notice.article)).toMatchObject({ kind: "span", meta: "申报窗口", start: { year: 2027, month: 3, day: 1 }, end: { year: 2027, month: 3, day: 20 } });
    expect(parseBodyWindow("申报系统于4月15日零时至4月25日17时开放，逾期不再受理。", 2025))
      .toMatchObject({ start: { year: 2025, month: 4, day: 15 }, end: { year: 2025, month: 4, day: 25 } });
    expect(parseBodyWindow("本次面上资助申报时间为 2025年3月1日-3月31日", 2025))
      .toMatchObject({ start: { year: 2025, month: 3, day: 1 }, end: { year: 2025, month: 3, day: 31 } });

    // Official publish date in the body beats the feed's own timestamp.
    const dateless = seed({
      id: 44,
      title: "关于发布某专项项目指南的通知",
      snippet: "官方来源：国家科技管理信息系统 发布日期：2026-03-06 筛选命中：申报、指南",
      publishedAt: "2026-08-29",
    });
    expect(growPlacement(dateless.article)).toMatchObject({ kind: "point", meta: "官方发布", start: { year: 2026, month: 3, day: 6 } });

    // Feed snippets stop around 220 chars, so a notice placed only by its posting
    // date must be re-read in full before we believe where it sits.
    expect(needsDeepRead(dateless.article)).toBe(true);
    expect(needsDeepRead(notice.article)).toBe(false);
    expect(needsDeepRead({ ...dateless.article, body: "集中接收工作于2026年3月1日开始，3月20日16时截止。" })).toBe(false);
    expect(growPlacement({ ...dateless.article, body: "集中接收工作于2026年3月1日开始，3月20日16时截止。" }))
      .toMatchObject({ kind: "span", start: { month: 3, day: 1 }, end: { month: 3, day: 20 } });
    expect(htmlToText("<p>集中接收工作于<b>3月1日</b>开始</p><script>x</script>")).toBe("集中接收工作于 3月1日 开始");

    // An eligibility range says who may apply, not when the window is open.
    expect(parseBodyWindow("申请人须为2024年11月1日至2026年2月28日期间新入职的特别研究助理。请于2026年7月20日上午9点前提交申报材料。", 2026))
      .toMatchObject({ start: { year: 2026, month: 7, day: 20 }, meta: "截止" });
    expect(parseBodyWindow("提交时间：2026年7月16日下午下班前，逾期不予受理。", 2026))
      .toMatchObject({ start: { year: 2026, month: 7, day: 16 }, meta: "截止" });
    // The announced window outranks an internal review cut-off mentioned later.
    expect(parseBodyWindow("申报系统于2025年2月28日至2025年3月28日17时受理项目网上申报。各申报单位审核工作截止日期为2025年4月3日。", 2025))
      .toMatchObject({ start: { month: 2, day: 28 }, end: { month: 3, day: 28 }, meta: "申报窗口" });
    // The date sits before the cue word, so scanning forward from "截止" misses it.
    expect(parseBodyWindow("2026年度博士后科研业绩评估考核资助8月31日申报截止，9月份组织评审。", 2026))
      .toMatchObject({ start: { year: 2026, month: 8, day: 31 }, meta: "截止" });
    expect(parseBodyWindow("2026年度国资计划将于2月24日开始申报，4至6月份组织专家评审。", 2026))
      .toMatchObject({ start: { year: 2026, month: 2, day: 24 }, meta: "开放" });
    // Officials pad the digits with spaces.
    expect(parseBodyWindow("受理时间为 2025年 7月 21日 8:00至 9月 2日 16:00。", 2025))
      .toMatchObject({ start: { year: 2025, month: 7, day: 21 }, end: { year: 2025, month: 9, day: 2 } });

    const packed = packedYear();
    const onKey = (key: string) => packed.filter((event) => eventDateKey(event) === key).length;
    // The two harvest days used to swallow 179 and 137 items; real windows pulled them apart.
    expect(onKey("09-16")).toBeLessThan(60);
    expect(onKey("09-07")).toBeLessThan(30);
    expect(packed.filter((event) => event.payload.meta === "会期").length).toBeGreaterThan(250);
  });
  it("treats year events as evidence and promotes repeats into habits", () => {
    const grown = growYearEvents([
      seed({ id: 31, title: "[国自然] 指南甲", publishedAt: "2026-03-01" }),
      seed({ id: 32, title: "[国自然] 指南乙", publishedAt: "2025-03-01" }),
      seed({ id: 33, title: "[教育部] 单独一条", publishedAt: "2026-04-01" }),
      seed({ id: 34, title: "[ November 5, 2026 -  November 6, 2026] First conference", publishedAt: "2026-09-01" }, "会议征稿"),
      seed({ id: 35, title: "[ November 5, 2025 -  November 6, 2025] Second conference", publishedAt: "2025-09-01" }, "会议征稿"),
    ]);
    const march = habitsOnDateKey(grown, "03-01");
    expect(march).toHaveLength(1);
    expect(march[0]).toMatchObject({ tag: "自然科学基金", habit: true });
    expect(march[0].evidence).toHaveLength(2);
    expect(march[0].years).toEqual([2025, 2026]);
    const april = habitsOnDateKey(grown, "04-01");
    expect(april).toHaveLength(1);
    expect(april[0].habit).toBe(false);
    expect(april[0].evidence).toHaveLength(1);
    const start = habitsOnDateKey(grown, "11-05");
    const end = habitsOnDateKey(grown, "11-06");
    expect(start[0].starts).toBe(true);
    expect(end[0].ends).toBe(true);
    // One mark per habit, settled ones first, so a busy cell still leads with what matters.
    expect(cellMarks(start)).toEqual([{ id: start[0].id, kind: "start", habit: true, tone: 0 }]);
    expect(cellMarks(end)).toEqual([{ id: end[0].id, kind: "end", habit: true, tone: 1 }]);
    const mixed = cellMarks([...habitsOnDateKey(grown, "04-01"), ...march]);
    expect(mixed[0].habit).toBe(true);
    expect(mixed.map((mark) => mark.kind)).toEqual(["point", "point"]);
    const packed = packedYear();
    const habits = yearHabits(packed);
    expect(habits.length).toBeGreaterThan(0);
    expect(habits.length).toBeLessThan(packed.length);
    expect(habits.some((habit) => habit.habit)).toBe(true);
    expect(habits.every((habit) => habit.evidence.length >= 1)).toBe(true);
    const marchStart = habitsOnDateKey(packed, "03-01");
    expect(marchStart.some((habit) => habit.tag === "自然科学基金" && habit.habit && habit.starts)).toBe(true);
    expect(marchStart.some((habit) => habit.tag === "人才计划" && habit.habit && habit.starts)).toBe(true);
    expect(habitsOnDateKey(packed, "03-20").some((habit) => habit.tag === "自然科学基金" && habit.ends)).toBe(true);
    expect(habitsOnDateKey(packed, "01-15").some((habit) => habit.tag === "自然科学基金" && habit.habit)).toBe(true);
    expect(habitsOnDateKey(packed, "04-15").some((habit) => habit.tag === "人才计划" && habit.habit)).toBe(true);
    expect(habitsOnDateKey(packed, "07-01").some((habit) => habit.tag === "人才计划" && habit.habit)).toBe(true);
    // Four CAS institutes run the same programme, so mid-July reads as one habit.
    expect(habitsOnDateKey(packed, "07-16").some((habit) => habit.tag === "科研岗位" && habit.habit)).toBe(true);
    expect(habitsOnDateKey(packed, "02-28").some((habit) => habit.tag === "人文社科基金" && habit.starts)).toBe(true);
    expect(habitsOnDateKey(packed, "07-14").some((habit) => habit.tag === "国家科技项目" && habit.starts)).toBe(true);
    // Postdoc funding runs two batches a year, so both March and August settle.
    expect(habitsOnDateKey(packed, "03-01").some((habit) => habit.tag === "博士后项目" && habit.habit)).toBe(true);
    expect(habitsOnDateKey(packed, "08-01").some((habit) => habit.tag === "博士后项目" && habit.habit)).toBe(true);
    // A verified window outranks a harvested stub for the same notice.
    const planning = packed.filter((event) => event.title.includes("全国教育科学规划年度项目"));
    expect(planning).toHaveLength(1);
    expect(planning[0]).toMatchObject({ kind: "span", start: { month: 6, day: 10 }, end: { month: 6, day: 25 } });
    expect(packed.some((event) => event.tags.includes("艺术"))).toBe(true);
    expect(packed.some((event) => event.tags.includes("教育科学"))).toBe(true);
    // Harvested stubs for these 2026 notices used the posting day; verified windows win.
    const later2026 = packed.filter((event) => event.title.includes("2026年国家社会科学基金后期资助"));
    expect(later2026).toHaveLength(1);
    expect(later2026[0]).toMatchObject({ kind: "span", start: { year: 2026, month: 7, day: 25 }, end: { year: 2026, month: 7, day: 30 } });
    const popular2026 = packed.filter((event) => event.title.includes("2026年国家社会科学基金哲学社会科学学术通俗读物"));
    expect(popular2026).toHaveLength(1);
    expect(popular2026[0]).toMatchObject({ kind: "point", start: { year: 2026, month: 7, day: 31 } });
    const ideology2026 = packed.filter((event) => event.title.includes("2026年高校思政课教师研究专项"));
    expect(ideology2026).toHaveLength(1);
    expect(ideology2026[0]).toMatchObject({ kind: "span", start: { year: 2026, month: 6, day: 18 }, end: { year: 2026, month: 7, day: 12 } });
    expect(habitsOnDateKey(packed, "07-25").some((habit) => habit.tag === "人文社科基金" && habit.habit && habit.starts)).toBe(true);
    expect(habitsOnDateKey(packed, "04-15").some((habit) => habit.tag === "人文社科基金" && habit.habit && habit.starts && habit.tone === 0)).toBe(true);
    expect(habitsOnDateKey(packed, "06-15").some((habit) => habit.tag === "人文社科基金" && habit.habit && habit.ends)).toBe(true);
    const artMid = habitsOnDateKey(packed, "05-15").find((habit) => habit.tag === "人文社科基金");
    expect(artMid).toMatchObject({ habit: true, starts: false, ends: false });
    expect(artMid!.tone).toBeGreaterThan(0.3);
    expect(artMid!.tone).toBeLessThan(0.8);
    expect(cellMarks([artMid!])[0].kind).toBe("through");
    const artWindow = packed.find((event) => event.tags.includes("艺术基金") && event.kind === "span");
    expect(spanProgressOnDateKey(artWindow!, "05-15")!).toBeGreaterThan(0.4);
    expect(spanProgressOnDateKey(artWindow!, "05-15")!).toBeLessThan(0.6);
    expect(packed.some((event) => event.tags[0] === "人文社科基金" && event.tags.includes("艺术基金"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "人文社科基金" && event.tags.includes("语委"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "人才计划" && event.tags.includes("青年人才"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "人文社科基金" && event.tags.includes("出版基金"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "地方科研项目" && event.tags.includes("省自然科学基金"))).toBe(true);
    expect(habitsOnDateKey(packed, "03-10").some((habit) => habit.tag === "国际科研机会" && habit.starts)).toBe(true);
    expect(habitsOnDateKey(packed, "04-10").some((habit) => habit.tag === "国际科研机会" && habit.starts)).toBe(true);
    expect(packed.some((event) => event.tags.includes("暑期学校") && event.kind === "span")).toBe(true);
    expect(packed.some((event) => event.tags.includes("教职"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "人文社科基金" && event.tags.includes("省社科"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "人才计划" && event.tags.includes("地方人才"))).toBe(true);
    expect(packed.some((event) => event.tags.includes("面上项目"))).toBe(true);
    expect(packed.some((event) => event.tags[0] === "学术出版" && (event.tags.includes("优秀成果奖") || event.tags.includes("专著出版")))).toBe(true);
    expect(YEAR_GROUPS.every((item) => yearHabits(filterByTag(packed, item.group)).length > 0)).toBe(true);
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("惯例");
    expect(board).toContain("HabitCard");
    expect(board).toContain("yearHabits");
    expect(board).not.toContain("STRIP_WINDOW");
    expect(board).not.toContain("monthRange(");
  });
  it("refuses spans whose length contradicts what the source claims to be", () => {
    expect(spanDays({ year: 2026, month: 11, day: 5 }, { year: 2026, month: 11, day: 6 })).toBe(2);
    expect(spanDays({ year: 2026, month: 12, day: 27 }, { year: 2027, month: 2, day: 14 })).toBe(50);
    expect(acceptSpan({ year: 2026, month: 11, day: 5 }, { year: 2026, month: 11, day: 8 }, "会期")).toBe(true);
    // PhilEvents files submission ranges as "Conference or similar"; a 200-day sitting is not one.
    expect(acceptSpan({ year: 2026, month: 4, day: 29 }, { year: 2026, month: 11, day: 26 }, "会期")).toBe(false);
    // The same length is ordinary for an application window.
    expect(acceptSpan({ year: 2026, month: 7, day: 6 }, { year: 2026, month: 9, day: 30 }, "申报窗口")).toBe(true);
    expect(acceptSpan({ year: 2026, month: 3, day: 2 }, { year: 2026, month: 9, day: 30 }, "申报窗口")).toBe(true);
    expect(acceptSpan({ year: 2026, month: 1, day: 1 }, { year: 2026, month: 12, day: 31 }, "申报窗口")).toBe(false);

    const bogus = seed({ id: 51, title: "[ April 29, 2026 -  November 26, 2026] Conference or similar", publishedAt: "2026-04-01" }, "会议征稿");
    expect(growPlacement(bogus.article, "会议征稿")).toMatchObject({ kind: "point", meta: "起始", start: { month: 4, day: 29 } });
    // The opening day survives as evidence; only the false window and its red flag go.
    expect(growYearEvents([bogus])[0].kind).toBe("point");
    expect(growYearEvents([bogus])[0].end).toBeUndefined();

    // Aggregator listings are not events at all.
    expect(keepGrowArticle(seed({ title: "2026年国内 / 国际精品会议推荐" }).article, "会议征稿")).toBe(false);

    // The lane decides whether a range is a sitting or a submission window.
    const window = seed({ id: 52, title: "[2026年4月10日-2026年6月15日] 2026年优秀青年科学基金项目（海外）项目指南" });
    expect(growPlacement(window.article, "科研申报")).toMatchObject({ kind: "span", meta: "申报窗口" });
    expect(growPlacement(seed({ id: 53, title: "[ November 5, 2026 -  November 6, 2026] Conference" }, "会议征稿").article, "会议征稿"))
      .toMatchObject({ kind: "span", meta: "会期" });

    const packed = packedYear();
    const spans = packed.filter((event) => event.kind === "span" && event.end?.day != null);
    const lengthOf = (event: (typeof spans)[number]) => spanDays(event.start, event.end!);
    expect(spans.filter((event) => event.payload.meta === "会期").every((event) => lengthOf(event) <= 14)).toBe(true);
    expect(spans.every((event) => lengthOf(event) <= 240)).toBe(true);
    expect(packed.some((event) => /精品会议推荐/.test(event.title))).toBe(false);
    expect(packed.filter((event) => event.payload.meta === "申报窗口").length).toBeGreaterThan(20);
  });
  it("folds away months that hold nothing under the chosen tag", () => {
    const packed = packedYear();
    const emptyMonths = (tag: string | null) => {
      const visible = filterByTag(packed, tag);
      return historyYearMonths(2026)
        .filter((pane) => !historyMonthGrid(pane.year, pane.month)
          .some((cell) => cell.inMonth && habitsOnDateKey(visible, cell.dateKey).length > 0))
        .map((pane) => pane.month);
    };
    // Every month carries something overall, so nothing folds until a tag narrows it.
    expect(emptyMonths(null)).toEqual([]);
    // The CAS assistantship only runs in July, so the other eleven months fold.
    expect(emptyMonths("科研助理")).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
    expect(emptyMonths("国家重点研发")).toContain(5);
    expect(emptyMonths("国家重点研发")).not.toContain(7);
    expect(emptyMonths("人才计划").length).toBeLessThan(emptyMonths("杰青").length);
    expect(emptyMonths("自然科学基金").length).toBeLessThan(emptyMonths("国家重点研发").length);
    expect(emptyMonths("人文社科基金").length).toBeLessThan(emptyMonths("语委").length);
    expect(emptyMonths("地方科研项目").length).toBeLessThan(12);
    expect(read("calendar/CalendarBoard.tsx")).toContain("YEAR_GROUPS");
    expect(read("calendar/CalendarBoard.tsx")).toContain("calendar-tag-group");
    expect(read("calendar/CalendarBoard.tsx")).toContain("calendar-tag-member");
    expect(read("calendar/CalendarBoard.tsx")).toContain("openGroup");
    expect(read("calendar/CalendarBoard.tsx")).toContain("toggleGroup");
    expect(read("calendar/CalendarBoard.tsx")).toContain("aria-expanded");
    expect(read("calendar/CalendarBoard.tsx")).toContain("chevron-right");
    expect(read("calendar/calendar.css")).toContain(".calendar-tag-member");
    expect(read("calendar/calendar.css")).toContain(".calendar-tag-caret");
    expect(read("calendar/calendar.css")).toContain(".calendar-tag-group.is-open");
    expect(read("calendar/calendar.css")).toContain(".calendar-glossary");
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("calendar-month-collapsed");
    expect(board).toContain("is-collapsed");
    expect(board).toContain("无内容");
    // Both scripts, centred, in the folded row and the open heading alike.
    expect([...MONTH_SHORT_LABELS]).toEqual(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
    expect(board).toContain("MONTH_SHORT_LABELS[month - 1]");
    expect(board).toContain("{month} 月");
    const css = read("calendar/calendar.css");
    expect(css).toContain(".calendar-month-head { display: flex; align-items: center; justify-content: center;");
    expect(css).toContain(".calendar-month-title");
    // Folding is a default, not a lock: the header stays clickable.
    expect(board).toContain("setForceOpen(true)");
    expect(board).toContain("setForceOpen(false)");
    expect(css).toContain(".calendar-almanac-month.is-collapsed");
  });
  it("sorts tags by heat and keeps a resizable 1–12 month grid without spanning bars", () => {
    const grown = growYearEvents([
      seed({ id: 11, title: "[国自然] 指南甲", publishedAt: "2026-09-01" }),
      seed({ id: 12, title: "[国社科] 指南乙", publishedAt: "2026-09-02" }),
      seed({ id: 13, title: "CFPs on Computer Science", publishedAt: "2026-09-03" }, "会议征稿"),
    ]);
    const ranked = tagHeat(grown);
    expect(ranked[0].count).toBeGreaterThanOrEqual(ranked[ranked.length - 1].count);
    expect(filterByTag(grown, ranked[0].tag).every((event) => event.tags.includes(ranked[0].tag))).toBe(true);
    expect(filterByTag(grown, null)).toHaveLength(3);
    const historyHeat = tagHeat(history);
    expect(historyHeat[0].count).toBeGreaterThanOrEqual(historyHeat.at(-1)!.count);
    expect([...WEEKDAY_LABELS]).toEqual(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
    const january = monthGrid(2026, 1);
    expect(january).toHaveLength(35);
    expect(january[0]).toMatchObject({ dateKey: "12-28", day: 28, inMonth: false, year: 2025, month: 12 });
    expect(january[4]).toMatchObject({ dateKey: "01-01", day: 1, inMonth: true, year: 2026, month: 1 });
    expect(pairMonths({ year: 2026, month: 9 })).toEqual([{ year: 2026, month: 9 }, { year: 2026, month: 10 }]);
    expect(monthInPair({ year: 2026, month: 9 }, { year: 2026, month: 10 })).toBe(true);
    expect(monthInPair({ year: 2026, month: 9 }, { year: 2026, month: 11 })).toBe(false);
    expect(pairOriginForDay({ year: 2026, month: 10 }, { year: 2026, month: 9 })).toEqual({ year: 2026, month: 9 });
    expect(pairOriginForDay({ year: 2026, month: 11 }, { year: 2026, month: 9 })).toEqual({ year: 2026, month: 11 });
    expect(monthRange({ year: 2026, month: 11 }, 3)).toEqual([{ year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 1 }]);
    expect(shiftAlmanacPage({ year: 2026, month: 12 }, 2)).toEqual({ year: 2027, month: 2 });
    expect(almanacPageLabel({ year: 2026, month: 12 })).toBe("2026 年 12 月 — 2027 年 1 月");
    expect(parseAlmanacWidth(null)).toBe(ALMANAC_DEFAULT);
    expect(parseAlmanacWidth("{")).toBe(ALMANAC_DEFAULT);
    expect(fitAlmanacWidth(1000, 360).almanacWidth).toBe(360);
    expect(fitAlmanacWidth(600, 400).almanacWidth).toBe(600 - DETAIL_MIN);
    expect(fitAlmanacWidth(400, 360).almanacWidth).toBeGreaterThanOrEqual(Math.min(ALMANAC_MIN, 400));
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("calendar-almanac");
    expect(board).toContain("calendar-split");
    expect(board).toContain("calendar-month-grid");
    expect(board).toContain("calendar-dots");
    expect(board).toContain("calendar-dot");
    expect(board).toContain("cellMarks");
    expect(board).toContain("yearMode");
    // One vocabulary only: dots. The flag pennants are gone for good.
    expect(board).not.toContain("calendar-flag");
    expect(board).not.toContain("Flag");
    expect(read("calendar/calendar.css")).not.toContain(".calendar-flag");
    expect(read("calendar/calendar.css")).toContain(".calendar-dot.is-start");
    expect(read("calendar/calendar.css")).toContain(".calendar-dot.is-end");
    expect(read("calendar/calendar.css")).toContain(".calendar-dot.is-span");
    expect(read("calendar/calendar.css")).toContain("--span-t");
    expect(read("calendar/calendar.css")).toContain("--cal-dot-neutral: #0a84ff");
    expect(read("calendar/calendar.css")).toContain("background: var(--cal-dot-neutral)");
    expect(board).toContain("calendar-cell-tip");
    expect(board).toContain("CELL_TIP_LIMIT");
    expect(read("calendar/calendar.css")).toContain(".calendar-cell-tip");
    expect(read("calendar/calendar.css")).toContain("button:hover .calendar-cell-tip");
    expect(read("calendar/calendar.css")).toContain("width: 3px; height: 3px; border-radius: 50%; background: var(--cal-dot-neutral)");
    expect(read("calendar/calendar.css")).not.toContain(".calendar-dot { display: inline-block; flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: var(--cal-dot-0); }");
    expect(board).toContain("--span-t");
    expect(board).toContain("through");
    // Blue overview for 全部; the green–yellow–red ramp after a tag.
    expect(board).toContain("scale={view === \"year\" && tag != null}");
    expect(board).toContain("scale={tag != null}");
    expect(board).toContain("scale ? spanTone(kind, tone) : null");
    expect(board).toContain("eventFocusOnDate");
    expect(board).toContain("is-focusing");
    expect(board).toContain("entry.rawCount > 0");
    expect(board).toContain("取消高亮");
    expect(board).toContain("clearFocus");
    expect(board).not.toContain("onHoverDay");
    expect(board).not.toContain("setHoverKey");
    expect(read("calendar/calendar.css")).toContain(".calendar-almanac.is-focusing");
    expect(read("calendar/calendar.css")).toContain(".calendar-clear-focus");
    expect(almanacDayIndex(1, 1)).toBe(1);
    expect(almanacDayIndex(2, 29)).toBe(60);
    expect(almanacDayIndex(3, 1)).toBe(61);
    expect(almanacDayIndex(12, 31)).toBe(366);
    const ramp = seed({ id: 81, title: "[2026年4月15日-2026年6月15日] Colour ramp window" });
    const grownRamp = growYearEvents([ramp])[0];
    expect(spanProgressOnDateKey(grownRamp, "04-15")).toBe(0);
    expect(spanProgressOnDateKey(grownRamp, "06-15")).toBe(1);
    expect(spanProgressOnDateKey(grownRamp, "05-15")!).toBeGreaterThan(0.4);
    expect(spanProgressOnDateKey(grownRamp, "05-15")!).toBeLessThan(0.6);
    expect(spanCoversDateKey(grownRamp, "05-01")).toBe(true);
    expect(spanCoversDateKey(grownRamp, "07-01")).toBe(false);
    // Small dots with headroom: the busiest day in either view stays under the cap.
    expect(board).toContain("const CELL_DOT_LIMIT = 8");
    const packedForDots = packedYear();
    const busiestYear = Math.max(...historyYearMonths(2026).flatMap((pane) => historyMonthGrid(pane.year, pane.month)
      .filter((cell) => cell.inMonth)
      .map((cell) => cellMarks(habitsOnDateKey(packedForDots, cell.dateKey)).length)));
    const busiestHistory = Math.max(...historyYearMonths(2026).flatMap((pane) => historyMonthGrid(pane.year, pane.month)
      .filter((cell) => cell.inMonth)
      .map((cell) => historyOnDateKey(history, cell.dateKey).length)));
    // Long windows now occupy every day they cover, so a busy cell can overflow.
    expect(busiestYear).toBeGreaterThan(0);
    expect(busiestYear).toBeLessThan(30);
    expect(board).toContain("calendar-more");
    expect(busiestHistory).toBeLessThanOrEqual(8);
    expect(board).toContain("historyYearMonths");
    expect(board).toContain("ResizeHandle");
    expect(board).toContain("selectedHabits");
    expect(board).not.toContain("STRIP_WINDOW");
    expect(board).not.toContain("onStripScroll");
    expect(board).not.toContain("pairMonths");
    expect(board).not.toContain("calendar-month-rail");
    expect(board).toContain("calendar-detail");
    expect(board).toContain("calendar-glossary");
    expect(board).toContain("explainTag");
    expect(board).not.toContain("calendar-bar");
    expect(board).not.toContain("timelineSegments");
    expect(read("calendar/helpers.ts")).not.toContain("timelineSegments");
  });
  it("explains every year-rail tag, seed tag, and history domain", () => {
    const missingYear = YEAR_GLOSSARY_TAGS.filter((tag) => !TAG_GLOSSARY[tag] || TAG_GLOSSARY[tag].length < 12);
    expect(missingYear).toEqual([]);
    const packedTags = [...new Set(packedYear().flatMap((event) => event.tags))];
    expect(packedTags.filter((tag) => !TAG_GLOSSARY[tag])).toEqual([]);
    const domains = [...new Set((historyEvents as HistoryEvent[]).map((event) => event.domain))];
    expect(domains.filter((tag) => !TAG_GLOSSARY[tag])).toEqual([]);
    expect(explainTag("面上项目").kind).toBe("member");
    expect(explainTag("面上项目").group).toBe("自然科学基金");
    expect(explainTag("自然科学基金").kind).toBe("group");
    expect(explainTag("统计学史", "history").kind).toBe("history");
    expect(explainTag("面上项目").definition).toContain("自由申请");
  });
  it("keeps labels inside the hot workspace and gives calendar the third slot", () => {
    const shell = read("WorkspaceApp.tsx");
    expect(shell).toContain('id="workspace-calendar-panel"');
    expect(shell).not.toContain('id="workspace-labels-panel"');
    expect(read("hot/TrendsWorkspace.tsx")).toContain("LabelBoard");
    expect(read("components/WorkspaceSwitcher.tsx")).toContain('value: "year"');
    expect(read("components/WorkspaceSwitcher.tsx")).toContain('value: "history"');
    expect(read("components/WorkspaceSwitcher.tsx")).toContain('value: "labels"');
    expect(parseTrendsSection("labels")).toBe("labels");
    expect(parseTrendsSection("hot")).toBe("hot");
  });
  it("covers all 366 history dateKeys and the hard-event batch", () => {
    const events = historyEvents as HistoryEvent[];
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const expectedKeys = daysInMonth.flatMap((days, index) =>
      Array.from({ length: days }, (_, day) => dateKeyFromParts(index + 1, day + 1)),
    );
    expect(expectedKeys).toHaveLength(366);
    expect(expectedKeys).toContain("02-29");
    const keys = new Set(events.map((event) => event.dateKey));
    expect([...expectedKeys].filter((key) => !keys.has(key))).toEqual([]);
    const emptyDays = ["01-31", "02-11", "05-29", "06-18", "07-13", "09-10"];
    for (const dateKey of emptyDays) {
      expect(events.some((event) => event.dateKey === dateKey)).toBe(true);
    }
    expect(events.some((event) => event.dateKey === "09-17" && event.title.includes("胰岛素"))).toBe(true);
    const batchTitles = [
      "Explorer 1 发射，美国第一颗人造卫星入轨",
      "LIGO 宣布首次直接探测到引力波",
      "东方红一号发射，中国第一颗人造卫星入轨",
      "詹纳给詹姆斯·菲普斯接种牛痘",
      "爱丁顿日食远征观测到恒星光线偏折",
      "Sally Ride 随 STS-7 升空，成为首位进入太空的美国女性",
      "CERN 宣布 ATLAS 与 CMS 观测到与希格斯玻色子相符的新粒子",
      "Trinity 试验装置在 McDonald 牧场完成装配",
      "GRAIL 双星从卡纳维拉尔角发射",
      "列文虎克写信报告牙垢中的活微生物",
      "中国首次人工合成结晶牛胰岛素",
      "斯普特尼克 1 号发射，第一颗人造卫星入轨",
      "伦琴在维尔茨堡发现 X 射线",
      "芝加哥一号堆实现首次可控链式反应",
    ];
    for (const title of batchTitles) {
      const event = events.find((item) => item.title === title);
      expect(event, title).toBeTruthy();
      expect(event!.sources.length).toBeGreaterThan(0);
      expect(event!.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
      expect(event!.sources.some((source) => !source.url.includes("api.crossref.org"))).toBe(true);
    }
  });
  it("orders the vertical timeline by occurrence and keeps a month-grid switch", () => {
    const ordered = sortTimelineEvents(history);
    expect(ordered.length).toBe(history.length);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(eventSortStamp(ordered[index])).toBeGreaterThanOrEqual(eventSortStamp(ordered[index - 1]));
    }
    const lee = ordered.findIndex((event) => event.title.includes("列文虎克"));
    const insulin = ordered.findIndex((event) => event.title.includes("结晶牛胰岛素"));
    expect(lee).toBeGreaterThan(-1);
    expect(insulin).toBeGreaterThan(lee);
    expect(timelineDateLabel(ordered[insulin])).toContain("1965");
    const yearOrdered = sortTimelineEvents(growYearEvents([
      seed({ id: 21, title: "[国自然] 三月指南", publishedAt: "2026-03-01" }),
      seed({ id: 22, title: "[国自然] 九月指南", publishedAt: "2026-09-01" }),
    ]));
    expect(yearOrdered[0].start.month).toBeLessThanOrEqual(yearOrdered.at(-1)!.start.month);
    const board = read("calendar/CalendarBoard.tsx");
    expect(board).toContain("react-vertical-timeline-component");
    expect(board).toContain("1-column-left");
    expect(board).toContain("月历");
    expect(board).toContain("时间轴");
    expect(board).toContain("sortTimelineEvents");
    expect(board).toContain("HabitTimeline");
    expect(board).toContain("yearHabits");
  });
});
