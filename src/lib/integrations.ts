import { invoke } from "@tauri-apps/api/core";
export interface LibraryStatus {
  enabled: boolean; writable: boolean; articles: boolean; articleClean: boolean; revision: number;
  configuration: object;
  archived: { id: number; title: string; articles: number; archivedAt: string }[];
  history: { id: number; actor: string; actions: { action: string; id?: number }[]; createdAt: string }[];
}
export interface PlatformStatus {
  id: string; name: string; method: string; service: string; status: string; detail: string;
  lastVerifiedAt?: string; lastSyncAt?: number; lastSyncStatus?: string;
}
/** Each capability is its own switch; the backend also enforces the chain, so a
 *  stale view cannot leave one enabled underneath a switch that was turned off. */
export interface McpPermissions { enabled: boolean; writable: boolean; articles: boolean; articleClean: boolean }
export const libraryStatus = () => invoke<LibraryStatus>("library_status");
export const libraryPermissions = (p: McpPermissions) => invoke<void>("library_permissions", { ...p });
export const libraryApply = (actions: object[], dryRun = false, expectedRevision: number | null = null) => invoke("library_apply", { actions, dryRun, expectedRevision, requestKey: null });
export const platformStatus = () => invoke<PlatformStatus[]>("platform_status");
export const platformAction = (platform: string, action: string, secret: string | null = null) => invoke<PlatformStatus>("platform_action", { platform, action, secret });
