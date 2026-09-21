import { descendantIds, orderedFolders } from "../lib/folderTree";
import type { Folder, StructuredListItem } from "../types";

export type LibraryScope = "all" | "unfiled" | "examples" | number;

export function docsInScope(
  docs: StructuredListItem[],
  folders: Folder[],
  scope: LibraryScope,
): StructuredListItem[] {
  if (scope === "all") return docs;
  if (scope === "examples") return [];
  if (scope === "unfiled") return docs.filter((doc) => doc.folderId == null);
  const ids = descendantIds(scope, folders);
  return docs.filter((doc) => doc.folderId != null && ids.has(doc.folderId));
}

/** Include a parent only when it leads to a cleaned document. Empty RSS
 * folders are not library content; search never changes this navigation tree. */
export function populatedFolders(docs: StructuredListItem[], folders: Folder[]): Folder[] {
  return orderedFolders(folders).filter((folder) => cleanedCountForFolder(docs, folders, folder.id) > 0);
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
