import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateArticlePreview } from "../api";
import { listTranslationKey, useListTranslation } from "../listTranslation";
import { reportError } from "../toast";
import type { ArticlePreviewTranslation, ArticleSummary } from "../types";

vi.mock("../api", () => ({ translateArticlePreview: vi.fn() }));
vi.mock("../toast", () => ({ reportError: vi.fn() }));
vi.mock("./errors", () => ({ errorText: (error: unknown) => String(error) }));

const article = (id: number): ArticleSummary => ({
  id, feedId: 1, feedTitle: "Synthetic feed", sourceType: "rss",
  title: `Source ${id}`, snippet: `Snippet ${id}`, author: null,
  imageUrl: null, url: null, publishedAt: null,
  isRead: false, isStarred: false, readLater: false,
});

const jobs = () => useListTranslation.getState().jobs;
const key = (id: number) => listTranslationKey(id, "zh", "llm");
const setActive = (active: boolean) => useListTranslation.getState().setForegroundActive(active);
const enqueue = (...ids: number[]) => useListTranslation.getState().enqueueVisible(ids.map(article), "zh", "llm");
const requests: Array<{
  resolve: () => void;
  reject: (reason: string) => void;
}> = [];

// Drain the API promise's then/catch/finally chain without timers or network.
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };

beforeEach(() => {
  useListTranslation.setState({ jobs: {}, foregroundActive: false });
  requests.length = 0;
  vi.clearAllMocks();
  vi.mocked(translateArticlePreview).mockImplementation((articleId, lang, engine) =>
    new Promise<ArticlePreviewTranslation>((resolve, reject) => {
      requests.push({
        resolve: () => resolve({ articleId, lang, engine, title: `Translated ${articleId}`, snippet: `Translated snippet ${articleId}` }),
        reject,
      });
    }),
  );
});

afterEach(async () => {
  setActive(false);
  for (const request of requests) request.resolve();
  await settle();
  useListTranslation.setState({ jobs: {}, foregroundActive: false });
});

describe("RSS foreground list translation dispatch", () => {
  it("starts paused and retains queued jobs without dispatching", () => {
    expect(useListTranslation.getState().foregroundActive).toBe(false);
    enqueue(1, 2);
    expect(translateArticlePreview).not.toHaveBeenCalled();
    expect(Object.values(jobs()).map((job) => job.status)).toEqual(["queued", "queued"]);
    setActive(true);
    expect(translateArticlePreview).toHaveBeenCalledTimes(2);
  });

  it("keeps in-flight successes and failures while hidden, then resumes only queued work", async () => {
    setActive(true);
    enqueue(1, 2, 3, 4, 5);
    expect(translateArticlePreview).toHaveBeenCalledTimes(3);
    setActive(false);
    requests[0].resolve();
    requests[1].reject("Synthetic translation failure");
    requests[2].resolve();
    await settle();

    expect(translateArticlePreview).toHaveBeenCalledTimes(3);
    expect(jobs()[key(1)]).toMatchObject({ status: "done", title: "Translated 1" });
    expect(jobs()[key(2)]).toMatchObject({ status: "error", error: "Synthetic translation failure" });
    expect(jobs()[key(3)]).toMatchObject({ status: "done", title: "Translated 3" });
    expect(jobs()[key(4)].status).toBe("queued");
    expect(jobs()[key(5)].status).toBe("queued");
    expect(reportError).toHaveBeenCalledOnce();

    setActive(true);
    expect(vi.mocked(translateArticlePreview).mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
    requests[3].resolve();
    requests[4].resolve();
    await settle();
    expect(jobs()[key(1)].title).toBe("Translated 1");
    expect(jobs()[key(2)].status).toBe("error");
    expect(jobs()[key(4)].status).toBe("done");
    expect(jobs()[key(5)].status).toBe("done");
  });

  it("blocks the next dispatch when paused before a resolved request's finally runs", async () => {
    setActive(true);
    enqueue(1, 2, 3, 4);
    requests[0].resolve();
    setActive(false);
    await settle();
    expect(jobs()[key(1)].status).toBe("done");
    expect(jobs()[key(4)].status).toBe("queued");
    expect(translateArticlePreview).toHaveBeenCalledTimes(3);
  });

  it("does not duplicate in-flight jobs or exceed concurrency during setup/cleanup/setup", async () => {
    enqueue(1, 2, 3, 4, 5);
    setActive(true);
    setActive(false);
    setActive(true);
    setActive(true);
    expect(translateArticlePreview).toHaveBeenCalledTimes(3);
    expect(Object.values(jobs()).filter((job) => job.status === "translating")).toHaveLength(3);
    requests[0].resolve();
    await settle();
    expect(vi.mocked(translateArticlePreview).mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4]);
    expect(Object.values(jobs()).filter((job) => job.status === "translating")).toHaveLength(3);
  });

  it("retains jobs queued during a pause and does not redo completed unchanged previews", async () => {
    setActive(true);
    enqueue(1);
    requests[0].resolve();
    await settle();
    setActive(false);
    enqueue(1, 2, 3);
    expect(translateArticlePreview).toHaveBeenCalledTimes(1);
    expect(jobs()[key(1)].status).toBe("done");
    setActive(true);
    expect(vi.mocked(translateArticlePreview).mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
  });
});
