import { invoke } from "@tauri-apps/api/core";
import { hasTauriRuntime } from "./tauriRuntime";

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimits = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export type ClaudeRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
};

export type ClaudeModelRateLimit = {
  model: string;
  window: ClaudeRateLimitWindow;
};

export type ClaudeRateLimits = {
  primary: ClaudeRateLimitWindow | null;
  secondary: ClaudeRateLimitWindow | null;
  models: ClaudeModelRateLimit[];
  stale: boolean;
  expired: boolean;
};

export type UsageSource = {
  key: string;
  kind: "local" | "wsl" | "ssh";
  label: string | null;
};

export type UsageAccount<L> = {
  id: string;
  email: string | null;
  sources: UsageSource[];
  limits: L | null;
};

export async function getCodexUsage(): Promise<
  UsageAccount<CodexRateLimits>[]
> {
  if (!hasTauriRuntime()) return [];
  return invoke<UsageAccount<CodexRateLimits>[]>("get_codex_usage");
}

export async function getClaudeUsage(): Promise<
  UsageAccount<ClaudeRateLimits>[]
> {
  if (!hasTauriRuntime()) return [];
  return invoke<UsageAccount<ClaudeRateLimits>[]>("get_claude_usage");
}
