import { descendantIds } from "../lib/folderTree";
import type { Folder, StructuredListItem } from "../types";

export type LibraryScope = "all" | "unfiled" | number;

export function docsInScope(
  docs: StructuredListItem[],
  folders: Folder[],
  scope: LibraryScope,
): StructuredListItem[] {
  if (scope === "all") return docs;
  if (scope === "unfiled") return docs.filter((doc) => doc.folderId == null);
  const ids = descendantIds(scope, folders);
  return docs.filter((doc) => doc.folderId != null && ids.has(doc.folderId));
}

export function cleanedCountForFolder(docs: StructuredListItem[], folders: Folder[], folderId: number): number {
  return docsInScope(docs, folders, folderId).length;
}

export function matchesLibraryQuery(doc: StructuredListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [doc.title, doc.feedTitle, doc.folderName ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}
