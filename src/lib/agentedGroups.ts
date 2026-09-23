/** Section boundaries for the Agented list. The backend already orders named
 *  groups first and leaves unassigned cleaned articles last. */
export interface AgentedGroupRow {
  groupId?: number | null;
  groupName?: string | null;
}

export function agentedGroupKey(article: AgentedGroupRow): string {
  return article.groupId == null ? "ungrouped" : String(article.groupId);
}

export function agentedGroupLabel(article: AgentedGroupRow): string {
  return article.groupId == null ? "未分组" : article.groupName?.trim() || "未分组";
}

export function startsAgentedGroup(article: AgentedGroupRow, previous?: AgentedGroupRow): boolean {
  return previous == null || agentedGroupKey(article) !== agentedGroupKey(previous);
}
