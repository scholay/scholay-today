/** Only the trusted application document/storage is consulted here, never the
 * remote page. An explicit opt-out survives restarts and workspace switches. */
export function resolvePageViewDarkMode(mode: string | undefined, enabled: boolean, systemDark: boolean): boolean {
  return enabled && (mode === "dark" || (mode !== "light" && systemDark));
}

export function pageViewDarkMode(): boolean {
  try {
    return resolvePageViewDarkMode(
      document.documentElement.dataset.mode,
      localStorage.getItem("pref.webDarkMode") !== "0",
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    );
  } catch {
    return false;
  }
}
