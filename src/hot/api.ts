import { invoke } from "@tauri-apps/api/core";
import { createHotRequestQueue } from "./helpers";
import type { HotAuthStatus, HotSnapshot, HotSource } from "./types";

const schedule = createHotRequestQueue(4);
export const listHotSources = (): Promise<HotSource[]> => invoke("list_hot_sources");
export const getHotSnapshot = (sourceId: string, refresh: boolean, signal?: AbortSignal): Promise<HotSnapshot> =>
  schedule(() => invoke<HotSnapshot>("get_hot_snapshot", { sourceId, refresh }), signal);
export const getHotAuthStatus = (sourceId: string): Promise<HotAuthStatus> => invoke("get_hot_auth_status", { sourceId });
export const saveHotApiToken = (sourceId: string, token: string): Promise<void> => invoke("save_hot_api_token", { sourceId, token });
