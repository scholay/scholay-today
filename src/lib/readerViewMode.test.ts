import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPEN_MODE_KEY, READER_VIEW_PREFERENCE_KEY, loadDefaultOpenMode,
  loadReaderViewPreference, resolveReaderViewMode, saveReaderViewPreference,
} from "./readerViewMode";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(READER_VIEW_PREFERENCE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("remembered reader view mode", () => {
  it("respects resolved global/feed defaults until the user makes a manual selection", () => {
    const preference = loadReaderViewPreference(memoryStorage());
    expect(preference).toBeNull();
    expect(resolveReaderViewMode(preference, "web", true)).toBe("web");
    expect(resolveReaderViewMode(preference, "reader", true)).toBe("reader");
    expect(resolveReaderViewMode(preference, "extracted", true)).toBe("reader");
  });

  it("opens Web while automatic configuration is unavailable", () => {
    expect(resolveReaderViewMode(null, undefined, true)).toBe("web");
  });

  it("persists a Web selection across a reload and different feed defaults", () => {
    const storage = memoryStorage();
    expect(saveReaderViewPreference("web", storage)).toBe(true);
    const afterRestart = loadReaderViewPreference(storage);
    expect(afterRestart).toBe("web");
    expect(resolveReaderViewMode(afterRestart, "reader", true)).toBe("web");
    expect(resolveReaderViewMode(afterRestart, "extracted", true)).toBe("web");
  });

  it("persists an explicit Reading selection even for feeds defaulting to Web", () => {
    const storage = memoryStorage("web");
    saveReaderViewPreference("reader", storage);
    expect(loadReaderViewPreference(storage)).toBe("reader");
    expect(resolveReaderViewMode(loadReaderViewPreference(storage), "web", true)).toBe("reader");
  });

  it("temporarily falls back for a URL-less article without erasing Web preference", () => {
    const storage = memoryStorage("web");
    const preference = loadReaderViewPreference(storage);
    expect(resolveReaderViewMode(preference, "web", false)).toBe("reader");
    expect(loadReaderViewPreference(storage)).toBe("web");
    expect(resolveReaderViewMode(loadReaderViewPreference(storage), "reader", true)).toBe("web");
  });

  it("does not need the feed list to resolve an existing manual preference", () => {
    expect(resolveReaderViewMode("web", undefined, true)).toBe("web");
    expect(resolveReaderViewMode("reader", undefined, true)).toBe("reader");
    expect(resolveReaderViewMode(null, undefined, true)).toBe("web");
  });

  it("ignores invalid or legacy values rather than making an unchecked cast", () => {
    for (const invalid of ["", "card", "extracted", "true", "WEB", "null"]) {
      expect(loadReaderViewPreference(memoryStorage(invalid))).toBeNull();
    }
  });

  it("does not crash when storage is unavailable", () => {
    expect(loadReaderViewPreference({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(saveReaderViewPreference("web", { setItem: () => { throw new Error("blocked"); } })).toBe(false);
  });

  it("writes only the manual preference, not the existing global/feed default", () => {
    const writes: [string, string][] = [];
    saveReaderViewPreference("web", { setItem: (key, value) => { writes.push([key, value]); } });
    expect(writes).toEqual([["pref.readerViewMode", "web"]]);
  });
});

describe("global default open mode", () => {
  const storage = (values: Record<string, string>) => ({
    getItem: (key: string) => values[key] ?? null,
  });

  it("defaults a fresh install to Web", () => {
    expect(loadDefaultOpenMode(storage({}))).toBe("web");
  });

  it.each(["reader", "extracted", "web"] as const)("respects an explicit %s setting", (mode) => {
    expect(loadDefaultOpenMode(storage({ [DEFAULT_OPEN_MODE_KEY]: mode }))).toBe(mode);
  });

  it("migrates both values of the legacy auto-extract preference", () => {
    expect(loadDefaultOpenMode(storage({ "pref.autoExtract": "1" }))).toBe("extracted");
    expect(loadDefaultOpenMode(storage({ "pref.autoExtract": "0" }))).toBe("reader");
  });

  it("uses the valid legacy choice behind an invalid modern value", () => {
    expect(loadDefaultOpenMode(storage({ [DEFAULT_OPEN_MODE_KEY]: "stale", "pref.autoExtract": "0" }))).toBe("reader");
  });

  it("falls back to Web when storage is unavailable", () => {
    expect(loadDefaultOpenMode({ getItem: () => { throw new Error("blocked"); } })).toBe("web");
  });
});
