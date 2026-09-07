// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { batchScope, MAX_BATCH_ARTICLES, previewLabel, runBatchExport, uniqueArticles, useBatchExport } from "./batchExport";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = () => {}; } }));
vi.mock("../toast", () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock("./errors", () => ({ errorText: (e: unknown) => e instanceof Error ? e.message : String(e) }));
const articles = [{ id: 1, title: "一" }, { id: 2, title: "二" }];
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useBatchExport.setState({ scope:"",mode:false,selected:[],targets:[],open:false,running:false,result:null,error:"",progress:null,options:{includeImages:true,fetchMissing:false} });
});
describe("batch selection and background export", () => {
  it("deduplicates identity without mixing reading selection", () => {
    expect(uniqueArticles([...articles, articles[0]])).toEqual(articles);
    const s = useBatchExport.getState(); s.toggle(articles[0]); s.toggle(articles[1]);
    expect(useBatchExport.getState().selected).toEqual(articles);
    s.toggle(articles[0]); expect(useBatchExport.getState().selected).toEqual([articles[1]]);
  });
  it("bounds selection and resets only on scope change", () => {
    const s = useBatchExport.getState(); s.changeScope("feed1"); s.setMode(true);
    s.replaceSelection(Array.from({length:MAX_BATCH_ARTICLES+3}, (_,i)=>({id:i+1,title:String(i)})));
    s.toggle({id:999,title:"extra"}); expect(useBatchExport.getState().selected).toHaveLength(MAX_BATCH_ARTICLES);
    s.changeScope("feed1"); expect(useBatchExport.getState().mode).toBe(true);
    s.changeScope("feed2"); expect(useBatchExport.getState().selected).toEqual([]);
    expect(useBatchExport.getState().mode).toBe(false);
    expect(batchScope({kind:"feed",value:1}, false)).not.toBe(batchScope({kind:"feed",value:1}, true));
  });
  it("freezes reviewed IDs; query changes and closing UI cannot cancel export", async () => {
    let finish!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const s = useBatchExport.getState(); s.replaceSelection(articles); s.review();
    const task = runBatchExport({includeImages:true,fetchMissing:false});
    s.setOpen(false); s.changeScope("another feed");
    expect(useBatchExport.getState().running).toBe(true);
    expect(invoke).toHaveBeenCalledWith("export_article_bundles", expect.objectContaining({articleIds:[1,2],options:{includeImages:true,fetchMissing:false}}));
    await runBatchExport({includeImages:false,fetchMissing:true}); expect(invoke).toHaveBeenCalledTimes(1);
    finish({path:"bundle.zip",total:2,successful:2,retryIds:[],items:[]}); await task;
    expect(useBatchExport.getState().running).toBe(false);
    expect(useBatchExport.getState().result?.path).toBe("bundle.zip");
    expect(useBatchExport.getState().open).toBe(false);
  });
  it("only retries failed IDs and preserves original result on failed retry", async () => {
    const result = {path:"first.zip",total:2,successful:2,retryIds:[2],items:[]};
    useBatchExport.setState({targets:articles,result});
    vi.mocked(invoke).mockRejectedValue(new Error("offline"));
    await runBatchExport({includeImages:true,fetchMissing:false},true);
    expect(invoke).toHaveBeenCalledWith("export_article_bundles",expect.objectContaining({articleIds:[2]}));
    expect(useBatchExport.getState().result).toEqual(result);
    expect(useBatchExport.getState().error).toContain("offline");
  });
  it("labels RSS cache honestly instead of promising full text", () => {
    expect(previewLabel({articleId:1,error:null,needsFetch:true,images:2})).toBe("RSS 缓存 · 可能仅摘要 · 2 张图");
    expect(previewLabel({articleId:1,error:null,hasMarkdown:true})).toBe("Markdown 已缓存");
    expect(previewLabel({articleId:1,error:"缺失"})).toBe("缺失");
  });
});
