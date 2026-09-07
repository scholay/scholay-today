import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const document = new JSDOM(read(`src-tauri/${config.bundle.macOS.infoPlist}`), { contentType: "text/xml" }).window.document;
const root = document.querySelector("plist > dict")!;
const valueFor = (dict: Element, name: string) =>
  [...dict.children].find((child) => child.tagName === "key" && child.textContent === name)?.nextElementSibling;

describe("macOS publisher webpage transport compatibility", () => {
  it("bundles the plist explicitly, so installed WebKit can open HTTP-only publishers", () => {
    expect(config.bundle.macOS.infoPlist).toBe("Info.plist");
    const ats = valueFor(root, "NSAppTransportSecurity")!;
    expect(ats.tagName).toBe("dict");
    expect(valueFor(ats, "NSAllowsArbitraryLoadsInWebContent")?.tagName).toBe("true");
  });

  it("does not globally exempt native networking or install per-domain TLS exceptions", () => {
    const ats = valueFor(root, "NSAppTransportSecurity")!;
    expect(valueFor(ats, "NSAllowsArbitraryLoads")?.tagName).toBe("false");
    expect([...ats.children].filter((child) => child.tagName === "key").map((child) => child.textContent).sort())
      .toEqual(["NSAllowsArbitraryLoads", "NSAllowsArbitraryLoadsInWebContent"]);
  });

  it("keeps external webviews outside the trusted app capability boundary", () => {
    const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capability.webviews).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.windows).toBeUndefined();
    expect(config.identifier).toBe("com.thomas.papr");
  });
});
