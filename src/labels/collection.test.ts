import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { credentialText, LABEL_SOURCES, parseLabelCache } from "./helpers";

const script=readFileSync(new URL("../../src-tauri/src/label_extract.js",import.meta.url),"utf8");
function extract(id: string, body: string, override?: string) {
  const source=LABEL_SOURCES.find(item=>item.id===id)!;
  const dom=new JSDOM(body,{url:override??source.url,runScripts:"outside-only"});
  dom.window.HTMLElement.prototype.getClientRects=function(){return (this.hasAttribute("hidden")?[]:[{}]) as unknown as DOMRectList;};
  const result=JSON.parse(dom.window.eval(script.replace("__LABEL_EXTRACT_OPTIONS__",JSON.stringify({id,hosts:source.hosts}))));
  dom.window.close(); return result;
}
const dy=(kind: string, term: string)=>`<section><div><div>${kind}</div></div><div class="byted-table-row"><div class="byted-table-cell-body"></div><div class="byted-table-cell-body"><a href="/creator-micro/creator-count/arithmetic-index/hot?topic_name=topic">${term}</a></div><div class="byted-table-cell-body">1209.8万</div><div class="byted-table-cell-body"></div></div></section>`;
const zh=(kind: string)=>`<section><div><svg></svg>${kind}</div><div><div>1</div><div>如何看待学术发展？</div></div></section>`;
describe("uniform labels pipeline",()=>{
  it("extracts Douyin kinds and hotspot index without account/sidebar/form data",()=>{
    const result=extract("douyin",'<nav>私信 PRIVATE</nav><input type="password" value="SECRET">'+dy("抖音实时热点","知识话题")+dy("抖音飙升热点","研究话题"));
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({term:"知识话题",metric:"1209.8万",rank:1,kind:"抖音实时热点",metricLabel:"热点指数"});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET/);
  });
  it("keeps Zhihu rank but never invents traffic numbers",()=>{
    const result=extract("zhihu",'<header>private account</header><main>'+zh("知乎热题")+zh("全网热点")+'</main>');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row:{metric:string})=>row.metric==="")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private account");
  });
  it("rejects unverified domains, paths, platform home decoration and mixed tables",()=>{
    expect(extract("douyin",dy("抖音实时热点","topic"),"https://creator.douyin.com/private").rows).toEqual([]);
    expect(extract("zhihu",'<main>'+zh("知乎热题")+'</main>',"https://www.zhihu.com.evil.org/organization/search-question/init").rows).toEqual([]);
    expect(extract("kuaishou",'<div class="ks-index-home-bg__tag"><span>话题</span>示例词</div>').rows).toEqual([]);
    expect(extract("douyin",'<div>抖音实时热点</div><div>抖音飙升热点</div><div class="byted-table-row"></div>').rows).toEqual([]);
  });
  it("migrates safe cached data for all adapters, dropping extra fields at every level",()=>{
    const snapshot={...extract("zhihu",'<main>'+zh("知乎热题")+'</main>'),capturedAt:new Date().toISOString(),cookie:"SECRET"};
    snapshot.rows[0].token="SECRET";
    const parsed=parseLabelCache(JSON.stringify({zhihu:snapshot}));
    expect(parsed.zhihu.rows).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|token|cookie|auth/);
    expect(credentialText({configured:true,count:3,savedAt:1,expired:false,persistent:true})).not.toContain("已登录");
  });
  it("keeps login explicit, secrets native, and background windows separate from the reader",()=>{
    const collector=readFileSync(new URL("../../src-tauri/src/label_collector.rs",import.meta.url),"utf8");
    expect(collector).toContain('.visible(false)');
    expect(collector).toContain('NewWindowResponse::Deny');
    expect(collector).toContain('GENERATION');
    expect(collector).not.toContain('get_webview("page-view")');
    const native=readFileSync(new URL("../../src-tauri/src/lib.rs",import.meta.url),"utf8");
    expect(native).toContain('.with_filter(|label| !label.starts_with("label-collector-"))');
    expect(script).not.toMatch(/\.click\(|document\.cookie|localStorage|fetch\(|XMLHttpRequest/);
    const auth=readFileSync(new URL("./LabelAuthorization.tsx",import.meta.url),"utf8");
    expect(auth).not.toContain('localStorage.setItem');
    expect(auth).toContain('save_label_browser_credentials');
    expect(auth).toContain('import_label_cookie');
  });
});
