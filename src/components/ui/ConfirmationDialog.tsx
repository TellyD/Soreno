import { LoaderCircle, X } from "lucide-react";
import { useId, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
import { DialogOverlay, DialogSurface } from "./Dialog";
import { IconButton } from "./IconButton";
import "./ConfirmationDialog.css";
import { useDismissibleLayer } from "./useDismissibleLayer";

type ConfirmationDialogProps = {
  cancelDisabled?: boolean;
  children?: ReactNode;
  cancelLabel: string;
  closeLabel: string;
  confirmDisabled?: boolean;
  confirmLabel: string;
  confirmPending?: boolean;
  confirmVariant?: "primary" | "danger";
  description: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function ConfirmationDialog({
  cancelDisabled = false,
  children,
  cancelLabel,
  closeLabel,
  confirmDisabled = false,
  confirmLabel,
  confirmPending = false,
  confirmVariant = "danger",
  description,
  onCancel,
  onConfirm,
  title,
  returnFocusRef,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = () => {
    if (!cancelDisabled) {
      onCancel();
    }
  };
  const dialogRef = useDismissibleLayer<HTMLElement>(true, cancel);

  return (
    <DialogOverlay className="confirmation-dialog-overlay">
      <DialogSurface
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="confirmation-dialog"
        ref={dialogRef}
        returnFocusRef={returnFocusRef}
        role="alertdialog"
      >
        <header className="confirmation-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <IconButton
            aria-label={closeLabel}
            className="confirmation-dialog-close"
            disabled={cancelDisabled}
            onClick={cancel}
          >
            <X />
          </IconButton>
        </header>
        <div className="confirmation-dialog-body">
          <p id={descriptionId}>{description}</p>
          {children}
        </div>
        <footer className="confirmation-dialog-footer">
          <Button autoFocus disabled={cancelDisabled} onClick={cancel}>
            {cancelLabel}
          </Button>
          <Button
            aria-busy={confirmPending || undefined}
            className="confirmation-dialog-confirm"
            disabled={confirmDisabled}
            onClick={onConfirm}
            startIcon={
              confirmPending ? (
                <LoaderCircle className="app-loading-spinner" />
              ) : undefined
            }
            variant={confirmVariant}
          >
            {confirmLabel}
          </Button>
        </footer>
      </DialogSurface>
    </DialogOverlay>
  );
}
