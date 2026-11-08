// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getClaudeUsage,
  getCodexUsage,
  type ClaudeRateLimits,
  type CodexRateLimits,
  type UsageAccount,
} from "../data/subscriptionUsageApi";
import { I18nProvider } from "../i18n";
import { SubscriptionUsage } from "./SubscriptionUsage";

const updateSettings = vi.fn();
let selectedCodex: string | null = null;
vi.mock("../data/subscriptionUsageApi", () => ({
  getClaudeUsage: vi.fn(),
  getCodexUsage: vi.fn(),
}));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: {
      languagePreference: "fr",
      claudeUsageAccountId: null,
      codexUsageAccountId: selectedCodex,
    },
    updateSettings,
  }),
}));

let root: Root;
let container: HTMLDivElement;
const now = new Date("2026-06-01T12:00:00Z").getTime();
const local = [{ key: "local", kind: "local" as const, label: null }];
const claudeAccount = (
  limits: Partial<ClaudeRateLimits>,
): UsageAccount<ClaudeRateLimits> => ({
  id: "account:uuid",
  email: "dev@example.com",
  sources: local,
  limits: {
    // 5 h window, 4 h left: 20 % elapsed.
    primary: {
      usedPercent: 3,
      windowDurationMins: 300,
      resetsAt: now / 1000 + 14_400,
    },
    // 7 d window, 6 d 14 h left: 6 % elapsed.
    secondary: {
      usedPercent: 4,
      windowDurationMins: 10_080,
      resetsAt: now / 1000 + 568_800,
    },
    models: [],
    stale: false,
    expired: false,
    ...limits,
  },
});
const codexAccount: UsageAccount<CodexRateLimits> = {
  id: "account:dev@example.com",
  email: "dev@example.com",
  sources: local,
  limits: {
    primary: null,
    secondary: { usedPercent: 92, windowDurationMins: 10_080, resetsAt: null },
  },
};
const sshCodexAccount: UsageAccount<CodexRateLimits> = {
  id: "source:ssh:me@h:",
  email: null,
  sources: [{ key: "ssh:me@h:", kind: "ssh", label: "me@h" }],
  limits: {
    primary: null,
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  selectedCodex = null;
  updateSettings.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  // Focus changes queue jsdom's zero-delay `selectionchange` dispatch.
  vi.advanceTimersByTime(0);
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function renderUsage() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <SubscriptionUsage />
      </I18nProvider>,
    ),
  );
}
const trigger = () =>
  container.querySelector<HTMLButtonElement>(".subscription-usage-button")!;
const cards = () => [
  ...container.querySelectorAll<HTMLElement>(".subscription-usage-card"),
];
async function openPanel() {
  await act(async () => trigger().click());
}

it("details every window with reset and model caps, emails masked", async () => {
  vi.mocked(getClaudeUsage).mockResolvedValue([
    claudeAccount({
      models: [
        {
          model: "opus",
          window: {
            usedPercent: 0,
            windowDurationMins: 10_080,
            resetsAt: null,
          },
        },
      ],
    }),
  ]);
  vi.mocked(getCodexUsage).mockResolvedValue([codexAccount]);
  await renderUsage();
  expect(trigger().getAttribute("aria-label")).toContain(
    "Claude · d•••@e•••.com\n5h : 3 % utilisés · 4h\n7j : 4 % utilisés · 6j 14h",
  );
  await openPanel();
  const [claude, codex] = cards();
  expect(container.querySelector("[role=dialog]")?.textContent).not.toContain(
    "dev@example.com",
  );
  expect(claude.querySelector("strong")?.textContent).toBe("d•••@e•••.com");
  const meters = [...claude.querySelectorAll("[role=meter]")];
  expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual([
    "3",
    "4",
    "0",
  ]);
  expect(
    meters[0].querySelector(".subscription-usage-meter-pace"),
  ).not.toBeNull();
  expect(codex.querySelector("[role=meter]")?.getAttribute("data-level")).toBe(
    "critical",
  );
  // No reset time means no elapsed share to mark.
  expect(codex.querySelector(".subscription-usage-meter-pace")).toBeNull();
  expect(
    codex.querySelector(".subscription-usage-card-status")?.textContent,
  ).toBe("À l’instant");
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(
    codex.querySelector(".subscription-usage-card-status")?.textContent,
  ).toMatch(/^il y a\s2\smin$/);
});

