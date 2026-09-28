import { describe, expect, it } from "vitest";
import yearSeeds from "./yearSeeds.json";
import yearProgramSeeds from "./yearProgramSeeds.json";
import yearWindowSeeds from "./yearWindowSeeds.json";
import yearTalentSeeds from "./yearTalentSeeds.json";
import yearLocalSeeds from "./yearLocalSeeds.json";
import yearSocialSeeds from "./yearSocialSeeds.json";
import yearCampusSeeds from "./yearCampusSeeds.json";
import officialCampusSeeds from "./yearOfficialCampusSeeds.json";
import { officialSourceForUrl } from "./sourceRegistry";
import { attachOfficialBodyCache, officialBodyCacheEntries } from "./yearOfficialBodyCache";
import { growYearEvents, type GrowSeed } from "./yearGrow";
import { isYearOpening, yearOpenings } from "./yearOpenings";
import { yearOfficialSeeds } from "./yearOfficialSeedSets";

describe("official-search calendar seeds", () => {
  const seeds = yearOfficialSeeds;
  const events = growYearEvents(seeds);
  const legacy = [
    ...(yearProgramSeeds as GrowSeed[]),
    ...(yearWindowSeeds as GrowSeed[]),
    ...(yearTalentSeeds as GrowSeed[]),
    ...(yearLocalSeeds as GrowSeed[]),
    ...(yearSocialSeeds as GrowSeed[]),
    ...(yearCampusSeeds as GrowSeed[]),
    ...(yearSeeds as GrowSeed[]),
  ];

  it("keeps an expanding, official, reviewed seed set", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(137);
    expect(events).toHaveLength(seeds.length);
    expect(new Set(seeds.map((seed) => seed.article.id)).size).toBe(seeds.length);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.every((event) => (
      event.payload.provenance?.origin === "web_search"
      && event.payload.provenance.sourceTier === "official"
      && event.payload.provenance.verification === "verified"
      && officialSourceForUrl(event.payload.sourceUrl) != null
    ))).toBe(true);
  });

  it("makes verified one-off calls visible as current-year opportunities", () => {
    const openings = yearOpenings(events, 2026);
    expect(openings).toHaveLength(events.filter((event) => isYearOpening(event, 2026)).length);
    expect(openings.length).toBeGreaterThanOrEqual(40);
    expect(openings.some((event) => event.tags.includes("自然科学基金"))).toBe(true);
    expect(openings.some((event) => event.tags.includes("博士后项目"))).toBe(true);
    expect(openings.some((event) => event.tags.includes("国家科技项目"))).toBe(true);
    expect(openings.some((event) => event.tags.includes("人文社科基金"))).toBe(true);
    expect(openings.some((event) => event.tags.includes("教育部人文社科"))).toBe(true);
    expect(openings.some((event) => event.tags.includes("国际科研机会"))).toBe(true);
    expect(openings.every((event) => event.kind === "point" || event.end?.day != null)).toBe(true);
  });

  it("adds 985 campus notices as source-backed training nodes without turning them into opportunities", () => {
    const campus = events.filter((event) => event.tags.includes("培养节点"));
    const schools = new Set(campus.map((event) => event.payload.sourceName));

    expect((officialCampusSeeds as GrowSeed[]).length).toBeGreaterThanOrEqual(56);
    expect(campus.length).toBeGreaterThanOrEqual(56);
    expect(schools.size).toBeGreaterThanOrEqual(14);
    expect(campus.every((event) => event.payload.provenance?.sourceTier === "official")).toBe(true);
    expect(campus.some((event) => event.tags.includes("报到注册"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("毕业离校"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("开题"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("中期答辩"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("预答辩"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("外审"))).toBe(true);
    expect(campus.some((event) => event.tags.includes("答辩"))).toBe(true);
    expect(campus.find((event) => event.title.includes("湖南大学2024级秋季学期"))).toMatchObject({ kind: "point", payload: { meta: "开学节点" } });
    expect(campus.every((event) => !isYearOpening(event, event.start.year))).toBe(true);
  });

  it("keeps state-funded exchange talent tracks on both relevant rails", () => {
    const youthTeacher = events.find((event) => event.title.includes("青年骨干教师出国研修项目"));
    const artsTalent = events.find((event) => event.title.includes("艺术类人才培养特别项目第一批人员申报"));

    expect(youthTeacher?.tags).toEqual(expect.arrayContaining(["人才计划", "国际科研机会"]));
    expect(artsTalent?.tags).toEqual(expect.arrayContaining(["人才计划", "国际科研机会"]));
  });

  it("expands the talent rail with people-based postdoc and public-study tracks", () => {
    const talent = events.filter((event) => event.tags.includes("人才计划"));
    const overseasYouth = events.find((event) => event.title.includes("优秀青年科学基金项目（海外）"));
    const castDoctoral = events.find((event) => event.title.includes("2026年中国科协青年科技人才培育工程博士生专项计划推荐截止"));

    expect(talent.length).toBeGreaterThanOrEqual(20);
    expect(talent.some((event) => event.title.includes("博士后创新人才支持计划"))).toBe(true);
    expect(talent.some((event) => event.title.includes("国家建设高水平大学公派研究生项目"))).toBe(true);
    expect(overseasYouth?.payload).toMatchObject({
      summary: expect.stringContaining("海外"),
      body: expect.stringContaining("100—300万元"),
    });
    expect(castDoctoral?.payload.body).toContain("8200");
    expect(events.filter((event) => event.payload.body?.trim()).length).toBeGreaterThanOrEqual(25);
  });

  it("keeps source-backed bodies for the first expanded funding and talent batch", () => {
    const aiPlan = events.find((event) => event.title.includes("下一代人工智能方法重大研究计划"));
    const sdic = events.find((event) => event.title.includes("可持续发展国际合作科学计划（SDIC）"));
    const platform = events.find((event) => event.title.includes("国家重大科技平台国际开放合作基础研究专项"));
    const youthTeacher = events.find((event) => event.title.includes("青年骨干教师出国研修项目"));

    expect(aiPlan?.payload.body).toContain("300—500万元");
    expect(sdic?.payload.body).toContain("6月22日16时");
    expect(platform?.payload.body).toContain("中外双负责人制");
    expect(youthTeacher?.payload.body).toContain("9月30日前");
  });

  it("hydrates every priority official record from a reviewed body or the original-text cache", () => {
    const priorityLanes = new Set(["科研申报", "人才计划", "国际基金", "会议征稿"]);
    const priority = seeds.filter((seed) => priorityLanes.has(seed.lane));
    const staticSeeds = [...seeds, ...legacy];
    const hasSeedForCacheEntry = (articleId: number, sourceUrl: string) => staticSeeds.some((seed) => (
      seed.article.id === articleId && seed.article.url === sourceUrl
    ));

    expect(priority.length).toBeGreaterThanOrEqual(160);
    expect(priority.every((seed) => Boolean(seed.article.body?.trim()))).toBe(true);
    expect(officialBodyCacheEntries.length).toBeGreaterThanOrEqual(80);
    for (const entry of officialBodyCacheEntries) {
      expect(hasSeedForCacheEntry(entry.articleId, entry.sourceUrl)).toBe(true);
      expect(entry.body.trim().length).toBeGreaterThanOrEqual(180);
      expect(officialSourceForUrl(entry.sourceUrl)).not.toBeNull();
    }
  });

  it("attaches official-source originals to legacy RSS/search calendar records without changing their provenance", () => {
    const cachedLegacy = attachOfficialBodyCache(legacy);
    const nsfc2026 = cachedLegacy.find((seed) => seed.article.id === 910031 && seed.article.url?.includes("www.nsfc.gov.cn"));

    expect(nsfc2026?.article.body).toContain("国家自然科学基金");
    expect(nsfc2026?.article.body?.length).toBeGreaterThanOrEqual(180);
  });

  it("keeps separately dated annual editions instead of collapsing them by title", () => {
    const monographGrants = events.filter((event) => event.title.includes("中国博士后科学基金优秀学术专著出版资助申报"));

    expect(monographGrants.map((event) => event.start.year)).toEqual([2024, 2025, 2026]);
  });

  it("upgrades exact RSS copies without erasing distinct tracks from one official guide", () => {
    const merged = growYearEvents([...seeds, ...legacy]);
    const futureIndustrial = merged.filter((event) => event.title.includes("未来工业互联网基础理论与关键技术") && event.start.year === 2026);
    const postdocGuide = merged.filter((event) => event.payload.sourceUrl?.includes("af35dac8-8e29-417b-b050-f120c3808dd6"));

    // The static RSS copy has the same normalized title, so the reviewed event wins.
    expect(futureIndustrial).toHaveLength(1);
    expect(futureIndustrial[0]?.payload.provenance).toMatchObject({
      origin: "web_search",
      sourceTier: "official",
      verification: "verified",
    });
    // One postdoc guide explicitly contains two reviewed funding tracks and a
    // broader source notice; keeping all three avoids data loss by URL-only dedupe.
    expect(postdocGuide.map((event) => event.title)).toEqual(expect.arrayContaining([
      "[2026年3月1日-2026年3月31日] 中国博士后科学基金李政道研究所特别资助申报",
      "[2026年3月1日-2026年3月31日] 中国博士后科学基金联合资助（特别资助）申报",
      "[博士后基金] 关于发布《中国博士后科学基金资助指南（2026年度）》的通知",
    ]));
  });
});
