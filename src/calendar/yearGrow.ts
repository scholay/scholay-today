import { getArticle, listArticles, listFeeds, listFolders } from "../api";
import type { ArticleQuery, ArticleSummary, Feed, Folder } from "../types";
import { dateKeyFromParts, daysInMonth, shanghaiCivilFromIso, shanghaiToday } from "./helpers";
import type { CalendarDay, CalendarEvent } from "./types";

export interface GrowArticle {
  id: number;
  feedTitle: string;
  title: string;
  snippet: string | null;
  url: string | null;
  publishedAt: string | null;
  /** Full article text, pulled only when title and snippet fail to reveal a window. */
  body?: string | null;
}

export interface GrowSeed {
  article: GrowArticle;
  lane: string;
}

export interface GrowQuery {
  query: ArticleQuery;
  lane: string;
}

const REJECT = /知乎热榜|开学装机|气球塔防|范进|保时捷|兰博基尼|内存暴涨|学位授予单位|拟推荐这所|获批博士学位授予|获批硕士学位授予|民办高校，获批|通报\d+起|不端行为|现场考察会|双清论坛.{0,20}召开|会见|学习教育|资金监督检查|习近平|精品会议推荐|会议推荐|会议列表|会议汇总/;
/** A sitting conference runs days, not seasons; anything longer is a submission range. */
const MAX_SESSION_DAYS = 14;
/** Some real windows run half a year (博士后境外学术交流 3月2日—9月30日); a full year does not. */
const MAX_WINDOW_DAYS = 240;
const NOTICE_KEEP = /指南|申报|征集|申请通告|项目指南|集中接收|申请与结题|人选推荐|评审结果|Due Dates|CFP|Call for|截稿|公募/;
const PREFIX = /^\[([^\]]+)\]\s*/;
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function growLaneForFolder(name: string): string | null {
  if (name.includes("基金申报")) return "科研申报";
  if (name.includes("资助机会")) return "国际基金";
  if (name.includes("学术会议")) return "会议征稿";
  return null;
}

export function growLaneForFeed(title: string): string | null {
  if (title.includes("国家自然科学基金委员会") || title.includes("基金申报")) return "科研申报";
  if (title.includes("科学网新闻RSS——通知公告")) return "科研申报";
  if (/Upcoming Due Dates|公募情報|RSS Feed - Call|Opportunities – UKRI|Informationen für die Wissenschaft/.test(title)) return "国际基金";
  if (/WikiCFP|Calenda|会议日历|会议预告|PhilEvents|CFPs on/.test(title)) return "会议征稿";
  return null;
}

export function pickGrowQueries(folders: readonly Folder[], feeds: readonly Feed[]): GrowQuery[] {
  const folderIds = new Set<number>();
  const queries: GrowQuery[] = [];
  for (const folder of folders) {
    const lane = growLaneForFolder(folder.name);
    if (!lane) continue;
    folderIds.add(folder.id);
    queries.push({ query: { kind: "folder", value: folder.id }, lane });
  }
  for (const feed of feeds) {
    const lane = growLaneForFeed(feed.title);
    if (!lane || (feed.folderId != null && folderIds.has(feed.folderId))) continue;
    queries.push({ query: { kind: "feed", value: feed.id }, lane });
  }
  return queries;
}

export function toGrowArticle(article: ArticleSummary): GrowArticle {
  return {
    id: article.id,
    feedTitle: article.feedTitle,
    title: article.title,
    snippet: article.snippet,
    url: article.url,
    publishedAt: article.publishedAt,
  };
}

function normalizeTitle(title: string): string {
  return title.replace(PREFIX, "").replace(/\s+/g, "").toLowerCase();
}

