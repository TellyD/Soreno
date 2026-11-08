import { useRef, useState, type FormEvent } from "react";
import type { Task, TaskStatus } from "../../domain/tasks";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type TaskCreateFormProps = {
  onCancel: () => void;
  onCreateTask: (status: TaskStatus, title: string) => Task | null;
  onCreated: () => void;
  status: TaskStatus;
};

export function TaskCreateForm({
  onCancel,
  onCreateTask,
  onCreated,
  status,
}: TaskCreateFormProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedTitle = title.trim();

    if (!normalizedTitle) {
      titleInputRef.current?.focus();
      return;
    }

    if (onCreateTask(status, normalizedTitle)) {
      onCreated();
    }
  }

  return (
    <form
      className="task-create-form"
      onSubmit={submitTask}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Input
        aria-label={t("tasks.create.titlePlaceholder")}
        autoFocus
        className="task-create-title"
        maxLength={200}
        placeholder={t("tasks.create.titlePlaceholder")}
        ref={titleInputRef}
        required
        size="small"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      <div className="task-create-actions">
        <Button size="small" onClick={onCancel}>
          {t("tasks.create.cancel")}
        </Button>
        <Button size="small" type="submit" variant="primary">
          {t("tasks.add")}
        </Button>
      </div>
    </form>
  );
}
