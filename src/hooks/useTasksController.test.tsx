// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../data/tasksApi";
import type { Task } from "../domain/tasks";
import { clearNotifications, getNotifications } from "../notifications";
import { useTasksController } from "./useTasksController";
import { deferred } from "../testing/deferred";

const i18n = vi.hoisted(() => ({
  language: "en" as "en" | "fr",
  translators: {
    en: (key: string) => `en:${key}`,
    fr: (key: string) => `fr:${key}`,
  },
}));

vi.mock("../data/tasksApi");
vi.mock("../i18n", () => ({
  useI18n: () => ({
    locale: i18n.language,
    t: i18n.translators[i18n.language],
  }),
}));

const initial: Task = {
  id: "task",
  title: "Title",
  status: "todo",
  priority: 2,
  attachedNoteId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
let root: Root;
let container: HTMLDivElement;
let controller: ReturnType<typeof useTasksController>;
function Harness({ vaultId = "vault" }: { vaultId?: string }) {
  controller = useTasksController(vaultId);
  return null;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  i18n.language = "en";
  vi.mocked(api.listTasks).mockResolvedValue([initial]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
});

describe("task mutation persistence", () => {
  it.each([false, true])(
    "drains accepted mutations before changing vault (pending creation=%s)",
    async (withCreation) => {
      const creation = deferred<Task>();
      const status = deferred<Task>();
      const priority = deferred<Task>();
      let nativeVault = "vault";
      const apiVaults: string[] = [];
      vi.mocked(api.createTask).mockReturnValue(creation.promise);
      vi.mocked(api.updateTaskStatus).mockImplementation(() => {
        apiVaults.push(nativeVault);
        return status.promise;
      });
      vi.mocked(api.updateTaskPriority).mockImplementation(() => {
        apiVaults.push(nativeVault);
        return priority.promise;
      });
      let task = initial;
      let transition!: Promise<void>;
      let savedTasks: Task[] = [];
      await act(async () => {
        if (withCreation) task = controller.handleCreateTask("todo", "New")!;
        void controller.handleUpdateTaskStatus(task.id, "doing");
        void controller.handleUpdateTaskPriority(task.id, 1);
        transition = controller.flushPendingTasks().then(() => {
          savedTasks = controller.tasks;
          nativeVault = "other";
          root.render(<Harness vaultId="other" />);
        });
      });
      if (withCreation) {
        expect(vi.mocked(api.createTask).mock.calls).toEqual([
          ["New", "todo", task.id],
        ]);
        expect(api.updateTaskStatus).not.toHaveBeenCalled();
        expect(nativeVault).toBe("vault");
        await act(async () => {
          creation.resolve(task);
        });
      }
      expect(api.updateTaskStatus).toHaveBeenCalledWith(task.id, "doing");
      expect(api.updateTaskPriority).not.toHaveBeenCalled();
      await act(async () => {
        status.resolve({ ...task, status: "doing" });
      });
      expect(nativeVault).toBe("vault");
      expect(api.updateTaskPriority).toHaveBeenCalledWith(task.id, 1);
      await act(async () => {
        priority.resolve({ ...task, status: "doing", priority: 1 });
        await transition;
      });
      expect(apiVaults).toEqual(["vault", "vault"]);
      expect(savedTasks.find((saved) => saved.id === task.id)).toMatchObject({
        status: "doing",
        priority: 1,
      });
      expect(nativeVault).toBe("other");
    },
  );

  it("keeps draining when another mutation is accepted during the flush", async () => {
    const status = deferred<Task>();
    const priority = deferred<Task>();
    vi.mocked(api.updateTaskStatus).mockReturnValue(status.promise);
    vi.mocked(api.updateTaskPriority).mockReturnValue(priority.promise);
    let drained = false;
    let flush!: Promise<void>;
    const flushPendingTasks = controller.flushPendingTasks;
    await act(async () => {
      void controller.handleUpdateTaskStatus(initial.id, "doing");
      flush = flushPendingTasks().then(() => {
        drained = true;
      });
    });
    expect(controller.flushPendingTasks).toBe(flushPendingTasks);
    await act(async () => {
      void controller.handleUpdateTaskPriority(initial.id, 1);
      status.resolve({ ...initial, status: "doing" });
    });
    expect(drained).toBe(false);
    await act(async () => {
      priority.resolve({ ...initial, status: "doing", priority: 1 });
      await flush;
    });
    expect(drained).toBe(true);
    expect(controller.tasks[0]).toMatchObject({ status: "doing", priority: 1 });
  });

  it("drains creations without mutations, including a failed creation and its rollback", async () => {
    const creation = deferred<Task>();
    vi.mocked(api.createTask).mockReturnValue(creation.promise);
    let drained = false;
    let flush!: Promise<void>;
    await act(async () => {
      controller.handleCreateTask("todo", "New");
      flush = controller.flushPendingTasks().then(() => {
        drained = true;
      });
    });
    expect(drained).toBe(false);
    await act(async () => {
      creation.reject(new Error("offline"));
      await flush;
    });
    expect(drained).toBe(true);
    expect(controller.tasks).toEqual([initial]);
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        message: "en:tasks.error.create",
        tone: "error",
      }),
    ]);
    await controller.flushPendingTasks();
  });

  it("serializes two failing optimistic updates against the confirmed task", async () => {
    const first = deferred<Task>();
    const second = deferred<Task>();
    vi.mocked(api.updateTaskStatus).mockReturnValue(first.promise);
    vi.mocked(api.updateTaskPriority).mockReturnValue(second.promise);
    let a: Promise<unknown>;
    let b: Promise<unknown>;
    await act(async () => {
      a = controller.handleUpdateTaskStatus("task", "doing");
      b = controller.handleUpdateTaskPriority("task", 1);
    });
    expect(controller.tasks[0].status).toBe("doing");
    expect(api.updateTaskPriority).not.toHaveBeenCalled();
    await act(async () => {
      first.reject(new Error("fail"));
      await a;
    });
    expect(controller.tasks[0].status).toBe("todo");
    expect(controller.tasks[0].priority).toBe(1);
    await act(async () => {
      second.reject(new Error("fail"));
      await b;
    });
    expect(controller.tasks).toEqual([initial]);
  });

  it("restores a newly persisted task when its queued deletion fails", async () => {
    const creation = deferred<Task>();
    vi.mocked(api.createTask).mockReturnValue(creation.promise);
    vi.mocked(api.deleteTask).mockRejectedValue(new Error("delete failed"));
    let created!: Task;
    let deletion!: Promise<void>;
    await act(async () => {
      created = controller.handleCreateTask("todo", "New")!;
      deletion = controller.handleDeleteTask(created.id);
    });
    expect(controller.tasks.some((task) => task.id === created.id)).toBe(false);
    await act(async () => {
      creation.resolve(created);
      await deletion;
    });
    expect(controller.tasks).toContainEqual(created);
  });

  it("returns failure without losing title, counting Unicode code points", async () => {
    vi.mocked(api.updateTaskTitle).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      expect(await controller.handleUpdateTaskTitle("task", "New title")).toBe(
        false,
      );
      expect(
        await controller.handleUpdateTaskTitle("task", "é".repeat(201)),
      ).toBe(false);
    });
    expect(controller.tasks[0].title).toBe("Title");
    expect(api.updateTaskTitle).toHaveBeenCalledTimes(1);
    const title = "😀".repeat(200);
    vi.mocked(api.updateTaskTitle).mockResolvedValue({ ...initial, title });
    await act(async () => {
      expect(await controller.handleUpdateTaskTitle("task", title)).toBe(true);
    });
    expect(controller.tasks[0].title).toBe(title);
  });

  it("keeps an optimistic creation when the language changes", async () => {
    const creation = deferred<Task>();
    vi.mocked(api.createTask).mockReturnValue(creation.promise);
    let created!: Task;

    await act(async () => {
      created = controller.handleCreateTask("todo", "New")!;
    });

    i18n.language = "fr";
    await act(async () => root.render(<Harness />));
    expect(api.listTasks).toHaveBeenCalledTimes(1);
    expect(controller.tasks).toContainEqual(created);

    const persisted = { ...created, title: "Persisted" };
    await act(async () => creation.resolve(persisted));
    expect(controller.tasks).toContainEqual(persisted);
  });

  it("keeps a pending optimistic mutation when the language changes", async () => {
    const mutation = deferred<Task>();
    vi.mocked(api.updateTaskStatus).mockReturnValue(mutation.promise);

    await act(async () => {
      void controller.handleUpdateTaskStatus(initial.id, "doing");
    });

    i18n.language = "fr";
    await act(async () => root.render(<Harness />));
    expect(api.listTasks).toHaveBeenCalledTimes(1);
    expect(controller.tasks[0].status).toBe("doing");

    await act(async () => mutation.resolve({ ...initial, status: "doing" }));
    expect(controller.tasks[0].status).toBe("doing");
  });

  it("uses the current language when a task load fails", async () => {
    const load = deferred<Task[]>();
    vi.mocked(api.listTasks).mockReturnValue(load.promise);

    await act(async () => root.render(<Harness vaultId="other" />));
    i18n.language = "fr";
    await act(async () => root.render(<Harness vaultId="other" />));
    await act(async () => load.reject(null));

    expect(api.listTasks).toHaveBeenCalledTimes(2);
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        message: "fr:tasks.error.load",
        tone: "error",
      }),
    ]);
  });
});