const YEAR_FIELDS: [RegExp, string][] = [
  [/Artificial Intelligence|人工智能|类脑研究/, "人工智能"],
  [/Computer Science|CCF|CNCC|信息科学部/, "计算机"],
  [/中国物理学会|CPS Fall/, "数理"],
  [/中国化学会|化学科学部/, "化学"],
  [/医学科学部/, "医学"],
  [/管理科学部/, "管理"],
  [/数学物理科学部|数理科学部/, "数理"],
  [/生命科学部/, "生命科学"],
  [/交叉科学部/, "交叉科学"],
  [/工程与材料科学部/, "工程材料"],
  [/地球科学部/, "地球科学"],
  [/PhilEvents|心灵哲学|科学哲学|计算与信息哲学/, "哲学"],
  [/中国社会科学网|Social Sciences|社会科学哲学|社会与政治哲学/, "社科"],
  [/Éducation|教育学|思政课|辅导员研究/, "教育"],
  [/Psychologie|Sciences cognitives|认知科学哲学/, "心理认知"],
  [/Humanités numériques|人文社会科学/, "人文"],
  [/艺术学|国家艺术基金|艺术科学规划/, "艺术"],
];

/** Ten families on the year rail. Specific instruments stay as secondary tags. */
export const YEAR_RAIL = [
  "学术会议",
  "自然科学基金",
  "人文社科基金",
  "国家科技项目",
  "地方科研项目",
  "人才计划",
  "博士后项目",
  "国际科研机会",
  "学术出版",
  "科研岗位",
] as const;

export const YEAR_CLUSTERS: Record<string, string> = {
  学术会议: "学术会议",
  国际会议: "学术会议",
  国内会议: "学术会议",
  顶会: "学术会议",
  学会年会: "学术会议",
  "Workshop/研讨会": "学术会议",
  博士生论坛: "学术会议",
  暑期学校: "学术会议",
  国自然: "自然科学基金",
  青年基金: "自然科学基金",
  面上项目: "自然科学基金",
  重点项目: "自然科学基金",
  重大项目: "自然科学基金",
  联合基金: "自然科学基金",
  国际合作: "自然科学基金",
  专项项目: "自然科学基金",
  科研项目: "自然科学基金",
  国社科: "人文社科基金",
  教育部人文社科: "人文社科基金",
  省社科: "人文社科基金",
  后期资助: "人文社科基金",
  中华学术外译: "人文社科基金",
  艺术基金: "人文社科基金",
  出版基金: "人文社科基金",
  教育科学: "人文社科基金",
  语委: "人文社科基金",
  国家重点研发: "国家科技项目",
  科技重大专项: "国家科技项目",
  国家科技计划: "国家科技项目",
  重大专项: "国家科技项目",
  科研仪器: "国家科技项目",
  科技创新专项: "国家科技项目",
  省自然科学基金: "地方科研项目",
  省科技计划: "地方科研项目",
  市级项目: "地方科研项目",
  地方重点研发: "地方科研项目",
  地方人才科研项目: "地方科研项目",
  杰青: "人才计划",
  优青: "人才计划",
  长江学者: "人才计划",
  海外优青: "人才计划",
  千人计划: "人才计划",
  万人计划: "人才计划",
  青年人才: "人才计划",
  地方人才: "人才计划",
  博士后基金: "博士后项目",
  博新计划: "博士后项目",
  香江学者: "博士后项目",
  澳门青年学者: "博士后项目",
  国际培养计划: "博士后项目",
  博士后国资项目: "博士后项目",
  博士后: "博士后项目",
  国际基金: "国际科研机会",
  联合研究: "国际科研机会",
  国际合作项目: "国际科研机会",
  访问学者: "国际科研机会",
  国际交换: "国际科研机会",
  海外博后: "国际科研机会",
  期刊征稿: "学术出版",
  "Special Issue": "学术出版",
  专著出版: "学术出版",
  论文奖: "学术出版",
  优秀成果奖: "学术出版",
  教职: "科研岗位",
  博士后岗位: "科研岗位",
  科研助理: "科研岗位",
  PI招聘: "科研岗位",
  实验室招聘: "科研岗位",
  联合培养: "科研岗位",
};

