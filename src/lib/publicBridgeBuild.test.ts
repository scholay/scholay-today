import { beforeEach, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { preparePublicBridge } from "../../scripts/prepare-public-bridge.mjs";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), temp: vi.fn(), remove: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("node:fs", () => ({ mkdirSync: mocks.mkdir, mkdtempSync: mocks.temp, rmSync: mocks.remove }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.spawn.mockReturnValue({ status: 0 });
  let serial = 0;
  mocks.temp.mockImplementation((prefix: string) => `${prefix}${++serial}`);
});

it("does not create or execute a Python environment on non-Windows hosts", () => {
  preparePublicBridge("darwin"); preparePublicBridge("linux");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.temp).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("creates a fresh complete venv outside target on every invocation and preserves packaged output", () => {
  preparePublicBridge("win32"); preparePublicBridge("win32");
  const prefix = join(tmpdir(), "scholay-bridge-build-");
  expect(mocks.temp.mock.calls).toEqual([[prefix], [prefix]]);
  expect(mocks.spawn).toHaveBeenCalledTimes(8);
  for (const [index, serial] of [[0, 1], [4, 2]]) {
    const venv = `${prefix}${serial}`;
    const python = join(venv, "Scripts", "python.exe");
    expect(mocks.spawn.mock.calls[index][1]).toEqual(["-I", "-m", "venv", venv]);
    expect(mocks.spawn.mock.calls[index + 1]).toEqual([python, ["-I", "-m", "pip", "install", "--disable-pip-version-check", "pyinstaller==6.16.0", "requests==2.32.5", "beautifulsoup4==4.13.5", "tzdata==2025.2"], { stdio: "inherit" }]);
    expect(mocks.spawn.mock.calls[index + 2][1]).toEqual(["-I", resolve("scripts/collect-bridge-licenses.py")]);
    expect(mocks.spawn.mock.calls[index + 3][1]).toEqual(expect.arrayContaining(["-I", "-m", "PyInstaller", "--onefile", "--collect-data", "tzdata", "--distpath", resolve("target/bundle-resources/connectors")]));
    expect(mocks.remove).toHaveBeenCalledWith(venv, { recursive: true, force: true });
  }
  expect(mocks.remove).toHaveBeenCalledTimes(2);
});

it.each([0, 1, 2, 3])("aborts after failed stage %i and cleans only its own temporary environment", failedStage => {
  for (let stage = 0; stage < failedStage; stage++) mocks.spawn.mockReturnValueOnce({ status: 0 });
  mocks.spawn.mockReturnValueOnce({ status: 1 });
  expect(() => preparePublicBridge("win32")).toThrow("Bridge build command failed (1)");
  expect(mocks.spawn).toHaveBeenCalledTimes(failedStage + 1);
  expect(mocks.remove.mock.calls).toEqual([[`${join(tmpdir(), "scholay-bridge-build-")}1`, { recursive: true, force: true }]]);
});

it("does not hide failure to start Python", () => {
  mocks.spawn.mockReturnValueOnce({ error: new Error("Python not found"), status: null });
  expect(() => preparePublicBridge("win32")).toThrow("Python not found");
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
