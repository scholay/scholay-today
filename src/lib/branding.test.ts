import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Brand, { APP_NAME } from "../components/Brand";
import WorkspaceSwitcher from "../components/WorkspaceSwitcher";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

describe("scholay tody display branding with compatible local identity", () => {
  it("uses the exact requested spelling in the app bundle and document", () => {
    expect(APP_NAME).toBe("scholay tody");
    expect(config.productName).toBe(APP_NAME);
    expect(config.app.windows[0].title).toBe(APP_NAME);
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
  it("shows the supplied logo and name in both workspace choices", () => {
    const brand = renderToStaticMarkup(createElement(Brand));
    expect(brand).toContain('src="/scholay-logo.png"');
    expect(brand).toContain(APP_NAME);
    for (const workspace of ["rss", "hotboard"] as const) {
      const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { workspace, captureBusy: false, onChange: () => {} }));
      expect(html).toContain(APP_NAME);
      expect(html.match(/<button/g)).toHaveLength(2);
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    }
  });
  it("supports dark mode and does not crowd the immersive reader toolbar", () => {
    expect(read("src/styles.css")).toContain(':root[data-mode="dark"] .app-brand-logo { filter: invert(1); }');
    expect(read("src/workspace.css")).toContain('.reader-toolbar .workspace-brand { display: none; }');
  });
  it("renames native tray, notifications, and localized product copy", () => {
    expect(read("src-tauri/src/tray.rs")).toContain('.tooltip("scholay tody")');
    expect(read("src-tauri/src/notify.rs")).toContain('.title("scholay tody")');
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
});
