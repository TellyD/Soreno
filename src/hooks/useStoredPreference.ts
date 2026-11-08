import { useCallback, useEffect, useState } from "react";

/** Shares one localStorage preference across every mounted panel and window. */
export function useStoredPreference<T>(
  storageKey: string,
  changeEvent: string,
  parse: (stored: string | null) => T,
) {
  const [value, setValue] = useState(() => {
    try {
      return parse(localStorage.getItem(storageKey));
    } catch {
      return parse(null);
    }
  });

  useEffect(() => {
    const syncCustomEvent = (event: Event) =>
      setValue((event as CustomEvent<T>).detail);
    const syncStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setValue(parse(event.newValue));
    };
    window.addEventListener(changeEvent, syncCustomEvent);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(changeEvent, syncCustomEvent);
      window.removeEventListener("storage", syncStorage);
    };
  }, [storageKey, changeEvent, parse]);

  const change = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* Optional preference. */
      }
      window.dispatchEvent(new CustomEvent<T>(changeEvent, { detail: next }));
    },
    [storageKey, changeEvent],
  );

  return [value, change] as const;
}
