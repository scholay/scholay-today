import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
const source = readFileSync(new URL("../../src-tauri/src/page_view.rs", import.meta.url), "utf8");
const script = source.split('const CAPTURE_SCRIPT: &str = r#"')[1].split('"#;')[0];
it.each(["data-original", "original"])("captures ScienceNet dates, captions and %s lazy images without chrome", (lazyAttribute) => {
  const dom = new JSDOM(`<title>生态研究 - 作者的博文</title><nav>999</nav><div class="vw mbm">
    <div class="h pbm"><h1 class="ph">生态研究</h1><p class="xg2"><span class="xg1">已有 166 次阅读</span><span class="xg1">2026-9-6 16:41</span></p></div>
    <div id="blog_article"><p>20 个群落，185 种植物，阈值 0.8。</p><p><img src="/grey.gif" ${lazyAttribute}="https://example.org/figure.png" alt="图2"></p><p>图2 叶脉性状。基金 32271611、2024YFF1306501。</p>
    <label>转载本文请联系原作者获取授权，同时请注明本文来自作者科学网博客。链接地址：</label><a href="/blog-3493355-1551238.html">原文</a><br>上一篇：2009-2020 年评估<img src="/sponsor.png"></div>
    <div>IP: 61.178.180.* 热度 0</div></div><aside>侧栏 120</aside><footer>2007-2026</footer>`, { url: "https://blog.sciencenet.cn/home.php?mod=space&uid=3493355&do=blog&id=1551238", runScripts: "outside-only" });
  dom.window.Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  const result = JSON.parse(dom.window.eval(script));
  expect(result.bodyFallback).toBe(false);
  expect(result.text).toContain("生态研究");
  expect(result.text).toContain("2026-9-6 16:41");
  expect(result.text).toContain("185 种植物，阈值 0.8");
  expect(result.text).toContain("2024YFF1306501");
  expect(result.text).toContain("转载本文请联系原作者");
  expect(result.text).not.toMatch(/侧栏|上一篇|166|IP:|999|2007/);
  expect(result.html).toContain('src="https://example.org/figure.png"');
  expect(result.html).not.toMatch(/grey.gif|sponsor.png/);
  expect(dom.window.document.querySelectorAll("img")).toHaveLength(2);
});
