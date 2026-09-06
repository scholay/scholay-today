import { describe, expect, it } from "vitest";
import { createPageViewQueue, nextPageViewRequestId } from "./pageViewQueue";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("application-wide native page queue", () => {
  it("serializes owners and returns each task's own value", async () => {
    const queue = createPageViewQueue();
    const log: string[] = [];
    const first = deferred<number>();
    const one = queue.enqueue(async () => { log.push("reader-open"); return first.promise; });
    const two = queue.enqueue(() => { log.push("reader-close"); return "closed"; });
    const three = queue.enqueue(() => { log.push("hot-open"); return true; });
    await Promise.resolve();
    expect(log).toEqual(["reader-open"]);
    first.resolve(12);
    expect(await Promise.all([one, two, three])).toEqual([12, "closed", true]);
    expect(log).toEqual(["reader-open", "reader-close", "hot-open"]);
  });

  it("returns rejection but recovers the shared tail for the replacement", async () => {
    const queue = createPageViewQueue();
    const failure = queue.enqueue(() => Promise.reject(new Error("native rejected")));
    const replacement = queue.enqueue(() => "new owner");
    await expect(failure).rejects.toThrow("native rejected");
    await expect(replacement).resolves.toBe("new owner");
  });

  it("also recovers from synchronous task failures", async () => {
    const queue = createPageViewQueue();
    const failure = queue.enqueue(() => { throw new Error("synchronous failure"); });
    await expect(failure).rejects.toThrow("synchronous failure");
    await expect(queue.enqueue(() => 2)).resolves.toBe(2);
  });

  it("lets an in-flight capture finish before old close and new open", async () => {
    const queue = createPageViewQueue();
    const capture = deferred<string>();
    const log: string[] = [];
    const result = queue.enqueue(async () => { log.push("capture-start"); const value = await capture.promise; log.push("capture-end"); return value; });
    const close = queue.enqueue(() => { log.push("reader-close"); });
    const open = queue.enqueue(() => { log.push("hot-open"); });
    await Promise.resolve();
    expect(log).toEqual(["capture-start"]);
    capture.resolve("capture-id");
    await Promise.all([result, close, open]);
    expect(log).toEqual(["capture-start", "capture-end", "reader-close", "hot-open"]);
  });

  it("never lets a late old-open cleanup close the next workspace", async () => {
    const queue = createPageViewQueue();
    const nativeOpen = deferred<void>();
    const log: string[] = [];
    let cancelled = false;
    const oldOpen = queue.enqueue(async () => {
      log.push("reader-open-start");
      await nativeOpen.promise;
      log.push("reader-open-finish");
      if (cancelled) log.push("reader-close-after-late-open");
    });
    await Promise.resolve();
    cancelled = true;
    const cleanup = queue.enqueue(() => { log.push("reader-cleanup-close"); });
    const nextOpen = queue.enqueue(() => { log.push("hot-open"); });
    nativeOpen.resolve();
    await Promise.all([oldOpen, cleanup, nextOpen]);
    expect(log).toEqual(["reader-open-start", "reader-open-finish", "reader-close-after-late-open", "reader-cleanup-close", "hot-open"]);
  });

  it("skips cancelled queued controls before handing ownership over", async () => {
    const queue = createPageViewQueue();
    const opening = deferred<void>();
    const log: string[] = [];
    let cancelled = false;
    const first = queue.enqueue(() => opening.promise);
    const control = queue.enqueue(() => { if (!cancelled) log.push("old-reload"); });
    cancelled = true;
    const cleanup = queue.enqueue(() => { log.push("old-close"); });
    const next = queue.enqueue(() => { log.push("new-open"); });
    opening.resolve();
    await Promise.all([first, control, cleanup, next]);
    expect(log).toEqual(["old-close", "new-open"]);
  });

  it("does not serialize model generation behind native view operations", async () => {
    const queue = createPageViewQueue();
    const model = deferred<string>();
    let modelFinished = false;
    const captured = await queue.enqueue(() => "captured");
    const generation = model.promise.then(() => { modelFinished = true; });
    expect(captured).toBe("captured");
    await queue.enqueue(() => "close");
    await expect(queue.enqueue(() => "hot-open")).resolves.toBe("hot-open");
    expect(modelFinished).toBe(false);
    model.resolve("saved draft");
    await generation;
  });

  it("gives RSS, Hot, retries, and remounts distinct request IDs", () => {
    const ids = Array.from({ length: 200 }, (_, index) => nextPageViewRequestId(index % 2 ? "reader" : "hot"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^hot-/);
    expect(ids[1]).toMatch(/^reader-/);
  });
});
