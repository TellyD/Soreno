import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  getClaudeUsage,
  getCodexUsage,
  type UsageAccount,
} from "../data/subscriptionUsageApi";
import {
  formatUsageDuration,
  maskEmail,
  resetMinutes,
  usageElapsedFraction,
  usageLevel,
  usageWindows,
  visibleUsageAccounts,
  weeklyUsageWindow,
  type UsageLimits,
  type UsageWindowEntry,
} from "../domain/subscriptionUsage";
import {
  useSubscriptionUsage,
  type SubscriptionUsageState,
} from "../hooks/useSubscriptionUsage";
import { useI18n, type TranslationKey } from "../i18n";
import { notifyError } from "../notifications";
import { useAppSettings } from "../settings";
import { MenuSurface } from "./ui/Menu";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";
import "./SubscriptionUsage.css";

type UsageProvider = {
  id: "claude" | "codex";
  name: string;
  product: string;
  logoClassName: string;
  selectionSetting: "claudeUsageAccountId" | "codexUsageAccountId";
  loading: TranslationKey;
  unavailable: TranslationKey;
  expired?: TranslationKey;
};

type ProviderUsage = {
  provider: UsageProvider;
  listed: UsageAccount<UsageLimits>[];
  displayed: UsageAccount<UsageLimits> | null;
  usage: SubscriptionUsageState<UsageLimits>;
};

const claude: UsageProvider = {
  id: "claude",
  name: "Claude",
  product: "Claude Code",
  logoClassName: "claude-usage-logo",
  selectionSetting: "claudeUsageAccountId",
  loading: "status.claude.loading",
  unavailable: "status.claude.unavailable",
  expired: "status.claude.expired",
};

const codex: UsageProvider = {
  id: "codex",
  name: "Codex",
  product: "Codex",
  logoClassName: "codex-usage-logo",
  selectionSetting: "codexUsageAccountId",
  loading: "status.codex.loading",
  unavailable: "status.codex.unavailable",
};

function useUsageLabels() {
  const { locale, t } = useI18n();
  const percent = new Intl.NumberFormat(locale, { style: "percent" });

  return {
    accountTitle: (account: UsageAccount<UsageLimits>) =>
      account.email
        ? maskEmail(account.email)
        : t("status.usage.unknownAccount"),
    sources: (account: UsageAccount<UsageLimits>) =>
      [
        ...new Set(
          account.sources.map((source) =>
            source.kind === "local"
              ? t("status.usage.local")
              : source.kind.toUpperCase(),
          ),
        ),
      ].join(", "),
    windowLabel: ({ key, model, window }: UsageWindowEntry) =>
      model
        ? `${model.charAt(0).toUpperCase()}${model.slice(1)}`
        : window.windowDurationMins
          ? formatUsageDuration(window.windowDurationMins, locale)
          : t(
              key === "primary"
                ? "status.usage.window.primary"
                : "status.usage.window.secondary",
            ),
    percent: (value: number) => percent.format(value / 100),
    reset: (minutes: number | null) =>
      minutes === null
        ? ""
        : minutes === 0
          ? t("status.codex.resetPending")
          : formatUsageDuration(minutes, locale),
    resetDate: (resetsAt: number | null) =>
      resetsAt === null
        ? undefined
        : t("status.codex.resetsAt", {
            date: new Date(resetsAt * 1000).toLocaleString(locale),
          }),
    updated: (updatedAt: number, now: number) => {
      const minutes = Math.floor((now - updatedAt) / 60_000);
      if (minutes < 1) return t("status.usage.updatedNow");
      const relative = new Intl.RelativeTimeFormat(locale, { style: "short" });
      return minutes < 60
        ? relative.format(-minutes, "minute")
        : relative.format(-Math.floor(minutes / 60), "hour");
    },
  };
}

function usageMessage(
  provider: UsageProvider,
  account: UsageAccount<UsageLimits> | null,
  isLoading: boolean,
): TranslationKey {
  if (isLoading) return provider.loading;
  return (account?.limits?.expired && provider.expired) || provider.unavailable;
}

