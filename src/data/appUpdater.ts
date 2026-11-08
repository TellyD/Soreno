import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

export type AppUpdate = Update;
export type AppUpdateDownloadEvent = DownloadEvent;

export async function checkForAppUpdate(): Promise<AppUpdate | null> {
  if (!import.meta.env.PROD || !isTauri()) return null;
  return check();
}

export async function downloadAppUpdate(
  update: AppUpdate,
  onEvent: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  await update.download(onEvent);
}

export async function installAppUpdate(update: AppUpdate): Promise<void> {
  await update.install({ restartAfterInstall: true });
}

export function releaseAppUpdate(update: AppUpdate): void {
  void update.close().catch(() => undefined);
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
