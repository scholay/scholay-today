/** Preview-only decoration, applied AFTER the shared allowlist sanitizer.
 * Never rewrites the stored Markdown, image URLs or captured evidence. */
export interface MarkdownHeading {
  id: string;
  text: string;
  level: number;
  depth: number;
  children: MarkdownHeading[];
}

export function isChineseParagraph(text: string): boolean {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return han >= 2 && han > latin * 0.4 && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

export function prepareMarkdownReading(sanitizedHtml: string, articleId: number) {
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
  const headings: MarkdownHeading[] = [];
  const outline: MarkdownHeading[] = [];
  const parents: MarkdownHeading[] = [];
  for (const el of doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (el.closest("blockquote,pre,table")) continue;
    const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) continue;
    const level = Number(el.tagName[1]);
    while (parents.length && parents[parents.length - 1].level >= level) parents.pop();
    const item: MarkdownHeading = {
      id: `md-${Number.isSafeInteger(articleId) ? articleId : 0}-heading-${headings.length + 1}`,
      text, level, depth: parents.length, children: [],
    };
    el.id = item.id;
    el.setAttribute("tabindex", "-1");
    el.classList.add("md-heading");
    // Models often start with ## instead of #. Give the first, top-level
    // heading a title treatment without changing its stored Markdown level.
    if (!headings.length) el.classList.add("md-document-title");
    (parents[parents.length - 1]?.children ?? outline).push(item);
    parents.push(item);
    headings.push(item);
  }

  for (const quote of doc.body.querySelectorAll("blockquote")) {
    const label = quote.querySelector("p > strong:first-child")?.textContent?.trim();
    if (label && /^(INFO|NOTE|TIP|WARNING|CAUTION|IMPORTANT)(?:\s|·|$)/.test(label)) {
      quote.classList.add("md-callout");
    }
  }
  for (const p of doc.body.querySelectorAll("p")) {
    if (p.closest("li,blockquote,td,th,pre")) continue;
    const text = p.textContent?.trim() ?? "";
    if (p.querySelector("img") || !text) continue;
    const previous = p.previousElementSibling;
    const caption = Boolean(previous?.querySelector("img") || previous?.tagName === "IMG")
      && /^(?:图|表|附图|附表|Figure\b|Fig\.|Table\b)\s*[\d一二三四五六七八九十]/i.test(text);
    const metadata = text.length <= 240 && (
      /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:日)?(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(text)
      || /^(?:来源|原文链接|链接地址|发布时间|发布于|作者|转载说明|版权声明|Source|Published|Author)\s*[:：]/i.test(text)
      || /^转载本文请联系原作者/.test(text)
      || /^本文(?:首发|转载|来源)于/.test(text)
      || (p.children.length === 1 && p.firstElementChild?.tagName === "A" && p.firstElementChild.textContent?.trim() === text)
    );
    if (caption) p.classList.add("md-caption");
    else if (metadata) p.classList.add("md-secondary");
    else if (isChineseParagraph(text)) p.classList.add("md-chinese-paragraph");
  }
  return { html: doc.body.innerHTML, headings, outline };
}

/** Last heading above the reading line; at the bottom include the last short
 * section even when it cannot scroll all the way to the top. */
export function activeMarkdownHeading(tops: number[], readingLine: number, atBottom: boolean): number {
  if (!tops.length) return -1;
  if (atBottom) return tops.length - 1;
  let current = 0;
  tops.forEach((top, index) => { if (top <= readingLine) current = index; });
  return current;
}
