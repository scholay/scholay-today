import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bundles = process.platform === "win32" ? "nsis" : process.platform === "darwin" ? "app" : "deb,appimage";
const result = spawnSync(process.execPath, [require.resolve("@tauri-apps/cli/tauri.js"), "build", "--bundles", bundles, "--ci", "--no-sign", "--", "--locked"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
