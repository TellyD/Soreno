// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrateLegacyStorageKeys } from "./legacyStorage";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("moves Telaoi keys to Soreno without overwriting newer values", () => {
  localStorage.setItem("telaoi.agents.selection.v1", '{"projectId":"p1"}');
  localStorage.setItem("telaoi:git-repository:p%201", "cache");
  localStorage.setItem("telaoi:layout-widths", "old");
  localStorage.setItem("soreno:layout-widths", "new");
  localStorage.setItem("telaoi-unrelated", "keep");

  migrateLegacyStorageKeys();

  expect(
    Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => {
        const key = localStorage.key(index)!;
        return [key, localStorage.getItem(key)];
      }),
    ),
  ).toEqual({
    "soreno.agents.selection.v1": '{"projectId":"p1"}',
    "soreno:git-repository:p%201": "cache",
    "soreno:layout-widths": "new",
    "telaoi-unrelated": "keep",
  });
});

it("swaps a legacy value too large to copy alongside itself under the quota", () => {
  const value = "x".repeat(3_000_000);
  localStorage.setItem("telaoi.workspace.v1", value);
  expect(() => localStorage.setItem("soreno.probe.v1", value)).toThrow();

  migrateLegacyStorageKeys();

  expect(localStorage.getItem("soreno.workspace.v1")).toBe(value);
  expect(localStorage.getItem("telaoi.workspace.v1")).toBeNull();
});

it("ignores a localStorage getter that throws", () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });

  expect(() => migrateLegacyStorageKeys()).not.toThrow();
});
