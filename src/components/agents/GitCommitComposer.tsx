import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generateGitCommitMessage } from "../../data/projectGitApi";
import {
  dismissNotification,
  notifyError,
  useNotification,
} from "../../notifications";
import { Button } from "../ui/Button";
import { useGitStrings } from "./gitStrings";

const generationKey = "git-commit-generation";

export function GitCommitComposer({
  id,
  open,
  projectId,
  version,
  generationDisabled,
  message,
  merge,
  busy,
  changed,
  disabled,
  warning,
  onMessage,
  onCancel,
  onCommit,
}: {
  id: string;
  open: boolean;
  projectId?: string;
  version?: string;
  generationDisabled: boolean;
  message: string;
  merge: boolean;
  busy: boolean;
  changed: boolean;
  disabled: boolean;
  warning?: string;
  onMessage: (message: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const s = useGitStrings();
  const messageId = `${id}-message`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [generating, setGenerating] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const edits = useRef(0);
  const latest = useRef({ message, onMessage, blocked: false });
  latest.current = {
    message,
    onMessage,
    blocked: busy || changed || generationDisabled,
  };

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  useEffect(() => {
    pending.current = false;
    setGenerating(false);
    if (projectId && version) dismissNotification(generationKey);
    setDiscarded(false);
    return () => {
      request.current += 1;
    };
  }, [projectId, version, busy, changed, generationDisabled]);

  async function generateMessage() {
    if (!projectId || !version || pending.current || latest.current.blocked)
      return;
    const requestId = ++request.current;
    const revision = edits.current;
    const original = message;
    pending.current = true;
    setGenerating(true);
    dismissNotification(generationKey);
    setDiscarded(false);
    try {
      const generated = await generateGitCommitMessage(projectId, version);
      if (request.current !== requestId || latest.current.blocked) return;
      if (edits.current !== revision || latest.current.message !== original)
        setDiscarded(true);
      else latest.current.onMessage(generated);
    } catch {
      if (request.current === requestId && !latest.current.blocked)
        notifyError(s.generationFailed, { key: generationKey });
    } finally {
      if (request.current === requestId) {
        pending.current = false;
        setGenerating(false);
      }
    }
  }

  useNotification(
    open && changed
      ? {
          key: "git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );

  return (
    <form
      id={id}
      className="git-commit-composer"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onCommit();
      }}
    >
      <div className="git-commit-fields">
        <div className="git-commit-message-label">
          <label htmlFor={messageId}>{s.commitMessage}</label>
          {projectId && version ? (
            <Button
              size="small"
              aria-live="polite"
              disabled={generating || busy || changed || generationDisabled}
              title={s.generateMessageHint}
              startIcon={
                generating ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : (
                  <Sparkles />
                )
              }
              onClick={() => void generateMessage()}
            >
              {generating ? s.generatingMessage : s.generateMessage}
            </Button>
          ) : null}
        </div>
        <textarea
          ref={textareaRef}
          id={messageId}
          rows={3}
          placeholder={s.commitPlaceholder}
          value={message}
          disabled={busy || changed}
          onChange={(event) => {
            edits.current += 1;
            setDiscarded(false);
            onMessage(event.currentTarget.value);
          }}
        />
        <span className="git-commit-generation-status" role="status">
          {discarded ? s.generatedMessageDiscarded : ""}
        </span>
      </div>
      <footer>
        <Button disabled={busy} onClick={onCancel}>
          {s.cancel}
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={disabled}
          title={disabled ? warning : undefined}
        >
          {merge ? s.mergeCommit : s.commit}
        </Button>
      </footer>
    </form>
  );
}
