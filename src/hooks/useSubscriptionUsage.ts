import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { UsageAccount } from "../data/subscriptionUsageApi";

const pollIntervalMs = 300_000;

export type SubscriptionUsageState<L> = {
  accounts: UsageAccount<L>[];
  isLoading: boolean;
  updatedAt: number | null;
};

async function isWindowAway() {
  if (document.visibilityState === "hidden") return true;
  return (
    isTauri() &&
    (await getCurrentWindow()
      .isMinimized()
      .catch(() => false))
  );
}

export function useSubscriptionUsage<L>(
  load: () => Promise<UsageAccount<L>[]>,
): SubscriptionUsageState<L> {
  const [state, setState] = useState<SubscriptionUsageState<L>>({
    accounts: [],
    isLoading: true,
    updatedAt: null,
  });

  useEffect(() => {
    let disposed = false;
    let checking = false;
    let request = 0;
    let loadedAt = -Infinity;
    let timer: number | undefined;
    const refresh = async () => {
      if (checking) return;
      checking = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), pollIntervalMs);
      try {
        // A Codex reading starts and stops a process: skip it while nobody sees the result.
        if ((await isWindowAway()) || disposed) return;
      } finally {
        checking = false;
      }
      loadedAt = Date.now();
      const current = ++request;
      setState((previous) => ({ ...previous, isLoading: true }));
      void load().then(
        (accounts) => {
          if (!disposed && current === request) {
            setState({ accounts, isLoading: false, updatedAt: Date.now() });
          }
        },
        () => {
          if (!disposed && current === request) {
            setState({ accounts: [], isLoading: false, updatedAt: null });
          }
        },
      );
    };
    const wake = () => {
      if (Date.now() - loadedAt >= pollIntervalMs) void refresh();
    };

    void refresh();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [load]);

  return state;
}
