export type UsageWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type UsageModelWindow = {
  model: string;
  window: UsageWindow;
};

export type UsageLimits = {
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  models?: UsageModelWindow[];
  stale?: boolean;
  expired?: boolean;
};

export type UsageWindowEntry = {
  key: string;
  model: string | null;
  window: UsageWindow;
};

type UsageLevel = "low" | "high" | "critical";

export function usageWindows(
  limits: UsageLimits | null | undefined,
): UsageWindowEntry[] {
  if (!limits) return [];
  return [
    ...(limits.primary
      ? [{ key: "primary", model: null, window: limits.primary }]
      : []),
    ...(limits.secondary
      ? [{ key: "secondary", model: null, window: limits.secondary }]
      : []),
    ...(limits.models ?? []).map(({ model, window }) => ({
      key: `model:${model}`,
      model,
      window,
    })),
  ];
}

// Providers do not guarantee which slot carries the weekly cap: keep the
// longest window of a day or more, trusting the secondary slot on ties or
// when its duration is unknown.
export function weeklyUsageWindow(
  limits: UsageLimits | null | undefined,
): UsageWindow | null {
  if (!limits) return null;
  const { primary, secondary } = limits;
  let weekly: UsageWindow | null = null;
  for (const window of [secondary, primary]) {
    const mins = window?.windowDurationMins ?? 0;
    if (window && mins >= 1_440 && mins > (weekly?.windowDurationMins ?? 0)) {
      weekly = window;
    }
  }
  return weekly ?? (secondary?.windowDurationMins === null ? secondary : null);
}

export function usageElapsedFraction(
  window: UsageWindow,
  now: number,
): number | null {
  if (!window.windowDurationMins || window.resetsAt === null) return null;
  const total = window.windowDurationMins * 60_000;
  const remaining = window.resetsAt * 1000 - now;
  return Math.min(1, Math.max(0, 1 - remaining / total));
}

// Keeps the first letter of the mailbox and domain plus the TLD: j•••@g•••.com.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return `${[...email][0] ?? ""}•••`;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${[...email][0]}•••@${[...host][0] ?? ""}•••${tld}`;
}

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "high";
  return "low";
}

export function resetMinutes(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null) return null;
  return Math.max(0, Math.ceil((window.resetsAt * 1000 - now) / 60_000));
}

export function formatUsageDuration(minutes: number, locale: string): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const units: [Intl.NumberFormatOptions["unit"], number][] =
    days > 0
      ? [
          ["day", days],
          ["hour", hours],
        ]
      : [
          ["hour", hours],
          ["minute", minutes % 60],
        ];
  return units
    .filter(([, value]) => value > 0)
    .map(([unit, value]) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "narrow",
      }).format(value),
    )
    .join(" ");
}

type ListedAccount = { email: string | null; limits: UsageLimits | null };

// Unidentified sources without any quota (logged out, expired token) only add noise.
export function visibleUsageAccounts<A extends ListedAccount>(
  accounts: A[],
): A[] {
  const withUsage = accounts.filter(
    (account) =>
      account.email !== null || usageWindows(account.limits).length > 0,
  );
  return withUsage.length > 0 ? withUsage : accounts.slice(0, 1);
}
