import { LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  changelogVersions,
  getLastSeenVersion,
  loadChangelog,
  markVersionSeen,
} from "../data/releaseNotesApi";
import { hasTauriRuntime } from "../data/tauriRuntime";
import { pendingReleaseNotes } from "../domain/releaseNotes";
import { useI18n } from "../i18n";
import { MarkdownContent } from "./MarkdownContent";
import { Button } from "./ui/Button";
import { DialogOverlay, DialogSurface } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";
import "./ReleaseNotes.css";

type OpenReleaseNotes = {
  versions: string[];
  // Only the dialog opened after an update records the version as seen.
  acknowledgeOnClose: boolean;
};

export function ReleaseNotes({ version }: { version: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<OpenReleaseNotes | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let isCurrent = true;
    // Best effort: an unreadable marker only delays the changelog to a later launch.
    void getLastSeenVersion()
      .then((lastSeen) => {
        const versions = pendingReleaseNotes(
          lastSeen,
          version,
          changelogVersions,
        );
        if (!isCurrent || !versions) return;
        if (versions.length > 0)
          setOpen({ versions, acknowledgeOnClose: true });
        else void markVersionSeen().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [version]);

  if (!changelogVersions.includes(version)) {
    return <span title={`Soreno ${version}`}>v{version}</span>;
  }

  const close = (displayed: boolean) => {
    if (open?.acknowledgeOnClose && displayed) {
      void markVersionSeen().catch(() => undefined);
    }
    setOpen(null);
  };

  return (
    <>
      <button
        className="release-notes-trigger"
        ref={triggerRef}
        title={t("releaseNotes.open", { version })}
        type="button"
        onClick={() =>
          setOpen({ versions: [version], acknowledgeOnClose: false })
        }
      >
        v{version}
      </button>
      {open
        ? createPortal(
            <ReleaseNotesDialog
              key={open.versions.join(" ")}
              returnFocusRef={triggerRef}
              versions={open.versions}
              onClose={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function ReleaseNotesDialog({
  returnFocusRef,
  versions,
  onClose,
}: {
  returnFocusRef: RefObject<HTMLElement | null>;
  versions: string[];
  // Reports whether the changelogs were rendered, so a failed load is not acknowledged.
  onClose: (displayed: boolean) => void;
}) {
  const { language, t } = useI18n();
  const titleId = useId();
  const [changelogs, setChangelogs] = useState<string[] | "error" | null>(null);
  const close = () => onClose(Array.isArray(changelogs));
  const dialogRef = useDismissibleLayer<HTMLElement>(true, close);

  useEffect(() => {
    let isCurrent = true;
    Promise.all(
      versions.map((version) => loadChangelog(version, language)),
    ).then(
      (loaded) => {
        if (isCurrent) setChangelogs(loaded);
      },
      () => {
        if (isCurrent) setChangelogs("error");
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [language, versions]);

  return (
    <DialogOverlay>
      <DialogSurface
        aria-labelledby={titleId}
        className="release-notes-dialog"
        ref={dialogRef}
        returnFocusRef={returnFocusRef}
      >
        <header className="release-notes-header">
          <h2 id={titleId}>Soreno {versions[0]}</h2>
          <IconButton aria-label={t("releaseNotes.close")} onClick={close}>
            <X />
          </IconButton>
        </header>
        <div
          aria-label={t("releaseNotes.content")}
          className="release-notes-body"
          role="region"
          tabIndex={0}
        >
          {changelogs === "error" ? (
            <p className="release-notes-status">
              {t("releaseNotes.loadError")}
            </p>
          ) : changelogs ? (
            changelogs.map((changelog, index) => (
              <MarkdownContent
                className="release-notes-content"
                // The dialog title already names the newest version.
                content={
                  index === 0 ? changelog.replace(/^# .*\s*/, "") : changelog
                }
                key={versions[index]}
              />
            ))
          ) : (
            <p className="release-notes-status" role="status">
              <LoaderCircle className="app-loading-spinner" size={14} />
              {t("releaseNotes.loading")}
            </p>
          )}
        </div>
        <footer className="release-notes-footer">
          <Button autoFocus onClick={close} variant="primary">
            {t("releaseNotes.dismiss")}
          </Button>
        </footer>
      </DialogSurface>
    </DialogOverlay>
  );
}
