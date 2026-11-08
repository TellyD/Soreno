import { AlertCircle, Check, Clock, MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendAgentSessionMessage } from "../../data/agentSessionsApi";
import type { AgentSessionMessage } from "../../domain/agentSessions";
import {
  diffLineCommentRequest,
  diffLineRangeLabel,
  type DiffLineSelection,
} from "../../domain/diffLineComment";
import { errorMessage } from "../../domain/errors";
import { gitPathParts } from "../../domain/projectGit";
import { isImeComposing } from "../../domain/keyboard";
import { useAgentSessionMessage } from "../../hooks/useAgentSessionMessage";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { AgentProviderIcon } from "./AgentProviderIcon";
import { useGitStrings } from "./gitStrings";
import "./GitDiffLineComment.css";

/** A running agent session; the selected session comes first. */
export type GitDiffCommentTarget = {
  sessionId: string;
  projectId: string;
  name: string;
  executable: string;
};

export function GitDiffLineComment({
  selection,
  draft,
  stale = false,
  targets,
  onDraftChange,
  onSent,
  onClose,
}: {
  selection: DiffLineSelection;
  draft: string;
  /** The diff changed since the lines were selected: sending waits for a new selection. */
  stale?: boolean;
  targets: readonly GitDiffCommentTarget[];
  onDraftChange: (draft: string) => void;
  /** The parent clears the draft only if it still belongs to the sent comment. */
  onSent: (sent: { selection: DiffLineSelection; draft: string }) => void;
  onClose: () => void;
}) {
  const s = useGitStrings();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{
    name: string;
    message: AgentSessionMessage;
  } | null>(null);
  const delivery = useAgentSessionMessage(sent?.message ?? null);
  const deliveryText =
    sent && delivery
      ? delivery.status === "delivered"
        ? s.lineCommentDelivery.delivered(sent.name)
        : s.lineCommentDelivery[delivery.status](sent.name, delivery.error)
      : "";
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [shownSelection, setShownSelection] = useState(selection);
  if (shownSelection !== selection) {
    setShownSelection(selection);
    setSent(null);
  }
  // The send completes after later renders: read the current selection, not the submitted one.
  const latestSelection = useRef(selection);
  useEffect(() => {
    latestSelection.current = selection;
  }, [selection]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, [selection]);
  const target =
    targets.find((candidate) => candidate.sessionId === chosenId) ?? targets[0];
  const blank = draft.trim().length === 0;

  async function submit() {
    if (blank || sending || stale || !target) return;
    const submitted = { selection, draft };
    setSending(true);
    try {
      const message = await sendAgentSessionMessage(
        target.sessionId,
        crypto.randomUUID(),
        diffLineCommentRequest(submitted.selection, submitted.draft),
      );
      onSent(submitted);
      if (latestSelection.current === submitted.selection) {
        setSent({ name: target.name, message });
      }
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="git-diff-comment"
      aria-label={s.lineComment}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isImeComposing(event.nativeEvent)) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="git-diff-comment-header">
        <MessageSquare size={13} aria-hidden="true" />
        <strong>
          {gitPathParts(selection.path).name} · {diffLineRangeLabel(selection)}
        </strong>
        <span>{s.lineCommentVersion[selection.version]}</span>
        <IconButton
          size="small"
          aria-label={s.cancel}
          title={s.cancel}
          onClick={onClose}
        >
          <X />
        </IconButton>
      </header>
      <textarea
        aria-label={s.lineComment}
        ref={textareaRef}
        onChange={(event) => {
          onDraftChange(event.currentTarget.value);
          setSent(null);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey) &&
            !isImeComposing(event.nativeEvent)
          ) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={s.lineCommentPlaceholder}
        readOnly={sending}
        rows={3}
        value={draft}
      />
      <footer className="git-diff-comment-footer">
        {targets.length > 1 ? (
          <Select
            className="git-diff-comment-select"
            popupClassName="git-diff-comment-select-popup"
            size="small"
            aria-label={s.lineCommentTarget}
            title={s.lineCommentTarget}
            value={target.sessionId}
            startIcon={<AgentProviderIcon executable={target.executable} />}
            options={targets.map((candidate) => ({
              value: candidate.sessionId,
              label: candidate.name,
              icon: <AgentProviderIcon executable={candidate.executable} />,
            }))}
            onValueChange={setChosenId}
          />
        ) : target ? (
          <span className="git-diff-comment-target">
            <AgentProviderIcon executable={target.executable} />
            {target.name}
          </span>
        ) : (
          <span className="git-diff-comment-hint">{s.lineCommentNoAgent}</span>
        )}
        {sent && delivery ? (
          <span
            className="git-diff-comment-sent"
            data-status={delivery.status}
            role="status"
            title={deliveryText}
          >
            {delivery.status === "queued" ? (
              <Clock size={12} aria-hidden="true" />
            ) : delivery.status === "delivered" ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <AlertCircle size={12} aria-hidden="true" />
            )}
            <span className="git-diff-comment-sent-text">{deliveryText}</span>
          </span>
        ) : null}
        {stale ? (
          <span className="git-diff-comment-hint" role="status">
            {s.lineCommentStale}
          </span>
        ) : null}
        <Button
          size="small"
          type="submit"
          variant="primary"
          disabled={blank || sending || stale || !target}
        >
          {s.lineCommentSend}
        </Button>
      </footer>
    </form>
  );
}
