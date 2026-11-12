// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import type {
  AgentBoard,
  AgentTransitionGuard,
} from "./components/agents/AgentWorkspace";
import type { Note } from "./domain/notes";
import { deferred } from "./testing/deferred";

const state = vi.hoisted(() => ({
  close: {} as {
    beforeClose: () => Promise<boolean>;
    onCloseCancelled?: () => void;
  },
  prepareAgents: vi.fn<() => Promise<boolean>>(),
  cancelAgents: vi.fn(),
  mountAgents: vi.fn(),
  unmountAgents: vi.fn(),
  flushPendingTasks: vi.fn<() => Promise<void>>(),
  activeView: "tasks",
  reactiveView: false,
  searchQuery: "",
  selectView: vi.fn(),
  agentLoadPromise: null as Promise<void> | null,
  agentLoadResolved: false,
  selectedNote: null as Note | null,
  isLoading: false,
  changeVault: vi.fn<() => Promise<void>>(),
  selectVault: (_id: string): Promise<void> => Promise.resolve(),
  updateSettings: vi.fn(),
}));
vi.mock("./hooks/useNotesController", () => ({
  useNotesController: (options: typeof state.close) => {
    state.close = options;
    const [reactiveActiveView, setReactiveActiveView] = useState(
      state.activeView,
    );
    return {
      activeVault: { id: "vault" },
      activeView: state.reactiveView ? reactiveActiveView : state.activeView,
      notes: [],
      noteTypes: [],
      vaults: [],
      selectedNote: state.selectedNote,
      content: state.selectedNote?.content ?? "",
      isLoading: state.isLoading,
      searchQuery: state.searchQuery,
      setSearchQuery: (query: string) => {
        state.searchQuery = query;
      },
      handleSelectView: (view: string) => {
        state.selectView(view);
        state.activeView = view;
        state.searchQuery = "";
        setReactiveActiveView(view);
      },
      handleSelectVault: state.changeVault,
      saveState: "saved",
      saveStateText: "Saved",
    };
  },
}));
vi.mock("./hooks/useTasksController", () => ({
  useTasksController: () => ({
    saveState: "saved",
    saveStateText: "Saved",
    flushPendingTasks: state.flushPendingTasks,
  }),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({ locale: "fr-FR", t: (key: string) => key }),
}));
vi.mock("./settings", () => ({
  useAppSettings: () => ({
    settings: { noteLockMinutes: 10 },
    updateSettings: state.updateSettings,
  }),
}));
vi.mock("./components/agents/AgentWorkspace", () => ({
  AgentWorkspace: ({
    gitPanelContainer,
    gitPanelExpanded,
    gitPanelVisible,
    hidden,
    boardRequest,
    onGitPanelExpandedChange,
    onGitPanelVisibleChange,
    onBoardChange,
    onBoardIssuePanelChange,
    sidebarContainer,
    registerTransitionGuard,
  }: {
    gitPanelContainer?: HTMLElement | null;
    gitPanelExpanded: boolean;
    gitPanelVisible: boolean;
    hidden: boolean;
    boardRequest?: { board: AgentBoard | null };
    onGitPanelExpandedChange: (expanded: boolean) => void;
    onGitPanelVisibleChange: (visible: boolean) => void;
    onBoardChange: (board: AgentBoard | null) => void;
    onBoardIssuePanelChange: (open: boolean) => void;
    sidebarContainer?: HTMLElement | null;
    registerTransitionGuard: (guard: AgentTransitionGuard) => () => void;
  }) => {
    if (state.agentLoadPromise && !state.agentLoadResolved)
      throw state.agentLoadPromise;
    const [closing, setClosing] = useState(false);
    const [draft, setDraft] = useState("");
    useEffect(() => {
      state.mountAgents();
      return () => {
        state.unmountAgents();
      };
    }, []);
    useEffect(() => {
      if (boardRequest) onBoardChange(boardRequest.board);
    }, [boardRequest, onBoardChange]);
    useEffect(
      () =>
        registerTransitionGuard({
          prepare: () => {
            setClosing(true);
            return state.prepareAgents();
          },
          cancel: () => {
            state.cancelAgents();
            setClosing(false);
          },
          hasPendingWork: () => true,
        }),
      [registerTransitionGuard],
    );
    return createElement(
      "div",
      { "data-agent-workspace": true, "data-closing": closing, hidden },
      createElement(
        "button",
        {
          "aria-controls": "workspace-agent-git",
          onClick: () => onGitPanelVisibleChange(!gitPanelVisible),
        },
        "Changements",
      ),
      createElement(
        "button",
        {
          "aria-label": "Expand changes",
          onClick: () => onGitPanelExpandedChange(!gitPanelExpanded),
        },
        "Agrandir",
      ),
      createElement(
        "button",
        {
          "aria-label": "Write agent draft",
          onClick: () => setDraft("Draft preserved"),
        },
        "Brouillon",
      ),
      createElement(
        "button",
        {
          "aria-label": "Open board issue",
          onClick: () => onBoardIssuePanelChange(true),
        },
        "Issue",
      ),
      createElement("span", { "data-agent-draft": true }, draft),
      sidebarContainer
        ? createPortal(
            createElement(
              "nav",
              { "data-agent-navigation": true, hidden },
              "Agent projects",
            ),
            sidebarContainer,
          )
        : null,
      gitPanelContainer
        ? createPortal(
            createElement(
              "section",
              {
                "data-agent-git-panel": true,
                hidden: hidden || !gitPanelVisible,
              },
              "Git backend pending",
            ),
            gitPanelContainer,
          )
        : null,
    );
  },
}));
vi.mock("./components/ResizableWorkspace", () => ({
  ResizableWorkspace: ({
    sidebar,
    browser,
    editor,
    editorVisible,
    rightPanel,
    rightPanelExpanded,
    rightPanelVisible,
    sidebarVisible,
  }: {
    sidebar: ReactNode;
    browser: ReactNode;
    editor: ReactNode;
    editorVisible: boolean;
    rightPanel: ReactNode;
    rightPanelExpanded: boolean;
    rightPanelVisible: boolean;
    sidebarVisible: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-right-panel-expanded": rightPanelExpanded,
        "data-right-panel-visible": rightPanelVisible,
        "data-sidebar-visible": sidebarVisible,
      },
      sidebar,
      createElement("div", { "data-workspace-browser": true }, browser),
      createElement(
        "div",
        { "data-workspace-editor": true, hidden: !editorVisible },
        editor,
      ),
      createElement("div", { "data-workspace-right": true }, rightPanel),
    ),
}));
vi.mock("./components/AppTitleBar", () => ({ AppTitleBar: () => null }));
vi.mock("./components/EditorPane", () => ({
  EditorPane: ({
    selectedNote,
    readOnly,
  }: {
    selectedNote: Note | null;
    readOnly: boolean;
  }) =>
    createElement("div", {
      "data-editor-note": selectedNote?.id ?? "none",
      "data-read-only": readOnly,
    }),
}));
vi.mock("./components/NoteBrowser", () => ({
  NoteBrowser: ({ isLoading }: { isLoading: boolean }) =>
    createElement("div", { "data-browser-loading": isLoading }),
}));
// Base UI tooltips never settle in jsdom once their trigger receives focus.
vi.mock("@base-ui/react/tooltip", () => ({
  Tooltip: {
    Provider: ({ children }: { children: ReactNode }) => children,
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ render }: { render: ReactNode }) => render,
    Portal: () => null,
  },
}));
vi.mock("./components/Sidebar", () => ({
  Sidebar: () =>
    createElement("div", { "data-notes-navigation": true }, "Note collections"),
}));
vi.mock("./components/SettingsModal", () => ({
  SettingsModal: () => createElement("div", { "data-settings-modal": true }),
}));
vi.mock("./components/StatusBar", () => ({
  StatusBar: ({
    onSelectVault,
    showNotesInfo,
  }: {
    onSelectVault: typeof state.selectVault;
    showNotesInfo: boolean;
  }) => {
    state.selectVault = onSelectVault;
    return createElement("div", { "data-notes-info": showNotesInfo });
  },
}));
vi.mock("./components/tasks/TaskBoard", () => ({ TaskBoard: () => null }));
vi.mock("./components/tasks/TaskLinkedNoteEditor", () => ({
  TaskLinkedNoteEditor: () => null,
}));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  state.reactiveView = false;
  state.searchQuery = "";
  state.agentLoadPromise = null;
  state.agentLoadResolved = false;
  state.flushPendingTasks.mockResolvedValue(undefined);
  state.prepareAgents.mockResolvedValue(true);
});
afterEach(() => {
  vi.resetAllMocks();
  state.activeView = "tasks";
  state.selectedNote = null;
  state.isLoading = false;
});

