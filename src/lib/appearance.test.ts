import { describe, expect, it } from "vitest";
import { applyThemeAccent } from "./appearance";

describe("Papr theme appearance", () => {
  it.each([
    ["paper", "light", "oklch(0.60 0.13 38)", "oklch(0.94 0.04 50)", "oklch(0.42 0.10 38)"],
    ["paper", "dark", "oklch(0.74 0.13 45)", "oklch(0.32 0.06 40)", "oklch(0.80 0.10 45)"],
    ["frost", "light", "#007AFF", "rgba(0, 122, 255, 0.13)", "#0062CC"],
    ["frost", "dark", "#0A84FF", "rgba(10, 132, 255, 0.20)", "#6FB4FF"],
    ["contrast", "light", "#0057D9", "rgba(0, 87, 217, 0.14)", "#003E9E"],
    ["contrast", "dark", "#0A84FF", "rgba(10, 132, 255, 0.24)", "#8CC4FF"],
  ] as const)("applies the existing %s/%s accent", (palette, mode, accent, soft, ink) => {
    const values = new Map<string, string | null>();
    applyThemeAccent({ setProperty: (name, value) => { values.set(name, value); } }, palette, mode);
    expect(Object.fromEntries(values)).toEqual({
      "--accent": accent,
      "--accent-soft": soft,
      "--accent-ink": ink,
    });
  });
});
