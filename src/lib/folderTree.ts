import type { Folder } from "../types";
export function folderAncestors(id: number, folders: Folder[]): number[] {
  const result: number[] = [], seen = new Set([id]);
  let parent = folders.find((f) => f.id === id)?.parentId;
  while (parent != null && !seen.has(parent)) { result.push(parent); seen.add(parent); parent = folders.find((f) => f.id === parent)?.parentId; }
  return result;
}
export function orderedFolders(folders: Folder[]): Folder[] {
  const result: Folder[] = [], seen = new Set<number>();
  const walk = (parent: number | null) => {
    for (const f of folders) if (!seen.has(f.id) && (f.parentId ?? null) === parent) { seen.add(f.id); result.push(f); walk(f.id); }
  };
  walk(null);
  for (const f of folders) if (!seen.has(f.id)) { seen.add(f.id); result.push(f); walk(f.id); }
  return result;
}
export const descendantIds = (id: number, folders: Folder[]) => new Set([id, ...folders.filter((f) => folderAncestors(f.id, folders).includes(id)).map((f) => f.id)]);
