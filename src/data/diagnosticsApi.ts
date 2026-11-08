import { invoke } from "@tauri-apps/api/core";
import { describeError } from "../domain/errors";
import { hasTauriRuntime } from "./tauriRuntime";

// An error repeated every frame must not flood the log.
const REPORT_LIMIT = 20;
let reportCount = 0;

export function reportWebviewError(
  source: string,
  error: unknown,
  detail?: string,
) {
  if (!hasTauriRuntime() || reportCount >= REPORT_LIMIT) return;
  reportCount += 1;
  const message = [`${source} ${describeError(error)}`, detail]
    .filter(Boolean)
    .join("\n");
  void invoke<void>("log_webview_error", { message }).catch(() => {});
}

export function openLogDirectory() {
  return invoke<void>("open_log_directory");
}