it("never presents unavailable usage as zero and refreshes on the poll", async () => {
  vi.mocked(getClaudeUsage).mockRejectedValue(new Error("offline"));
  vi.mocked(getCodexUsage).mockResolvedValue([
    {
      ...codexAccount,
      id: "source:local",
      email: null,
      limits: null,
    },
  ]);
  await renderUsage();
  expect(trigger().textContent).toBe("——");
  expect(container.querySelector(".subscription-usage-meter")).toBeNull();
  await openPanel();
  const [claude, codex] = cards();
  expect(claude.textContent).toContain("Usage Claude indisponible");
  expect(codex.textContent).toContain("Compte inconnu");
  expect(codex.textContent).toContain("Usage Codex indisponible");
  expect(container.querySelector("[role=meter]")).toBeNull();

  vi.mocked(getClaudeUsage).mockResolvedValue([
    claudeAccount({ stale: true, expired: true }),
  ]);
  await act(async () => vi.advanceTimersByTimeAsync(299_999));
  expect(getClaudeUsage).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(getClaudeUsage).toHaveBeenCalledTimes(2);
  const [expired] = cards();
  expect(
    expired.querySelector(".subscription-usage-card-status")?.textContent,
  ).toBe("Dernière valeur connue");
  // The last known quota stays visible alongside the sign-in hint.
  expect(expired.querySelectorAll("[role=meter]")).toHaveLength(2);
  expect(expired.textContent).toContain("Session Claude expirée");
  expect(trigger().getAttribute("aria-label")).toContain(
    "Dernière valeur connue\nSession Claude expirée",
  );
});

it("hides unidentified empty sources and remembers the account shown in the status bar", async () => {
  selectedCodex = sshCodexAccount.id;
  vi.mocked(getClaudeUsage).mockResolvedValue([]);
  vi.mocked(getCodexUsage).mockResolvedValue([
    codexAccount,
    {
      ...sshCodexAccount,
      sources: [
        ...sshCodexAccount.sources,
        { key: "wsl:ubuntu-24.04", kind: "wsl", label: "Ubuntu-24.04" },
        { key: "wsl:debian", kind: "wsl", label: "Debian" },
      ],
    },
    { ...sshCodexAccount, id: "source:ssh:@x:", limits: null },
  ]);
  await renderUsage();
  expect(trigger().getAttribute("aria-label")).toContain(
    "Codex · Compte inconnu\n7j : 40 % utilisés",
  );
  await openPanel();
  const [, local, remote] = cards();
  expect(cards()).toHaveLength(3);
  // Environment kinds only: host names and distributions stay out of the panel.
  expect(remote.querySelector("small")?.textContent).toBe("Codex · SSH, WSL");
  const pressed = [local, remote].map((card) =>
    card.querySelector("button")?.getAttribute("aria-pressed"),
  );
  expect(pressed).toEqual(["false", "true"]);
  await act(async () => local.querySelector("button")?.click());
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
    codexUsageAccountId: codexAccount.id,
  });
  expect(container.querySelector("[role=dialog]")).not.toBeNull();
});

it("does not offer a choice for a single account and closes on Escape", async () => {
  vi.mocked(getClaudeUsage).mockResolvedValue([claudeAccount({})]);
  vi.mocked(getCodexUsage).mockResolvedValue([codexAccount]);
  await renderUsage();
  await openPanel();
  const dialog = container.querySelector("[role=dialog]");
  expect(document.activeElement).toBe(dialog);
  expect(container.querySelector(".subscription-usage-card button")).toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  expect(container.querySelector("[role=dialog]")).toBeNull();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
});

it("shows the weekly usage in the status bar even when the 5 h window is higher", async () => {
  vi.mocked(getClaudeUsage).mockResolvedValue([
    claudeAccount({
      primary: { usedPercent: 19, windowDurationMins: 300, resetsAt: null },
    }),
  ]);
  vi.mocked(getCodexUsage).mockResolvedValue([codexAccount]);
  await renderUsage();
  expect(
    [...container.querySelectorAll(".subscription-usage-percent")].map(
      (percent) => percent.textContent?.replace(/\s/g, " "),
    ),
  ).toEqual(["4 %", "92 %"]);
});

it("names windows of unknown duration after their slot", async () => {
  vi.mocked(getClaudeUsage).mockResolvedValue([]);
  vi.mocked(getCodexUsage).mockResolvedValue([
    {
      ...codexAccount,
      limits: {
        primary: null,
        secondary: {
          usedPercent: 10,
          windowDurationMins: null,
          resetsAt: null,
        },
      },
    },
  ]);
  await renderUsage();
  expect(trigger().getAttribute("aria-label")).toContain(
    "Fenêtre longue : 10 % utilisés",
  );
});
