import { useEffect, useRef, useState } from "react";
import { readLabelEditions } from "./history";
import type { LabelEdition } from "./editions";

interface State { sourceId: string; editions: LabelEdition[]; hasMore: boolean; loading: boolean; loadingMore: boolean; error: string }
const empty = (sourceId: string): State => ({ sourceId, editions: [], hasMore: false, loading: true, loadingMore: false, error: "" });
export function useLabelEditions(sourceId: string, active: boolean, ready: boolean, revision: number) {
  const [state, setState] = useState(() => empty(sourceId));
  const owner = useRef(0), moreRequest = useRef<number | null>(null);
  const visible = state.sourceId === sourceId ? state : empty(sourceId);
  useEffect(() => {
    const generation = ++owner.current;
    moreRequest.current = null;
    if (!active || !ready) return;
    setState(old => ({ ...(old.sourceId === sourceId ? old : empty(sourceId)), loading: true, loadingMore: false, error: "" }));
    void readLabelEditions(sourceId).then(page => {
      if (owner.current !== generation) return;
      setState(old => {
        const older = old.sourceId === sourceId && page.editions.length ? old.editions.filter(item => item.start < page.editions.at(-1)!.start) : [];
        return { sourceId, editions: [...page.editions, ...older], hasMore: older.length ? old.hasMore : page.hasMore, loading: false, loadingMore: false, error: "" };
      });
    }).catch(() => {
      if (owner.current === generation) setState(old => ({ ...old, loading: false, loadingMore: false, error: "历史暂不可用，已保留最近缓存；请重试同步。" }));
    });
    return () => { if (owner.current === generation) owner.current++; };
  }, [sourceId, active, ready, revision]);
  const loadMore = async () => {
    if (!active || !ready || visible.loading || !visible.hasMore || moreRequest.current !== null) return;
    const generation = owner.current, before = visible.editions.at(-1)?.start;
    if (before === undefined) return;
    moreRequest.current = generation;
    setState(old => ({ ...old, loadingMore: true, error: "" }));
    try {
      const page = await readLabelEditions(sourceId, before);
      if (owner.current === generation) setState(old => ({ ...old, editions: [...old.editions, ...page.editions.filter(item => !old.editions.some(previous => previous.start === item.start))], hasMore: page.hasMore, loadingMore: false }));
    } catch { if (owner.current === generation) setState(old => ({ ...old, loadingMore: false, error: "更早的记录读取失败，请重试。" })); }
    finally { if (moreRequest.current === generation) moreRequest.current = null; }
  };
  return { ...visible, loadMore };
}
