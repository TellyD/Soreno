import type { AppLanguage } from "./language";
import { en } from "./locales/en";
import { fr } from "./locales/fr";

export type TranslationKey = keyof typeof fr;

export type TranslationValues = Record<string, string | number>;

export const translations: Record<
  AppLanguage,
  Record<TranslationKey, string>
> = {
  en,
  fr,
};
