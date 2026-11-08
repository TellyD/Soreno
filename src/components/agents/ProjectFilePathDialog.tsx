import { LoaderCircle, X } from "lucide-react";
import { useId, useState, type RefObject } from "react";
import { normalizeProjectFileInput } from "../../domain/projectFiles";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useGitStrings } from "./gitStrings";

export function ProjectFilePathDialog({
  title,
  description,
  initialValue,
  confirmLabel,
  pending,
  onCancel,
  onSubmit,
  returnFocusRef,
}: {
  title: string;
  description?: string;
  initialValue: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (path: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const s = useGitStrings();
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState(initialValue);
  const path = normalizeProjectFileInput(value);
  const unchanged = path === normalizeProjectFileInput(initialValue);
  const invalid = value.trim() !== "" && path === null;
  const ref = useDismissibleLayer<HTMLElement>(true, () => {
    if (!pending) onCancel();
  });
  return (
    <DialogOverlay className="git-dialog-overlay">
      <DialogSurface
        className="form-dialog project-file-path-dialog"
        ref={ref}
        returnFocusRef={returnFocusRef}
        aria-labelledby={titleId}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (path && !pending) onSubmit(path);
          }}
        >
          <header>
            <div>
              <h2 id={titleId}>{title}</h2>
              {description ? <p>{description}</p> : null}
            </div>
            <IconButton
              aria-label={s.cancel}
              disabled={pending}
              onClick={onCancel}
            >
              <X />
            </IconButton>
          </header>
          <fieldset className="form-dialog-body" disabled={pending}>
            <label htmlFor={inputId}>{s.projectPathLabel}</label>
            <Input
              id={inputId}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={hintId}
              value={value}
              onFocus={(event) => {
                // Preselect the name, not its folder or extension, like file managers do.
                const input = event.currentTarget;
                const start = input.value.lastIndexOf("/") + 1;
                const dot = input.value.lastIndexOf(".");
                input.setSelectionRange(
                  start,
                  dot > start ? dot : input.value.length,
                );
              }}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <p
              className="project-file-path-hint"
              id={hintId}
              role={invalid ? "alert" : undefined}
            >
              {invalid ? s.invalidProjectPath : s.projectPathHint}
            </p>
          </fieldset>
          <footer>
            <Button disabled={pending} onClick={onCancel}>
              {s.cancel}
            </Button>
            <Button
              aria-busy={pending || undefined}
              type="submit"
              variant="primary"
              disabled={pending || !path || unchanged}
              startIcon={
                pending ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
            >
              {confirmLabel}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