export function yearCluster(instrument: string): string {
  return YEAR_CLUSTERS[instrument] ?? instrument;
}

export const YEAR_GROUPS = YEAR_RAIL.map((group) => ({
  group,
  members: [...new Set(
    Object.entries(YEAR_CLUSTERS)
      .filter(([instrument, cluster]) => cluster === group && instrument !== group)
      .map(([instrument]) => instrument),
  )],
}));

function yearInstrument(text: string): string | null {
  if (/长江学者/.test(text)) return "长江学者";
  if (/千人计划|青年千人|海外高层次人才引进计划/.test(text)) return "千人计划";
  if (/万人计划/.test(text)) return "万人计划";
  if (/海外优青|优秀青年科学基金项目（海外）|优秀青年科学基金项目\(海外\)/.test(text)) return "海外优青";
  if (/青年科学基金项目（A类）|青年科学基金项目\(A类\)|国家杰出青年/.test(text)) return "杰青";
  if (/杰青/.test(text) && !/省/.test(text)) return "杰青";
  if (/青年科学基金项目（B类）|青年科学基金项目\(B类\)/.test(text)) return "优青";
  if (/优秀青年科学基金/.test(text) && !/省/.test(text) && !/海外/.test(text)) return "优青";
  if (/香江学者/.test(text)) return "香江学者";
  if (/澳门青年学者/.test(text)) return "澳门青年学者";
  if (/博新计划|博士后创新人才支持计划/.test(text)) return "博新计划";
  if (/国资计划|国家资助博士后/.test(text)) return "博士后国资项目";
  if (/中德博士后|境外学术交流|国（境）外交流|国\(境\)外交流/.test(text)) return "国际培养计划";
  if (/博士后科学基金|博士后.*面上资助|博士后.*特别资助/.test(text)) return "博士后基金";
  if (/访问学者|高级研究学者/.test(text)) return "访问学者";
  if (/国家公派.*博士后|公派.*博士后项目/.test(text)) return "海外博后";
  if (/博士后/.test(text) && /招聘/.test(text)) return "博士后岗位";
  if (/博士后/.test(text)) return "博士后";
  if (/特别研究助理/.test(text)) return "科研助理";
  if (/PI招聘|招聘PI|Principal Investigator/.test(text)) return "PI招聘";
  if (/实验室招聘|课题组招聘/.test(text)) return "实验室招聘";
  if (/甬江论坛|青年论坛|青年学者论坛|夏培肃|教职|tenure-track|faculty position|招聘.*教授|教授.*招聘/i.test(text)) return "教职";
  if (/国家公派|公派研究生|联合培养博士生|留学基金委|\bCSC\b/.test(text)) return "国际交换";
  if ((/省自然科学基金杰出青年|地方人才/.test(text) || /省.*杰出青年/.test(text)) && !/面上/.test(text)) return "地方人才";
  if (/省社会科学|省社科基金|省级社科|市社会科学基金|北京市社会科学基金/.test(text)) return "省社科";
  if (/省自然科学基金|市自然科学基金/.test(text)) return "省自然科学基金";
  if (/地方重点研发|省重点研发/.test(text)) return "地方重点研发";
  if (/省科技计划/.test(text)) return "省科技计划";
  if (/市科技计划|市级.*科研项目/.test(text)) return "市级项目";
  if (/科研仪器/.test(text)) return "科研仪器";
  if (/科技创新专项/.test(text)) return "科技创新专项";
  if (/国家重点研发计划|重点专项/.test(text)) return "国家重点研发";
  if (/科技重大专项|国家科技重大专项/.test(text)) return "科技重大专项";
  if (/国科管/.test(text)) return "重大专项";
  if (/国家艺术基金/.test(text)) return "艺术基金";
  if (/国家语委|语委科研/.test(text)) return "语委";
  if (/中国科协|青年人才托举|青年科技人才培育工程/.test(text)) return "青年人才";
  if (/国家出版基金/.test(text)) return "出版基金";
  if (/后期资助/.test(text)) return "后期资助";
  if (/中华学术外译/.test(text)) return "中华学术外译";
  if (/成果文库/.test(text)) return "优秀成果奖";
  if (/通俗读物|优秀学术著作再版/.test(text)) return "专著出版";
  if (/国社科|国家社科|全国哲学社会科学|国家哲学社会科学/.test(text)) return "国社科";
  if (/教育科学规划/.test(text)) return "教育科学";
  if (/教育部/.test(text)) return "教育部人文社科";
  if (/联合基金/.test(text)) return "联合基金";
  if (/国际合作|双边研讨会|合作交流项目/.test(text)) return "国际合作";
  if (/面上项目/.test(text)) return "面上项目";
  if (/重点项目/.test(text) && !/重点专项/.test(text)) return "重点项目";
  if (/重大项目/.test(text) && !/重大专项/.test(text)) return "重大项目";
  if (/专项项目/.test(text)) return "专项项目";
  if (/青年科学基金项目（C类）|青年科学基金项目\(C类\)|青年科学基金/.test(text)) return "青年基金";
  if (/国自然|自然科学基金|NSFC|国家自然科学基金委员会|基金委/.test(text)) return "国自然";
  if (/JSPS Postdoctoral|海外博士后|海外博后/.test(text)) return "海外博后";
  if (/NSF Upcoming|NSF Program|NSF Events|\bNSF\b|UKRI|JSTニュース|\bJST\b|DFG \||Informationen für die Wissenschaft|SNF RSS|Swiss National|\bSNSF\b/.test(text)) return "国际基金";
  return null;
}

