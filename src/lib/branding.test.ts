import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Brand, { APP_NAME, APP_SHORT_NAME, APP_VERSION, BRAND_WORDMARK } from "../components/Brand";
import WorkspaceSwitcher from "../components/WorkspaceSwitcher";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

describe("scholay today display branding with compatible local identity", () => {
  it("uses the exact requested spelling in the app bundle and document", () => {
    expect(APP_NAME).toBe("scholay today");
    expect(APP_SHORT_NAME).toBe("TODAY");
    expect(APP_VERSION).toBe(config.version);
    expect(read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1]).toBe(config.version);
    expect(config.productName).toBe(APP_NAME);
    expect(config.app.windows[0].title).toBe(APP_NAME);
    expect(JSON.parse(read("src-tauri/tauri.windows.conf.json")).app.windows[0].title).toBe(APP_NAME);
    expect(read("index.html")).toContain(`<title>${APP_NAME}</title>`);
    expect(read("index.html")).not.toContain("Papr");
  });
  it("keeps existing databases, binary, deep links and workspace memory", () => {
    expect(config.identifier).toBe("com.thomas.papr");
    expect(config.mainBinaryName).toBe("papr-desktop");
    expect(config.plugins["deep-link"].desktop.schemes).toContain("papr");
    expect(read("src-tauri/src/lib.rs")).toContain('data_dir.join("papr.db")');
    expect(read("src/WorkspaceApp.tsx")).toContain('"papr.workspace.v2"');
    expect(read("src/hot/helpers.ts")).toContain('"papr.hotboard.ui.v1"');
  });
  it("shows the small logo and exact product name beside the activity rail in all workspaces", () => {
    const brand = renderToStaticMarkup(createElement(Brand));
    expect(brand).toContain('src="/scholay-logo.png"');
    expect(BRAND_WORDMARK).toBe("SCHOLAY");
    expect(brand).toContain(`aria-label="${APP_NAME}"`);
    expect(brand).toContain(`<span class="app-brand-name">${BRAND_WORDMARK}</span>`);
    expect(brand).not.toContain(`>${APP_NAME}<`);
    for (const workspace of ["rss", "hot", "year"] as const) {
      const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace, captureBusy: false, onChange: () => {} }));
      expect(html).not.toContain(`aria-label="${APP_NAME}"`);
      expect(html).not.toContain(`>${BRAND_WORDMARK}</span>`);
      expect(html).toContain('src="/scholay-logo.png"');
      expect(html).not.toContain(`<span>${APP_SHORT_NAME}</span>`);
      expect(html.match(/<button/g)).toHaveLength(6);
      expect(html).toContain("workspace-rail-settings");
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(5);
    }
  });
  it("uses a small title-strip icon without changing other brand placements", () => {
    expect(read("src/styles.css")).toMatch(/\.app-brand\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/);
    expect(read("src/workspace.css")).toMatch(/\.workspace-title-brand > svg\s*\{[^}]*flex-shrink:\s*0;/);
  });
  it("uses the corrected MCP identity while preserving executable and local transport", () => {
    expect(read("src-tauri/src/library_service.rs")).toContain('"mcpServers":{"scholay-today":');
    expect(read("src-tauri/src/library_service.rs")).toContain('"mcp/scholay-mcp"');
    expect(read("crates/scholay-mcp/src/main.rs")).toContain('Implementation::new("scholay-today",');
    expect(read("crates/scholay-local-ipc/src/lib.rs")).toContain("scholay-tody-");
    expect(read("src-tauri/src/windows_credentials.rs")).toContain('"scholay-tody".encode_utf16()');
    expect(read("src-tauri/src/article_document.rs")).toContain("tags: [scholay-today]");
    for (const path of ["src-tauri/src/article_export.rs", "src-tauri/src/batch_export.rs"]) {
      expect(read(path)).toContain('"product":"scholay today"');
      expect(read(path)).toContain('.join("scholay today")');
    }
  });
  it("supports dark mode and keeps the product name out of the immersive reader toolbar", () => {
    expect(read("src/styles.css")).toContain(':root[data-mode="dark"] .app-brand-logo { filter: invert(1); }');
    expect(read("src/components/Reader.tsx")).not.toContain("workspaceSwitch");
    expect(read("src/workspace.css")).not.toContain("workspace-sidebar-toggle");
  });
  it("renames native tray, notifications, and localized product copy", () => {
    expect(read("src-tauri/src/tray.rs")).toContain('.tooltip("scholay today")');
    expect(read("src-tauri/src/notify.rs")).toContain('.title("scholay today")');
    for (const lang of ["en", "zh", "ja"]) {
      expect(read(`src/locales/${lang}.json`)).not.toContain("Papr");
      expect(read(`src/locales/${lang}.json`)).toContain(APP_NAME);
    }
  });
  it("retains upstream attribution and bundles the original license", () => {
    expect(read("src/components/SettingsDialog.tsx")).toContain("Based on Papr · MIT License");
    expect(config.bundle.resources["../LICENSE"]).toBe("LICENSE");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 l0ng-ai");
  });
  it("keeps repository, app bundle and CI artifact branding aligned", () => {
    const readme = read("README.md");
    const ci = read(".github/workflows/ci.yml");
    expect(readme).toContain("# scholay-today");
    expect(readme).toContain("https://github.com/scholay/scholay-today/actions/workflows/ci.yml");
    expect(readme).not.toContain("github.com/scholay/scholay-tody");
    expect(ci).toContain("name: scholay-today-${{ runner.os }}-${{ github.sha }}");
    expect(ci).toContain("artifacts/scholay-today-macos.zip");
    expect(ci).toContain("target/release/bundle/macos/scholay today.app");
    expect(read("docs/windows.md")).toContain("scholay-today-Windows-<commit>");
    expect(config.identifier).toBe("com.thomas.papr");
  });
});
