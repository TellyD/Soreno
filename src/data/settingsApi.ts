import { invoke } from "@tauri-apps/api/core";
import {
  isAgentProvider,
  ompConversationExecutable,
  type AgentProvider,
} from "../domain/agentSessions";
import {
  isCommitMessageStyle,
  isUsableCodexModel,
  type CommitMessageStyle,
} from "../domain/codexOptions";
import {
  isTerminalThemePreference,
  isThemePreference,
  type TerminalThemePreference,
  type ThemePreference,
} from "../domain/theme";
import {
  isLanguagePreference,
  type LanguagePreference,
} from "../i18n/language";

export const noteLockMinutesOptions = [1, 5, 10, 15, 30, 60] as const;
export type NoteLockMinutes = (typeof noteLockMinutesOptions)[number];

export type AppSettings = {
  codexGitModel: string | null;
  codexGitFastMode: boolean;
  codexGitCommitStyle: CommitMessageStyle;
  codexUsageAccountId: string | null;
  claudeUsageAccountId: string | null;
  hiddenAgentPresets: AgentProvider[];
  agentPresetArgs: Partial<Record<AgentProvider, string[]>>;
  hiddenChatCommands: string[];
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  terminalThemePreference: TerminalThemePreference;
  terminalLogEnabled: boolean;
  agentNotificationsEnabled: boolean;
  materialFileIconsEnabled: boolean;
  noteLockMinutes: NoteLockMinutes;
};

export const defaultAppSettings: AppSettings = {
  codexGitModel: null,
  codexGitFastMode: true,
  codexGitCommitStyle: "imperative",
  codexUsageAccountId: null,
  claudeUsageAccountId: null,
  hiddenAgentPresets: [],
  agentPresetArgs: {},
  hiddenChatCommands: ["autoresearch", "green", "annotate"],
  languagePreference: "system",
  themePreference: "system",
  terminalThemePreference: "app",
  terminalLogEnabled: false,
  agentNotificationsEnabled: true,
  materialFileIconsEnabled: false,
  noteLockMinutes: 10,
};

export async function resetWindowSizes(): Promise<void> {
  await invoke("reset_window_sizes");
}

export async function getAppSettings(): Promise<AppSettings> {
  const settings = await invoke<AppSettings>("get_app_settings");

  return normalizeSettings(settings);
}

export async function updateAppSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  const updatedSettings = await invoke<AppSettings>("update_app_settings", {
    settings,
  });

  return normalizeSettings(updatedSettings);
}

export function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    codexGitModel: isUsableCodexModel(settings.codexGitModel)
      ? settings.codexGitModel.trim()
      : null,
    codexGitFastMode: settings.codexGitFastMode !== false,
    codexGitCommitStyle: isCommitMessageStyle(settings.codexGitCommitStyle)
      ? settings.codexGitCommitStyle
      : defaultAppSettings.codexGitCommitStyle,
    codexUsageAccountId:
      typeof settings.codexUsageAccountId === "string" &&
      settings.codexUsageAccountId !== ""
        ? settings.codexUsageAccountId
        : null,
    claudeUsageAccountId:
      typeof settings.claudeUsageAccountId === "string" &&
      settings.claudeUsageAccountId !== ""
        ? settings.claudeUsageAccountId
        : null,
    hiddenAgentPresets: Array.isArray(settings.hiddenAgentPresets)
      ? [...new Set(settings.hiddenAgentPresets.filter(isAgentProvider))]
      : defaultAppSettings.hiddenAgentPresets,
    agentPresetArgs: Object.fromEntries(
      Object.entries(
        typeof settings.agentPresetArgs === "object" && settings.agentPresetArgs
          ? settings.agentPresetArgs
          : {},
      ).flatMap(([provider, args]) =>
        // The OMP chat runs over RPC and does not take session arguments.
        isAgentProvider(provider) &&
        provider !== ompConversationExecutable &&
        Array.isArray(args)
          ? [[provider, args.filter((arg) => typeof arg === "string" && arg)]]
          : [],
      ),
    ),
    hiddenChatCommands: Array.isArray(settings.hiddenChatCommands)
      ? [
          ...new Set(
            settings.hiddenChatCommands.filter(
              (name) => typeof name === "string" && name !== "",
            ),
          ),
        ]
      : defaultAppSettings.hiddenChatCommands,
    languagePreference: isLanguagePreference(settings.languagePreference)
      ? settings.languagePreference
      : defaultAppSettings.languagePreference,
    themePreference: isThemePreference(settings.themePreference)
      ? settings.themePreference
      : defaultAppSettings.themePreference,
    terminalThemePreference: isTerminalThemePreference(
      settings.terminalThemePreference,
    )
      ? settings.terminalThemePreference
      : defaultAppSettings.terminalThemePreference,
    terminalLogEnabled: settings.terminalLogEnabled === true,
    agentNotificationsEnabled: settings.agentNotificationsEnabled !== false,
    materialFileIconsEnabled: settings.materialFileIconsEnabled === true,
    noteLockMinutes: noteLockMinutesOptions.includes(
      settings.noteLockMinutes as NoteLockMinutes,
    )
      ? (settings.noteLockMinutes as NoteLockMinutes)
      : defaultAppSettings.noteLockMinutes,
  };
}
