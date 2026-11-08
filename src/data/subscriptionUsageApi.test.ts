import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCodexUsage } from "./subscriptionUsageApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("does not fabricate Codex quotas in the browser", async () => {
  vi.stubGlobal("isTauri", false);
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  expect(await getCodexUsage()).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
});
