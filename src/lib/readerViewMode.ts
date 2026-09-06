/** A manual Reading/Web choice is independent of global and per-feed open defaults. */
export type ReaderViewMode = "reader" | "web";
export type ReaderViewPreference = ReaderViewMode | null;
export type AutomaticReaderViewMode = ReaderViewMode | "extracted";

export const READER_VIEW_PREFERENCE_KEY = "pref.readerViewMode";
export const DEFAULT_OPEN_MODE_KEY = "pref.defaultOpenMode";
const LEGACY_AUTO_EXTRACT_KEY = "pref.autoExtract";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

/** Missing or stale values mean there is no explicit tab memory. */
export function loadReaderViewPreference(storage?: ReadStorage): ReaderViewPreference {
  try {
    const value = (storage ?? window.localStorage).getItem(READER_VIEW_PREFERENCE_KEY);
    return value === "reader" || value === "web" ? value : null;
  } catch {
    // Unavailable browser storage must not make the reader unusable.
    return null;
  }
}

/** Load the user's global open-mode configuration. A valid modern value wins;
 *  the old auto-extract toggle is retained as an explicit legacy choice. With
 *  neither setting, a fresh install opens original webpages first. */
export function loadDefaultOpenMode(storage?: ReadStorage): AutomaticReaderViewMode {
  try {
    const source = storage ?? window.localStorage;
    const current = source.getItem(DEFAULT_OPEN_MODE_KEY);
    if (current === "reader" || current === "extracted" || current === "web") return current;
    const legacy = source.getItem(LEGACY_AUTO_EXTRACT_KEY);
    if (legacy === "1") return "extracted";
    if (legacy === "0") return "reader";
    return "web";
  } catch {
    // Storage failure should preserve a usable, URL-first reader.
    return "web";
  }
}

/** Called only for a user's explicit choice, never for automatic URL fallback. */
export function saveReaderViewPreference(mode: ReaderViewMode, storage?: WriteStorage): boolean {
  try {
    (storage ?? window.localStorage).setItem(READER_VIEW_PREFERENCE_KEY, mode);
    return true;
  } catch {
    // React still keeps the choice for this session if storage is unavailable.
    return false;
  }
}

export function resolveReaderViewMode(
  preference: ReaderViewPreference,
  automaticMode: AutomaticReaderViewMode | undefined,
  hasOriginalUrl: boolean,
): ReaderViewMode {
  // URL-less items temporarily use Reading without erasing a remembered tab.
  if (!hasOriginalUrl) return "reader";
  if (preference !== null) return preference;
  // While feed/global configuration is loading, start in Web instead of
  // flashing Reading first. A resolved explicit configuration still wins.
  if (automaticMode === undefined) return "web";
  return automaticMode === "web" ? "web" : "reader";
}
