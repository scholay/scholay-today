import type { Palette, ResolvedMode } from "../store";

// Keep Papr's theme accent values in one place for startup and live changes.
const ACCENTS: Record<Palette, Record<ResolvedMode, { accent: string; soft: string; ink: string }>> = {
  paper: {
    light: { accent: "oklch(0.60 0.13 38)", soft: "oklch(0.94 0.04 50)", ink: "oklch(0.42 0.10 38)" },
    dark: { accent: "oklch(0.74 0.13 45)", soft: "oklch(0.32 0.06 40)", ink: "oklch(0.80 0.10 45)" },
  },
  frost: {
    light: { accent: "#007AFF", soft: "rgba(0, 122, 255, 0.13)", ink: "#0062CC" },
    dark: { accent: "#0A84FF", soft: "rgba(10, 132, 255, 0.20)", ink: "#6FB4FF" },
  },
  contrast: {
    light: { accent: "#0057D9", soft: "rgba(0, 87, 217, 0.14)", ink: "#003E9E" },
    dark: { accent: "#0A84FF", soft: "rgba(10, 132, 255, 0.24)", ink: "#8CC4FF" },
  },
};

export function applyThemeAccent(
  style: Pick<CSSStyleDeclaration, "setProperty">,
  palette: Palette,
  mode: ResolvedMode,
): void {
  const accent = ACCENTS[palette][mode];
  style.setProperty("--accent", accent.accent);
  style.setProperty("--accent-soft", accent.soft);
  style.setProperty("--accent-ink", accent.ink);
}
