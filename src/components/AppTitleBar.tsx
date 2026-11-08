import "./AppTitleBar.css";

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import appIcon from "../../src-tauri/icons/32x32.png";
import { useI18n } from "../i18n";
import { notifyError } from "../notifications";

const appName = "Soreno";
const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";
type WindowCommand = (window: Window) => Promise<void>;

function runWindowCommand(command: WindowCommand, errorMessage: string) {
  if (!isTauri()) {
    return;
  }

  void command(getCurrentWindow()).catch(() => notifyError(errorMessage));
}

export function AppTitleBar() {
  const { t } = useI18n();

  const handleMaximize = () => {
    runWindowCommand(
      (window) => window.toggleMaximize(),
      t("window.actionError"),
    );
  };

  const handleMinimize = () => {
    runWindowCommand((window) => window.minimize(), t("window.actionError"));
  };

  const handleClose = () => {
    runWindowCommand((window) => window.close(), t("window.actionError"));
  };

  return (
    <header className={`app-title-bar${isMacOS ? " app-title-bar-macos" : ""}`}>
      {isMacOS ? (
        <div className="app-title-macos-controls-space" aria-hidden="true" />
      ) : (
        <div
          className="app-title-bar-brand"
          aria-label={appName}
          data-tauri-drag-region="deep"
        >
          <span className="app-title-icon" aria-hidden="true">
            <img
              src={appIcon}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </span>
          <span className="app-title-name">{appName}</span>
        </div>
      )}
      <div className="app-title-drag-region" data-tauri-drag-region />

      {isMacOS ? null : (
        <div className="app-title-window-controls">
          <button
            aria-label={t("window.minimize")}
            onClick={handleMinimize}
            title={t("window.minimize")}
            type="button"
          >
            <Minus aria-hidden="true" size={15} />
          </button>
          <button
            aria-label={t("window.maximize")}
            className="app-title-window-control-maximize"
            onClick={handleMaximize}
            title={t("window.maximize")}
            type="button"
          >
            <Square aria-hidden="true" size={13} />
          </button>
          <button
            aria-label={t("window.close")}
            className="app-title-window-control-close"
            onClick={handleClose}
            title={t("window.close")}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}
    </header>
  );
}
