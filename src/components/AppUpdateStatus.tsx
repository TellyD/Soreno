import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  relaunchApp,
  releaseAppUpdate,
  type AppUpdate,
  type AppUpdateDownloadEvent,
} from "../data/appUpdater";
import { useI18n } from "../i18n";
import { useNotification } from "../notifications";
import { Button } from "./ui/Button";

type AppUpdateStatusProps = {
  cancelPreparedClose: () => void;
  prepareToClose: () => Promise<boolean>;
};

type UpdatePhase =
  "available" | "downloading" | "ready" | "installing" | "error";

// latest.json is a static release asset, so an hourly poll is cheap.
const updateCheckInterval = 60 * 60_000;

export function AppUpdateStatus({
  cancelPreparedClose,
  prepareToClose,
}: AppUpdateStatusProps) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [phase, setPhase] = useState<UpdatePhase | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const lastCheckRef = useRef(0);
  const offeredUpdateRef = useRef<AppUpdate | null>(null);
  // Set synchronously on click: a pending check result must not replace or
  // release the update being downloaded before React commits the new phase.
  const updateLockedRef = useRef(false);
  // A newer release can replace an offered update until its download starts.
  const checksEnabled = phase === null || phase === "available";

  useEffect(() => {
    if (!checksEnabled) return;
    let disposed = false;
    let checking = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => void check(),
        lastCheckRef.current + updateCheckInterval - Date.now(),
      );
    };
    const check = async () => {
      if (checking) return;
      checking = true;
      window.clearTimeout(timer);
      lastCheckRef.current = Date.now();
      try {
        const found = await checkForAppUpdate();
        if (!found) return;
        const offered = offeredUpdateRef.current;
        if (
          disposed ||
          updateLockedRef.current ||
          offered?.version === found.version
        ) {
          releaseAppUpdate(found);
          return;
        }
        offeredUpdateRef.current = found;
        setUpdate(found);
        setPhase("available");
        if (offered) releaseAppUpdate(offered);
      } catch {
        // Background checks stay silent; the next scheduled check retries.
      } finally {
        checking = false;
        if (!disposed) schedule();
      }
    };
    // Timers stall while the machine sleeps; catch up when the user returns.
    const wake = () => {
      if (
        document.visibilityState !== "hidden" &&
        Date.now() - lastCheckRef.current >= updateCheckInterval
      )
        void check();
    };

    if (Date.now() - lastCheckRef.current >= updateCheckInterval) void check();
    else schedule();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [checksEnabled]);

  const handleDownloadEvent = (event: AppUpdateDownloadEvent) => {
    switch (event.event) {
      case "Started":
        setDownloadedBytes(0);
        setContentLength(event.data.contentLength ?? null);
        break;
      case "Progress":
        setDownloadedBytes((current) => current + event.data.chunkLength);
        break;
      case "Finished":
        setDownloadedBytes((current) => contentLength ?? current);
        break;
    }
  };

  const runUpdate = async () => {
    const current = offeredUpdateRef.current;
    if (!current || phase === "downloading" || phase === "installing") return;
    updateLockedRef.current = true;

    if (!downloaded) {
      setPhase("downloading");
      try {
        await downloadAppUpdate(current, handleDownloadEvent);
        setDownloaded(true);
        setPhase("ready");
      } catch {
        setPhase("error");
        return;
      }
    }

    let prepared = false;
    try {
      prepared = await prepareToClose();
    } catch {
      cancelPreparedClose();
      setPhase("error");
      return;
    }
    if (!prepared) {
      setPhase("ready");
      return;
    }

    setPhase("installing");
    try {
      if (!installed) {
        await installAppUpdate(current);
        setInstalled(true);
      }
      await relaunchApp();
    } catch {
      cancelPreparedClose();
      setPhase("error");
    }
  };

  useNotification(
    phase === "error"
      ? {
          key: "app-update",
          message: t("updates.failed"),
          action: {
            label: t("updates.retry"),
            onAction: () => void runUpdate(),
          },
          onDismiss: () => {
            if (!downloaded) updateLockedRef.current = false;
            setPhase(downloaded ? "ready" : "available");
          },
        }
      : null,
  );

  if (!update || !phase || phase === "error") return null;

  const progress = contentLength
    ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
    : null;

  return (
    <div className="status-segment app-update-status">
      {phase === "available" ? (
        <Button size="small" startIcon={<Download />} onClick={runUpdate}>
          {t("updates.available", { version: update.version })}
        </Button>
      ) : null}
      {phase === "downloading" ? (
        <span role="status" aria-live="polite">
          {progress === null
            ? t("updates.downloading")
            : t("updates.downloadingProgress", { progress })}
        </span>
      ) : null}
      {phase === "ready" ? (
        <Button size="small" title={t("updates.blocked")} onClick={runUpdate}>
          {t("updates.installAndRestart")}
        </Button>
      ) : null}
      {phase === "installing" ? (
        <span role="status" aria-live="polite">
          {t("updates.installing")}
        </span>
      ) : null}
    </div>
  );
}
