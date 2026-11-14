import { compareDate } from "./dateTime";

export type Task = {
  id: string;
  attachedNoteId: string | null;
  priority: TaskPriority;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export const taskPriorities = [1, 2, 3, 4] as const;

export type TaskPriority = (typeof taskPriorities)[number];

export const defaultTaskPriority: TaskPriority = 4;

export const taskStatuses = ["todo", "doing", "done"] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const defaultTaskStatus: TaskStatus = "todo";

type TasksByStatus = Record<TaskStatus, Task[]>;

export function groupTasksByStatus(tasks: Task[]): TasksByStatus {
  const groups = createEmptyTaskGroups();

  tasks.forEach((task) => {
    groups[task.status].push(task);
  });

  return groups;
}

export function groupTasksForBoard(tasks: Task[]): TasksByStatus {
  const groups = groupTasksByStatus(tasks);

  return {
    todo: sortTasksByPriority(groups.todo),
    doing: sortTasksByPriority(groups.doing),
    done: sortDoneTasksByRecentUpdate(groups.done),
  };
}

export function sortTasksByPriority(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    return (
      left.priority - right.priority ||
      compareDate(left.createdAt, right.createdAt) ||
      left.title.localeCompare(right.title)
    );
  });
}

function sortDoneTasksByRecentUpdate(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    return (
      compareDate(right.updatedAt, left.updatedAt) ||
      compareDate(right.createdAt, left.createdAt) ||
      left.title.localeCompare(right.title)
    );
  });
}

function createEmptyTaskGroups(): TasksByStatus {
  return {
    todo: [],
    doing: [],
    done: [],
  };
}
