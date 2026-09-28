import rawCache from "./yearOfficialBodyCache.json";
import type { GrowSeed } from "./yearGrow";

export interface OfficialBodyCacheEntry {
  articleId: number;
  sourceUrl: string;
  body: string;
  cachedAt: string;
  contentType: "text/html" | "application/pdf" | "application/zip";
  truncated?: boolean;
}

interface OfficialBodyCacheFile {
  version: number;
  generatedAt: string;
  entries: OfficialBodyCacheEntry[];
}

const cache = rawCache as OfficialBodyCacheFile;

function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cacheKey(articleId: number, sourceUrl: string | null | undefined): string | null {
  const canonical = canonicalUrl(sourceUrl);
  return canonical ? `${articleId}\u0000${canonical}` : null;
}

/**
 * The cache is deliberately a sidecar rather than a replacement for calendar
 * seed files: refreshing a source body cannot change a notice's date, tags or
 * provenance. This also lets a legacy RSS/search event retain its original
 * label while receiving text from an exact, already-reviewed official URL.
 */
export function attachOfficialBodyCache(seeds: readonly GrowSeed[]): GrowSeed[] {
  const entries = new Map(cache.entries.flatMap((entry) => {
    const key = cacheKey(entry.articleId, entry.sourceUrl);
    return key ? [[key, entry]] : [];
  }));
  return seeds.map((seed) => {
    if (seed.article.body?.trim()) return seed;
    const key = cacheKey(seed.article.id, seed.article.url);
    const entry = key ? entries.get(key) : undefined;
    if (!entry || !entry.body.trim()) return seed;
    return {
      ...seed,
      article: {
        ...seed.article,
        body: entry.body,
        bodyTruncated: entry.truncated || undefined,
      },
    };
  });
}

export const officialBodyCacheEntries = cache.entries;
