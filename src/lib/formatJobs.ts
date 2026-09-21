import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import * as api from "../api";
import { errorText } from "./errors";
import { settleAiFormatJob, type AiFormatJob, type AiFormatLanguage, type AiFormatSource } from "./aiFormatted";

export const useFormatJobs = create<{ jobs: Record<number, AiFormatJob>; setJobs: (update: (jobs: Record<number, AiFormatJob>) => Record<number, AiFormatJob>) => void }>(set => ({ jobs: {}, setJobs: update => set(s => ({ jobs: update(s.jobs) })) }));
let sequence = 0;
export const nextFormatRun = () => ++sequence;
export function clearFormatJob(articleId: number, runId?: number) {
  useFormatJobs.getState().setJobs(jobs => {
    const run = runId ?? jobs[articleId]?.runId;
    return run === undefined ? jobs : settleAiFormatJob(jobs, articleId, run, null);
  });
}
export async function generateFormatted(qc: QueryClient, articleId: number, captureId: string, language: AiFormatLanguage, runId: number, source?: AiFormatSource) {
  const setJobs = useFormatJobs.getState().setJobs;
  setJobs(jobs => ({ ...jobs, [articleId]: { runId, phase: "formatting", captureId, error: null, source } }));
  try {
    const draft = await api.aiFormatPage(articleId, captureId, language);
    if (draft.articleId !== articleId || draft.captureId !== captureId) throw new Error("The formatted document does not match its source.");
    if (useFormatJobs.getState().jobs[articleId]?.runId !== runId) return;
    await qc.cancelQueries({ queryKey: ["ai-formatted", articleId], exact: true });
    qc.setQueryData(["ai-formatted", articleId], draft);
    clearFormatJob(articleId, runId);
  } catch (error) { setJobs(jobs => settleAiFormatJob(jobs, articleId, runId, errorText(error))); }
}
