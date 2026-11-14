import { useState } from "react";
import { isImeComposing } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";

// Unsent comments by issue id: closing the issue unmounts the composer.
const drafts = new Map<string, string>();

export function KanbanCommentComposer({
  formatError,
  issueId,
  onAddComment,
}: {
  formatError: (error: unknown) => string;
  issueId: string;
  onAddComment: (body: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => drafts.get(issueId) ?? "");
  const [sending, setSending] = useState(false);
  const blank = draft.trim() === "";

  function changeDraft(text: string) {
    if (text.trim() === "") drafts.delete(issueId);
    else drafts.set(issueId, text);
    setDraft(text);
  }

  async function submit() {
    if (blank || sending) return;
    setSending(true);
    // A composer reopened while this posts starts empty instead of offering it again.
    drafts.delete(issueId);
    try {
      await onAddComment(draft.trim());
      setDraft("");
    } catch (error) {
      // A newer draft typed in a reopened composer wins.
      if (!drafts.has(issueId)) drafts.set(issueId, draft);
      notifyError(formatError(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="kanban-issue-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label={t("kanban.issue.comment.label")}
        onChange={(event) => changeDraft(event.currentTarget.value)}
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
        placeholder={t("kanban.issue.comment.placeholder")}
        readOnly={sending}
        rows={3}
        value={draft}
      />
      <footer className="kanban-issue-composer-footer">
        <Button
          disabled={blank || sending}
          size="small"
          type="submit"
          variant="primary"
        >
          {t("kanban.issue.comment.submit")}
        </Button>
      </footer>
    </form>
  );
}
