import { describe, expect, it } from "vitest";
import { descendantIds, folderAncestors, orderedFolders } from "./folderTree";
const folders = [{ id: 2, name: "Child", position: 0, parentId: 1 }, { id: 1, name: "Root", position: 0, parentId: null }, { id: 3, name: "Leaf", position: 0, parentId: 2 }];
describe("folder hierarchy", () => {
  it("orders parents before their children and computes subtree", () => {
    expect(orderedFolders(folders).map((f) => f.id)).toEqual([1, 2, 3]);
    expect(folderAncestors(3, folders)).toEqual([2, 1]);
    expect([...descendantIds(2, folders)]).toEqual([2, 3]);
  });
  it("does not loop on malformed imported hierarchy", () => {
    const cycle = [{ id: 1, name: "A", position: 0, parentId: 2 }, { id: 2, name: "B", position: 0, parentId: 1 }];
    expect(orderedFolders(cycle)).toHaveLength(2);
    expect(folderAncestors(1, cycle)).toEqual([2]);
  });
  it("keeps legacy flat folders", () => {
    const flat = [{ id: 1, name: "A", position: 0 }];
    expect(orderedFolders(flat)).toEqual(flat); expect(folderAncestors(1, flat)).toEqual([]);
  });
});
