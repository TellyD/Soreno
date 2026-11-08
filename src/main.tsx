import React, { type ErrorInfo } from "react";
import "./fonts.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NotificationCenter } from "./components/NotificationCenter";
import { reportWebviewError } from "./data/diagnosticsApi";
import { migrateLegacyStorageKeys } from "./data/legacyStorage";
import { I18nProvider } from "./i18n";
import { AppSettingsProvider } from "./settings";
import { ThemeProvider } from "./theme";

migrateLegacyStorageKeys();

window.addEventListener("error", (event) => {
  reportWebviewError(
    "error",
    event.error ??
      `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  reportWebviewError("unhandledrejection", event.reason);
});

function reportRenderError(error: unknown, info: ErrorInfo) {
  console.error(error);
  reportWebviewError("render", error, info.componentStack ?? undefined);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: reportRenderError,
  onUncaughtError: reportRenderError,
}).render(
  <React.StrictMode>
    <AppSettingsProvider>
      <I18nProvider>
        <ThemeProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
          <NotificationCenter />
        </ThemeProvider>
      </I18nProvider>
    </AppSettingsProvider>
  </React.StrictMode>,
);
