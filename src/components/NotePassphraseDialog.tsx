import { LoaderCircle, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { WrongPassphraseError } from "../domain/noteEncryption";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { DialogOverlay, DialogSurface } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Input";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";
import "./NotePassphraseDialog.css";

const MIN_PASSPHRASE_LENGTH = 8;

export type NotePassphraseMode = "create" | "unlock" | "change";

type NotePassphraseDialogProps = {
  mode: NotePassphraseMode;
  onCancel: () => void;
  /** Rejects with `WrongPassphraseError` when the given passphrase is wrong. */
  onSubmit: (passphrase: string, currentPassphrase: string) => Promise<void>;
};

export function NotePassphraseDialog({
  mode,
  onCancel,
  onSubmit,
}: NotePassphraseDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const currentId = useId();
  const passphraseId = useId();
  const confirmationId = useId();
  const [current, setCurrent] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isNew = mode !== "unlock";
  const ref = useDismissibleLayer<HTMLElement>(true, () => {
    if (!pending) onCancel();
  });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (isNew && [...passphrase].length < MIN_PASSPHRASE_LENGTH) {
      setError(
        t("notes.passphrase.tooShort", { count: MIN_PASSPHRASE_LENGTH }),
      );
      return;
    }
    if (isNew && passphrase !== confirmation) {
      setError(t("notes.passphrase.mismatch"));
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit(passphrase, current);
    } catch (submitError) {
      setError(
        t(
          submitError instanceof WrongPassphraseError
            ? "notes.passphrase.wrong"
            : "notes.passphrase.error",
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogOverlay>
      <DialogSurface
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="form-dialog"
        ref={ref}
      >
        <form onSubmit={(event) => void handleSubmit(event)}>
          <header>
            <div>
              <h2 id={titleId}>{t(`notes.passphrase.${mode}.title`)}</h2>
              <p id={descriptionId}>
                {t(`notes.passphrase.${mode}.description`)}
              </p>
            </div>
            <IconButton
              aria-label={t("notes.passphrase.cancel")}
              disabled={pending}
              onClick={onCancel}
            >
              <X />
            </IconButton>
          </header>
          <fieldset className="form-dialog-body" disabled={pending}>
            {mode === "change" ? (
              <>
                <label htmlFor={currentId}>
                  {t("notes.passphrase.current")}
                </label>
                <Input
                  id={currentId}
                  autoFocus
                  autoComplete="current-password"
                  type="password"
                  value={current}
                  onChange={(event) => setCurrent(event.currentTarget.value)}
                />
              </>
            ) : null}
            <label htmlFor={passphraseId}>
              {t(
                mode === "change"
                  ? "notes.passphrase.new"
                  : "notes.passphrase.passphrase",
              )}
            </label>
            <Input
              id={passphraseId}
              autoFocus={mode !== "change"}
              autoComplete={isNew ? "new-password" : "current-password"}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.currentTarget.value)}
            />
            {isNew ? (
              <>
                <label htmlFor={confirmationId}>
                  {t("notes.passphrase.confirm")}
                </label>
                <Input
                  id={confirmationId}
                  autoComplete="new-password"
                  type="password"
                  value={confirmation}
                  onChange={(event) =>
                    setConfirmation(event.currentTarget.value)
                  }
                />
              </>
            ) : null}
            {error ? (
              <p className="note-passphrase-error" id={errorId} role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
          <footer>
            <Button disabled={pending} onClick={onCancel}>
              {t("notes.passphrase.cancel")}
            </Button>
            <Button
              aria-busy={pending || undefined}
              disabled={pending || !passphrase}
              startIcon={
                pending ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
              type="submit"
              variant="primary"
            >
              {t(`notes.passphrase.${mode}.submit`)}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
