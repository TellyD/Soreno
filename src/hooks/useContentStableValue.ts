import { useMemo } from "react";

/** Keeps one reference while the JSON content of a rebuilt value is unchanged. */
export function useContentStableValue<T>(value: T) {
  const key = JSON.stringify(value);
  const stable = useMemo(() => JSON.parse(key) as T, [key]);
  return [key, stable] as const;
}
