import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Folder, StructuredListItem } from "../types";
import { cleanedCountForFolder, docsInScope, matchesLibraryQuery, populatedFolders } from "./helpers";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const folders: Folder[] = [
  { id: 1, name: "Root", position: 0, parentId: null },
  { id: 2, name: "Child", position: 0, parentId: 1 },
];
const docs: StructuredListItem[] = [
  { articleId: 1, feedId: 1, feedTitle: "A", folderId: 1, folderName: "Root", title: "清洗甲", url: null, publishedAt: null, cleanedAt: "2026-09-01", sourceKind: "web", blocks: 1, words: 10, images: 0, staleSchema: false },
  { articleId: 2, feedId: 2, feedTitle: "B", folderId: 2, folderName: "Child", title: "清洗乙", url: null, publishedAt: null, cleanedAt: "2026-09-02", sourceKind: "web", blocks: 1, words: 10, images: 0, staleSchema: false },
  { articleId: 3, feedId: 3, feedTitle: "C", folderId: null, folderName: null, title: "未分类稿", url: null, publishedAt: null, cleanedAt: "2026-09-03", sourceKind: "web", blocks: 1, words: 10, images: 0, staleSchema: false },
];

describe("cleaned library scopes", () => {
  it("walks nested folders and leaves unfiled documents in their own bucket", () => {
    expect(docsInScope(docs, folders, "all")).toHaveLength(3);
    expect(docsInScope(docs, folders, "unfiled").map((doc) => doc.articleId)).toEqual([3]);
    expect(docsInScope(docs, folders, 2).map((doc) => doc.articleId)).toEqual([2]);
    expect(cleanedCountForFolder(docs, folders, 1)).toBe(2);
    expect(matchesLibraryQuery(docs[0], "甲")).toBe(true);
    expect(matchesLibraryQuery(docs[0], "zzz")).toBe(false);
  });
  it("only exposes nonempty branches, including ancestors of populated children", () => {
    const tree = [...folders, { id: 3, name: "Empty", position: 1, parentId: 1 }];
    expect(populatedFolders([docs[1]], tree).map(f => f.id)).toEqual([1, 2]);
    expect(populatedFolders([], tree)).toEqual([]);
    expect(populatedFolders([docs[2]], tree)).toEqual([]);
    expect(docsInScope(docs, tree, "examples")).toEqual([]);
  });
});

describe("files workspace", () => {
  it("retires the separate library workspace in favor of RSS Agented", () => {
    const shell = read("WorkspaceApp.tsx");
    const switcher = read("components/WorkspaceSwitcher.tsx");
    expect(switcher).not.toContain('value: "home"');
    expect(switcher).not.toContain('value: "files"');
    expect(switcher).toContain('value: "rss"');
    expect(switcher).toContain('icon: "logo"');
    expect(switcher).toContain("workspace-rail-settings");
    expect(shell).not.toContain("HomeBoard");
    expect(shell).not.toContain("<FilesBoard");
    expect(shell).not.toContain('id="workspace-files-panel"');
    expect(shell).toContain('<App active={workspace === "rss"}');
    expect(read("library/FilesBoard.tsx")).toContain("listStructuredDocuments");
    expect(read("library/FilesBoard.tsx")).toContain("<StructuredReader");
    expect(read("library/StructuredReader.tsx")).toContain("articleStructuredDocument");
    expect(read("library/StructuredReader.tsx")).toContain("prepareMarkdownReading");
    expect(read("library/StructuredReader.tsx")).toContain("className=\"reader-structured\"");
    expect(read("components/Sidebar.tsx")).not.toContain("onOpenSettings");
  });
});
