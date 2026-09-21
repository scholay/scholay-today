import { useLayoutEffect, type RefObject } from "react";
import { useReadingGroups } from "./readingGroups";
import type { ReadingState } from "./readerTabs";

type ScrollField = "rssScroll" | "markdownScroll" | "markdownSourceScroll";
/** Read from the live store on mount: changing scope never resets a tab. */
export function useContentScroll(ref: RefObject<HTMLElement | null>, tabId: string | undefined, field: ScrollField, ready: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tabId || !ready) return;
    const saved = useReadingGroups.getState().tabs.find(t => t.id === tabId)?.reading[field] ?? 0;
    el.scrollTop = saved;
    const save = () => useReadingGroups.getState().update(tabId, { [field]: el.scrollTop } as Partial<ReadingState>);
    el.addEventListener("scroll", save, { passive: true });
    return () => { save(); el.removeEventListener("scroll", save); };
  }, [tabId, field, ready, ref]);
}