function yearMeeting(article: GrowArticle, lane: string): string | null {
  if (lane !== "会议征稿") return null;
  const text = `${article.title} ${article.feedTitle}`;
  if (/Special Issue/i.test(text)) return "Special Issue";
  if (/MDPI 特刊|特刊征稿/.test(text)) return "期刊征稿";
  if (/暑期学校|Summer School/i.test(text)) return "暑期学校";
  if (/博士生论坛|Doctoral Forum|PhD Forum/i.test(text)) return "博士生论坛";
  if (/\bWorkshop\b|研讨会|研討會|研讨班/i.test(text)) return "Workshop/研讨会";
  if (/学会.*年会|学术年会|秋季学术会议/.test(text)) return "学会年会";
  if (/NeurIPS|ICML|ICLR|\bACL\b|CVPR|AAAI|SIGGRAPH|\bCHI\b|顶会|CCF-A/.test(text)) return "顶会";
  if (/WikiCFP|PhilEvents|Calenda|International Conference|\bIEEE\b|\bACM\b|国际会议/.test(text)) return "国际会议";
  if (/中国社会科学网|会议日历|会议预告|CNCC|中国计算机大会/.test(text)) return "国内会议";
  if (/WikiCFP|PhilEvents|Calenda|CFPs on/.test(article.feedTitle)) return "国际会议";
  return "国内会议";
}

function yearKind(article: GrowArticle, lane: string, instrument: string | null): string | null {
  const text = `${article.title} ${article.feedTitle}`;
  if (/Bourse, prix et emploi/.test(text)) return "国际基金";
  const meeting = yearMeeting(article, lane);
  if (meeting) return meeting;
  if (lane === "国际基金" && !instrument) return "国际基金";
  if (!instrument) return "科研项目";
  return null;
}

export function classifyYearTags(article: GrowArticle, lane: string): string[] {
  const text = `${article.title} ${article.feedTitle}`;
  const tags: string[] = [];
  const add = (tag: string | null) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };
  const instrument = yearInstrument(text);
  if (instrument) {
    add(yearCluster(instrument));
    add(instrument);
  }
  const kind = yearKind(article, lane, instrument);
  if (kind) {
    add(yearCluster(kind));
    add(kind);
  }
  for (const [pattern, field] of YEAR_FIELDS) {
    if (pattern.test(text)) add(field);
  }
  return tags.length > 0 ? tags : [yearCluster("科研项目"), "科研项目"];
}

