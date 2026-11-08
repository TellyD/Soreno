import { ListTodo, LoaderCircle, Plus } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  groupTasksForBoard,
  taskStatuses,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import { isImeComposing } from "../../domain/keyboard";
import type { Note } from "../../domain/notes";
import { useI18n } from "../../i18n";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { CountBadge } from "../ui/CountBadge";
import { EmptyState } from "../ui/EmptyState";
import {
  boardColumnAtPoint,
  useBoardDragAndDrop,
} from "../../hooks/useBoardDragAndDrop";
import { TaskCard, TaskDragPreview } from "./TaskCard";
import { TaskCreateForm } from "./TaskCreateForm";
import { taskStatusLabelKeys } from "./TaskStatusPicker";
import "./TaskBoard.css";

type TaskBoardProps = {
  isLoading: boolean;
  notes: Note[];
  onCreateTask: (status: TaskStatus, title: string) => Task | null;
  onDeleteTask: (taskId: string) => Promise<void>;
  onOpenAttachedNote: (note: Note) => void;
  onUpdateTaskAttachedNote: (taskId: string, noteId: string | null) => void;
  onUpdateTaskPriority: (taskId: string, priority: TaskPriority) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => void;
  onUpdateTaskTitle: (taskId: string, title: string) => Promise<boolean>;
  tasks: Task[];
};

