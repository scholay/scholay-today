import type { CalendarEvent } from "./types";

/** 国务院办公厅关于2026年部分节假日安排的通知, 国办发明电〔2025〕7号. */
const NOTICE_URL = "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm";
const NOTICE_NAME = "国务院办公厅";
const NOTICE_META = "国办发明电〔2025〕7号";

/**
 * Xinhua, citing Purple Mountain Observatory: Qingming 2026 falls at
 * 02:40 on 5 April, Beijing time.
 */
const QINGMING_URL = "http://www.gd.xinhuanet.com/20250404/9d7cfe44eeb64279a91f710dc87e27ce/c.html";

interface SpanSpec {
  id: string;
  title: string;
  start: [number, number];
  end: [number, number];
  body: string;
}

interface PointSpec {
  id: string;
  title: string;
  month: number;
  day: number;
  member: "传统节日" | "调休上班";
  body: string;
  sourceName?: string;
  sourceUrl?: string;
}

function holidayEvent(year: number, spec: SpanSpec | PointSpec, kind: "span" | "point"): CalendarEvent {
  const startDay = "start" in spec ? spec.start : [spec.month, spec.day] as [number, number];
  const member = "member" in spec ? spec.member : "法定放假";
  return {
    id: `holiday:${year}:${spec.id}`,
    title: spec.title,
    tags: [member, "节假日"],
    precision: "day",
    start: { year, month: startDay[0], day: startDay[1] },
    end: "end" in spec ? { year, month: spec.end[0], day: spec.end[1] } : undefined,
    kind,
    source: "year",
    approximate: false,
    payload: {
      body: spec.body,
      meta: NOTICE_META,
      sourceName: "sourceName" in spec && spec.sourceName ? spec.sourceName : NOTICE_NAME,
      sourceUrl: "sourceUrl" in spec ? spec.sourceUrl : NOTICE_URL,
      eventType: member,
    },
  };
}

/**
 * Nationwide dates for one civil year.
 * School calendars and region-split folk days (小年 north/south) are omitted.
 * Years without a published State Council notice return nothing.
 */
export function nationalHolidays(year: number): CalendarEvent[] {
  if (year !== 2026) return [];
  const rests: SpanSpec[] = [
    {
      id: "new-year-rest",
      title: "元旦放假",
      start: [1, 1],
      end: [1, 3],
      body: "1月1日至3日放假调休，共3天。",
    },
    {
      id: "spring-rest",
      title: "春节放假",
      start: [2, 15],
      end: [2, 23],
      body: "2月15日（腊月二十八）至23日（正月初七）放假调休，共9天。",
    },
    {
      id: "qingming-rest",
      title: "清明节放假",
      start: [4, 4],
      end: [4, 6],
      body: "4月4日至6日放假，共3天。节日当天是交节的4月5日。",
    },
    {
      id: "labour-rest",
      title: "劳动节放假",
      start: [5, 1],
      end: [5, 5],
      body: "5月1日至5日放假调休，共5天。",
    },
    {
      id: "dragon-boat-rest",
      title: "端午节放假",
      start: [6, 19],
      end: [6, 21],
      body: "6月19日至21日放假，共3天。",
    },
    {
      id: "mid-autumn-rest",
      title: "中秋节放假",
      start: [9, 25],
      end: [9, 27],
      body: "9月25日至27日放假，共3天。",
    },
    {
      id: "national-day-rest",
      title: "国庆节放假",
      start: [10, 1],
      end: [10, 7],
      body: "10月1日至7日放假调休，共7天。",
    },
  ];
  // Lunar dates below are fixed by the notice: 15 Feb is 腊月二十八 and 23 Feb is 正月初七,
  // so 除夕 is 16 Feb and 春节 is 17 Feb. Later festivals use the lunar calendar that matches those two labels.
  const points: PointSpec[] = [
    {
      id: "laba",
      title: "腊八",
      month: 1,
      day: 26,
      member: "传统节日",
      body: "腊月初八。通知写明2月15日为腊月二十八，倒推腊月初八是1月26日。",
    },
    {
      id: "new-year-work",
      title: "元旦调休上班",
      month: 1,
      day: 4,
      member: "调休上班",
      body: "1月4日（周日）上班。",
    },
    {
      id: "spring-work-before",
      title: "春节前调休上班",
      month: 2,
      day: 14,
      member: "调休上班",
      body: "2月14日（周六）上班。",
    },
    {
      id: "chuxi",
      title: "除夕",
      month: 2,
      day: 16,
      member: "传统节日",
      body: "腊月二十九。通知写明2月15日为腊月二十八、2月23日为正月初七，这一年没有腊月三十，除夕是2月16日。",
    },
    {
      id: "spring-festival",
      title: "春节",
      month: 2,
      day: 17,
      member: "传统节日",
      body: "正月初一。由2月23日为正月初七倒推，正月初一是2月17日。",
    },
    {
      id: "spring-work-after",
      title: "春节后调休上班",
      month: 2,
      day: 28,
      member: "调休上班",
      body: "2月28日（周六）上班。",
    },
    {
      id: "lantern",
      title: "元宵节",
      month: 3,
      day: 3,
      member: "传统节日",
      body: "正月十五。正月初一为2月17日，正月十五是3月3日。",
    },
    {
      id: "qingming",
      title: "清明",
      month: 4,
      day: 5,
      member: "传统节日",
      body: "交节时刻为4月5日02时40分（北京时间）。放假窗口是4月4日至6日。",
      sourceName: "新华社",
      sourceUrl: QINGMING_URL,
    },
    {
      id: "labour-work",
      title: "劳动节调休上班",
      month: 5,
      day: 9,
      member: "调休上班",
      body: "5月9日（周六）上班。",
    },
    {
      id: "dragon-boat",
      title: "端午节",
      month: 6,
      day: 19,
      member: "传统节日",
      body: "五月初五。放假从6月19日开始，这一天就是节日当天。",
    },
    {
      id: "qixi",
      title: "七夕",
      month: 8,
      day: 19,
      member: "传统节日",
      body: "七月初七，公历8月19日。日期取与通知中腊月二十八、正月初七一致的农历对照。",
    },
    {
      id: "national-day-work-before",
      title: "国庆前调休上班",
      month: 9,
      day: 20,
      member: "调休上班",
      body: "9月20日（周日）上班。",
    },
    {
      id: "mid-autumn",
      title: "中秋节",
      month: 9,
      day: 25,
      member: "传统节日",
      body: "八月十五。放假从9月25日开始，这一天就是节日当天。",
    },
    {
      id: "national-day-work-after",
      title: "国庆后调休上班",
      month: 10,
      day: 10,
      member: "调休上班",
      body: "10月10日（周六）上班。",
    },
    {
      id: "chongyang",
      title: "重阳节",
      month: 10,
      day: 18,
      member: "传统节日",
      body: "九月初九，公历10月18日。日期取与通知中腊月二十八、正月初七一致的农历对照。",
    },
    {
      id: "dongzhi",
      title: "冬至",
      month: 12,
      day: 22,
      member: "传统节日",
      body: "交节时刻为12月22日04时50分（北京时间）。",
      sourceName: "紫金山天文台历算",
      sourceUrl: undefined,
    },
  ];
  return [
    ...rests.map((spec) => holidayEvent(year, spec, "span")),
    ...points.map((spec) => holidayEvent(year, spec, "point")),
  ];
}
