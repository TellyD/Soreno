import { errorMessage } from "../domain/errors";
import type { TranslationKey } from "./translations";

export function formatCodexError(
  error: unknown,
  t: (key: TranslationKey) => string,
  fallbackKey: TranslationKey,
): string {
  switch (errorMessage(error)) {
    case "Command check_codex_update not found":
      return t("settings.codex.updateCheckUnavailable");
    case "CODEX_UPDATE_UNSUPPORTED":
      return t("settings.codex.updateUnsupported");
    case "CODEX_UPDATE_BUSY":
      return t("settings.codex.updateBusy");
    case "CODEX_UPDATE_ACTIVE":
      return t("settings.codex.updateActive");
    case "CODEX_UPDATE_TIMEOUT":
      return t("settings.codex.updateTimeout");
    case "CODEX_UPDATE_VERIFY_FAILED":
      return t("settings.codex.updateVerifyFailed");
    case "CODEX_UPDATE_DESKTOP_ONLY":
      return t("settings.codex.updateDesktopOnly");
  }

  return t(fallbackKey);
}
