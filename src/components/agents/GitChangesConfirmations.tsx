import { LoaderCircle, X } from "lucide-react";
import { useId } from "react";
import { createPortal } from "react-dom";
import type { GitChangesConfirmationsState } from "../../hooks/useGitChangesMutations";
import { useNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useGitStrings } from "./gitStrings";

function IdentityDialog({
  busy,
  changed,
  name,
  email,
  global,
  onName,
  onEmail,
  onGlobal,
  onCancel,
  onSave,
}: {
  busy: boolean;
  changed: boolean;
  name: string;
  email: string;
  global: boolean;
  onName: (value: string) => void;
  onEmail: (value: string) => void;
  onGlobal: (value: boolean) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const s = useGitStrings();
  const titleId = useId();
  const descriptionId = useId();
  const nameId = useId();
  const emailId = useId();
  const ref = useDismissibleLayer<HTMLElement>(true, onCancel);
  return (
    <DialogOverlay className="git-dialog-overlay">
      <DialogSurface
        className="form-dialog"
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <header>
            <div>
              <h2 id={titleId}>{s.identityTitle}</h2>
              <p id={descriptionId}>{s.identityDescription}</p>
            </div>
            <IconButton
              aria-label={s.cancel}
              disabled={busy}
              onClick={onCancel}
            >
              <X />
            </IconButton>
          </header>
          <fieldset className="form-dialog-body" disabled={busy}>
            <label htmlFor={nameId}>{s.identityName}</label>
            <Input
              id={nameId}
              autoComplete="name"
              value={name}
              onChange={(event) => onName(event.currentTarget.value)}
            />
            <label htmlFor={emailId}>{s.identityEmail}</label>
            <Input
              id={emailId}
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => onEmail(event.currentTarget.value)}
            />
            <label className="form-dialog-option">
              <Checkbox
                checked={global}
                disabled={busy}
                onCheckedChange={onGlobal}
              />
              {s.identityGlobal}
            </label>
          </fieldset>
          <footer>
            <Button disabled={busy} onClick={onCancel}>
              {s.cancel}
            </Button>
            <Button
              aria-busy={busy || undefined}
              variant="primary"
              type="submit"
              disabled={busy || changed || !name.trim() || !email.trim()}
              startIcon={
                busy ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
            >
              {s.saveIdentity}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}

export function GitRestoreConfirmationDialog({
  busy,
  changed,
  paths,
  blocked,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  changed: boolean;
  paths: string[];
  blocked: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useGitStrings();
  return (
    <ConfirmationDialog
      title={s.restoreTitle}
      description={
        <span className="git-commit-confirmation">
          <span>{s.restoreDescription}</span>
          <span>
            <strong>{s.restoreFiles}:</strong>
          </span>
          <span className="git-confirm-file-list">
            {paths.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </span>
        </span>
      }
      cancelLabel={s.cancel}
      closeLabel={s.cancel}
      confirmLabel={s.restore}
      cancelDisabled={busy}
      confirmDisabled={blocked || changed}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function GitResolveConfirmationDialog({
  busy,
  changed,
  paths,
  blocked,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  changed: boolean;
  paths: string[];
  blocked: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useGitStrings();
  return (
    <ConfirmationDialog
      title={s.resolveTitle}
      confirmVariant="primary"
      description={
        <span className="git-commit-confirmation">
          <span>{s.resolveDescription}</span>
          <span className="git-confirm-file-list">
            {paths.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </span>
        </span>
      }
      cancelLabel={s.cancel}
      closeLabel={s.cancel}
      confirmLabel={s.resolve}
      cancelDisabled={busy}
      confirmDisabled={blocked || changed}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function GitChangesConfirmations({
  active,
  state,
}: {
  active: boolean;
  state: GitChangesConfirmationsState;
}) {
  const s = useGitStrings();
  const repositoryChanged =
    active &&
    ((!!state.restore && state.restoreChanged) ||
      (!!state.resolve && state.resolveChanged) ||
      (!!state.identity && state.identityChanged));
  useNotification(
    repositoryChanged
      ? {
          key: "git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );
  useNotification(
    active && state.resolve?.allowMarkers
      ? {
          key: "git:conflict-markers",
          message: s.markerWarning,
          tone: "warning",
        }
      : null,
  );
  if (!active) return null;

  return (
    <>
      {state.restore
        ? createPortal(
            <GitRestoreConfirmationDialog
              busy={state.busy}
              changed={state.restoreChanged}
              paths={state.restore.paths}
              blocked={state.restoreBlocked}
              onCancel={state.onCancelRestore}
              onConfirm={state.onConfirmRestore}
            />,
            document.body,
          )
        : null}
      {state.resolve
        ? createPortal(
            <GitResolveConfirmationDialog
              busy={state.busy}
              changed={state.resolveChanged}
              paths={state.resolve.paths}
              blocked={state.actionBlocked}
              onCancel={state.onCancelResolve}
              onConfirm={state.onConfirmResolve}
            />,
            document.body,
          )
        : null}
      {state.identity
        ? createPortal(
            <IdentityDialog
              busy={state.busy}
              changed={state.identityChanged}
              name={state.identityName}
              email={state.identityEmail}
              global={state.identityGlobal}
              onName={state.onIdentityName}
              onEmail={state.onIdentityEmail}
              onGlobal={state.onIdentityGlobal}
              onCancel={state.onCancelIdentity}
              onSave={state.onSaveIdentity}
            />,
            document.body,
          )
        : null}
    </>
  );
}
