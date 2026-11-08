const appLanguages = ["fr", "en"] as const;
export const languagePreferences = ["system", ...appLanguages] as const;

export type AppLanguage = (typeof appLanguages)[number];
export type LanguagePreference = (typeof languagePreferences)[number];

const DEFAULT_LANGUAGE: AppLanguage = "fr";

function isAppLanguage(value: unknown): value is AppLanguage {
  return appLanguages.some((language) => language === value);
}

export function isLanguagePreference(
  value: unknown,
): value is LanguagePreference {
  return languagePreferences.some((preference) => preference === value);
}

export function resolveSystemLanguage(
  systemLanguage: string | undefined,
): AppLanguage {
  const language = systemLanguage?.split("-")[0]?.toLowerCase();

  return isAppLanguage(language) ? language : DEFAULT_LANGUAGE;
}

export function resolveAppLanguage(
  preference: LanguagePreference,
  systemLanguage: string | undefined,
): AppLanguage {
  return preference === "system"
    ? resolveSystemLanguage(systemLanguage)
    : preference;
}

export function localeForLanguage(language: AppLanguage): string {
  return language === "en" ? "en-US" : "fr-FR";
}