it("blocks native webview shortcuts without swallowing project search", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    for (const shortcut of [
      { key: "f", ctrlKey: true },
      { key: "f", metaKey: true },
      { key: "g", ctrlKey: true },
      { key: "g", metaKey: true, shiftKey: true },
      { key: "F3" },
      { key: "F3", shiftKey: true },
      { key: "p", ctrlKey: true },
      { key: "p", metaKey: true },
      { key: "r", ctrlKey: true },
      { key: "r", metaKey: true },
      { key: "r", ctrlKey: true, shiftKey: true },
      { key: "F5" },
      { key: "F5", ctrlKey: true },
      { key: "F5", shiftKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...shortcut,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const projectSearch = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(projectSearch);
    expect(projectSearch.defaultPrevented).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("steps the agent text size within its options from the agents view only", async () => {
  state.updateSettings.mockResolvedValue(undefined);
  const press = (init: KeyboardEventInit, target: EventTarget = document) => {
    const event = new KeyboardEvent("keydown", {
      ...init,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    expect(press({ key: "=", ctrlKey: true })).toBe(false);
    expect(state.updateSettings).not.toHaveBeenCalled();
    await act(async () => root.unmount());

    state.activeView = "agents";
    const next = createRoot(container);
    await act(async () => next.render(createElement(App)));
    const canvas = document.createElement("div");
    canvas.className = "design-canvas";
    const inCanvas = canvas.appendChild(document.createElement("div"));
    document.body.appendChild(canvas);
    try {
      for (const [init, from, to] of [
        [{ key: "+", ctrlKey: true, shiftKey: true }, 100, 110],
        [{ key: "=", ctrlKey: true }, 150, 150],
        [{ key: "-", ctrlKey: true }, 80, 80],
        [{ key: "-", code: "Digit6", ctrlKey: true }, 125, 110],
        [{ key: "à", code: "Digit0", ctrlKey: true }, 150, 100],
        [{ key: "=", ctrlKey: true, altKey: true }, null, null],
        [{ key: "]", code: "Equal", ctrlKey: true }, null, null],
        [{ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }, null, null],
        [{ key: "=", ctrlKey: true }, "canvas", null],
      ] as const) {
        state.updateSettings.mockClear();
        const prevented = press(init, from === "canvas" ? inCanvas : document);
        if (from === null || from === "canvas") {
          expect(prevented).toBe(false);
          expect(state.updateSettings).not.toHaveBeenCalled();
          continue;
        }
        expect(prevented).toBe(true);
        const patch = state.updateSettings.mock.calls[0][0];
        expect(patch({ agentTextSize: from })).toEqual({ agentTextSize: to });
      }
    } finally {
      canvas.remove();
      await act(async () => next.unmount());
    }
  } finally {
    container.remove();
  }
});

it.each(["close", "vault"] as const)(
  "waits for tasks under the inert lock before %s",
  async (reason) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let resolveTasks!: () => void;
    state.flushPendingTasks.mockImplementation(() => {
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(true);
      return new Promise<void>((resolve) => {
        resolveTasks = resolve;
      });
    });
    const destroy = vi.fn();
    try {
      await act(async () => root.render(createElement(App)));
      let transition!: Promise<void>;
      await act(async () => {
        transition =
          reason === "vault"
            ? state.selectVault("other")
            : state.close.beforeClose().then((ready) => {
                if (ready) destroy();
              });
      });
      expect(state.flushPendingTasks).toHaveBeenCalledTimes(1);
      expect(state.changeVault).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(true);
      await act(async () => {
        resolveTasks();
        await transition;
      });
      expect(
        reason === "vault" ? state.changeVault : destroy,
      ).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("keeps the selected editor read-only while a vault loads under the inert lock", async () => {
  state.activeView = "all";
  state.selectedNote = {
    id: "old-note",
    title: "Old note",
    content: "Content",
    kind: "notes",
    archived: false,
    favorite: false,
    pinned: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
  let resolveVault!: () => void;
  state.changeVault.mockImplementation(() => {
    state.isLoading = true;
    return new Promise((resolve) => {
      resolveVault = resolve;
    });
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    const editor = container.querySelector("[data-editor-note]");
    let changing!: Promise<void>;
    await act(async () => {
      changing = state.selectVault("other");
    });
    await act(async () => root.render(createElement(App)));
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(true);
    expect(
      container
        .querySelector("[data-browser-loading]")
        ?.getAttribute("data-browser-loading"),
    ).toBe("false");
    expect(container.querySelector("[data-editor-note]")).toBe(editor);
    expect(editor?.getAttribute("data-editor-note")).toBe("old-note");
    expect(editor?.getAttribute("data-read-only")).toBe("true");
    await act(async () => {
      state.selectedNote = { ...state.selectedNote!, id: "new-note" };
      state.isLoading = false;
      resolveVault();
      await changing;
    });
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(false);
    expect(editor?.getAttribute("data-editor-note")).toBe("new-note");
    expect(editor?.getAttribute("data-read-only")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the current note when flushing tasks fails before a vault change", async () => {
  state.activeView = "all";
  state.selectedNote = {
    id: "old-note",
    title: "Old note",
    content: "Content",
    kind: "notes",
    archived: false,
    favorite: false,
    pinned: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
  const rejectTasks = deferred<void>();
  state.flushPendingTasks.mockReturnValue(rejectTasks.promise);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    let changing!: Promise<void>;
    await act(async () => {
      changing = state.selectVault("other");
    });
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(true);
    expect(
      container
        .querySelector("[data-read-only]")
        ?.getAttribute("data-read-only"),
    ).toBe("true");
    await act(async () => {
      rejectTasks.reject(new Error("disk full"));
      await changing;
    });
    expect(state.changeVault).not.toHaveBeenCalled();
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(false);
    expect(
      container
        .querySelector("[data-editor-note]")
        ?.getAttribute("data-editor-note"),
    ).toBe("old-note");
    expect(
      container
        .querySelector("[data-read-only]")
        ?.getAttribute("data-read-only"),
    ).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not release a vault transition when a concurrent close is cancelled", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const resolveVault = deferred<void>();
  state.changeVault.mockReturnValue(resolveVault.promise);
  try {
    await act(async () => root.render(createElement(App)));
    let changing!: Promise<void>;
    await act(async () => {
      changing = state.selectVault("other");
    });
    expect(state.changeVault).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await state.close.beforeClose()).toBe(false);
      state.close.onCloseCancelled?.();
    });
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(true);
    await act(async () => {
      resolveVault.resolve();
      await changing;
    });
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([true, false])(
  "wires the unique close guard and keeps workspace locked until close on success=%s",
  async (success) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let finish!: () => void;
    state.flushPendingTasks.mockImplementation(() => {
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(true);
      return new Promise<void>((resolve, reject) => {
        finish = () => (success ? resolve() : reject(new Error("disk full")));
      });
    });
    try {
      await act(async () => root.render(createElement(App)));
      let closing!: Promise<boolean>;
      act(() => {
        closing = state.close.beforeClose();
      });
      await act(async () => {});
      expect(state.flushPendingTasks).toHaveBeenCalledTimes(1);
      expect(await state.close.beforeClose()).toBe(false);
      await act(async () => {
        finish();
        expect(await closing).toBe(success);
      });
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(success);
      // A later notes flush or native destroy failure cancels the prepared close.
      act(() => state.close.onCloseCancelled?.());
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([
  ["all", "true"],
  ["agents", "false"],
])(
  "sets Notes status information visibility in %s",
  async (activeView, visible) => {
    state.activeView = activeView;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(App)));
      expect(
        container
          .querySelector("[data-notes-info]")
          ?.getAttribute("data-notes-info"),
      ).toBe(visible);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("shows an accessible spinner without visible loading text when Agents suspends at startup", async () => {
  state.activeView = "agents";
  state.agentLoadPromise = new Promise<void>(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    const status = container.querySelector<HTMLElement>('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.closest("[hidden]")).toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("Chargement des projets…");
    expect(container.textContent).not.toContain("Chargement des projets…");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["after pending renders", "in the same task"])(
  "keeps the last Notes intent when Agents suspends %s",
  async (timing) => {
    state.activeView = "all";
    state.reactiveView = true;
    let resolveAgents!: () => void;
    state.agentLoadPromise = new Promise<void>((resolve) => {
      resolveAgents = resolve;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(App)));
      const notesButton = container.querySelector<HTMLButtonElement>(
        '[aria-controls="workspace-notes-navigation"]',
      )!;
      const agentsButton = container.querySelector<HTMLButtonElement>(
        '[aria-controls="workspace-agents-navigation"]',
      )!;
      if (timing === "in the same task") {
        act(() => {
          agentsButton.click();
          notesButton.click();
        });
      } else {
        act(() => agentsButton.click());
        act(() => notesButton.click());
      }
      expect(state.selectView.mock.calls.map(([view]) => view)).toEqual([
        "agents",
        "all",
      ]);
      state.agentLoadResolved = true;
      await act(async () => {
        resolveAgents();
        await state.agentLoadPromise;
      });
      expect(notesButton.getAttribute("aria-current")).toBe("page");
      expect(container.querySelector("[data-agent-workspace]")).toBeNull();
      expect(state.mountAgents).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("does not clear an existing search when Notes is already selected", async () => {
  state.activeView = "all";
  state.searchQuery = "needle";
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-controls="workspace-notes-navigation"]',
        )!
        .click(),
    );
    expect(state.selectView).not.toHaveBeenCalled();
    expect(state.searchQuery).toBe("needle");
  } finally {
    await act(async () => root.unmount());
  }
});

it("returns from the Tasks tab to the last notes view", async () => {
  state.activeView = "archive";
  state.reactiveView = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    const tasksButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="views.tasks"]',
    )!;
    act(() => tasksButton.click());
    expect(tasksButton.getAttribute("aria-current")).toBe("page");
    expect(
      container.querySelector<HTMLElement>("#workspace-notes-navigation")
        ?.hidden,
    ).toBe(true);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-controls="workspace-notes-navigation"]',
        )!
        .click(),
    );
    expect(state.selectView.mock.calls.map(([view]) => view)).toEqual([
      "tasks",
      "archive",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("restores a saved activity tab order and persists a dragged one", async () => {
  localStorage.setItem("soreno:activity-tab-order", "tasks,bogus,tasks");
  state.activeView = "all";
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const labels = () =>
    [...container.querySelectorAll(".activity-bar-items [aria-label]")].map(
      (item) => item.getAttribute("aria-label"),
    );
  const pointer = (target: EventTarget, type: string, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: "mouse" },
    });
    target.dispatchEvent(event);
  };
  try {
    await act(async () => root.render(createElement(App)));
    expect(labels()).toEqual([
      "views.tasks",
      "Kanban",
      "views.automations",
      "views.design",
      "sidebar.notes",
    ]);
    const box = (top: number, bottom: number) =>
      ({
        left: 0,
        right: 58,
        top,
        bottom,
        width: 58,
        height: bottom - top,
      }) as DOMRect;
    container.querySelector<HTMLElement>(
      ".activity-bar-items",
    )!.getBoundingClientRect = () => box(0, 300);
    container
      .querySelectorAll<HTMLElement>(".activity-bar-slot")
      .forEach((slot, index) => {
        slot.getBoundingClientRect = () => box(index * 50, index * 50 + 50);
      });
    const tasksButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="views.tasks"]',
    )!;
    act(() => pointer(tasksButton, "pointerdown", 25));
    act(() => pointer(document, "pointermove", 290));
    act(() => pointer(document, "pointerup", 290));
    act(() => tasksButton.click());

    expect(labels()).toEqual([
      "Kanban",
      "views.automations",
      "views.design",
      "sidebar.notes",
      "views.tasks",
    ]);
    expect(localStorage.getItem("soreno:activity-tab-order")).toBe(
      "kanban,automations,design,notes,tasks",
    );
    expect(state.selectView).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("respects a persisted hidden Git panel", async () => {
  localStorage.setItem("soreno:git-panel-open", "false");
  state.activeView = "agents";
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    expect(
      container
        .querySelector("[data-right-panel-visible]")
        ?.getAttribute("data-right-panel-visible"),
    ).toBe("false");
    expect(
      container.querySelector<HTMLElement>("[data-agent-git-panel]")?.hidden,
    ).toBe(true);
    expect(localStorage.getItem("soreno:git-panel-open")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

it("lazy mounts agents once and preserves their workspace across view and vault changes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    expect(state.mountAgents).not.toHaveBeenCalled();
    state.activeView = "agents";
    await act(async () => root.render(createElement(App)));
    const workspace = container.querySelector<HTMLElement>(
      "[data-agent-workspace]",
    );
    const gitPanel = container.querySelector<HTMLElement>(
      "[data-agent-git-panel]",
    );
    expect(workspace).not.toBeNull();
    expect(workspace?.hidden).toBe(false);
    expect(
      container
        .querySelector("[data-right-panel-expanded]")
        ?.getAttribute("data-right-panel-expanded"),
    ).toBe("false");
    expect(gitPanel?.hidden).toBe(false);
    await act(async () =>
      workspace!
        .querySelector<HTMLButtonElement>('[aria-label="Expand changes"]')!
        .click(),
    );
    expect(
      container
        .querySelector("[data-right-panel-expanded]")
        ?.getAttribute("data-right-panel-expanded"),
    ).toBe("true");
    await act(async () =>
      workspace!
        .querySelector<HTMLButtonElement>('[aria-label="Write agent draft"]')!
        .click(),
    );
    expect(workspace!.querySelector("[data-agent-draft]")?.textContent).toBe(
      "Draft preserved",
    );
    await act(async () =>
      workspace!
        .querySelector<HTMLButtonElement>(
          '[aria-controls="workspace-agent-git"]',
        )!
        .click(),
    );
    expect(
      container
        .querySelector("[data-right-panel-visible]")
        ?.getAttribute("data-right-panel-visible"),
    ).toBe("false");
    expect(gitPanel?.hidden).toBe(true);
    state.activeView = "all";
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector("[data-agent-workspace]")).toBe(workspace);
    expect(container.querySelector("[data-agent-git-panel]")).toBe(gitPanel);
    expect(workspace?.hidden).toBe(true);
    state.activeView = "agents";
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector("[data-agent-git-panel]")).toBe(gitPanel);
    expect(gitPanel?.hidden).toBe(true);
    expect(
      container
        .querySelector("[data-right-panel-expanded]")
        ?.getAttribute("data-right-panel-expanded"),
    ).toBe("true");
    expect(workspace!.querySelector("[data-agent-draft]")?.textContent).toBe(
      "Draft preserved",
    );
    await act(async () => {
      await state.selectVault("other");
    });
    expect(state.prepareAgents).not.toHaveBeenCalled();
    expect(state.cancelAgents).not.toHaveBeenCalled();
    state.flushPendingTasks.mockRejectedValue(new Error("disk full"));
    await act(async () => {
      await state.selectVault("other");
    });
    expect(state.cancelAgents).not.toHaveBeenCalled();
    expect(state.mountAgents).toHaveBeenCalledOnce();
    expect(state.unmountAgents).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["task error", "agent error"])(
  "cancels agent preparation and allows retry after %s",
  async (failure) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    state.activeView = "agents";
    if (failure === "task error")
      state.flushPendingTasks.mockRejectedValue(new Error("disk full"));
    if (failure === "agent error")
      state.prepareAgents.mockRejectedValue(new Error("agent failed"));
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => {
        expect(await state.close.beforeClose()).toBe(false);
      });
      expect(state.cancelAgents).toHaveBeenCalledOnce();
      expect(
        container
          .querySelector("[data-agent-workspace]")
          ?.getAttribute("data-closing"),
      ).toBe("false");
      expect(
        container.querySelector(".workspace-stage")?.hasAttribute("inert"),
      ).toBe(false);
      state.prepareAgents.mockResolvedValue(true);
      state.flushPendingTasks.mockResolvedValue(undefined);
      await act(async () => {
        expect(await state.close.beforeClose()).toBe(true);
      });
      expect(state.prepareAgents).toHaveBeenCalledTimes(2);
      expect(state.cancelAgents).toHaveBeenCalledOnce();
      expect(
        container
          .querySelector("[data-agent-workspace]")
          ?.getAttribute("data-closing"),
      ).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("keeps agents locked after successful preparation until native close is cancelled", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  state.activeView = "agents";
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      expect(await state.close.beforeClose()).toBe(true);
    });
    expect(state.cancelAgents).not.toHaveBeenCalled();
    expect(
      container
        .querySelector("[data-agent-workspace]")
        ?.getAttribute("data-closing"),
    ).toBe("true");
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(true);
    act(() => state.close.onCloseCancelled?.());
    expect(state.cancelAgents).toHaveBeenCalledOnce();
    expect(
      container
        .querySelector("[data-agent-workspace]")
        ?.getAttribute("data-closing"),
    ).toBe("false");
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["favorites", "favorites"],
  ["type:removed", "all"],
])(
  "switches the single sidebar from %s to Agents and restores %s without unmounting",
  async (initialView, restoredView) => {
    state.activeView = initialView;
    const container = document.createElement("div");
    const root = createRoot(container);
    async function switchSpace(id: string) {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)!
          .click(),
      );
      await act(async () => root.render(createElement(App)));
    }
    try {
      await act(async () => root.render(createElement(App)));
      const notesNavigation = container.querySelector(
        "[data-notes-navigation]",
      );
      const notesPanel = container.querySelector<HTMLElement>(
        "#workspace-notes-navigation",
      )!;
      const agentsPanel = container.querySelector<HTMLElement>(
        "#workspace-agents-navigation",
      )!;
      expect(notesPanel.hidden).toBe(false);
      expect(agentsPanel.hidden).toBe(true);
      expect(state.mountAgents).not.toHaveBeenCalled();

      await switchSpace("workspace-agents-navigation");
      expect(state.selectView).toHaveBeenLastCalledWith("agents");
      expect(notesPanel.hidden).toBe(true);
      expect(agentsPanel.hidden).toBe(false);
      const agentsNavigation = agentsPanel.querySelector(
        "[data-agent-navigation]",
      );
      const workspace = container.querySelector("[data-agent-workspace]");
      expect(agentsNavigation).not.toBeNull();
      expect(container.querySelectorAll(".workspace-navigation")).toHaveLength(
        1,
      );

      await switchSpace("workspace-notes-navigation");
      expect(state.selectView).toHaveBeenLastCalledWith(restoredView);
      expect(notesPanel.hidden).toBe(false);
      expect(agentsPanel.hidden).toBe(true);
      expect(container.querySelector("[data-notes-navigation]")).toBe(
        notesNavigation,
      );
      expect(container.querySelector("[data-agent-workspace]")).toBe(workspace);
      expect(agentsPanel.querySelector("[data-agent-navigation]")).toBe(
        agentsNavigation,
      );
      await switchSpace("workspace-agents-navigation");
      expect(state.mountAgents).toHaveBeenCalledOnce();
      expect(state.unmountAgents).not.toHaveBeenCalled();
      expect(state.prepareAgents).not.toHaveBeenCalled();
      expect(state.cancelAgents).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("opens Kanban without the project sidebar and returns to Projects from the activity bar", async () => {
  state.activeView = "all";
  const container = document.createElement("div");
  const root = createRoot(container);
  const item = (label: string) =>
    container.querySelector<HTMLButtonElement>(
      `.activity-bar [aria-label="${label}"]`,
    )!;
  async function select(label: string) {
    await act(async () => item(label).click());
    await act(async () => root.render(createElement(App)));
  }
  try {
    await act(async () => root.render(createElement(App)));
    const agentsPanel = container.querySelector<HTMLElement>(
      "#workspace-agents-navigation",
    )!;
    const workspace = container.querySelector("[data-sidebar-visible]")!;
    const rightPanelVisible = () =>
      workspace.getAttribute("data-right-panel-visible");

    await select("Kanban");
    expect(state.selectView).toHaveBeenLastCalledWith("agents");
    expect(item("Kanban").getAttribute("aria-current")).toBe("page");
    expect(item("views.agents").hasAttribute("aria-current")).toBe(false);
    expect(agentsPanel.hidden).toBe(true);
    expect(workspace.getAttribute("data-sidebar-visible")).toBe("false");
    // The Git panel stays out of the board; an opened issue takes the right panel.
    expect(rightPanelVisible()).toBe("false");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open board issue"]')!
        .click(),
    );
    expect(rightPanelVisible()).toBe("true");
    // The panel shortcut hides and shows the issue, leaving the Git panel's setting alone.
    const togglePanel = () =>
      act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            ctrlKey: true,
            altKey: true,
            bubbles: true,
          }),
        );
      });
    await togglePanel();
    expect(rightPanelVisible()).toBe("false");
    await togglePanel();
    expect(rightPanelVisible()).toBe("true");
    await togglePanel();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "M",
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(workspace.getAttribute("data-right-panel-expanded")).toBe("true");

    // Leaving the board collapses the panel so the requested session shows.
    await select("views.agents");
    expect(item("views.agents").getAttribute("aria-current")).toBe("page");
    expect(agentsPanel.hidden).toBe(false);
    expect(workspace.getAttribute("data-sidebar-visible")).toBe("true");
    expect(rightPanelVisible()).toBe("true");
    expect(workspace.getAttribute("data-right-panel-expanded")).toBe("false");

    await select("sidebar.notes");
    expect(state.selectView).toHaveBeenLastCalledWith("all");
    expect(item("sidebar.notes").getAttribute("aria-current")).toBe("page");
    expect(agentsPanel.hidden).toBe(true);

    expect(container.querySelector("[data-settings-modal]")).toBeNull();
    await act(async () => item("sidebar.settings").click());
    expect(container.querySelector("[data-settings-modal]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("toggles the sidebar with Ctrl+B unless a focused editor handled the key", async () => {
  state.activeView = "all";
  const container = document.createElement("div");
  let root = createRoot(container);
  const visible = () =>
    container
      .querySelector("[data-sidebar-visible]")!
      .getAttribute("data-sidebar-visible");
  const press = (init: KeyboardEventInit, handled = false) =>
    act(async () => {
      const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
      if (handled) event.preventDefault();
      document.dispatchEvent(event);
    });
  document.body.append(container);
  try {
    await act(async () => root.render(createElement(App)));
    await press({ key: "b", ctrlKey: true }, true);
    await press({ key: "b", metaKey: true });
    expect(visible()).toBe("true");

    const sidebarButton = document.createElement("button");
    container
      .querySelector("#workspace-notes-navigation")!
      .append(sidebarButton);
    sidebarButton.focus();
    await press({ key: "b", ctrlKey: true });
    expect(visible()).toBe("false");
    expect(document.activeElement).toBe(
      container.querySelector('.activity-bar [aria-label="sidebar.notes"]'),
    );
    sidebarButton.remove();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(App)));
    expect(visible()).toBe("false");

    const click = async (label: string) => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            `.activity-bar [aria-label="${label}"]`,
          )!
          .click(),
      );
      await act(async () => root.render(createElement(App)));
    };
    await click("views.agents");
    await click("sidebar.notes");
    expect(visible()).toBe("false");
    await click("sidebar.notes");
    expect(visible()).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("toggles and expands the Git panel with Ctrl+Alt+B and Ctrl+Shift+M even from a terminal that consumes keys", async () => {
  state.activeView = "agents";
  const container = document.createElement("div");
  const root = createRoot(container);
  const visible = () =>
    container
      .querySelector("[data-right-panel-visible]")!
      .getAttribute("data-right-panel-visible");
  const terminal = document.createElement("textarea");
  terminal.addEventListener("keydown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  const press = (init: KeyboardEventInit) =>
    act(async () => {
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", {
          ...init,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  document.body.append(container, terminal);
  try {
    await act(async () => root.render(createElement(App)));
    expect(visible()).toBe("true");
    await press({ key: "{", code: "KeyB", ctrlKey: true, altKey: true });
    expect(visible()).toBe("true");
    await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(visible()).toBe("false");
    await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(visible()).toBe("true");

    const expanded = () =>
      container
        .querySelector("[data-right-panel-expanded]")!
        .getAttribute("data-right-panel-expanded");
    await press({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(expanded()).toBe("true");
    await press({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(expanded()).toBe("false");
    expect(visible()).toBe("true");
    // From a closed panel, the chord opens it expanded.
    await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    await press({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(visible()).toBe("true");
    expect(expanded()).toBe("true");
    // Non-Latin layout: the physical key, not Ctrl+M (Enter) to the terminal.
    await press({ key: "Ь", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(expanded()).toBe("false");
    // The logical letter wins over its physical position (AZERTY).
    await press({ key: "M", code: "Semicolon", ctrlKey: true, shiftKey: true });
    expect(expanded()).toBe("true");
    await press({ key: "?", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(expanded()).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    terminal.remove();
  }
});

it("allows the agent close confirmation to veto closing before locking the workspace", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  state.activeView = "agents";
  state.prepareAgents.mockResolvedValue(false);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      expect(await state.close.beforeClose()).toBe(false);
    });
    expect(state.prepareAgents).toHaveBeenCalledOnce();
    expect(state.cancelAgents).toHaveBeenCalledOnce();
    expect(state.flushPendingTasks).not.toHaveBeenCalled();
    expect(
      container.querySelector(".workspace-stage")?.hasAttribute("inert"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
