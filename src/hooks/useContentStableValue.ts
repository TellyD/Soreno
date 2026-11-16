import { useMemo } from "react";

/** Keeps one reference while the JSON content of a rebuilt value is unchanged. */
export function useContentStableValue<T>(value: T) {
  const key = JSON.stringify(value);
  return useMemo(() => [key, JSON.parse(key) as T] as const, [key]);
}
