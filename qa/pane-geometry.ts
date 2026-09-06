type FrameApi = {
  runCase: (sidebar: number, list: number, surface: string) => { failures: string[] };
  runDrag: () => { failures: string[] };
  blockedIpc: string[];
};
const frame = document.getElementById("frame") as HTMLIFrameElement;
const getApi = () => (frame.contentWindow as unknown as { __PAPR_PANE_FRAME__?: FrameApi }).__PAPR_PANE_FRAME__;
const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
for (let attempt = 0; !getApi() && attempt < 300; attempt++) await waitFrame();
const api = getApi();
const failures: string[] = [];
let cases = 0;
if (!api) failures.push("Fixture frame did not become ready");
else {
  for (const width of [920, 1024, 1280, 1763, 2560]) {
    frame.style.width = `${width}px`;
    await waitFrame();
    for (const [sidebar, list] of [[248, 388], [420, 560], [200, 300], [420, 300], [200, 560]]) {
      for (const surface of ["reader", "web", "preview", "source", "capture"]) {
        const result = api.runCase(sidebar, list, surface);
        failures.push(...result.failures.map((message) => `${width}px/${sidebar}/${list}/${surface}: ${message}`));
        cases++;
      }
    }
  }
  frame.style.width = "920px";
  await waitFrame();
  failures.push(...api.runDrag().failures.map((message) => `clamped drag: ${message}`));
  cases++;
}
const result = { passed: failures.length === 0, cases, failures, blockedIpc: api?.blockedIpc ?? [] };
Object.assign(window, { __PAPR_PANE_GEOMETRY_QA__: result });
document.getElementById("results")!.textContent = JSON.stringify(result, null, 2);
document.title = `${result.passed ? "PASS" : "FAIL"} — ${cases} responsive DOM cases`;
document.documentElement.dataset.result = result.passed ? "pass" : "fail";
