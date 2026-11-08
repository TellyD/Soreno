const appThemes = ["light", "dark"] as const;
export const themePreferences = ["system", ...appThemes] as const;
export const terminalThemePreferences = ["app", ...appThemes] as const;

export type AppTheme = (typeof appThemes)[number];
export type ThemePreference = (typeof themePreferences)[number];
export type TerminalThemePreference = (typeof terminalThemePreferences)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return themePreferences.some((preference) => preference === value);
}

export function isTerminalThemePreference(
  value: unknown,
): value is TerminalThemePreference {
  return terminalThemePreferences.some((preference) => preference === value);
}

export function resolveAppTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean | undefined,
): AppTheme {
  return preference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : preference;
}
