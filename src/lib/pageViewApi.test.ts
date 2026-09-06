import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { openPageView, setPageViewTheme, type PageViewBounds } from "../api";

const bounds: PageViewBounds = { x: 12, y: 34, width: 560, height: 720 };

describe("native page-view initial visibility", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("keeps ordinary page views visible by default", async () => {
    await openPageView("https://example.com/article", bounds, "reader-1");
    expect(invoke).toHaveBeenCalledWith("open_page_view", {
      url: "https://example.com/article",
      ...bounds,
      requestId: "reader-1",
      visible: true,
      darkMode: false,
    });
  });

  it("forwards hidden creation for an automatic capture pipeline", async () => {
    await openPageView("https://example.com/article", bounds, "reader-2", false);
    expect(invoke).toHaveBeenCalledWith("open_page_view", {
      url: "https://example.com/article",
      ...bounds,
      requestId: "reader-2",
      visible: false,
      darkMode: false,
    });
  });
  it("updates appearance with a boolean-only command, not navigation or arbitrary scripts", async () => {
    await setPageViewTheme(true);
    await setPageViewTheme(false);
    expect(invoke.mock.calls).toEqual([
      ["set_page_view_theme", { dark: true }],
      ["set_page_view_theme", { dark: false }],
    ]);
  });
});
