import { nextPageViewRequestId } from "./pageViewQueue";
// A mounted reader is temporary; a native page identity lives until its tab closes.
const sessions = new Map<string, { requestId: string; instance: number }>();
export function readerPageRequest(tabId: string, retry = false): string {
  if (!sessions.has(tabId) || retry) sessions.set(tabId, { requestId: nextPageViewRequestId("reader"), instance: 0 });
  return sessions.get(tabId)!.requestId;
}
/** Reject queued callbacks from closed, retried or evicted native instances. */
export function acceptReaderPageEvent(event: { viewId?: string; requestId: string; instance?: number }): boolean {
  const session = event.viewId && sessions.get(event.viewId);
  if (!session || session.requestId !== event.requestId || !Number.isSafeInteger(event.instance) || event.instance! < 1 || event.instance! < session.instance) return false;
  session.instance = event.instance!;
  return true;
}
export function forgetReaderPage(tabId: string) { sessions.delete(tabId); }
