/** Native instances are retained, but only one content page can be visible.
 * RSS and workspace viewers share this queue for deterministic hide/open/close.
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
