import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useAppSettings } from "../settings";
import {
  localeForLanguage,
  resolveAppLanguage,
  type AppLanguage,
  type LanguagePreference,
} from "./language";
import {
  translations,
  type TranslationKey,
  type TranslationValues,
} from "./translations";

export type I18nContextValue = {
  language: AppLanguage;
  languagePreference: LanguagePreference;
  locale: string;
  setLanguagePreference: (preference: LanguagePreference) => Promise<void>;
  t: (key: TranslationKey, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

type I18nProviderProps = {
  children: ReactNode;
};

function readSystemLanguage(): string | undefined {
  return window.navigator.languages?.[0] ?? window.navigator.language;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const { settings, updateSettings } = useAppSettings();
  const languagePreference = settings.languagePreference;
  const systemLanguage = readSystemLanguage();
  const language = resolveAppLanguage(languagePreference, systemLanguage);
  const locale = localeForLanguage(language);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguagePreference = useCallback(
    async (preference: LanguagePreference) => {
      await updateSettings({
        languagePreference: preference,
      });
    },
    [updateSettings],
  );

  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) => {
      let value = translations[language][key];

      if (values) {
        Object.entries(values).forEach(([name, replacement]) => {
          value = value.split(`{${name}}`).join(String(replacement));
        });
      }

      return value;
    },
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      languagePreference,
      locale,
      setLanguagePreference,
      t,
    }),
    [language, languagePreference, locale, setLanguagePreference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);

  if (!value) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return value;
}
