import { describe, expect, it } from "vitest";
import { agentedGroupLabel, startsAgentedGroup, type AgentedGroupRow } from "./agentedGroups";

const row = (groupId: number | null, groupName: string | null): AgentedGroupRow => ({ groupId, groupName });

describe("Agented group sections", () => {
  const items = [row(2, "论文"), row(2, "论文"), row(null, null)];

  it("starts a section when the group changes and keeps ungrouped last in label only", () => {
    expect(items.map((item, index) => startsAgentedGroup(item, items[index - 1]))).toEqual([true, false, true]);
    expect(items.map(agentedGroupLabel)).toEqual(["论文", "论文", "未分组"]);
  });

  it("treats a missing name on a real group as ungrouped text without merging it into the ungrouped key", () => {
    const named = row(4, "  ");
    const loose = row(null, null);
    expect(agentedGroupLabel(named)).toBe("未分组");
    expect(startsAgentedGroup(loose, named)).toBe(true);
  });
});
