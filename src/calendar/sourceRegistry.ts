/**
 * Authoritative entry points used to turn a web-search discovery into a
 * reviewable calendar candidate. Search engines help find notices; a matching
 * official page is still required before an item can be published to the year.
 */
export type CalendarSourceLane =
  | "科研申报"
  | "人才计划"
  | "博士后项目"
  | "国家科技项目"
  | "人文社科基金"
  | "地方科研项目"
  | "国际科研机会"
  | "会议征稿"
  | "培养节点";

export interface CalendarSourceProfile {
  id: string;
  name: string;
  homepage: string;
  /** Include subdomains only when the organisation explicitly owns them. */
  officialHosts: readonly string[];
  lanes: readonly CalendarSourceLane[];
  /** Queries are discovery aids, never evidence or an import key. */
  queries: readonly string[];
  refreshDays: number;
}

/**
 * First-wave national sources. Provincial sources belong in a later whitelist,
 * not a generic `site:.gov.cn` query, so the calendar stays auditable.
 */
export const CALENDAR_SOURCE_REGISTRY: readonly CalendarSourceProfile[] = [
  {
    id: "c9-campus-calendars",
    name: "985高校教务与研究生院通知",
    homepage: "https://www.pku.edu.cn/",
    officialHosts: [
      "www.pku.edu.cn", "www.sjtu.edu.cn", "www.teach.ustc.edu.cn", "hsss.ustc.edu.cn",
      "jw.nju.edu.cn", "www.whu.edu.cn", "syxt.xjtu.edu.cn", "oa.xjtu.edu.cn",
      "acem.scu.edu.cn", "en.tju.edu.cn", "scet.tju.edu.cn", "cse.sysu.edu.cn", "lingnan.sysu.edu.cn",
      "cie.hit.edu.cn", "hituc.hit.edu.cn", "kgxy.jlu.edu.cn", "me.seu.edu.cn", "jwc.hnu.edu.cn", "phy.sdu.edu.cn",
      "pyb.hfut.edu.cn", "yjsy.hlju.edu.cn", "gs.cufe.edu.cn", "gs.cczu.edu.cn", "medgs.xjtu.edu.cn",
      "yjsb.ahtcm.edu.cn", "graduate.buct.edu.cn", "www.aais.pku.edu.cn", "cz.nankai.edu.cn", "www.sis.pku.edu.cn",
    ],
    lanes: ["培养节点"],
    queries: [
      "site:pku.edu.cn 校历 研究生 开学 寒假",
      "site:edu.cn 985 校历 研究生 开学 寒假",
    ],
    refreshDays: 30,
  },
  {
    id: "nsfc",
    name: "国家自然科学基金委员会",
    homepage: "https://www.nsfc.gov.cn/",
    officialHosts: ["nsfc.gov.cn", "www.nsfc.gov.cn", "grants.nsfc.gov.cn"],
    lanes: ["科研申报", "人才计划"],
    queries: [
      "site:nsfc.gov.cn 年度 项目 申请 通告",
      "site:nsfc.gov.cn 青年科学基金 项目 申请",
      "site:nsfc.gov.cn 项目指南 申请",
    ],
    refreshDays: 3,
  },
  {
    id: "nopss",
    name: "全国哲学社会科学工作办公室",
    homepage: "https://www.nopss.gov.cn/",
    officialHosts: ["www.nopss.gov.cn"],
    lanes: ["人文社科基金"],
    queries: [
      "site:nopss.gov.cn 国家社会科学基金 申报 公告",
      "site:nopss.gov.cn 后期资助 申报",
      "site:nopss.gov.cn 中华学术外译 申报",
    ],
    refreshDays: 3,
  },
  {
    id: "postdoc",
    name: "中国博士后网",
    homepage: "https://www.chinapostdoctor.org.cn/",
    officialHosts: ["www.chinapostdoctor.org.cn", "chinapostdoctor.org.cn"],
    lanes: ["博士后项目", "人才计划"],
    queries: [
      "site:chinapostdoctor.org.cn 博士后 基金 申报",
      "site:chinapostdoctor.org.cn 博士后创新人才支持计划 申报",
      "site:chinapostdoctor.org.cn 国家资助博士后研究人员计划 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "most-service",
    name: "国家科技管理信息系统公共服务平台",
    homepage: "https://service.most.gov.cn/",
    officialHosts: ["most.gov.cn", "www.most.gov.cn", "service.most.gov.cn", "service1.most.gov.cn", "service2.most.gov.cn", "fuwu.most.gov.cn"],
    lanes: ["国家科技项目", "科研申报"],
    queries: [
      "site:service.most.gov.cn 国家重点研发计划 项目申报指南",
      "site:most.gov.cn 国家重点研发计划 项目申报指南",
    ],
    refreshDays: 3,
  },
  {
    id: "moe",
    name: "中华人民共和国教育部",
    homepage: "https://www.moe.gov.cn/",
    officialHosts: ["www.moe.gov.cn", "moe.gov.cn"],
    lanes: ["人文社科基金", "人才计划"],
    queries: [
      "site:moe.gov.cn 人文社会科学研究 项目 申报",
      "site:moe.gov.cn 长江学者 奖励计划 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "onsgep",
    name: "全国教育科学规划领导小组办公室",
    homepage: "https://onsgep.moe.edu.cn/",
    officialHosts: ["onsgep.moe.edu.cn"],
    lanes: ["人文社科基金"],
    queries: [
      "site:onsgep.moe.edu.cn 全国教育科学规划 项目 申报 公告",
      "site:onsgep.moe.edu.cn 国家社科基金 教育学 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "csc",
    name: "国家留学基金管理委员会（国家留学网）",
    homepage: "https://www.csc.edu.cn/",
    officialHosts: ["www.csc.edu.cn", "csc.edu.cn", "origin-www.csc.edu.cn", "origin-bg.csc.edu.cn"],
    lanes: ["国际科研机会", "人才计划"],
    queries: [
      "site:csc.edu.cn 国家公派 博士后 项目 申报",
      "site:csc.edu.cn 国家留学基金 博士生 导师 国际交流 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "arts-planning",
    name: "全国艺术科学规划项目管理中心",
    homepage: "https://yskx.mct.gov.cn/",
    officialHosts: ["yskx.mct.gov.cn"],
    lanes: ["人文社科基金"],
    queries: [
      "site:yskx.mct.gov.cn 国家社科基金 艺术学 项目 申报",
      "site:yskx.mct.gov.cn 艺术学 后期资助 成果文库 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "national-arts-fund",
    name: "国家艺术基金管理中心",
    homepage: "https://www.cnaf.cn/",
    officialHosts: ["www.cnaf.cn", "cnaf.cn"],
    lanes: ["人文社科基金", "人才计划"],
    queries: [
      "site:cnaf.cn 国家艺术基金 项目申报指南",
      "site:cnaf.cn 国家艺术基金 青年艺术创作人才 申报",
    ],
    refreshDays: 7,
  },
  {
    id: "cast",
    name: "中国科学技术协会",
    homepage: "https://www.cast.org.cn/",
    officialHosts: ["www.cast.org.cn", "cast.org.cn", "rczx.cast.org.cn"],
    lanes: ["人才计划"],
    queries: [
      "site:cast.org.cn 中国科协 青年人才托举工程 申报",
      "site:cast.org.cn 青年科技人才培育工程 博士生专项计划",
    ],
    refreshDays: 14,
  },
  {
    id: "international-conference-organizers",
    name: "国际学术会议主办方官网",
    homepage: "https://icml.cc/",
    officialHosts: [
      "icml.cc", "neurips.cc", "2026.aclweb.org", "aclweb.org",
      "cvpr.thecvf.com", "thecvf.com", "www.egu.eu", "egu.eu",
      "callforabstracts.acs.org", "www.acs.org", "acs.org",
      "2026.ieeeicassp.org", "ieeeicassp.org",
    ],
    lanes: ["会议征稿"],
    queries: [
      "site:icml.cc 2026 Call for Papers",
      "site:neurips.cc 2026 Call for Papers",
      "site:aclweb.org 2026 call for papers",
      "site:thecvf.com 2026 call for papers",
    ],
    refreshDays: 14,
  },
  {
    id: "ukri",
    name: "英国研究与创新署（UKRI）",
    homepage: "https://www.ukri.org/",
    officialHosts: ["www.ukri.org", "ukri.org"],
    lanes: ["国际科研机会", "会议征稿"],
    queries: ["site:ukri.org funding opportunity researcher", "site:ukri.org events research conference"],
    refreshDays: 7,
  },
  {
    id: "jst",
    name: "日本科学技术振兴机构（JST）",
    homepage: "https://www.jst.go.jp/",
    officialHosts: ["www.jst.go.jp", "jst.go.jp"],
    lanes: ["国际科研机会", "会议征稿"],
    queries: ["site:jst.go.jp 公募 国際共同研究", "site:jst.go.jp symposium AI for Science"],
    refreshDays: 7,
  },
  {
    id: "snsf",
    name: "瑞士国家科学基金会（SNSF）",
    homepage: "https://www.snf.ch/",
    officialHosts: ["www.snf.ch", "snf.ch"],
    lanes: ["国际科研机会"],
    queries: ["site:snf.ch Postdoc.Mobility call", "site:snf.ch Swiss Quantum call"],
    refreshDays: 7,
  },
  {
    id: "dfg",
    name: "德国研究联合会（DFG）",
    homepage: "https://www.dfg.de/",
    officialHosts: ["www.dfg.de", "dfg.de"],
    lanes: ["国际科研机会"],
    queries: ["site:dfg.de call for proposals international research"],
    refreshDays: 7,
  },
];

function hostname(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try { return new URL(rawUrl).hostname.toLowerCase(); }
  catch { return null; }
}

export function officialSourceForUrl(rawUrl: string | null | undefined): CalendarSourceProfile | null {
  const host = hostname(rawUrl);
  if (!host) return null;
  return CALENDAR_SOURCE_REGISTRY.find((profile) => profile.officialHosts.includes(host)) ?? null;
}

export function isOfficialCalendarSource(rawUrl: string | null | undefined): boolean {
  return officialSourceForUrl(rawUrl) != null;
}
