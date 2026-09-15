import catalog from "./catalog.json";

export const LABEL_SOURCES = catalog;
export const LABEL_UI_KEY = "scholay.labels.ui.v1";
// Keep the old key and migrate safe public rows in place; never store credentials here.
export const LABEL_CACHE_KEY = "scholay.labels.snapshots.v1";
export type LabelAuth = "unknown" | "signed_in" | "signed_out" | "challenge";
export interface LabelRow { term: string; metric: string; kind: string; rank: number; metricLabel: string }
export interface LabelProbe { auth: LabelAuth; rows: LabelRow[]; period: string; clicked?: boolean }
export interface LabelSnapshot { rows: LabelRow[]; period: string; capturedAt: string }
export interface LabelUi { sourceId: string; group: string; search: string }
export interface CredentialStatus { configured: boolean; count: number; savedAt: number | null; expired: boolean; persistent: boolean }
export const LABEL_AUTH_TEXT: Record<LabelAuth, string> = {
  unknown: "登录状态待确认", signed_in: "已识别登录状态", signed_out: "平台提示登录", challenge: "需要安全验证",
};
export function credentialText(value?: CredentialStatus): string {
  if (!value) return "授权状态待查询";
  if (!value.configured) return "未保存授权";
  return value.expired ? "保存的 Cookie 已过期" : "Cookie 已安全保存 · 可用性需同步验证";
}
export function parseLabelUi(raw: string | null): LabelUi {
  const fallback: LabelUi = { sourceId: "all", group: "全部", search: "" };
  try {
    const data = JSON.parse(raw ?? "null");
    if (!data || !(data.sourceId === "all" || LABEL_SOURCES.some(source => source.id === data.sourceId))) return fallback;
    return { sourceId: data.sourceId, group: "全部", search: "" };
  } catch { return fallback; }
}
export function parseLabelCache(raw: string | null): Record<string, LabelSnapshot> {
  try {
    const data = JSON.parse(raw ?? "null"), result: Record<string, LabelSnapshot> = {};
    if (!data || typeof data !== "object") return result;
    for (const source of LABEL_SOURCES.filter(source => source.adapter)) {
      const snapshot = data[source.id];
      if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > 200 || typeof snapshot.period !== "string" || snapshot.period.length > 80 || typeof snapshot.capturedAt !== "string" || !Number.isFinite(Date.parse(snapshot.capturedAt))) continue;
      const kinds = source.id === "bilibili" ? ["热门关键词","飙升关键词"] : source.id === "douyin" ? ["抖音实时热点","抖音飙升热点"] : ["知乎热题","全网热点"];
      const metricLabel = source.id === "bilibili" ? "内容指数" : source.id === "douyin" ? "热点指数" : "";
      const rows: LabelRow[] = [];
      for (const row of snapshot.rows) {
        if (!row || typeof row.term !== "string" || !row.term || row.term.length > 400 || /[\u0000-\u001f]/.test(row.term) || typeof row.metric !== "string" || row.metric.length > 40 || !/^[\d,. WwKkMm%万亿]*$/.test(row.metric) || !kinds.includes(row.kind) || !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 100) continue;
        if (source.id === "zhihu" && row.metric) continue;
        // Explicit projection drops unknown fields, including accidental secret fields on rows.
        rows.push({ term: row.term, metric: row.metric, kind: row.kind, rank: row.rank, metricLabel });
      }
      if (rows.length) result[source.id] = { rows, period: snapshot.period, capturedAt: snapshot.capturedAt };
    }
    return result;
  } catch { return {}; }
}
export function labelTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
