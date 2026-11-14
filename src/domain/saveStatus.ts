import { compareDate, formatRelativeShortDateTime } from "./dateTime";

export type SaveState = "idle" | "saving" | "saved" | "error";

export type SaveStatusLabels = {
  error: string;
  saved: string;
  savedAtDate: (date: string) => string;
  savedAtTime: (time: string) => string;
  saving: string;
};

type SaveStatusSnapshot = {
  lastSavedAt: string | null;
  saveState: SaveState;
  saveStateText: string;
};

export function formatSaveStateText(
  saveState: SaveState,
  lastSavedAt: string | null,
  locale: string,
  labels: SaveStatusLabels,
  now = new Date(),
): string {
  if (saveState === "saving") {
    return labels.saving;
  }

  if (saveState === "error") {
    return labels.error;
  }

  if (saveState !== "saved") {
    return "";
  }

  if (!lastSavedAt) {
    return labels.saved;
  }

  const savedAt = formatRelativeShortDateTime(lastSavedAt, locale, now);

  if (!savedAt) {
    return labels.saved;
  }

  return savedAt.kind === "time"
    ? labels.savedAtTime(savedAt.value)
    : labels.savedAtDate(savedAt.value);
}

export function selectStatusBarSaveStateText(
  statuses: SaveStatusSnapshot[],
): string {
  const savingStatus = findLastStatusByState(statuses, "saving");

  if (savingStatus) {
    return savingStatus.saveStateText;
  }

  const errorStatus = findLastStatusByState(statuses, "error");

  if (errorStatus) {
    return errorStatus.saveStateText;
  }

  const savedStatuses = statuses.filter(
    (status) => status.saveState === "saved" && status.saveStateText,
  );

  if (savedStatuses.length === 0) {
    return "";
  }

  return savedStatuses.reduce((latestStatus, currentStatus) =>
    compareDate(
      currentStatus.lastSavedAt ?? "",
      latestStatus.lastSavedAt ?? "",
    ) >= 0
      ? currentStatus
      : latestStatus,
  ).saveStateText;
}

function findLastStatusByState(
  statuses: SaveStatusSnapshot[],
  saveState: SaveState,
): SaveStatusSnapshot | null {
  for (let index = statuses.length - 1; index >= 0; index -= 1) {
    const status = statuses[index];

    if (status.saveState === saveState && status.saveStateText) {
      return status;
    }
  }

  return null;
}
