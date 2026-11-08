import { describe, expect, it } from "vitest";
import {
  groupTasksForBoard,
  groupTasksByStatus,
  sortTasksByPriority,
  type Task,
  type TaskPriority,
} from "./tasks";

const baseTask = {
  attachedNoteId: null,
  createdAt: "2026-06-28T10:00:00.000Z",
  priority: 4 as TaskPriority,
  title: "Task",
  updatedAt: "2026-06-28T10:00:00.000Z",
};

function task(
  id: string,
  status: Task["status"],
  updatedAt = baseTask.updatedAt,
  priority = baseTask.priority,
  createdAt = baseTask.createdAt,
): Task {
  return {
    ...baseTask,
    createdAt,
    id,
    priority,
    status,
    updatedAt,
  };
}

describe("groupTasksByStatus", () => {
  it("groups tasks into fixed task statuses", () => {
    const groupedTasks = groupTasksByStatus([
      task("todo-1", "todo"),
      task("doing-1", "doing"),
      task("done-1", "done"),
      task("todo-2", "todo"),
    ]);

    expect(groupedTasks.todo.map((currentTask) => currentTask.id)).toEqual([
      "todo-1",
      "todo-2",
    ]);
    expect(groupedTasks.doing.map((currentTask) => currentTask.id)).toEqual([
      "doing-1",
    ]);
    expect(groupedTasks.done.map((currentTask) => currentTask.id)).toEqual([
      "done-1",
    ]);
  });

  it("orders board done tasks by most recent update instead of priority", () => {
    const groupedTasks = groupTasksForBoard([
      task("urgent-old", "done", "2026-06-28T10:00:00.000Z", 1),
      task("default-new", "done", "2026-06-28T12:00:00.000Z", 4),
      task("secondary-middle", "done", "2026-06-28T11:00:00.000Z", 3),
    ]);

    expect(groupedTasks.done.map((currentTask) => currentTask.id)).toEqual([
      "default-new",
      "secondary-middle",
      "urgent-old",
    ]);
  });
});

describe("sortTasksByPriority", () => {
  it("orders tasks by priority first", () => {
    const tasks = [
      task("default", "todo", "2026-06-28T12:00:00.000Z", 4),
      task("urgent", "doing", "2026-06-28T10:00:00.000Z", 1),
      task("secondary", "done", "2026-06-28T11:00:00.000Z", 3),
    ];

    expect(
      sortTasksByPriority(tasks).map((currentTask) => currentTask.id),
    ).toEqual(["urgent", "secondary", "default"]);
  });

  it("keeps older tasks first when priorities match", () => {
    const tasks = [
      task(
        "new",
        "doing",
        "2026-06-28T10:00:00.000Z",
        4,
        "2026-06-28T12:00:00.000Z",
      ),
      task(
        "old",
        "todo",
        "2026-06-28T12:00:00.000Z",
        4,
        "2026-06-28T10:00:00.000Z",
      ),
      task(
        "middle",
        "done",
        "2026-06-28T11:00:00.000Z",
        4,
        "2026-06-28T11:00:00.000Z",
      ),
    ];

    expect(
      sortTasksByPriority(tasks).map((currentTask) => currentTask.id),
    ).toEqual(["old", "middle", "new"]);
  });

  it("falls back to title when priority and creation date match", () => {
    const tasks = [
      { ...task("beta", "todo"), title: "Beta" },
      { ...task("alpha", "todo"), title: "Alpha" },
    ];

    expect(
      sortTasksByPriority(tasks).map((currentTask) => currentTask.id),
    ).toEqual(["alpha", "beta"]);
  });
});
