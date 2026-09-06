// Package the supplied logo without redrawing it. Requires ImageMagick + pnpm.
// Run from the repository root: node scripts/gen-branding.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
// A monochrome template for macOS: preserve the logo's alpha silhouette.
run("magick", ["public/scholay-logo.png", "-resize", "36x36", "-gravity", "center", "-background", "none", "-extent", "44x44", "PNG32:src-tauri/icons/tray.png"]);
if (!process.argv.includes("--tray-only")) {
  // A paper tile keeps the original black mark legible against any Dock color.
  run("magick", ["-size", "1024x1024", "xc:none", "-fill", "#FBF9F3", "-draw", "roundrectangle 64,64 959,959 196,196", "(", "public/scholay-logo.png", "-resize", "640x640", ")", "-gravity", "center", "-compose", "over", "-composite", "PNG32:public/scholay-app-icon.png"]);
  run("pnpm", ["exec", "tauri", "icon", "public/scholay-app-icon.png", "--output", "src-tauri/icons"]);
}