export function classifyYearCategory(article: GrowArticle, lane: string): string {
  return classifyYearTags(article, lane)[0];
}

function parseTitleDate(title: string, fallbackYear: number): CalendarDay | null {
  const chineseFull = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(title);
  if (chineseFull) return civilDay(Number(chineseFull[1]), Number(chineseFull[2]), Number(chineseFull[3]));
  const chineseShort = /(\d{1,2})月(\d{1,2})日/.exec(title);
  if (chineseShort) return civilDay(fallbackYear, Number(chineseShort[1]), Number(chineseShort[2]));
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(title);
  if (iso) return civilDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const englishNamed = /\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/.exec(title);
  if (englishNamed) {
    const month = MONTHS[englishNamed[1].toLowerCase()];
    if (month) return civilDay(Number(englishNamed[3]), month, Number(englishNamed[2]));
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(title);
  if (slash) return civilDay(fallbackYear, Number(slash[1]), Number(slash[2]));
  const english = /deadline[:\s]+(\d{1,2})\s+([A-Za-z]+)/i.exec(title);
  if (english) {
    const month = MONTHS[english[2].toLowerCase()];
    if (month) return civilDay(fallbackYear, month, Number(english[1]));
  }
  return null;
}

/** Feeds that label the window explicitly; the句子 wins over any harvest timestamp. */
const BODY_WINDOW = /(?:会议时间|活动时间|举办时间)(?:（非发布时间）)?\s*[:：]\s*([^\n]{4,80})/;
const BODY_DEADLINE = /(?:截止(?:日期|时间)?|申报时间|接收申请时间|报名截止)\s*(?:为|是)?\s*[:：]?\s*([^\n]{4,60})/;
const BODY_DEADLINE_EN = /(?:Full Proposal Deadline Date|Full Proposal Window|Preliminary Proposal Deadline|Submission Deadline|Proposal Deadline|Deadline Date|Due Date)s?\s*[:：]\s*([^\n]{4,60})/i;
const OFFICIAL_PUBLISHED = /发布日期\s*[:：]\s*(\d{4})-(\d{1,2})-(\d{1,2})/;
/** These feeds sort by first-harvest time, so publishedAt is an artifact, not an event date. */
const HARVEST_ARTIFACT = /RSS 排序日期为首次采集时间|原列表未提供发布时间/;

/**
 * The window a Chinese notice actually announces: "3月1日开始，3月20日16时截止",
 * "4月15日零时至4月25日17时", "2025年3月1日-3月31日".
 */
/** A date range that describes who may apply, not when the window is open. */
const ELIGIBILITY = /期间|入职|进站|入站|招聘|出生|年龄|获得博士|学位后/;

function parseChineseWindow(text: string, fallbackYear: number): { start: CalendarDay; end: CalendarDay } | null {
  // Official notices pad numbers with spaces ("2025年 7月 21日"), so allow them everywhere.
  const openClose = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,10}?开始[^。\n]{0,10}?(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,10}?截止/.exec(text);
  if (openClose) {
    const startYear = Number(openClose[1] || fallbackYear);
    const start = civilDay(startYear, Number(openClose[2]), Number(openClose[3]));
    const end = civilDay(Number(openClose[4] || startYear), Number(openClose[5]), Number(openClose[6]));
    if (start && end) return { start, end };
  }
  // Allow a clock ("零时", "16时") to sit between the day and the separator.
  const ranged = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\n月]{0,10}?(?:至|到|—|–|-|~|～)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  for (let match = ranged.exec(text); match; match = ranged.exec(text)) {
    if (ELIGIBILITY.test(text.slice(match.index + match[0].length, match.index + match[0].length + 14))) continue;
    const startYear = Number(match[1] || fallbackYear);
    const start = civilDay(startYear, Number(match[2]), Number(match[3]));
    const end = civilDay(Number(match[4] || startYear), Number(match[5]), Number(match[6]));
    if (start && end) return { start, end };
  }
  return null;
}

