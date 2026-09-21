// The old singleton-only browser assertions are now automated (and run in CI)
// in src/lib/readerWorkspaceInteraction.test.ts. Real native cache, generation,
// capture and keyboard checks live in the reader-tabs-smoke executable.
// Keep the former QA URL as an entry to the production-component tab preview.
import "./rss-tabs";

const result = document.getElementById("results");
if (result) result.textContent = "隔离界面预览（无真实数据）\n交互回归：pnpm exec vitest run src/lib/readerWorkspaceInteraction.test.ts\n原生验收：cargo run --locked -p papr --features reader-tabs-smoke --example reader-tabs-smoke";
