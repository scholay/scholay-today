import { describe, expect, it } from "vitest";
import { CALENDAR_SOURCE_REGISTRY, isOfficialCalendarSource, officialSourceForUrl } from "./sourceRegistry";

describe("calendar official source registry", () => {
  it("only trusts explicit official source hosts", () => {
    expect(officialSourceForUrl("https://www.nsfc.gov.cn/p1/3381/2824/99667.html")?.id).toBe("nsfc");
    expect(officialSourceForUrl("https://nsfc.gov.cn/p1/3381/2824/99667.html")?.id).toBe("nsfc");
    expect(officialSourceForUrl("https://service2.most.gov.cn/kjjh_tztg_all/20260828/5864.html")?.id).toBe("most-service");
    expect(officialSourceForUrl("https://www.most.gov.cn/kjbgz/2026/notice.html")?.id).toBe("most-service");
    expect(officialSourceForUrl("https://onsgep.moe.edu.cn/post/view/1848")?.id).toBe("onsgep");
    expect(officialSourceForUrl("https://origin-www.csc.edu.cn/article/4044")?.id).toBe("csc");
    expect(officialSourceForUrl("https://yskx.mct.gov.cn/index/more/toDetail?no=98")?.id).toBe("arts-planning");
    expect(officialSourceForUrl("https://www.cnaf.cn/guide_detail/5546.html")?.id).toBe("national-arts-fund");
    expect(officialSourceForUrl("https://rczx.cast.org.cn/jljj/jldt/art/2025/art_1660854139.html")?.id).toBe("cast");
    expect(officialSourceForUrl("https://www.pku.edu.cn/detail/3001.html")?.id).toBe("c9-campus-calendars");
    expect(officialSourceForUrl("https://icml.cc/Conferences/2026/CallForPapers")?.id).toBe("international-conference-organizers");
    expect(officialSourceForUrl("https://www.ukri.org/events/dafni-2026-conference/")?.id).toBe("ukri");
    expect(officialSourceForUrl("https://www.snf.ch/en/aK0GyCwNg3knzGat/news/call-for-postdocmobility")?.id).toBe("snsf");
    expect(officialSourceForUrl("https://www.dfg.de/de/aktuelles/neuigkeiten-themen/info-wissenschaft/2026/ifw-26-54")?.id).toBe("dfg");
    expect(isOfficialCalendarSource("https://example.gov.cn/notice")).toBe(false);
    expect(isOfficialCalendarSource("not a url")).toBe(false);
  });

  it("keeps a search plan for every first-wave source", () => {
    expect(CALENDAR_SOURCE_REGISTRY.length).toBeGreaterThanOrEqual(16);
    expect(CALENDAR_SOURCE_REGISTRY.every((source) => source.queries.length > 0 && source.refreshDays > 0)).toBe(true);
  });
});