/**
 * A single announced moment stated without a range: "7月20日上午9点前提交",
 * "8月31日申报截止", "2月24日开始申报". The date sits before the cue word, which is
 * why scanning forward from "截止" misses it.
 */
function parseChinesePoint(text: string, fallbackYear: number): { day: CalendarDay; meta: string } | null {
  const read = (match: RegExpExecArray) => civilDay(Number(match[1] || fallbackYear), Number(match[2]), Number(match[3]));
  const closing = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,12}?(?:前|截止|结束)/.exec(text);
  if (closing) {
    const day = read(closing);
    if (day) return { day, meta: "截止" };
  }
  const opening = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,10}?开始/.exec(text);
  if (opening) {
    const day = read(opening);
    if (day) return { day, meta: "开放" };
  }
  return null;
}

function parseIsoSpan(text: string): { start: CalendarDay; end: CalendarDay } | null {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})\s*[~～\-–—至到]+\s*(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (!iso) return null;
  const start = civilDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const end = civilDay(Number(iso[4]), Number(iso[5]), Number(iso[6]));
  return start && end ? { start, end } : null;
}

/** Reads the window out of the body so the event lands on when it happens, not when it was posted. */
export function parseBodyWindow(snippet: string | null, fallbackYear: number): { start: CalendarDay; end?: CalendarDay; meta: string } | null {
  if (!snippet) return null;
  // Feed snippets are capped around 220 chars, so the window often sits past the cut.
  const labelled = BODY_WINDOW.exec(snippet);
  const scope = labelled?.[1] ?? null;
  if (scope) {
    const span = parseIsoSpan(scope) ?? parseTitleSpan(scope, fallbackYear) ?? parseChineseWindow(scope, fallbackYear);
    if (span && laterDay(span.start, span.end)) return { start: span.start, end: span.end, meta: "会期" };
    const single = parseTitleDate(scope, fallbackYear);
    if (single) return { start: single, meta: "会期" };
  }
  // An announced window outranks any single cut-off date, which is often only an
  // internal review step ("各申报单位审核工作截止日期为…").
  const stated = parseChineseWindow(snippet, fallbackYear);
  if (stated && laterDay(stated.start, stated.end)) return { start: stated.start, end: stated.end, meta: "申报窗口" };
  const deadline = BODY_DEADLINE.exec(snippet) ?? BODY_DEADLINE_EN.exec(snippet);
  if (deadline) {
    const span = parseIsoSpan(deadline[1]) ?? parseTitleSpan(deadline[1], fallbackYear);
    if (span && laterDay(span.start, span.end)) return { start: span.start, end: span.end, meta: "申报窗口" };
    const single = parseTitleDate(deadline[1], fallbackYear);
    if (single) return { start: single, meta: "截止" };
  }
  const cue = parseChinesePoint(snippet, fallbackYear);
  if (cue) return { start: cue.day, meta: cue.meta };
  const loose = parseIsoSpan(snippet) ?? parseTitleSpan(snippet, fallbackYear);
  if (loose && laterDay(loose.start, loose.end)) return { start: loose.start, end: loose.end, meta: "会期" };
  return null;
}

function parseOfficialPublished(snippet: string | null): CalendarDay | null {
  if (!snippet) return null;
  const official = OFFICIAL_PUBLISHED.exec(snippet);
  if (!official) return null;
  return civilDay(Number(official[1]), Number(official[2]), Number(official[3]));
}

