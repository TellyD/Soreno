import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { checkCodexUpdate, updateCodexCli } from "./codexApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("does not simulate a successful update in the browser", async () => {
  vi.stubGlobal("isTauri", false);
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  await expect(updateCodexCli()).rejects.toThrow("CODEX_UPDATE_DESKTOP_ONLY");
  await expect(checkCodexUpdate()).rejects.toThrow("CODEX_UPDATE_DESKTOP_ONLY");
  expect(invoke).not.toHaveBeenCalled();
});
