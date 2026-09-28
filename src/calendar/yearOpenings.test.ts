import { describe, expect, it } from "vitest";
import type { CalendarEvent, CalendarProvenance } from "./types";
import { isYearOpening, yearOpenings, yearOpeningsCount } from "./yearOpenings";

function event({
  id,
  title = id,
  year = 2026,
  month = 3,
  day = 1,
  source = "year",
  tags = ["自然科学基金"],
  provenance,
  sourceUrl,
}: {
  id: string;
  title?: string;
  year?: number;
  month?: number;
  day?: number | null;
  source?: CalendarEvent["source"];
  tags?: string[];
  provenance?: CalendarProvenance;
  sourceUrl?: string;
}): CalendarEvent {
  return {
    id,
    title,
    tags,
    precision: day == null ? "month" : "day",
    start: { year, month, day },
    kind: "point",
    source,
    approximate: false,
    payload: { provenance, sourceUrl },
  };
}

const verified: CalendarProvenance = {
  origin: "web_search",
  sourceTier: "official",
  verification: "verified",
  reviewedAt: "2026-01-15",
};

describe("year openings", () => {
  it("keeps verified current-year opportunities without requiring a recurring habit", () => {
    const oneOff = event({ id: "one-off", provenance: verified, sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html" });
    const later = event({ id: "later", month: 8, day: 9, provenance: verified, sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html" });

    expect(isYearOpening(oneOff, 2026)).toBe(true);
    expect(yearOpenings([later, oneOff], 2026).map((item) => item.id)).toEqual(["one-off", "later"]);
    expect(yearOpeningsCount([later, oneOff], 2026)).toBe(2);
  });

  it("requires a verified year event in the requested year", () => {
    const verifiedRss = event({
      id: "verified-rss",
      provenance: { origin: "rss", sourceTier: "official", verification: "verified" },
      sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html",
    });
    const pending = event({ id: "pending", provenance: { ...verified, verification: "needs_review" }, sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html" });
    const legacy = event({ id: "legacy" });
    const nextYear = event({ id: "next-year", year: 2027, provenance: verified, sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html" });
    const history = event({ id: "history", source: "history", provenance: verified, sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html" });

    expect(yearOpenings([pending, legacy, nextYear, history, verifiedRss], 2026).map((item) => item.id)).toEqual(["verified-rss"]);
  });

  it("requires the verified evidence link to be a registered official page", () => {
    const officialUrl = "https://www.nsfc.gov.cn/p1/3381/2824/99667.html";
    const official = event({ id: "official", provenance: verified, sourceUrl: officialUrl });
    const forged = event({ id: "forged", provenance: verified, sourceUrl: "https://example.gov.cn/notice" });
    const repost = event({
      id: "repost",
      provenance: { ...verified, sourceTier: "official_repost" },
      sourceUrl: officialUrl,
    });
    const community = event({
      id: "community",
      provenance: { ...verified, sourceTier: "community" },
      sourceUrl: "https://example.com/post",
    });

    expect(yearOpenings([community, repost, forged, official], 2026).map((item) => item.id)).toEqual(["official"]);
  });

  it("does not mistake holidays or campus administration for research opportunities", () => {
    const sourceUrl = "https://www.nsfc.gov.cn/p1/3381/2824/99667.html";
    const holiday = event({ id: "holiday", tags: ["节假日"], provenance: { origin: "curated", sourceTier: "official", verification: "verified" }, sourceUrl });
    const campus = event({ id: "campus", tags: ["培养节点", "开学"], provenance: verified, sourceUrl });
    const opening = event({ id: "opening", tags: ["博士后项目"], provenance: verified, sourceUrl });

    expect(yearOpenings([holiday, campus, opening], 2026).map((item) => item.id)).toEqual(["opening"]);
  });

  it("orders equal-date openings deterministically and keeps month-only entries before dated ones", () => {
    const sourceUrl = "https://www.nsfc.gov.cn/p1/3381/2824/99667.html";
    const monthOnly = event({ id: "month", title: "月度机会", month: 4, day: null, provenance: verified, sourceUrl });
    const alpha = event({ id: "alpha", title: "甲项目", month: 4, day: 3, provenance: verified, sourceUrl });
    const beta = event({ id: "beta", title: "乙项目", month: 4, day: 3, provenance: verified, sourceUrl });

    expect(yearOpenings([beta, alpha, monthOnly], 2026).map((item) => item.id)).toEqual(["month", "alpha", "beta"]);
  });
});
