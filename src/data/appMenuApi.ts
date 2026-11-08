import { listen } from "@tauri-apps/api/event";

/** "Settings…" was chosen in the macOS app menu. */
export const listenOpenSettings = (onOpen: () => void) =>
  listen("open-settings", () => onOpen());

/** "Close Tab" (Cmd+W) was chosen in the macOS menu. */
export const listenCloseTab = (onClose: () => void) =>
  listen("close-tab", () => onClose());
