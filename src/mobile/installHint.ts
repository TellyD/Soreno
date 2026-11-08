import { readStorage, writeStorage } from "./mobileStorage";

export type InstallPlatform = "ios" | "android" | "other";

/** Which steps to show: an installed app can only have its icon put back, with the gestures of its system. */
export type InstallGuide =
  InstallPlatform | "installedIos" | "installedAndroid";

const DISMISSED_KEY = "soreno-mobile-install-hint-dismissed";

export function installPlatform(
  userAgent: string,
  maxTouchPoints: number,
): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  // iPadOS reports a desktop Mac user agent; only its touch screen tells it apart.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

export function shouldShowInstallHint(standalone: boolean, dismissed: boolean) {
  return !standalone && !dismissed;
}

export function installGuide(
  platform: InstallPlatform,
  standalone: boolean,
): InstallGuide {
  if (!standalone) return platform;
  return platform === "ios" ? "installedIos" : "installedAndroid";
}

export function isInstalledGuide(guide: InstallGuide) {
  return guide === "installedIos" || guide === "installedAndroid";
}

export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function loadInstallHintDismissed() {
  return readStorage(DISMISSED_KEY) === "1";
}

export function saveInstallHintDismissed() {
  writeStorage(DISMISSED_KEY, "1");
}

type InstallPromptEvent = Event & { prompt(): Promise<void> };

let installPrompt: InstallPromptEvent | null = null;

/** Chrome offers its install dialog once, early: keep it for the menu. */
export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
  });
}

/** `false` when the browser offers no install dialog: show the manual steps instead. */
export async function promptInstall() {
  const event = installPrompt;
  if (!event) return false;
  installPrompt = null;
  await event.prompt();
  return true;
}
