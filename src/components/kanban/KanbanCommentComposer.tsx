import { useState } from "react";
import { isImeComposing } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";

export function KanbanCommentComposer({
  formatError,
  onAddComment,
}: {
  formatError: (error: unknown) => string;
  onAddComment: (body: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const blank = draft.trim() === "";

  async function submit() {
    if (blank || sending) return;
    setSending(true);
    try {
      await onAddComment(draft.trim());
      setDraft("");
    } catch (error) {
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
        onChange={(event) => setDraft(event.currentTarget.value)}
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