export function TaskBoard({
  isLoading,
  notes,
  onCreateTask,
  onDeleteTask,
  onOpenAttachedNote,
  onUpdateTaskAttachedNote,
  onUpdateTaskPriority,
  onUpdateTaskStatus,
  onUpdateTaskTitle,
  tasks,
}: TaskBoardProps) {
  const { t } = useI18n();
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [isDeletingTask, setIsDeletingTask] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
  const [creatingInStatus, setCreatingInStatus] = useState<TaskStatus | null>(
    null,
  );
  const boardRef = useRef<HTMLElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const savingTitleRef = useRef(false);
  const editRevisionRef = useRef(0);
  const statusFocusRef = useRef<{ id: string; status: TaskStatus } | null>(
    null,
  );
  const addTaskButtonRefs = useRef<
    Record<TaskStatus, HTMLButtonElement | null>
  >({
    doing: null,
    done: null,
    todo: null,
  });
  const tasksByStatus = useMemo(() => groupTasksForBoard(tasks), [tasks]);
  const notesById = useMemo(() => {
    return new Map(notes.map((note) => [note.id, note]));
  }, [notes]);
  const taskDrag = useBoardDragAndDrop<Task, TaskStatus>({
    canStartDrag: (task, target) =>
      editingTaskId !== task.id && !target.closest("[data-task-no-drag]"),
    columnAtPoint: (x, y) => {
      const status = boardColumnAtPoint(x, y, "data-task-status");
      return taskStatuses.find((taskStatus) => taskStatus === status) ?? null;
    },
    getColumn: (task) => task.status,
    getId: (task) => task.id,
    onDrop: (task, status) => onUpdateTaskStatus(task.id, status),
    onTap: (task, target) => {
      if (target?.closest("[data-task-edit-title]")) beginEditing(task);
    },
  });

  useEffect(() => {
    if (editingTaskId) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTaskId]);

  useEffect(() => {
    const pending = statusFocusRef.current;
    if (!pending) return;

    const movedTask = tasks.find((task) => task.id === pending.id);
    if (!movedTask) {
      statusFocusRef.current = null;
      return;
    }
    if (movedTask.status !== pending.status) return;

    const frame = requestAnimationFrame(() => {
      if (statusFocusRef.current !== pending) return;
      const triggers = boardRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-task-status-trigger]",
      );
      [...(triggers ?? [])]
        .find((trigger) => trigger.dataset.taskStatusTrigger === pending.id)
        ?.focus();
      statusFocusRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [tasks]);

  function beginEditing(task: Task) {
    if (savingTitleRef.current) return;
    resetCreating();
    editRevisionRef.current += 1;
    setEditingTaskId(task.id);
    setDraftTitle(task.title);
  }

  function beginCreating(status: TaskStatus) {
    if (savingTitleRef.current) return;
    cancelEditing();
    setCreatingInStatus(status);
  }

  function resetCreating() {
    setCreatingInStatus(null);
  }

  function cancelCreating() {
    const status = creatingInStatus;

    resetCreating();

    if (status) {
      requestAnimationFrame(() => addTaskButtonRefs.current[status]?.focus());
    }
  }

  function maybeBeginEditing(task: Task) {
    if (taskDrag.shouldSkipClick(task.id)) {
      return;
    }

    beginEditing(task);
  }

  async function confirmTaskDeletion() {
    if (!taskToDelete) {
      return;
    }

    try {
      setIsDeletingTask(true);
      await onDeleteTask(taskToDelete.id);
      setTaskToDelete(null);
    } finally {
      setIsDeletingTask(false);
    }
  }

  function cancelEditing() {
    editRevisionRef.current += 1;
    setEditingTaskId(null);
    setDraftTitle("");
  }

  async function commitEditing(task: Task) {
    if (savingTitleRef.current) return;
    const title = draftTitle.trim() || t("tasks.fallbackTitle");
    const revision = editRevisionRef.current;
    savingTitleRef.current = true;
    try {
      const saved = await onUpdateTaskTitle(task.id, title);
      if (saved && editRevisionRef.current === revision) cancelEditing();
    } finally {
      savingTitleRef.current = false;
    }
  }

  function handleTitleKeyDown(
    task: Task,
    event: KeyboardEvent<HTMLInputElement>,
  ) {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditing(task);
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  }

  function updateTaskStatusFromMenu(taskId: string, status: TaskStatus) {
    statusFocusRef.current = { id: taskId, status };
    onUpdateTaskStatus(taskId, status);
  }

  return (
    <section
      className="task-board"
      aria-label={t("tasks.ariaLabel")}
      ref={boardRef}
    >
      <header className="browser-toolbar">
        <div className="browser-toolbar-main">
          <div className="browser-title">
            <ListTodo size={15} aria-hidden="true" />
            <h1>{t("views.tasks")}</h1>
          </div>
        </div>
      </header>

      {isLoading ? (
        <p className="empty-state">
          <LoaderCircle size={16} /> {t("notes.loading")}
        </p>
      ) : (
        <div className="task-columns">
          {taskStatuses.map((status) => (
            <section
              className={`task-column ${
                taskDrag.dropColumn === status ? "drop-target" : ""
              }`}
              data-task-status={status}
              key={status}
              aria-label={t(taskStatusLabelKeys[status])}
            >
              <header className="task-column-header">
                <div>
                  <h2>{t(taskStatusLabelKeys[status])}</h2>
                  <CountBadge count={tasksByStatus[status].length} />
                </div>
              </header>

              <div className="task-card-list">
                {tasksByStatus[status].length > 0 ? (
                  tasksByStatus[status].map((task) => (
                    <TaskCard
                      attachedNote={
                        task.attachedNoteId
                          ? (notesById.get(task.attachedNoteId) ?? null)
                          : null
                      }
                      draftTitle={draftTitle}
                      inputRef={titleInputRef}
                      isDragging={taskDrag.draggedId === task.id}
                      isEditing={editingTaskId === task.id}
                      key={task.id}
                      task={task}
                      onCommitEdit={commitEditing}
                      onDelete={() => setTaskToDelete(task)}
                      onDraftTitleChange={(title) => {
                        editRevisionRef.current += 1;
                        setDraftTitle(title);
                      }}
                      onEdit={() => maybeBeginEditing(task)}
                      onOpenAttachedNote={onOpenAttachedNote}
                      notes={notes}
                      {...taskDrag.getPointerHandlers(task)}
                      onUpdateAttachedNote={(noteId) =>
                        onUpdateTaskAttachedNote(task.id, noteId)
                      }
                      onUpdatePriority={(priority) =>
                        onUpdateTaskPriority(task.id, priority)
                      }
                      onUpdateStatus={(nextStatus) =>
                        updateTaskStatusFromMenu(task.id, nextStatus)
                      }
                      onTitleKeyDown={handleTitleKeyDown}
                    />
                  ))
                ) : (
                  <EmptyState
                    className="task-empty-column"
                    description={t("tasks.emptyColumn")}
                    size="compact"
                  />
                )}
                {creatingInStatus === status ? (
                  <TaskCreateForm
                    onCancel={cancelCreating}
                    onCreateTask={onCreateTask}
                    onCreated={resetCreating}
                    status={status}
                  />
                ) : (
                  <button
                    type="button"
                    className="task-add-link"
                    aria-label={t("tasks.addToColumn", {
                      status: t(taskStatusLabelKeys[status]),
                    })}
                    title={t("tasks.addToColumn", {
                      status: t(taskStatusLabelKeys[status]),
                    })}
                    ref={(button) => {
                      addTaskButtonRefs.current[status] = button;
                    }}
                    onClick={() => beginCreating(status)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>{t("tasks.add")}</span>
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {taskDrag.dragPreview ? (
        <TaskDragPreview
          dragPreview={taskDrag.dragPreview}
          previewRef={taskDrag.previewRef}
        />
      ) : null}

      {taskToDelete ? (
        <ConfirmationDialog
          cancelDisabled={isDeletingTask}
          cancelLabel={t("tasks.deleteDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={isDeletingTask}
          confirmLabel={t("tasks.deleteDialog.confirm")}
          description={t("tasks.deleteDialog.description", {
            title: taskToDelete.title,
          })}
          onCancel={() => setTaskToDelete(null)}
          onConfirm={() => void confirmTaskDeletion()}
          title={t("tasks.deleteDialog.title")}
        />
      ) : null}
    </section>
  );
}
