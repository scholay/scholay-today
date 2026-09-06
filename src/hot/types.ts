export interface HotSource {
  id: string;
  name: string;
  region: "china" | "global";
  category: string;
  kind: "hot" | "latest" | "daily";
  homepage: string;
  description: string;
  project: string;
  project_url: string;
  refresh_secs: number;
  auth_kind: string | null;
  auth_url: string | null;
}

export interface HotAuthStatus { configured: boolean; supported: boolean }

export interface HotItem {
  id: string;
  title: string;
  url: string;
  description: string | null;
  heat: string | null;
  rank: number;
  published_at: string | null;
}

export interface HotSnapshot {
  source_id: string;
  items: HotItem[];
  fetched_at: string | null;
  last_attempt_at: string | null;
  status: "ok" | "error" | "never";
  error: string | null;
  stale: boolean;
  cached: boolean;
}

export type HotFilter = "all" | "china" | "global" | "tech" | "finance" | "life";
export interface HotUiState {
  filter: HotFilter;
  favorites: string[];
  favoritesOnly: boolean;
  paused: boolean;
  cardLimit: 5 | 8;
  sourceId: string | null;
  itemId: string | null;
  view: "overview" | "source";
  search: string;
}
