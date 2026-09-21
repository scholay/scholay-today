import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("embeds the Windows native GUI manifest in every smoke executable", () => {
  const build = readFileSync(new URL("../../src-tauri/build.rs", import.meta.url), "utf8");
  expect(build).toContain('CARGO_CFG_TARGET_OS');
  expect(build).toContain('CARGO_CFG_TARGET_ENV');
  expect(build).toContain('cargo:rustc-link-arg-examples=/MANIFEST:EMBED');
  expect(build).toContain('cargo:rustc-link-arg-examples=/MANIFESTINPUT:');
  // A feature gate previously left page-theme-smoke and reader-tabs-smoke
  // without Common Controls v6, failing before their first assertion ran.
  expect(build).not.toContain('CARGO_FEATURE_WINDOWS_SMOKE');
});

it("selects Common Controls v6 without requesting elevation", () => {
  const manifest = readFileSync(new URL("../../src-tauri/examples/windows-smoke.manifest", import.meta.url), "utf8");
  expect(manifest).toMatch(/name="Microsoft\.Windows\.Common-Controls" version="6\.0\.0\.0"/);
  expect(manifest).toContain('requestedExecutionLevel level="asInvoker" uiAccess="false"');
});
