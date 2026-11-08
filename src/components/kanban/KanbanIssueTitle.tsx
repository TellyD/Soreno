import { useEffect, useRef, useState } from "react";
import { isImeComposing } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { Input } from "../ui/Input";

export function KanbanIssueTitle({
  onRename,
  title,
}: {
  onRename: ((title: string) => void) | undefined;
  title: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(false);
  // Title shown when editing started; a newer server title must not count as a user edit.
  const initialTitleRef = useRef(title);
  const refocusRef = useRef(false);

  useEffect(() => {
    if (draft !== null || !refocusRef.current) return;
    refocusRef.current = false;
    buttonRef.current?.focus();
  }, [draft]);

  return (
    <h1 className="kanban-issue-title">
      {!onRename ? (
        title
      ) : draft === null ? (
        <button
          className="kanban-issue-title-button"
          onClick={() => {
            initialTitleRef.current = title;
            setDraft(title);
          }}
          ref={buttonRef}
          title={t("kanban.issue.editTitle")}
          type="button"
        >
          {title}
        </button>
      ) : (
        <Input
          aria-label={t("kanban.issue.title")}
          autoFocus
          className="kanban-issue-title-input"
          // Enter and Escape blur the input so blur stays the only way editing ends.
          onBlur={(event) => {
            const nextTitle = event.currentTarget.value.trim();
            if (
              !cancelRef.current &&
              nextTitle &&
              nextTitle !== initialTitleRef.current.trim() &&
              nextTitle !== title
            ) {
              onRename(nextTitle);
            }
            cancelRef.current = false;
            setDraft(null);
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) return;
            if (event.key === "Escape") cancelRef.current = true;
            else if (event.key !== "Enter") return;
            event.preventDefault();
            refocusRef.current = true;
            event.currentTarget.blur();
          }}
          value={draft}
        />
      )}
    </h1>
  );
}
