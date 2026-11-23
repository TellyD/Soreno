import { useEffect, type RefObject } from "react";
import { listenCloseTab } from "../../data/appMenuApi";

const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

export function useCloseTabShortcut(closeActiveTab: RefObject<() => boolean>) {
  useEffect(() => {
    if (isMacOS) {
      const unlisten = listenCloseTab(() => closeActiveTab.current()).catch(
        () => undefined,
      );
      return () => void unlisten.then((stop) => stop?.());
    }
    // Capture phase, before the terminal; plain Ctrl+W stays the shell's delete-word.
    function handleCloseShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        event.metaKey ||
        !event.ctrlKey ||
        !event.shiftKey ||
        event.key.toLowerCase() !== "w" ||
        !closeActiveTab.current()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    }
    document.addEventListener("keydown", handleCloseShortcut, true);
    return () =>
      document.removeEventListener("keydown", handleCloseShortcut, true);
  }, []);
}
