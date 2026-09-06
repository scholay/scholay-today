/** There is one native child webview for the entire application. RSS and Hot
 * must share this queue: an old owner's close must finish before the next open.
 * A rejected task is still returned to its caller, but never poisons the tail. */
export function createPageViewQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => T | Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

const pageViewQueue = createPageViewQueue();
export const enqueuePageView = pageViewQueue.enqueue;

let requestCounter = 0;
/** IDs are unique across both workspaces and every mount/retry in this load. */
export function nextPageViewRequestId(owner: "reader" | "hot"): string {
  return `${owner}-${Date.now().toString(36)}-${++requestCounter}`;
}
