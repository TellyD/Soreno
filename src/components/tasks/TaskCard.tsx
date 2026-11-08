import { FileText, Flag, Trash2 } from "lucide-react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { useState } from "react";
import type { Note } from "../../domain/notes";
import type { Task, TaskPriority, TaskStatus } from "../../domain/tasks";
import type { BoardDragPreview } from "../../hooks/useBoardDragAndDrop";
import { useI18n } from "../../i18n";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { TaskNotePicker } from "./TaskNotePicker";
import {
  TaskPriorityPicker,
  taskPriorityClassName,
} from "./TaskPriorityPicker";
import { TaskStatusPicker } from "./TaskStatusPicker";

type TaskCardProps = {
  attachedNote: Note | null;
  draftTitle: string;
  inputRef: RefObject<HTMLInputElement | null>;
  isDragging: boolean;
  isEditing: boolean;
  notes: Note[];
  onCommitEdit: (task: Task) => void;
  onDelete: () => void;
  onDraftTitleChange: (title: string) => void;
  onEdit: () => void;
  onOpenAttachedNote: (note: Note) => void;
  onUpdateAttachedNote: (noteId: string | null) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onUpdatePriority: (priority: TaskPriority) => void;
  onUpdateStatus: (status: TaskStatus) => void;
  onTitleKeyDown: (task: Task, event: KeyboardEvent<HTMLInputElement>) => void;
  task: Task;
};

type TaskCardMenu = "note" | "priority" | "status";

export function TaskCard({
  attachedNote,
  draftTitle,
  inputRef,
  isDragging,
  isEditing,
  notes,
  onCommitEdit,
  onDelete,
  onDraftTitleChange,
  onEdit,
  onOpenAttachedNote,
  onUpdateAttachedNote,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onUpdatePriority,
  onUpdateStatus,
  onTitleKeyDown,
  task,
}: TaskCardProps) {
  const { t } = useI18n();
  const [activeMenu, setActiveMenu] = useState<TaskCardMenu | null>(null);

  function handleMenuOpenChange(menu: TaskCardMenu, isOpen: boolean) {
    setActiveMenu((currentMenu) => {
      if (isOpen) {
        return menu;
      }

      return currentMenu === menu ? null : currentMenu;
    });
  }

  return (
    <article
      className={[
        "task-card",
        task.status === "done" ? "completed" : null,
        isDragging ? "dragging" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="task-card-heading">
        <div className="task-card-main">
          <div className="task-card-title-row">
            <TaskPriorityPicker
              isEditing={isEditing}
              isOpen={activeMenu === "priority"}
              onOpenChange={(isOpen) =>
                handleMenuOpenChange("priority", isOpen)
              }
              onUpdatePriority={onUpdatePriority}
              task={task}
            />
            {isEditing ? (
              <Input
                aria-label={t("tasks.editTitle")}
                className="task-card-title-input"
                data-task-no-drag
                ref={inputRef}
                size="small"
                value={draftTitle}
                onBlur={() => onCommitEdit(task)}
                onChange={(event) =>
                  onDraftTitleChange(event.currentTarget.value)
                }
                onKeyDown={(event) => onTitleKeyDown(task, event)}
              />
            ) : (
              <span
                role="button"
                tabIndex={0}
                className="task-card-title"
                data-task-edit-title
                title={t("tasks.editTitle")}
                onClick={onEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onEdit();
                  }
                }}
              >
                {task.title}
              </span>
            )}
          </div>
        </div>
        <TaskNotePicker
          attachedNote={attachedNote}
          isEditing={isEditing}
          isOpen={activeMenu === "note"}
          notes={notes}
          onOpenChange={(isOpen) => handleMenuOpenChange("note", isOpen)}
          onUpdateAttachedNote={onUpdateAttachedNote}
          selectedNoteId={task.attachedNoteId}
        />
        <TaskStatusPicker
          isEditing={isEditing}
          isOpen={activeMenu === "status"}
          onOpenChange={(isOpen) => handleMenuOpenChange("status", isOpen)}
          onUpdateStatus={onUpdateStatus}
          task={task}
        />
        <IconButton
          className="task-card-delete"
          data-task-no-drag
          aria-label={t("tasks.delete")}
          size="small"
          title={t("tasks.delete")}
          tone="danger"
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </IconButton>
      </div>
      {attachedNote ? (
        <div className="task-card-meta">
          <button
            type="button"
            className="task-attached-note"
            data-task-no-drag
            aria-label={t("tasks.note.open", { title: attachedNote.title })}
            title={t("tasks.note.open", { title: attachedNote.title })}
            onClick={() => onOpenAttachedNote(attachedNote)}
          >
            <FileText size={13} aria-hidden="true" />
            <span>{attachedNote.title}</span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function TaskDragPreview({
  dragPreview,
  previewRef,
}: {
  dragPreview: BoardDragPreview<Task>;
  previewRef: RefObject<HTMLElement | null>;
}) {
  return (
    <article
      className={[
        "task-card",
        "task-drag-preview",
        dragPreview.item.status === "done" ? "completed" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      ref={previewRef}
      aria-hidden="true"
      style={{
        left: dragPreview.x,
        minHeight: dragPreview.height,
        top: dragPreview.y,
        width: dragPreview.width,
      }}
    >
      <div className="task-card-heading">
        <div className="task-card-main">
          <div className="task-card-title-row">
            <span
              className={taskPriorityClassName(dragPreview.item)}
              aria-hidden="true"
            >
              <Flag size={14} />
            </span>
            <span className="task-card-title">{dragPreview.item.title}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
