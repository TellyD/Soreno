import { invoke } from "@tauri-apps/api/core";
import { hasTauriRuntime } from "./tauriRuntime";

export type CodexStatus = {
  installed: boolean;
  version: string | null;
};

export type CodexUpdateStatus =
  | { status: "available" | "upToDate"; latestVersion: string }
  | { status: "unsupported"; latestVersion: null };

export type CodexModel = {
  displayName: string;
  id: string;
};

export async function getCodexStatus(): Promise<CodexStatus> {
  if (!hasTauriRuntime()) {
    return { installed: false, version: null };
  }

  const status = await invoke<{ installed: boolean; version?: string | null }>(
    "get_codex_status",
  );

  return {
    installed: Boolean(status.installed),
    version: status.version ?? null,
  };
}

export async function checkCodexUpdate(): Promise<CodexUpdateStatus> {
  if (!hasTauriRuntime()) {
    throw new Error("CODEX_UPDATE_DESKTOP_ONLY");
  }

  return invoke<CodexUpdateStatus>("check_codex_update");
}

export async function updateCodexCli(): Promise<CodexStatus> {
  if (!hasTauriRuntime()) {
    throw new Error("CODEX_UPDATE_DESKTOP_ONLY");
  }

  return invoke<CodexStatus>("update_codex_cli");
}

export async function listCodexModels(): Promise<CodexModel[]> {
  if (!hasTauriRuntime()) {
    return [];
  }

  return invoke<CodexModel[]>("list_codex_models");
}
