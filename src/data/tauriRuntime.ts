export function hasTauriRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    isTauri?: boolean;
  };

  return Boolean(
    runtime.isTauri ||
    typeof runtime.__TAURI_INTERNALS__?.invoke === "function",
  );
}
