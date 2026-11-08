import { useCallback, useMemo, useState } from "react";
import { formatSaveStateText, type SaveState } from "../domain/saveStatus";
import { useI18n } from "../i18n";

export function useSaveStatus() {
  const { locale, t } = useI18n();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const saveStateText = useMemo(() => {
    return formatSaveStateText(saveState, lastSavedAt, locale, {
      error: t("status.saveState.error"),
      saved: t("status.saveState.saved"),
      savedAtDate: (date) => t("status.saveState.savedAtDate", { date }),
      savedAtTime: (time) => t("status.saveState.savedAtTime", { time }),
      saving: t("status.saveState.saving"),
    });
  }, [lastSavedAt, locale, saveState, t]);

  const beginSave = useCallback(() => {
    setSaveState("saving");
  }, []);

  const recordSavedAt = useCallback((savedAt: string | null) => {
    setLastSavedAt(savedAt);
  }, []);

  const markSaved = useCallback(() => {
    setSaveState("saved");
  }, []);

  const markError = useCallback(() => {
    setSaveState("error");
  }, []);

  const resetSaveStatus = useCallback(() => {
    setLastSavedAt(null);
    setSaveState("idle");
  }, []);

  return {
    beginSave,
    lastSavedAt,
    markError,
    markSaved,
    recordSavedAt,
    resetSaveStatus,
    saveState,
    saveStateText,
  };
}
