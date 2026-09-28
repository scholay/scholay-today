import { describe, expect, it } from "vitest";
import { growEventId, growYearEvents, type GrowSeed } from "./yearGrow";

const canonicalUrl = "https://www.nsfc.gov.cn/p1/3381/2824/99667.html";

function seed({
  id,
  title,
  url = canonicalUrl,
  provenance,
}: {
  id: number;
  title: string;
  url?: string;
  provenance?: GrowSeed["provenance"];
}): GrowSeed {
  return {
    lane: "科研申报",
    article: {
      id,
      feedTitle: "测试来源",
      title,
      snippet: "申报时间为 2026年4月1日—4月20日。",
      url,
      publishedAt: "2026-03-01T00:00:00.000Z",
    },
    provenance,
  };
}

const rawRssCopy = seed({
  id: 1,
  title: "[RSS] 官方项目指南",
  url: `http://www.nsfc.gov.cn/p1/3381/2824/99667.html?utm_source=rss`,
  provenance: { origin: "rss", sourceTier: "aggregator", verification: "unverified" },
});

const officialPrimary = seed({
  id: 2,
  title: "[2026年4月1日—4月20日] 官方项目指南",
  provenance: {
    origin: "web_search",
    sourceTier: "official",
    verification: "verified",
    reviewedAt: "2026-09-27",
  },
});

describe("official source preference", () => {
  it("lets a reviewed official page replace an exact-title RSS copy of the same page", () => {
    const events = growYearEvents([rawRssCopy, officialPrimary]);

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe(officialPrimary.article.title);
    expect(events[0]?.payload.provenance).toMatchObject({
      origin: "web_search",
      sourceTier: "official",
      verification: "verified",
    });
  });

  it("keeps distinct tracks which intentionally cite one guide page", () => {
    const officialSecondary = seed({
      id: 3,
      title: "[2026年4月1日—4月20日] 官方另一资助轨道",
      provenance: officialPrimary.provenance,
    });
    const rawDifferentTrack = seed({
      id: 4,
      title: "[RSS] 同一指南下的另一原始资助轨道",
      provenance: rawRssCopy.provenance,
    });
    const events = growYearEvents([rawRssCopy, officialPrimary, officialSecondary, rawDifferentTrack]);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.title)).toEqual(expect.arrayContaining([
      officialPrimary.article.title,
      officialSecondary.article.title,
      rawDifferentTrack.article.title,
    ]));
  });

  it("normalizes a registered official HTTP link for stable identity", () => {
    const httpCopy = {
      ...officialPrimary,
      article: { ...officialPrimary.article, url: `http://www.nsfc.gov.cn/p1/3381/2824/99667.html?utm_source=rss` },
    };
    expect(growEventId(httpCopy)).toBe(growEventId(officialPrimary));
  });

  it("does not let forged official metadata take priority", () => {
    const plain = seed({
      id: 5,
      title: "[RSS] 未核验项目指南",
      url: "https://example.gov.cn/notice",
      provenance: { origin: "rss", sourceTier: "aggregator", verification: "unverified" },
    });
    const forged = seed({
      id: 6,
      title: "[2026年4月1日—4月20日] 未核验项目指南",
      url: plain.article.url!,
      provenance: { origin: "web_search", sourceTier: "official", verification: "verified" },
    });

    expect(growYearEvents([plain, forged]).map((event) => event.title)).toEqual([plain.article.title]);
  });
});