function parseTitleSpan(title: string, fallbackYear: number): { start: CalendarDay; end: CalendarDay } | null {
  const english = /\[\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*[-–—]\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*\]/.exec(title);
  if (english) {
    const start = civilDay(Number(english[3]), MONTHS[english[1].toLowerCase()] ?? 0, Number(english[2]));
    const end = civilDay(Number(english[6]), MONTHS[english[4].toLowerCase()] ?? 0, Number(english[5]));
    if (start && end) return { start, end };
  }
  const chinese = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-–—至到]+\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/.exec(title);
  if (chinese) {
    const start = civilDay(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));
    const end = civilDay(Number(chinese[4] || chinese[1]), Number(chinese[5]), Number(chinese[6]));
    if (start && end) return { start, end };
  }
  const short = /(\d{1,2})月(\d{1,2})日\s*[-–—至到]+\s*(\d{1,2})月(\d{1,2})日/.exec(title);
  if (short) {
    const start = civilDay(fallbackYear, Number(short[1]), Number(short[2]));
    const end = civilDay(fallbackYear, Number(short[3]), Number(short[4]));
    if (start && end) return { start, end };
  }
  return null;
}

function civilDay(year: number, month: number, day: number): CalendarDay | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  const last = daysInMonth(year, month);
  if (day < 1 || day > last) return null;
  return { year, month, day, dateKey: dateKeyFromParts(month, day) };
}

function laterDay(left: CalendarDay, right: CalendarDay): boolean {
  return left.year < right.year || (left.year === right.year && (left.month < right.month || (left.month === right.month && left.day < right.day)));
}

