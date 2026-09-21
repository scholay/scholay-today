import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
const { format } = vi.hoisted(() => ({ format: vi.fn() }));
vi.mock("../api", () => ({ aiFormatPage: format }));
vi.mock("./errors", () => ({ errorText: String }));
import { generateFormatted, nextFormatRun, useFormatJobs } from "./formatJobs";
import { useReaderTabs } from "./readerTabs";
beforeEach(() => { useFormatJobs.setState({ jobs: {} }); useReaderTabs.setState({ tabs: [], activeId: null, recent: [], closed: [], captureTabId: null }); format.mockReset(); });
it("finishes for the originating article after its tab has closed without reopening it", async () => {
  let resolve!: (value: unknown) => void;
  format.mockReturnValue(new Promise(r => { resolve = r; }));
  const qc = new QueryClient(); const s = useReaderTabs.getState(); s.open(1); const first = useReaderTabs.getState().activeId!;
  const work = generateFormatted(qc, 1, "capture-1", "zh", nextFormatRun());
  s.open(2); const second = useReaderTabs.getState().activeId; s.close([first]);
  const draft = { articleId: 1, captureId: "capture-1", markdown: "# Finished" };
  resolve(draft); await work;
  expect(qc.getQueryData(["ai-formatted", 1])).toEqual(draft);
  expect(qc.getQueryData(["ai-formatted", 2])).toBeUndefined();
  expect(useReaderTabs.getState().activeId).toBe(second); expect(useReaderTabs.getState().tabs).toHaveLength(1);
  expect(useFormatJobs.getState().jobs[1]).toBeUndefined();
});
it("keeps failure details after the reader unmounts and rejects mismatched responses", async () => {
  format.mockResolvedValue({ articleId: 9, captureId: "wrong" });
  const qc = new QueryClient(); await generateFormatted(qc, 1, "capture-1", "zh", nextFormatRun());
  expect(useFormatJobs.getState().jobs[1].phase).toBe("failed");
  expect(qc.getQueryData(["ai-formatted", 1])).toBeUndefined();
});
