import { ExternalLink, LoaderCircle, X } from "lucide-react";
import { useId, useState, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";

const apiKeySettingsUrl = "https://linear.app/settings/account/security";

type KanbanLinearConnectDialogProps = {
  formatError: (error: unknown) => string;
  onClose: () => void;
  // Resolves once the key is validated and stored; the caller closes the dialog.
  onConnect: (apiKey: string) => Promise<void>;
  onOpenUrl: (url: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

export function KanbanLinearConnectDialog({
  formatError,
  onClose,
  onConnect,
  onOpenUrl,
  returnFocusRef,
}: KanbanLinearConnectDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const errorId = useId();
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, () => {
    if (!pending) onClose();
  });
  const trimmed = apiKey.trim();

  async function submit() {
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConnect(trimmed);
    } catch (connectError) {
      setError(formatError(connectError));
      setPending(false);
    }
  }

  return (
    <DialogOverlay>
      <DialogSurface
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="form-dialog kanban-linear-dialog"
        ref={surfaceRef}
        returnFocusRef={returnFocusRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header>
            <div>
              <h2 id={titleId}>{t("kanban.linear.connectDialog.title")}</h2>
              <p id={descriptionId}>
                {t("kanban.linear.connectDialog.description")}
              </p>
            </div>
            <IconButton
              aria-label={t("kanban.create.close")}
              disabled={pending}
              onClick={onClose}
              size="small"
              title={t("kanban.create.close")}
            >
              <X size={14} />
            </IconButton>
          </header>
          <div className="form-dialog-body">
            <label htmlFor={inputId}>
              {t("kanban.linear.connectDialog.label")}
            </label>
            <Input
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              autoFocus
              id={inputId}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="lin_api_…"
              readOnly={pending}
              spellCheck={false}
              type="password"
              value={apiKey}
            />
            {error ? (
              <p
                className="kanban-linear-dialog-error"
                id={errorId}
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
          <footer>
            <Button
              endIcon={<ExternalLink />}
              onClick={() => onOpenUrl(apiKeySettingsUrl)}
              size="small"
            >
              {t("kanban.linear.connectDialog.createKey")}
            </Button>
            <Button
              aria-busy={pending || undefined}
              disabled={!trimmed || pending}
              size="small"
              startIcon={
                pending ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
              type="submit"
              variant="primary"
            >
              {t("kanban.linear.connectDialog.submit")}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