export function spanDays(start: CalendarDay, end: CalendarDay): number {
  const from = Date.UTC(start.year, start.month - 1, start.day ?? 1);
  const to = Date.UTC(end.year, end.month - 1, end.day ?? 1);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** Conference lanes announce sittings; grant lanes announce submission windows. */
function spanMeta(lane: string | undefined): "会期" | "申报窗口" {
  return lane === undefined || lane === "会议征稿" ? "会期" : "申报窗口";
}

/**
 * Keeps a range only when its length matches what the source claims to be.
 * A 200-day "conference" is a submission range that PhilEvents filed as an event,
 * so we keep the opening day as evidence and drop the false window.
 */
export function acceptSpan(start: CalendarDay, end: CalendarDay, meta: "会期" | "申报窗口"): boolean {
  const days = spanDays(start, end);
  return days >= 1 && days <= (meta === "会期" ? MAX_SESSION_DAYS : MAX_WINDOW_DAYS);
}

function articleText(article: GrowArticle): string {
  return [article.snippet, article.body].filter(Boolean).join("\n");
}

export function growPlacement(article: GrowArticle, lane?: string): { start: CalendarDay; end?: CalendarDay; kind: "point" | "span"; meta: string } | null {
  const text = articleText(article);
  const official = parseOfficialPublished(text);
  const published = official ?? (article.publishedAt ? shanghaiCivilFromIso(article.publishedAt) : null);
  const year = published?.year ?? shanghaiToday().year;
  const meta = spanMeta(lane);
  const span = parseTitleSpan(article.title, year);
  if (span && laterDay(span.start, span.end)) {
    if (acceptSpan(span.start, span.end, meta)) return { start: span.start, end: span.end, kind: "span", meta };
    return { start: span.start, kind: "point", meta: meta === "会期" ? "起始" : "开放" };
  }
  const titled = parseTitleDate(article.title, year);
  if (titled) return { start: titled, kind: "point", meta: "标题日期" };
  const body = parseBodyWindow(text, year);
  if (body) {
    if (body.end && !acceptSpan(body.start, body.end, body.meta === "会期" ? "会期" : "申报窗口")) {
      return { start: body.start, kind: "point", meta: body.meta === "会期" ? "起始" : "开放" };
    }
    return { start: body.start, end: body.end, kind: body.end ? "span" : "point", meta: body.meta };
  }
  // A first-harvest timestamp says when we looked, not when anything happened.
  if (HARVEST_ARTIFACT.test(text)) return null;
  if (published) return { start: published, kind: "point", meta: official ? "官方发布" : "发布" };
  return null;
}

/** True when we only have a posting date, so the real window is still hiding in the full text. */
export function needsDeepRead(article: GrowArticle, lane?: string): boolean {
  if (article.body) return false;
  const placed = growPlacement(article, lane);
  return placed == null || placed.meta === "发布" || placed.meta === "官方发布";
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function growDate(article: GrowArticle): { day: CalendarDay; meta: string } | null {
  const placed = growPlacement(article);
  if (!placed) return null;
  return { day: placed.start, meta: placed.meta };
}

export function keepGrowArticle(article: GrowArticle, lane: string): boolean {
  const title = article.title.trim();
  if (!title || REJECT.test(title)) return false;
  if (article.feedTitle.includes("通知公告") && !NOTICE_KEEP.test(title)) return false;
  if (article.feedTitle.includes("国家自然科学基金委员会") && !NOTICE_KEEP.test(title)) return false;
  if (lane === "会议征稿" && /MDPI 特刊|特刊征稿/.test(title)) return false;
  return true;
}

export function growYearEvents(seeds: readonly GrowSeed[]): CalendarEvent[] {
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const seed of seeds) {
    if (!keepGrowArticle(seed.article, seed.lane)) continue;
    const placed = growPlacement(seed.article, seed.lane);
    if (!placed) continue;
    const key = normalizeTitle(seed.article.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = classifyYearTags(seed.article, seed.lane);
    events.push({
      id: `year:${seed.article.id}`,
      title: seed.article.title,
      tags,
      precision: "day",
      start: { year: placed.start.year, month: placed.start.month, day: placed.start.day },
      end: placed.end ? { year: placed.end.year, month: placed.end.month, day: placed.end.day } : undefined,
      kind: placed.kind,
      source: "year",
      approximate: false,
      payload: {
        body: seed.article.snippet || undefined,
        meta: placed.meta,
        sourceName: seed.article.feedTitle,
        sourceUrl: seed.article.url || undefined,
        eventType: tags[0],
      },
    });
  }
  return events.sort((a, b) => (
    a.start.year - b.start.year
    || a.start.month - b.start.month
    || (a.start.day ?? 0) - (b.start.day ?? 0)
    || a.title.localeCompare(b.title, "zh")
  ));
}

export async function loadGrowSeeds(): Promise<GrowSeed[]> {
  const [folders, feeds] = await Promise.all([
    listFolders().catch(() => [] as Folder[]),
    listFeeds().catch(() => [] as Feed[]),
  ]);
  const queries = pickGrowQueries(folders, feeds);
  const batches = await Promise.all(queries.map(async (item) => {
    const articles = await listArticles(item.query, false, null, false, 400, 0).catch(() => [] as ArticleSummary[]);
    return articles.map((article) => ({ article: toGrowArticle(article), lane: item.lane }));
  }));
  return deepenGrowSeeds(batches.flat());
}

/** Feed snippets truncate before the window sentence, so re-read the ones we could not place. */
export const DEEP_READ_LIMIT = 120;

export async function deepenGrowSeeds(seeds: readonly GrowSeed[]): Promise<GrowSeed[]> {
  const pending = seeds.filter((seed) => keepGrowArticle(seed.article, seed.lane) && needsDeepRead(seed.article, seed.lane)).slice(0, DEEP_READ_LIMIT);
  if (pending.length === 0) return [...seeds];
  const bodies = new Map<number, string>();
  await Promise.all(pending.map(async (seed) => {
    const detail = await getArticle(seed.article.id).catch(() => null);
    const html = detail?.contentHtml;
    if (html) bodies.set(seed.article.id, htmlToText(html));
  }));
  return seeds.map((seed) => {
    const body = bodies.get(seed.article.id);
    return body ? { ...seed, article: { ...seed.article, body } } : seed;
  });
}