function providerUsage(
  provider: UsageProvider,
  usage: SubscriptionUsageState<UsageLimits>,
  selectedId: string | null,
): ProviderUsage {
  const listed = visibleUsageAccounts(usage.accounts);
  return {
    provider,
    listed,
    displayed:
      listed.find((account) => account.id === selectedId) ?? listed[0] ?? null,
    usage,
  };
}

export function SubscriptionUsage() {
  const { t } = useI18n();
  const { settings, updateSettings } = useAppSettings();
  const labels = useUsageLabels();
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closePanel = () => {
    // Removing the focused panel would drop focus on <body>. After a pointer
    // dismissal the browser then focuses the clicked target itself.
    if (panelRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    setIsOpen(false);
  };
  const layerRef = useDismissibleLayer<HTMLDivElement>(isOpen, closePanel);
  const claudeUsage = useSubscriptionUsage<UsageLimits>(getClaudeUsage);
  const codexUsage = useSubscriptionUsage<UsageLimits>(getCodexUsage);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    setNow(Date.now());
  }, [claudeUsage.updatedAt, codexUsage.updatedAt]);

  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  const providers = [
    providerUsage(claude, claudeUsage, settings.claudeUsageAccountId),
    providerUsage(codex, codexUsage, settings.codexUsageAccountId),
  ];

  const summary = providers
    .flatMap(({ provider, displayed, usage }) => {
      const windows = usageWindows(displayed?.limits);
      if (!displayed || windows.length === 0) {
        return [t(usageMessage(provider, displayed, usage.isLoading))];
      }
      return [
        `${provider.name} · ${labels.accountTitle(displayed)}`,
        ...(displayed.limits?.stale ? [t("status.claude.stale")] : []),
        ...(displayed.limits?.expired && provider.expired
          ? [t(provider.expired)]
          : []),
        ...windows.map((entry) => {
          const reset = labels.reset(resetMinutes(entry.window, now));
          return `${labels.windowLabel(entry)} : ${t("status.codex.used", {
            percent: entry.window.usedPercent,
          })}${reset ? ` · ${reset}` : ""}`;
        }),
      ];
    })
    .join("\n");

  return (
    <div className="status-segment subscription-usage" ref={layerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="subscription-usage-button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={summary}
        title={summary}
        aria-busy={claudeUsage.isLoading || codexUsage.isLoading}
        onClick={() => (isOpen ? closePanel() : setIsOpen(true))}
      >
        {providers.map(({ provider, displayed, usage }) => {
          const weekly = weeklyUsageWindow(displayed?.limits);
          return (
            <span className="subscription-usage-summary" key={provider.id}>
              <span className={provider.logoClassName} aria-hidden="true" />
              {weekly ? (
                <>
                  <UsageMeter compact percent={weekly.usedPercent} />
                  <span className="subscription-usage-percent">
                    {labels.percent(weekly.usedPercent)}
                  </span>
                </>
              ) : usage.isLoading ? (
                <LoaderCircle
                  size={12}
                  className="app-loading-spinner"
                  aria-hidden="true"
                />
              ) : (
                <span aria-hidden="true">—</span>
              )}
            </span>
          );
        })}
      </button>
      {isOpen ? (
        <MenuSurface
          ref={panelRef}
          className="subscription-usage-panel"
          role="dialog"
          aria-label={t("status.usage.title")}
          tabIndex={-1}
        >
          {providers.flatMap(({ provider, listed, displayed, usage }) =>
            listed.length === 0 ? (
              <UsageCard
                key={provider.id}
                account={null}
                now={now}
                provider={provider}
                selected={false}
                usage={usage}
              />
            ) : (
              listed.map((account) => (
                <UsageCard
                  key={`${provider.id}:${account.id}`}
                  account={account}
                  now={now}
                  onSelect={
                    listed.length > 1
                      ? () =>
                          void updateSettings({
                            [provider.selectionSetting]: account.id,
                          }).catch(() => notifyError(t("settings.updateError")))
                      : undefined
                  }
                  provider={provider}
                  selected={listed.length > 1 && account.id === displayed?.id}
                  usage={usage}
                />
              ))
            ),
          )}
        </MenuSurface>
      ) : null}
    </div>
  );
}

