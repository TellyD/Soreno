import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTaskAttachedNote,
  updateTaskPriority,
  updateTaskStatus,
  updateTaskTitle,
} from "../data/tasksApi";
import {
  defaultTaskPriority,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../domain/tasks";
import { useI18n } from "../i18n";
import { dismissNotification, notifyError } from "../notifications";
import { useSaveStatus } from "./useSaveStatus";

const TASKS_LOAD_NOTIFICATION_KEY = "tasks-load";

export function useTasksController(activeVaultId: string | null) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const saveStatus = useSaveStatus();
  const activeVaultIdRef = useRef(activeVaultId);
  const hasSaveErrorRef = useRef(false);
  const pendingSaveCountRef = useRef(0);
  const pendingCreateTasksRef = useRef(new Map<string, Promise<Task>>());
  const tasksRef = useRef(tasks);
  const taskMutationsRef = useRef(new Map<string, Promise<unknown>>());
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    activeVaultIdRef.current = activeVaultId;
    pendingCreateTasksRef.current.clear();
    taskMutationsRef.current.clear();
    resetTaskSaveStatus();
  }, [activeVaultId]);

  useEffect(() => {
    tasksRef.current = [];
    setTasks([]);

    if (!activeVaultId) {
      return;
    }

    let isCurrent = true;

    async function loadCurrentTasks() {
      setIsLoading(true);

      try {
        const loadedTasks = await listTasks();

        if (isCurrent) {
          tasksRef.current = loadedTasks;
          setTasks(loadedTasks);
          dismissNotification(TASKS_LOAD_NOTIFICATION_KEY);
        }
      } catch {
        if (isCurrent) {
          notifyError(tRef.current("tasks.error.load"), {
            key: TASKS_LOAD_NOTIFICATION_KEY,
          });
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    void loadCurrentTasks();

    return () => {
      isCurrent = false;
    };
  }, [activeVaultId]);

  function handleCreateTask(status: TaskStatus, title: string) {
    const createdInVaultId = activeVaultIdRef.current;

    if (!createdInVaultId) return null;
    if ([...title.trim()].length > 200) {
      notifyError(t("tasks.error.create"));
      return null;
    }

    const id = crypto.randomUUID();
    const optimisticTask = createOptimisticTask(id, title.trim(), status);
    const pendingCreateTask = createTask(title, status, id);

    beginSave();
    updateTasksForVault(createdInVaultId, (currentTasks) => [
      ...currentTasks,
      optimisticTask,
    ]);
    pendingCreateTasksRef.current.set(id, pendingCreateTask);

    void pendingCreateTask
      .then((persistedTask) => {
        pendingCreateTasksRef.current.delete(id);

        updateTasksForVault(createdInVaultId, (currentTasks) =>
          replaceTask(currentTasks, persistedTask),
        );

        if (isActiveVault(createdInVaultId)) {
          completeSave(persistedTask.updatedAt);
        }
      })
      .catch(() => {
        pendingCreateTasksRef.current.delete(id);

        updateTasksForVault(createdInVaultId, (currentTasks) =>
          removeTask(currentTasks, id),
        );

        if (isActiveVault(createdInVaultId)) {
          failSave(tRef.current("tasks.error.create"));
        }
      });

    return optimisticTask;
  }

  async function handleUpdateTaskStatus(taskId: string, status: TaskStatus) {
    const operationVaultId = activeVaultIdRef.current;
    const currentTask = await findTaskForMutation(taskId, operationVaultId);

    if (!currentTask || currentTask.status === status) {
      return;
    }

    await persistOptimisticTaskUpdate(
      currentTask,
      { ...currentTask, status, updatedAt: new Date().toISOString() },
      () => updateTaskStatus(taskId, status),
      operationVaultId,
    );
  }

  async function handleUpdateTaskTitle(taskId: string, title: string) {
    const operationVaultId = activeVaultIdRef.current;
    const currentTask = await findTaskForMutation(taskId, operationVaultId);

    if (!currentTask || !isActiveVault(operationVaultId)) {
      return false;
    }

    if ([...title.trim()].length > 200) {
      notifyError(t("tasks.error.update"));
      return false;
    }

    if (currentTask.title === title.trim()) {
      return true;
    }

    try {
      beginSave();
      const updatedTask = await updateTaskTitle(taskId, title);

      updateTasksForVault(operationVaultId, (currentTasks) =>
        currentTasks.map((task) =>
          task.id === updatedTask.id ? updatedTask : task,
        ),
      );

      if (isActiveVault(operationVaultId)) {
        completeSave(updatedTask.updatedAt);
        return true;
      }
    } catch {
      if (isActiveVault(operationVaultId)) {
        failSave(tRef.current("tasks.error.update"));
      }
    }
    return false;
  }

  async function handleUpdateTaskPriority(
    taskId: string,
    priority: TaskPriority,
  ) {
    const operationVaultId = activeVaultIdRef.current;
    const currentTask = await findTaskForMutation(taskId, operationVaultId);

    if (!currentTask || currentTask.priority === priority) {
      return;
    }

    await persistOptimisticTaskUpdate(
      currentTask,
      { ...currentTask, priority, updatedAt: new Date().toISOString() },
      () => updateTaskPriority(taskId, priority),
      operationVaultId,
    );
  }

  async function handleUpdateTaskAttachedNote(
    taskId: string,
    noteId: string | null,
  ) {
    const operationVaultId = activeVaultIdRef.current;
    const currentTask = await findTaskForMutation(taskId, operationVaultId);

    if (!currentTask || currentTask.attachedNoteId === noteId) {
      return;
    }

    await persistOptimisticTaskUpdate(
      currentTask,
      {
        ...currentTask,
        attachedNoteId: noteId,
        updatedAt: new Date().toISOString(),
      },
      () => updateTaskAttachedNote(taskId, noteId),
      operationVaultId,
    );
  }

  async function handleDeleteTask(taskId: string) {
    const operationVaultId = activeVaultIdRef.current;
    const pendingCreateTask = pendingCreateTasksRef.current.get(taskId);
    let hiddenCreatedTask: Task | null = null;

    if (pendingCreateTask) {
      updateTasksForVault(operationVaultId, (currentTasks) =>
        removeTask(currentTasks, taskId),
      );

      try {
        hiddenCreatedTask = await pendingCreateTask;
      } catch {
        return;
      }

      if (!isActiveVault(operationVaultId)) {
        return;
      }
    }

    if (!isActiveVault(operationVaultId)) {
      return;
    }

    try {
      beginSave();
      await deleteTask(taskId);
      updateTasksForVault(operationVaultId, (currentTasks) =>
        removeTask(currentTasks, taskId),
      );

      if (isActiveVault(operationVaultId)) {
        completeSave(new Date().toISOString());
      }
    } catch {
      if (isActiveVault(operationVaultId)) {
        if (hiddenCreatedTask) {
          const restoredTask = hiddenCreatedTask;
          updateTasksForVault(operationVaultId, (currentTasks) =>
            currentTasks.some((task) => task.id === taskId)
              ? currentTasks
              : [...currentTasks, restoredTask],
          );
        }
        failSave(tRef.current("tasks.error.delete"));
      }
    }
  }

  async function findTaskForMutation(
    taskId: string,
    operationVaultId: string | null,
  ): Promise<Task | null> {
    const pendingCreateTask = pendingCreateTasksRef.current.get(taskId);

    if (pendingCreateTask) {
      try {
        await pendingCreateTask;
      } catch {
        return null;
      }
    }

    if (!isActiveVault(operationVaultId)) {
      return null;
    }

    return tasksRef.current.find((task) => task.id === taskId) ?? null;
  }

  function isActiveVault(vaultId: string | null): boolean {
    return activeVaultIdRef.current === vaultId;
  }

  function updateTasksForVault(
    vaultId: string | null,
    updateTasks: (currentTasks: Task[]) => Task[],
  ) {
    if (isActiveVault(vaultId)) {
      tasksRef.current = updateTasks(tasksRef.current);
      setTasks(tasksRef.current);
    }
  }

  async function persistOptimisticTaskUpdate(
    previousTask: Task,
    optimisticTask: Task,
    persistTask: () => Promise<Task>,
    operationVaultId: string | null,
  ) {
    updateTasksForVault(operationVaultId, (currentTasks) =>
      replaceTask(currentTasks, optimisticTask),
    );

    if (!isActiveVault(operationVaultId)) {
      return;
    }

    try {
      beginSave();
      const updatedTask = await persistTask();

      if (isActiveVault(operationVaultId)) {
        updateTasksForVault(operationVaultId, (currentTasks) =>
          replaceTask(currentTasks, updatedTask),
        );
        completeSave(updatedTask.updatedAt);
      }
    } catch {
      updateTasksForVault(operationVaultId, (currentTasks) =>
        replaceTask(currentTasks, previousTask),
      );

      if (isActiveVault(operationVaultId)) {
        failSave(tRef.current("tasks.error.update"));
      }
    }
  }

  // Serialize each task so a rollback always restores its last confirmed state.
  function serializeTaskMutation<Args extends unknown[], Result>(
    mutate: (taskId: string, ...args: Args) => Promise<Result>,
  ) {
    return (taskId: string, ...args: Args): Promise<Result | false> => {
      const vaultId = activeVaultIdRef.current;
      const previous =
        taskMutationsRef.current.get(taskId) ?? Promise.resolve();
      const pending = previous
        .catch(() => undefined)
        .then<Result | false>(() =>
          vaultId && isActiveVault(vaultId) ? mutate(taskId, ...args) : false,
        );
      taskMutationsRef.current.set(taskId, pending);
      void pending
        .finally(() => {
          if (taskMutationsRef.current.get(taskId) === pending) {
            taskMutationsRef.current.delete(taskId);
          }
        })
        .catch(() => undefined);
      return pending;
    };
  }

  const flushPendingTasks = useCallback(async () => {
    while (
      taskMutationsRef.current.size ||
      pendingCreateTasksRef.current.size
    ) {
      // Failures are already reported and rolled back by the mutation handlers.
      await Promise.allSettled([
        ...taskMutationsRef.current.values(),
        ...pendingCreateTasksRef.current.values(),
      ]);
    }
  }, []);

  function resetTaskSaveStatus() {
    hasSaveErrorRef.current = false;
    pendingSaveCountRef.current = 0;
    saveStatus.resetSaveStatus();
  }

  function beginSave() {
    if (pendingSaveCountRef.current === 0) {
      hasSaveErrorRef.current = false;
    }

    pendingSaveCountRef.current += 1;
    saveStatus.beginSave();
  }

  function completeSave(savedAt: string) {
    pendingSaveCountRef.current = Math.max(0, pendingSaveCountRef.current - 1);
    saveStatus.recordSavedAt(savedAt);

    if (pendingSaveCountRef.current === 0) {
      if (hasSaveErrorRef.current) {
        saveStatus.markError();
      } else {
        saveStatus.markSaved();
      }
    }
  }

  function failSave(message: string) {
    pendingSaveCountRef.current = Math.max(0, pendingSaveCountRef.current - 1);
    hasSaveErrorRef.current = true;
    notifyError(message);

    if (pendingSaveCountRef.current === 0) {
      saveStatus.markError();
    }
  }

  return {
    isLoading,
    lastSavedAt: saveStatus.lastSavedAt,
    saveState: saveStatus.saveState,
    saveStateText: saveStatus.saveStateText,
    tasks,
    handleCreateTask,
    flushPendingTasks,
    handleDeleteTask: async (taskId: string) => {
      await serializeTaskMutation(handleDeleteTask)(taskId);
    },
    handleUpdateTaskAttachedNote: serializeTaskMutation(
      handleUpdateTaskAttachedNote,
    ),
    handleUpdateTaskPriority: serializeTaskMutation(handleUpdateTaskPriority),
    handleUpdateTaskStatus: serializeTaskMutation(handleUpdateTaskStatus),
    handleUpdateTaskTitle: serializeTaskMutation(handleUpdateTaskTitle),
  };
}

function createOptimisticTask(
  id: string,
  title: string,
  status: TaskStatus,
): Task {
  const now = new Date().toISOString();

  return {
    attachedNoteId: null,
    createdAt: now,
    id,
    priority: defaultTaskPriority,
    status,
    title,
    updatedAt: now,
  };
}

function replaceTask(tasks: Task[], updatedTask: Task): Task[] {
  return tasks.map((task) => (task.id === updatedTask.id ? updatedTask : task));
}

function removeTask(tasks: Task[], taskId: string): Task[] {
  return tasks.filter((task) => task.id !== taskId);
}
