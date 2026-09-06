// Keep the existing command compatible without restoring the retired RSS logo.
process.argv.push("--tray-only");
await import("./gen-branding.mjs");
