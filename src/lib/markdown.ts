// Render markdown produced by the AI features (summaries, Q&A, digests).
//
// The text is LLM output, but the LLM summarizes attacker-influenced feed
// content, so its markdown can carry raw HTML. `marked` does not sanitize,
// and the result is injected via dangerouslySetInnerHTML inside a Tauri
// webview — so every render is passed through an allowlist sanitizer first.

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

// Elements removed wholesale, including their text content.
const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "noscript",
  "template", "link", "meta", "form", "input", "button", "svg",
]);

// Elements kept as-is. Anything else is unwrapped to its children.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div", "blockquote", "pre", "code",
  "strong", "em", "b", "i", "u", "s", "del", "mark", "sub", "sup",
  "ul", "ol", "li", "a",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
]);

// Per-tag attribute allowlist. Everything not listed (incl. on* handlers,
// style, srcset) is stripped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

const SAFE_HREF = /^(https?:|mailto:)/i;

export function capturedImageSources(markdown: string): Set<string> {
  const sources = new Set<string>();
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === "image") {
      try {
        const url = new URL(token.href);
        if (/^https?:$/.test(url.protocol) && !url.username && !url.password) sources.add(token.href);
      } catch { /* Invalid or relative image references are not remote assets. */ }
    }
  });
  return sources;
}

function sanitizeElement(el: Element, imageSources?: ReadonlySet<string>) {
  // Depth-first: process children before the element may be unwrapped.
  for (const child of Array.from(el.children)) sanitizeElement(child, imageSources);

  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") ?? "";
    if (!imageSources?.has(src)) { el.remove(); return; }
    for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
    // Do not initiate an unvalidated webview/mixed-content request. The native
    // captured-asset fetcher verifies ownership, DNS, redirects and image bytes.
    el.setAttribute("data-captured-src", src);
    el.setAttribute("alt", alt);
    el.setAttribute("decoding", "async");
    return;
  }

  if (DROP_TAGS.has(tag)) {
    el.remove();
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    el.replaceWith(...Array.from(el.childNodes)); // unwrap, keep contents
    return;
  }

  const allowed = ALLOWED_ATTRS[tag];
  for (const attr of Array.from(el.attributes)) {
    if (!allowed || !allowed.has(attr.name.toLowerCase())) {
      el.removeAttribute(attr.name);
    }
  }
  if (tag === "a") {
    const href = (el.getAttribute("href") ?? "").trim();
    if (SAFE_HREF.test(href)) {
      el.setAttribute("rel", "noopener noreferrer nofollow");
    } else {
      el.removeAttribute("href");
    }
  }
}

export function renderMarkdown(text: string, imageSources?: ReadonlySet<string>): string {
  const raw = marked.parse(text, { async: false });
  // DOMParser documents are inert — nothing here executes.
  const doc = new DOMParser().parseFromString(raw, "text/html");
  for (const child of Array.from(doc.body.children)) sanitizeElement(child, imageSources);
  return doc.body.innerHTML;
}
