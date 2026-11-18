import { BundleType, getBundleType } from "@tauri-apps/api/app";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

export type AppUpdate = Update;
export type AppUpdateDownloadEvent = DownloadEvent;

// RPM 6 refuses the plugin's unsigned `rpm -U`: Rust downloads and installs these.
const rpmPackages = new WeakMap<AppUpdate, number>();

export async function checkForAppUpdate(): Promise<AppUpdate | null> {
  if (!import.meta.env.PROD || !isTauri()) return null;
  return check();
}

export async function downloadAppUpdate(
  update: AppUpdate,
  onEvent: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  if ((await getBundleType()) !== BundleType.Rpm) {
    await update.download(onEvent);
    return;
  }
  const rid = await invoke<number>("download_rpm_update", {
    rid: update.rid,
    onEvent: new Channel(onEvent),
  });
  rpmPackages.set(update, rid);
}

export async function installAppUpdate(update: AppUpdate): Promise<void> {
  const rid = rpmPackages.get(update);
  if (rid === undefined) await update.install({ restartAfterInstall: true });
  else await invoke("install_rpm_update", { rid });
}

export function releaseAppUpdate(update: AppUpdate): void {
  void update.close().catch(() => undefined);
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
