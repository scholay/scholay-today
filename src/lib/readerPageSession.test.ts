import { expect, it } from "vitest";
import { acceptReaderPageEvent, forgetReaderPage, readerPageRequest } from "./readerPageSession";
it("rejects late native events after retry, eviction/recreation and tab closure", () => {
  const viewId = "rss-session-test";
  const requestId = readerPageRequest(viewId);
  expect(readerPageRequest(viewId)).toBe(requestId);
  expect(acceptReaderPageEvent({ viewId, requestId, instance: 2 })).toBe(true);
  expect(acceptReaderPageEvent({ viewId, requestId, instance: 3 })).toBe(true);
  expect(acceptReaderPageEvent({ viewId, requestId, instance: 2 })).toBe(false);
  const retry = readerPageRequest(viewId, true);
  expect(acceptReaderPageEvent({ viewId, requestId, instance: 4 })).toBe(false);
  expect(acceptReaderPageEvent({ viewId, requestId: retry, instance: 4 })).toBe(true);
  forgetReaderPage(viewId);
  expect(acceptReaderPageEvent({ viewId, requestId: retry, instance: 4 })).toBe(false);
});
