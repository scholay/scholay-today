import type { CalendarEvent } from "./types";

/**
 * A compact browsing taxonomy for 昔日学术.  These are not new event labels:
 * every event keeps its original historical domain as its precise tag.
 */
export const HISTORY_GROUPS = [
  {
    group: "研究体系",
    members: ["研究规范史", "研究诚信史", "研究方法史", "定性研究方法史", "开放科学史", "数据治理史", "学术制度", "科学机构史", "统计学史"],
  },
  {
    group: "基础与计算",
    members: ["数学史", "物理学史", "粒子物理史", "核科学史", "化学史", "材料科学史", "生命科学史", "地球科学史", "天文学史", "计算史", "工程史"],
  },
  {
    group: "生命、健康与环境",
    members: ["医学史", "公共卫生史", "心理学史", "农业科学史", "食品科学史", "环境科学政策史"],
  },
  {
    group: "航天与空间",
    members: ["航天史", "航天政策史", "月球探测史"],
  },
] as const;

export type HistoryGroup = (typeof HISTORY_GROUPS)[number]["group"];

const HISTORY_GROUP_BY_MEMBER = new Map<string, HistoryGroup>(
  HISTORY_GROUPS.flatMap(({ group, members }) => members.map((member) => [member, group] as const)),
);

export function historyGroupFor(tag: string | null): HistoryGroup | null {
  return tag ? HISTORY_GROUP_BY_MEMBER.get(tag) ?? null : null;
}

export function isHistoryGroup(tag: string | null): tag is HistoryGroup {
  return !!tag && HISTORY_GROUPS.some((item) => item.group === tag);
}

/** A group is an OR-filter across its original, still-visible member tags. */
export function filterHistoryByTag(events: readonly CalendarEvent[], tag: string | null): CalendarEvent[] {
  if (!tag) return [...events];
  const members = HISTORY_GROUPS.find((item) => item.group === tag)?.members;
  return events.filter((event) => event.tags.some((eventTag) => members ? members.includes(eventTag as never) : eventTag === tag));
}
