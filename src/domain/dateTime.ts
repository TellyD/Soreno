type RelativeShortDateTime = {
  kind: "time" | "dateTime";
  value: string;
};

export function formatShortDateTime(value: string, locale: string): string {
  const date = parseDate(value);

  if (!date) {
    return "";
  }

  return formatShortDateTimeValue(date, locale);
}

export function formatRelativeShortDateTime(
  value: string,
  locale: string,
  now = new Date(),
): RelativeShortDateTime | null {
  const date = parseDate(value);

  if (!date || Number.isNaN(now.getTime())) {
    return null;
  }

  if (isSameLocalDate(date, now)) {
    return {
      kind: "time",
      value: formatShortTimeValue(date, locale),
    };
  }

  return {
    kind: "dateTime",
    value: formatShortDateTimeValue(date, locale),
  };
}

export function formatCompactDate(
  value: string,
  locale: string,
  now = new Date(),
): { kind: "time" | "relative" | "date"; value: string } | null {
  const date = parseDate(value);
  if (!date || Number.isNaN(now.getTime())) return null;

  if (isSameLocalDate(date, now)) {
    return { kind: "time", value: formatShortTimeValue(date, locale) };
  }

  // Compare calendar days rather than elapsed hours across daylight-saving changes.
  const days =
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
    86_400_000;
  if (days > 0 && days < 7) {
    return {
      kind: "relative",
      value: new Intl.RelativeTimeFormat(locale, {
        numeric: days === 1 ? "auto" : "always",
      }).format(-days, "day"),
    };
  }

  return {
    kind: "date",
    value: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      ...(date.getFullYear() !== now.getFullYear()
        ? { year: "numeric" as const }
        : {}),
    }).format(date),
  };
}

function formatShortDateTimeValue(date: Date, locale: string): string {
  const dateText = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);

  return `${dateText} ${formatShortTimeValue(date, locale)}`;
}

function formatShortTimeValue(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function isSameLocalDate(left: Date, right: Date): boolean {
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) {
    return false;
  }

  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function parseDate(value: string): Date | null {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function compareDate(left: string, right: string): number {
  return normalizeTimestamp(left) - normalizeTimestamp(right);
}

export function isNewer(
  change: { updatedAt: string },
  than: { updatedAt: string },
): boolean {
  return Date.parse(change.updatedAt) > Date.parse(than.updatedAt);
}

function normalizeTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
