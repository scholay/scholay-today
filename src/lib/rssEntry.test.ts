import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function frontendSources(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return frontendSources(path);
    return /\.(?:tsx?|css)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("mail-free RSS and hot board frontend", () => {
  it("keeps the RSS App mounted inside the original query cache and error boundary", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('import WorkspaceApp from "./WorkspaceApp"');
    expect(main).toMatch(/<ErrorBoundary>\s*<QueryClientProvider client=\{queryClient\}>\s*<WorkspaceApp \/>/);
    expect(read("src/WorkspaceApp.tsx")).toContain('<App active={workspace === "rss"}');
    expect(main).not.toMatch(/MailWorkspace/);
    // An old workspace preference may remain on disk, but no migration should
    // erase it or any unrelated reader settings just to restore this entry.
    expect(main).not.toMatch(/localStorage\.(?:clear|removeItem)/);
  });

  it("does not retain the removed mail UI, workspace chrome or synthetic preview", () => {
    for (const path of [
      "src/mail/MailWorkspace.tsx", "src/mail/api.ts", "src/mail/types.ts",
      "src/mail/helpers.ts", "src/mail/mail.css", "src/mail/api.test.ts",
      "src/mail/helpers.test.ts", "src/mail/appearance.test.ts",
      "qa/private-mail-preview.tsx", "qa/private-mail-preview.html",
    ]) expect(existsSync(new URL(path, root)), path).toBe(false);
    expect(read("vitest.config.ts")).not.toContain("src/mail/");
  });

  it("has no production imports, events or IPC calls to the removed personal mailbox", () => {
    const integration = /MailWorkspace|personal_mail_|papr-open-personal-mail|private-mail-preview/;
    const remaining = frontendSources(new URL("src/", root))
      .filter((path) => integration.test(readFileSync(path, "utf8")))
      .map((path) => path.pathname);
    expect(remaining).toEqual([]);
  });

  it("keeps RSS discovery/subscription without restoring a newsletter form or mail handoff", () => {
    const dialog = read("src/components/AddFeedDialog.tsx");
    expect(dialog).toContain("api.addFeed(target, folderId)");
    expect(dialog).toContain("api.searchFeedDirectory");
    expect(dialog).not.toMatch(/Newsletter|newsletter|personal-mail|workspace-rss-notice|前往个人邮箱/);
    expect(read("src/api.ts")).not.toMatch(/addNewsletterSource|listNewsletterSources|removeNewsletterSource|add_newsletter_source|list_newsletter_sources|remove_newsletter_source/);
  });

  it("preserves legacy feed types and the RSS theme implementation", () => {
    const types = read("src/types.ts");
    expect(types).toMatch(/export type SourceType\s*=[^;]*"newsletter"/);
    expect(types).not.toMatch(/interface Newsletter(?:Input|Source)/);
    expect(read("src/App.tsx")).toContain("applyThemeAccent(root.style, palette, effectiveMode)");
    expect(existsSync(new URL("src/lib/appearance.ts", root))).toBe(true);
  });
});