type UsageCardProps = {
  account: UsageAccount<UsageLimits> | null;
  now: number;
  onSelect?: () => void;
  provider: UsageProvider;
  selected: boolean;
  usage: SubscriptionUsageState<UsageLimits>;
};

function UsageCard({
  account,
  now,
  onSelect,
  provider,
  selected,
  usage,
}: UsageCardProps) {
  const { t } = useI18n();
  const labels = useUsageLabels();
  const windows = usageWindows(account?.limits);
  const status = account?.limits?.stale
    ? t("status.claude.stale")
    : usage.updatedAt !== null && account
      ? labels.updated(usage.updatedAt, now)
      : null;
  const message =
    windows.length === 0
      ? usageMessage(provider, account, usage.isLoading)
      : account?.limits?.expired
        ? provider.expired
        : undefined;
  const title = account ? labels.accountTitle(account) : provider.name;
  const subtitle = account
    ? `${provider.product} · ${labels.sources(account)}`
    : provider.product;
  const header = (
    <>
      <span className="subscription-usage-card-logo" aria-hidden="true">
        <span className={provider.logoClassName} />
      </span>
      <span className="subscription-usage-card-identity">
        <strong title={title}>{title}</strong>
        <small title={subtitle}>{subtitle}</small>
      </span>
      {status ? (
        <span className="subscription-usage-card-status">{status}</span>
      ) : null}
    </>
  );

  return (
    <section
      className={`subscription-usage-card${selected ? " selected" : ""}`}
    >
      {onSelect ? (
        <button
          type="button"
          className="subscription-usage-card-header"
          aria-pressed={selected}
          title={t("status.usage.showInStatusBar")}
          onClick={onSelect}
        >
          {header}
        </button>
      ) : (
        <div className="subscription-usage-card-header">{header}</div>
      )}
      {windows.length > 0 ? (
        <div className="subscription-usage-windows">
          {windows.map((entry) => {
            const label = labels.windowLabel(entry);
            const elapsed = usageElapsedFraction(entry.window, now);
            return (
              <div className="subscription-usage-window" key={entry.key}>
                <span>{label}</span>
                <UsageMeter
                  elapsed={elapsed}
                  label={label}
                  percent={entry.window.usedPercent}
                />
                <span>{labels.percent(entry.window.usedPercent)}</span>
                <span title={labels.resetDate(entry.window.resetsAt)}>
                  {labels.reset(resetMinutes(entry.window, now))}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {message ? (
        <p className="subscription-usage-card-message">
          {message === provider.loading ? (
            <LoaderCircle
              size={12}
              className="app-loading-spinner"
              aria-hidden="true"
            />
          ) : null}
          {t(message)}
        </p>
      ) : null}
    </section>
  );
}

type UsageMeterProps = {
  compact?: boolean;
  elapsed?: number | null;
  label?: string;
  percent: number;
};

function UsageMeter({
  compact = false,
  elapsed,
  label,
  percent,
}: UsageMeterProps) {
  const { t } = useI18n();
  const style = {
    "--usage-percent": `${percent}%`,
    ...(elapsed == null ? {} : { "--usage-elapsed": `${elapsed * 100}%` }),
  } as CSSProperties;
  return (
    <span
      className={`subscription-usage-meter${compact ? " compact" : ""}`}
      data-level={usageLevel(percent)}
      style={style}
      {...(compact
        ? { "aria-hidden": true }
        : {
            role: "meter",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": percent,
            "aria-valuetext": t("status.codex.used", { percent }),
          })}
    >
      {elapsed == null ? null : (
        <span className="subscription-usage-meter-pace" />
      )}
    </span>
  );
}
