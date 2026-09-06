// Build and stage the correct companion before Tauri resolves bundle resources.
// A failed build is fatal: never ship a placeholder or another OS's executable.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || "";
const args = ["build", "--release", "--locked", "-p", "scholay-mcp", ...(target ? ["--target", target] : [])];
const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const windows = target ? target.includes("windows") : process.platform === "win32";
const name = `scholay-mcp${windows ? ".exe" : ""}`;
const output = join(root, "target", "bundle-resources", "mcp");
mkdirSync(output, { recursive: true });
// Only known generated companions, not a recursive directory cleanup.
for (const old of readdirSync(output)) if (["scholay-mcp", "scholay-mcp.exe"].includes(old) && old !== name) unlinkSync(join(output, old));
copyFileSync(join(root, "target", target, "release", name), join(output, name));
console.log(`Staged MCP companion: ${name}`);
