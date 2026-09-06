import { invoke } from "@tauri-apps/api/core";
export interface LibraryStatus {
  enabled: boolean; writable: boolean; revision: number;
  configuration: object;
  archived: { id: number; title: string; articles: number; archivedAt: string }[];
  history: { id: number; actor: string; actions: { action: string; id?: number }[]; createdAt: string }[];
}
export interface PlatformStatus {
  id: string; name: string; method: string; service: string; status: string; detail: string;
  lastVerifiedAt?: string; lastSyncAt?: number; lastSyncStatus?: string;
}
export const libraryStatus = () => invoke<LibraryStatus>("library_status");
export const libraryPermissions = (enabled: boolean, writable: boolean) => invoke<void>("library_permissions", { enabled, writable });
export const libraryApply = (actions: object[], dryRun = false, expectedRevision: number | null = null) => invoke("library_apply", { actions, dryRun, expectedRevision, requestKey: null });
export const platformStatus = () => invoke<PlatformStatus[]>("platform_status");
export const platformAction = (platform: string, action: string, secret: string | null = null) => invoke<PlatformStatus>("platform_action", { platform, action, secret });
