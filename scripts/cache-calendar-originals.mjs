#!/usr/bin/env node
/**
 * Build the local original-text cache for academic-calendar notices whose
 * source URL belongs to the reviewed official-source allowlist.
 *
 * The cache deliberately sits beside the reviewed event seeds: a crawl can
 * enrich article text but cannot silently edit an event's date, title, tags or
 * provenance. Reviewed records and legacy RSS/search records are both eligible
 * only when their URL belongs to a host already reviewed as official. HTML is
 * reduced to readable primary text and PDFs are converted
 * with the locally installed `pdftotext`; no remote extraction service is used.
 *
 * Examples:
 *   node scripts/cache-calendar-originals.mjs
 *   node scripts/cache-calendar-originals.mjs --limit 60
 *   node scripts/cache-calendar-originals.mjs --refresh --lanes 科研申报,人才计划,国际基金,会议征稿
 *   node scripts/cache-calendar-originals.mjs --refresh --ids 910031,16382
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CALENDAR_DIR = join(ROOT, "src", "calendar");
const CACHE_PATH = join(CALENDAR_DIR, "yearOfficialBodyCache.json");
const CACHE_VERSION = 2;
const DEFAULT_LANES = new Set(["科研申报", "人才计划", "国际基金", "会议征稿"]);
const MAX_BODY_CHARS = 48_000;
const CONCURRENCY = 4;

function parseArgs(argv) {
  const result = { limit: Number.POSITIVE_INFINITY, refresh: false, lanes: DEFAULT_LANES, ids: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--refresh") result.refresh = true;
    else if (value === "--limit") result.limit = Number(argv[++index] ?? 0);
    else if (value === "--lanes") result.lanes = new Set((argv[++index] ?? "").split(",").map((lane) => lane.trim()).filter(Boolean));
    else if (value === "--ids") {
      const ids = (argv[++index] ?? "").split(",").map((raw) => Number(raw.trim())).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) throw new Error("--ids 至少需要一个正整数 articleId");
      result.ids = new Set(ids);
    }
    else throw new Error(`未知参数：${value}`);
  }
  if ((result.limit !== Number.POSITIVE_INFINITY && !Number.isFinite(result.limit)) || result.limit < 1) throw new Error("--limit 必须是正整数");
  return result;
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cacheKey(articleId, sourceUrl) {
  return `${articleId}\u0000${sourceUrl}`;
}

async function readCalendarSeeds() {
  const names = (await readdir(CALENDAR_DIR)).filter((name) => /^year.*Seeds\.json$/.test(name));
  const rows = [];
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(CALENDAR_DIR, name), "utf8"));
    for (const seed of parsed) rows.push({ ...seed, _file: name });
  }
  const officialHosts = new Set(rows
    .filter((seed) => (
      seed._file.startsWith("yearOfficial")
      && seed.provenance?.sourceTier === "official"
      && seed.provenance?.verification === "verified"
    ))
    .map((seed) => {
      const url = canonicalUrl(seed.article?.url);
      return url ? new URL(url).hostname : null;
    })
    .filter(Boolean));
  return { rows, officialHosts };
}

function decodeEntities(value) {
  const named = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (named[key] != null) return named[key];
    if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16)) || whole;
    if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10)) || whole;
    return whole;
  });
}

function htmlToText(html) {
  return decodeEntities(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|button|input|select|textarea)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|footer|h[1-6]|li|tr|blockquote|pre|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line, index, lines) => line && line !== lines[index - 1])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodedHtml(bytes, contentType) {
  const headerCharset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  const declared = bytes.subarray(0, 8_000).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  const encoding = headerCharset || declared || "utf-8";
  let primary;
  try {
    primary = new TextDecoder(encoding).decode(bytes);
  } catch {
    primary = new TextDecoder("utf-8").decode(bytes);
  }
  // A few legacy official sites declare UTF-8 while serving GBK. Prefer the
  // legible GB18030 decoding only when UTF-8 demonstrably contains loss marks.
  if (!primary.includes("�")) return primary;
  const gb18030 = new TextDecoder("gb18030").decode(bytes);
  const score = (value) => (value.match(/[\u3400-\u9fffA-Za-z0-9]/g)?.length ?? 0) - (value.match(/�/g)?.length ?? 0) * 100;
  return score(gb18030) > score(primary) ? gb18030 : primary;
}

function captureElement(html, start) {
  const open = /<([a-z][\w:-]*)\b[^>]*>/i.exec(html.slice(start));
  if (!open) return null;
  const tag = open[1];
  const openEnd = start + open[0].length;
  const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    const closing = /^<\//.test(match[0]);
    const selfClosing = /\/$/.test(match[0]) || /^(br|hr|img|meta|link|input)$/i.test(tag);
    if (!closing && !selfClosing) depth += 1;
    if (closing) depth -= 1;
    if (depth === 0) return html.slice(start, tagPattern.lastIndex);
  }
  return html.slice(start, Math.min(html.length, openEnd + 200_000));
}

function chooseHtmlBody(html) {
  const candidates = [];
  const marker = /<(article|main|section|div)\b[^>]*(?:id|class)=["'][^"']*(?:article|content|detail|zoom|news|main|text|editor|TRS_Editor)[^"']*["'][^>]*>/gi;
  let match;
  while ((match = marker.exec(html))) {
    const fragment = captureElement(html, match.index);
    if (!fragment) continue;
    const text = htmlToText(fragment);
    if (text.length < 160) continue;
    const clue = /article|content|detail|zoom|TRS_Editor/i.test(match[0]) ? 1_000 : 0;
    candidates.push({ text, score: Math.min(text.length, MAX_BODY_CHARS) + clue });
  }
  const main = /<(article|main)\b[^>]*>/gi;
  while ((match = main.exec(html))) {
    const fragment = captureElement(html, match.index);
    if (!fragment) continue;
    const text = htmlToText(fragment);
    if (text.length >= 160) candidates.push({ text, score: Math.min(text.length, MAX_BODY_CHARS) + 500 });
  }
  if (!candidates.length) candidates.push({ text: htmlToText(html), score: 0 });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.text ?? "";
}

function compactOriginal(text) {
  const plain = text.replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (plain.length <= MAX_BODY_CHARS) return { body: plain, truncated: false };
  return { body: `${plain.slice(0, MAX_BODY_CHARS).trimEnd()}\n\n[正文缓存已截断，请打开原文阅读完整内容]`, truncated: true };
}

async function fetchPostdocArticleApi(url) {
  const page = new URL(url);
  if (page.hostname !== "www.chinapostdoctor.org.cn" || page.pathname !== "/article") return null;
  const infoId = page.searchParams.get("inid");
  const categoryId = page.searchParams.get("catid");
  if (!infoId || !categoryId) return null;
  const endpoint = new URL("/prod-api/system/info/findone", page.origin);
  endpoint.searchParams.set("infoid", infoId);
  endpoint.searchParams.set("categoryid", categoryId);
  const { stdout } = await execFileAsync("curl", [
    "--silent", "--show-error", "--location", "--fail", "--request", "POST",
    "--connect-timeout", "10", "--max-time", "40",
    "--user-agent", "Scholay Today Calendar Cache/1.0 (+local archival)",
    "--header", "Content-Type: application/json",
    endpoint.toString(),
  ], { maxBuffer: 8_000_000 });
  const detail = JSON.parse(stdout);
  const text = htmlToText(`<h1>${detail.infotitle ?? ""}</h1>${detail.infocontent ?? ""}`);
  const compact = compactOriginal(text);
  if (compact.body.length < 180) throw new Error("博士后官网接口未返回足够正文");
  return { status: "200", effectiveUrl: url, contentType: "text/html", ...compact };
}

async function textFromZip(payload, scratch, index) {
  // libarchive exposes non-UTF8 legacy filenames as usable JS strings, so we
  // can round-trip a member name without the CP932/GBK mismatch seen in unzip.
  const { stdout: listing } = await execFileAsync("bsdtar", ["-tf", payload], { maxBuffer: 1_000_000 });
  const candidates = listing
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => /\.(pdf|txt|html?)$/i.test(name))
    .sort((left, right) => {
      const score = (name) => Number(/(?:公募|募集|要項|通知|guideline|call|announcement)/i.test(name)) * 10 - Number(/別紙|appendix/i.test(name));
      return score(right) - score(left);
    })
    .slice(0, 3);
  if (!candidates.length) throw new Error("压缩包内没有可提取的 PDF、文本或 HTML 原文");

  const parts = [];
  for (const [fileIndex, name] of candidates.entries()) {
    const { stdout } = await execFileAsync("bsdtar", ["-xOf", payload, name], { encoding: "buffer", maxBuffer: 8_000_000 });
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (bytes.length === 0) continue;
    const nested = join(scratch, `${index}-${fileIndex}.source`);
    await writeFile(nested, bytes);
    const text = /\.pdf$/i.test(name)
      ? (await execFileAsync("pdftotext", ["-layout", nested, "-"], { maxBuffer: 8_000_000 })).stdout
      : /\.html?$/i.test(name)
        ? chooseHtmlBody(decodedHtml(bytes, "text/html"))
        : decodedHtml(bytes, "text/plain");
    if (text.trim().length >= 100) parts.push(`附件：${name}\n${text.trim()}`);
  }
  if (!parts.length) throw new Error("压缩包附件未提取到可读正文");
  return parts.join("\n\n");
}

async function fetchSource(url, scratch, index) {
  const postdocArticle = await fetchPostdocArticleApi(url);
  if (postdocArticle) return postdocArticle;
  const payload = join(scratch, `${index}.payload`);
  const { stdout } = await execFileAsync("curl", [
    "--silent", "--show-error", "--location", "--fail", "--retry", "1",
    "--connect-timeout", "10", "--max-time", "40",
    "--user-agent", "Scholay Today Calendar Cache/1.0 (+local archival)",
    "--output", payload,
    "--write-out", "%{http_code}\\n%{content_type}\\n%{url_effective}",
    url,
  ], { maxBuffer: 1_000_000 });
  const [status, contentType = "", effectiveUrl = url] = stdout.trim().split("\n");
  const bytes = await readFile(payload);
  const pdf = /application\/pdf/i.test(contentType) || bytes.subarray(0, 4).toString("ascii") === "%PDF";
  const zip = /application\/(?:zip|x-zip-compressed)/i.test(contentType) || bytes.subarray(0, 4).toString("ascii") === "PK\x03\x04";
  const text = zip
    ? await textFromZip(payload, scratch, index)
    : pdf
    ? (await execFileAsync("pdftotext", ["-layout", payload, "-"], { maxBuffer: 8_000_000 })).stdout
    : chooseHtmlBody(decodedHtml(bytes, contentType));
  const compact = compactOriginal(text);
  if (compact.body.length < 180 || /^(404|页面不存在|访问出错|网页无法访问)/i.test(compact.body)) {
    throw new Error("未提取到足够的正文");
  }
  return { status, effectiveUrl, contentType: zip ? "application/zip" : pdf ? "application/pdf" : "text/html", ...compact };
}

async function mapConcurrent(items, worker) {
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const args = parseArgs(process.argv.slice(2));
const scratch = await mkdtemp(join(tmpdir(), "scholay-calendar-cache-"));
try {
  const [{ rows: seeds, officialHosts }, oldCache] = await Promise.all([
    readCalendarSeeds(),
    readFile(CACHE_PATH, "utf8").then(JSON.parse),
  ]);
  if (![1, CACHE_VERSION].includes(oldCache.version)) {
    throw new Error(`不支持的正文缓存版本：${oldCache.version}`);
  }
  const saved = new Map((oldCache.entries ?? []).flatMap((entry) => {
    const sourceUrl = canonicalUrl(entry.sourceUrl);
    return sourceUrl && entry.articleId > 0 && entry.body?.trim()
      ? [[cacheKey(entry.articleId, sourceUrl), { ...entry, sourceUrl }]]
      : [];
  }));
  const groups = new Map();
  for (const seed of seeds) {
    const url = canonicalUrl(seed.article?.url);
    if (!url || seed.article?.body?.trim()) continue;
    if (!args.lanes.has(seed.lane)) continue;
    if (args.ids && !args.ids.has(seed.article.id)) continue;
    const isReviewedOfficial = seed.provenance?.sourceTier === "official" && seed.provenance?.verification === "verified";
    if (!isReviewedOfficial && !officialHosts.has(new URL(url).hostname)) continue;
    const prior = saved.get(cacheKey(seed.article.id, url));
    if (!args.refresh && prior?.sourceUrl === url && prior.body?.trim()) continue;
    const group = groups.get(url) ?? { url, seeds: [] };
    group.seeds.push(seed);
    groups.set(url, group);
  }
  const targets = [...groups.values()].slice(0, args.limit);
  console.log(`正文缓存候选：${targets.length} 个官网原文地址，覆盖 ${targets.reduce((sum, item) => sum + item.seeds.length, 0)} 条事件。`);
  const fetched = await mapConcurrent(targets, async (group, index) => {
    try {
      const source = await fetchSource(group.url, scratch, index);
      console.log(`✓ ${source.status} ${basename(new URL(source.effectiveUrl).pathname) || new URL(source.effectiveUrl).hostname} → ${group.seeds.length} 条`);
      return { group, source };
    } catch (error) {
      console.warn(`× ${group.url}：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });
  let added = 0;
  for (const result of fetched.filter(Boolean)) {
    for (const seed of result.group.seeds) {
      const sourceUrl = canonicalUrl(seed.article.url);
      saved.set(cacheKey(seed.article.id, sourceUrl), {
        articleId: seed.article.id,
        sourceUrl,
        body: result.source.body,
        cachedAt: new Date().toISOString(),
        contentType: result.source.contentType,
        ...(result.source.truncated ? { truncated: true } : {}),
      });
      added += 1;
    }
  }
  const validKeys = new Set(seeds.flatMap((seed) => {
    const sourceUrl = canonicalUrl(seed.article?.url);
    return sourceUrl ? [cacheKey(seed.article?.id, sourceUrl)] : [];
  }));
  const entries = [...saved.values()]
    .filter((entry) => validKeys.has(cacheKey(entry.articleId, entry.sourceUrl)))
    .sort((left, right) => left.articleId - right.articleId || left.sourceUrl.localeCompare(right.sourceUrl));
  await writeFile(CACHE_PATH, `${JSON.stringify({ version: CACHE_VERSION, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`);
  console.log(`已写入 ${added} 条正文缓存；缓存总计 ${entries.length} 条。`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
