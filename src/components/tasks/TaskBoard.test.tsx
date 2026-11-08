// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Note } from "../../domain/notes";
import type { Task } from "../../domain/tasks";
import { TaskBoard } from "./TaskBoard";
import { stubModalSelector } from "../ui/testTopLayer";
import { setInputValue } from "../ui/testInput";

vi.mock("../../i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t, locale: "en-US" }) };
});

beforeEach(() => {
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function titleTask(attachedNoteId: string | null): Task {
  return {
    id: "task",
    title: "Title",
    status: "todo",
    priority: 4,
    attachedNoteId,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function StatefulTaskBoard({ initialTask }: { initialTask: Task }) {
  const [tasks, setTasks] = useState([initialTask]);

  return (
    <TaskBoard
      isLoading={false}
      notes={[]}
      tasks={tasks}
      onCreateTask={() => null}
      onDeleteTask={async () => {}}
      onOpenAttachedNote={() => {}}
      onUpdateTaskAttachedNote={() => {}}
      onUpdateTaskPriority={() => {}}
      onUpdateTaskStatus={(taskId, status) =>
        setTasks((currentTasks) =>
          currentTasks.map((task) =>
            task.id === taskId ? { ...task, status } : task,
          ),
        )
      }
      onUpdateTaskTitle={async () => true}
    />
  );
}

it("creates tasks with only a title and preserves note links without label controls", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const note: Note = {
    id: "note",
    title: "Linked note",
    content: "",
    kind: "note",
    archived: false,
    favorite: false,
    pinned: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const task = titleTask(note.id);
  const createTask = vi.fn().mockReturnValue(task);
  const openNote = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <TaskBoard
          isLoading={false}
          notes={[note]}
          tasks={[task]}
          onCreateTask={createTask}
          onDeleteTask={async () => {}}
          onOpenAttachedNote={openNote}
          onUpdateTaskAttachedNote={() => {}}
          onUpdateTaskPriority={() => {}}
          onUpdateTaskStatus={() => {}}
          onUpdateTaskTitle={async () => true}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".task-attached-note")!
        .click();
    });
    expect(openNote).toHaveBeenCalledExactlyOnceWith(note);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".task-add-link")!.click();
    });
    const form = container.querySelector<HTMLFormElement>(".task-create-form")!;
    const input = form.querySelector("input")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      setInputValue(input, "  New task  ");
    });
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(createTask).toHaveBeenCalledExactlyOnceWith("todo", "New task");
    expect(container.querySelector(".task-create-form")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("uses portalled keyboard menus to update priority, notes and status", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const notes: Note[] = ["First note", "Second note"].map((title, index) => ({
    id: `note-${index}`,
    title,
    content: "",
    kind: "note",
    archived: false,
    favorite: false,
    pinned: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }));
  const task = titleTask(notes[0].id);
  const updateNote = vi.fn();
  const updatePriority = vi.fn();
  const updateStatus = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const key = async (element: Element, value: string) => {
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  };
  try {
    await act(async () => {
      root.render(
        <TaskBoard
          isLoading={false}
          notes={notes}
          tasks={[task]}
          onCreateTask={() => null}
          onDeleteTask={async () => {}}
          onOpenAttachedNote={() => {}}
          onUpdateTaskAttachedNote={updateNote}
          onUpdateTaskPriority={updatePriority}
          onUpdateTaskStatus={updateStatus}
          onUpdateTaskTitle={async () => true}
        />,
      );
    });

    const priorityTrigger =
      container.querySelector<HTMLButtonElement>(".task-priority")!;
    priorityTrigger.focus();
    await key(priorityTrigger, "ArrowDown");
    let surface = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(surface).not.toBeNull();
    expect(container.contains(surface)).toBe(false);
    const firstPriority = [
      ...surface.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((item) => item.textContent === "tasks.priority.set")!;
    await key(surface, "Home");
    expect(document.activeElement).toBe(firstPriority);
    await act(async () => firstPriority.click());
    expect(updatePriority).toHaveBeenCalledExactlyOnceWith("task", 1);

    const noteTrigger =
      container.querySelector<HTMLButtonElement>(".task-note-button")!;
    await act(async () => noteTrigger.click());
    let noteDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(noteDialog).not.toBeNull();
    expect(
      container.querySelector(".task-card-list")!.contains(noteDialog),
    ).toBe(false);
    const search = noteDialog.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(search);
    await act(async () => {
      setInputValue(search, "Second");
    });
    const secondNote = [
      ...noteDialog.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Second note")!;
    await act(async () => secondNote.click());
    expect(updateNote).toHaveBeenLastCalledWith("task", notes[1].id);

    await act(async () => noteTrigger.click());
    noteDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const detach = [
      ...noteDialog.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "tasks.note.detach")!;
    await act(async () => detach.click());
    expect(updateNote).toHaveBeenLastCalledWith("task", null);

    await act(async () => noteTrigger.click());
    const statusTrigger = container.querySelector<HTMLButtonElement>(
      ".task-status-picker button",
    )!;
    await act(async () => statusTrigger.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    surface = document.querySelector<HTMLElement>('[role="menu"]')!;
    const doing = [
      ...surface.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((item) => item.textContent === "tasks.status.doing")!;
    await key(surface, "Home");
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(doing);
    await act(async () => doing.click());
    expect(updateStatus).toHaveBeenCalledExactlyOnceWith("task", "doing");

    statusTrigger.focus();
    await key(statusTrigger, "ArrowDown");
    await key(document.activeElement!, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(statusTrigger);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("restores focus after repeated keyboard status moves", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const task = titleTask(null);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const key = async (element: Element, value: string) => {
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  };
  const enter = async (element: Element) => {
    await key(element, "Enter");
    // jsdom does not synthesize the native button click generated by Enter.
    await act(async () =>
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 0,
        }),
      ),
    );
  };
  const triggerIn = (status: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-task-status="${status}"] [data-task-status-trigger="task"]`,
    )!;
  const waitForMenuFocus = async () => {
    await act(async () =>
      vi.waitFor(() => {
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        expect(menu?.contains(document.activeElement)).toBe(true);
      }),
    );
  };

  try {
    await act(async () =>
      root.render(<StatefulTaskBoard initialTask={task} />),
    );

    const todoTrigger = triggerIn("todo");
    todoTrigger.focus();
    await key(todoTrigger, "ArrowDown");
    await waitForMenuFocus();
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("tasks.status.doing");
    await enter(document.activeElement!);
    await act(async () =>
      vi.waitFor(() => {
        expect(document.activeElement).toBe(triggerIn("doing"));
      }),
    );

    const doingTrigger = triggerIn("doing");
    await key(doingTrigger, "ArrowDown");
    await waitForMenuFocus();
    await key(document.activeElement!, "End");
    expect(document.activeElement?.textContent).toBe("tasks.status.done");
    await enter(document.activeElement!);
    await act(async () =>
      vi.waitFor(() => {
        expect(document.activeElement).toBe(triggerIn("done"));
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  { fails: false, revise: false },
  { fails: true, revise: false },
  { fails: false, revise: true },
])(
  "blocks editor replacement and creation during a title save (%j)",
  async ({ fails, revise }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const tasks: Task[] = ["A", "B", "C"].map((id) => ({
      id,
      title: id,
      status: "todo",
      priority: 4,
      attachedNoteId: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }));
    let resolve!: (saved: boolean) => void;
    let reject!: (reason: unknown) => void;
    // The controller reports rejected API saves as false after recording the error.
    const pending = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    }).catch(() => false);
    const saveTitle = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <TaskBoard
            isLoading={false}
            notes={[]}
            tasks={tasks}
            onCreateTask={() => null}
            onDeleteTask={async () => {}}
            onOpenAttachedNote={() => {}}
            onUpdateTaskAttachedNote={() => {}}
            onUpdateTaskPriority={() => {}}
            onUpdateTaskStatus={() => {}}
            onUpdateTaskTitle={saveTitle}
          />,
        );
      });
      const titles = [
        ...container.querySelectorAll<HTMLElement>("[data-task-edit-title]"),
      ];
      await act(async () => {
        titles[0].click();
      });
      const input = container.querySelector<HTMLInputElement>(
        ".task-card-title-input input, input.task-card-title-input",
      )!;
      const changeDraft = (value: string) => {
        setInputValue(input, value);
      };
      await act(async () => {
        changeDraft("Draft A");
      });
      await act(async () => {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      expect(saveTitle).toHaveBeenCalledWith("A", "Draft A");
      await act(async () => {
        titles[1].click();
      });
      await act(async () => {
        titles[2].click();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".task-add-link")!.click();
      });
      expect(
        container.querySelectorAll('input:not([aria-hidden="true"])'),
      ).toHaveLength(1);
      expect(container.contains(input)).toBe(true);
      expect(input.value).toBe("Draft A");
      if (revise)
        await act(async () => {
          changeDraft("Newer draft A");
        });
      await act(async () => {
        if (fails) reject(new Error("offline"));
        else resolve(true);
        await pending;
      });
      if (fails || revise) {
        expect(container.contains(input)).toBe(true);
        expect(input.value).toBe(revise ? "Newer draft A" : "Draft A");
        await act(async () => {
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        });
        expect(saveTitle).toHaveBeenLastCalledWith(
          "A",
          revise ? "Newer draft A" : "Draft A",
        );
      }
      expect(container.contains(input)).toBe(false);
      await act(async () => {
        titles[1].click();
      });
      expect(
        container.querySelector<HTMLInputElement>(
          ".task-card-title-input input, input.task-card-title-input",
        )?.value,
      ).toBe("B");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("keeps a failed title draft, ignores composing Enter and allows dragging without a status select", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const task = titleTask(null);
  const saveTitle = vi.fn().mockResolvedValue(false);
  const updateStatus = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <TaskBoard
          isLoading={false}
          notes={[]}
          tasks={[task]}
          onCreateTask={() => null}
          onDeleteTask={async () => {}}
          onOpenAttachedNote={() => {}}
          onUpdateTaskAttachedNote={() => {}}
          onUpdateTaskPriority={() => {}}
          onUpdateTaskStatus={updateStatus}
          onUpdateTaskTitle={saveTitle}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLElement>("[data-task-edit-title]")!.click();
    });
    const input = container.querySelector<HTMLInputElement>(
      ".task-card-title-input input, input.task-card-title-input",
    )!;
    await act(async () => {
      setInputValue(input, "Draft");
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    expect(saveTitle).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(saveTitle).toHaveBeenCalledWith("task", "Draft");
    expect(container.contains(input)).toBe(true);
    expect(input.value).toBe("Draft");
    saveTitle.mockResolvedValue(true);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(container.contains(input)).toBe(false);
    const card = container.querySelector<HTMLElement>(".task-card")!;
    const doneColumn = container.querySelector<HTMLElement>(
      '[data-task-status="done"]',
    )!;
    // jsdom does not implement pointer capture or hit testing.
    card.setPointerCapture = vi.fn();
    card.hasPointerCapture = () => false;
    const elementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint",
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => doneColumn,
    });
    try {
      for (const [type, clientX] of [
        ["pointerdown", 0],
        ["pointermove", 20],
        ["pointerup", 20],
      ] as const) {
        await act(async () => {
          const event = new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX,
          });
          Object.defineProperty(event, "pointerId", { value: 1 });
          card.dispatchEvent(event);
        });
      }
      expect(updateStatus).toHaveBeenCalledExactlyOnceWith("task", "done");
    } finally {
      if (elementFromPoint)
        Object.defineProperty(document, "elementFromPoint", elementFromPoint);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
