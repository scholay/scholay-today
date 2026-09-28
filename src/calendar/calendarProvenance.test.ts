import { describe, expect, it } from "vitest";
import { calendarProvenance } from "./adapters";
import type { CalendarEvent } from "./types";

function event({
  sourceUrl,
  sourceName,
  body,
  provenance,
}: Pick<CalendarEvent["payload"], "sourceUrl" | "sourceName" | "body" | "provenance">): CalendarEvent {
  return {
    id: "year:test",
    title: "测试项目",
    tags: ["自然科学基金"],
    start: { year: 2026, month: 4, day: 1 },
    kind: "point",
    source: "year",
    precision: "day",
    approximate: false,
    payload: { sourceUrl, sourceName, body, provenance },
  };
}

describe("calendar provenance trust boundary", () => {
  it("downgrades an official claim when its evidence URL is not in the registry", () => {
    const resolved = calendarProvenance(event({
      sourceUrl: "https://example.gov.cn/notice",
      provenance: { origin: "web_search", sourceTier: "official", verification: "verified", reviewedAt: "2026-09-27" },
    }));

    expect(resolved).toMatchObject({ origin: "web_search", sourceTier: "unknown", verification: "needs_review" });
  });

  it("accepts a registered official page and does not infer community from notice text", () => {
    const official = calendarProvenance(event({
      sourceUrl: "https://www.nsfc.gov.cn/p1/3381/2824/99667.html",
      provenance: { origin: "web_search", sourceTier: "official", verification: "verified" },
    }));
    const textMention = calendarProvenance(event({
      sourceName: "RSS 通知",
      body: "请勿通过微信或知乎转发链接提交申请。",
    }));

    expect(official).toMatchObject({ sourceTier: "official", verification: "verified" });
    expect(textMention.sourceTier).toBe("unknown");
  });
});
