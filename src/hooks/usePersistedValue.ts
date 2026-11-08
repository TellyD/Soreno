import { useEffect, useRef } from "react";

export function usePersistedValue<T>(
  key: string,
  value: T,
  serialize: (value: T) => unknown = (value) => value,
) {
  const persisted = useRef(value);
  useEffect(() => {
    if (persisted.current === value) return;
    persisted.current = value;
    try {
      localStorage.setItem(key, JSON.stringify(serialize(value)));
    } catch {
      /* Storage is optional; keep the value in memory. */
    }
  }, [value]);
}
