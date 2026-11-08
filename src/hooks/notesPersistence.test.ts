// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAutosave } from "./useAutosave";
import { useNotesController } from "./useNotesController";
import type { LibraryView } from "../domain/library";
import type { Note } from "../domain/notes";
import {
  createNoteKey,
  decryptImage,
  decryptNoteContent,
  encryptNoteContent,
  unlockNoteKey,
} from "../domain/noteEncryption";
import { clearNotifications, getNotifications } from "../notifications";
import { deferred } from "../testing/deferred";

const errorNotifications = () =>
  getNotifications()
    .filter((notification) => notification.tone === "error")
    .map((notification) => notification.message);

const desktop = vi.hoisted(() => ({
  close: null as
    null | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (callback: typeof desktop.close) => {
      desktop.close = callback;
      return () => {};
    },
    destroy: desktop.destroy,
  }),
}));
vi.mock("../i18n", () => {
  const value = { locale: "fr-FR", t: (key: string) => key };
  return { useI18n: () => value };
});

const date = "2025-01-01T00:00:00.000Z";
const note = (id: string, content = id): Note => ({
  id,
  content,
  title: content,
  kind: "notes",
  archived: false,
  favorite: false,
  pinned: false,
  createdAt: date,
  updatedAt: date,
});
const type = (id: string, sortOrder = 0) => ({
  id,
  name: id,
  icon: "File",
  color: "blue",
  sortOrder,
  createdAt: date,
  updatedAt: date,
});
const vault = (id: string) => ({
  id,
  name: id,
  createdAt: date,
  updatedAt: date,
});
let root: Root;
let container: HTMLDivElement;
const commands = new Map<string, (args: Record<string, unknown>) => unknown>();
async function mount<T>(hook: () => T) {
  let current!: T;
  function Harness() {
    current = hook();
    return null;
  }
  await act(async () => {
    root.render(createElement(Harness));
  });
  return () => current;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  // These tests exercise Notes; a first launch would open Agents.
  localStorage.setItem("soreno.workspace.v1", "notes");
  vi.useFakeTimers();
  desktop.destroy.mockReset();
  commands.clear();
  commands.set("list_vaults", () => [vault("old"), vault("new")]);
  commands.set("get_active_vault", () => vault("old"));
  commands.set("list_notes", () => [note("A"), note("B")]);
  commands.set("list_note_types", () => [type("notes"), type("tasks", 1)]);
  commands.set("select_vault", () => ({
    activeVaultId: "new",
    vaults: [vault("old"), vault("new")],
  }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Unexpected command ${command}`);
    return handler(args as Record<string, unknown>) as never;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  clearNotifications();
});

async function mountAutosave() {
  return mount(() => {
    const [notes, setNotes] = useState([note("A"), note("B")]);
    const [selectedId, select] = useState("A");
    const autosave = useAutosave({
      notes,
      setNotes,
      selectedId,
      locale: "fr-FR",
      noteFallbackTitle: "Empty",
      saveNoteErrorMessage: "Save failed",
      closeGuardErrorMessage: "Close guard unavailable",
    });
    return { ...autosave, select };
  });
}

describe("workspace persistence", () => {
  it("opens Agents on first launch, then restores the saved workspace", async () => {
    localStorage.removeItem("soreno.workspace.v1");
    const fresh = await mount(useNotesController);
    expect(fresh().activeView).toBe("agents");

    await act(async () => fresh().handleSelectView("all"));
    expect(localStorage.getItem("soreno.workspace.v1")).toBe("notes");
    await act(async () => root.unmount());
    root = createRoot(container);
    const restored = await mount(useNotesController);
    expect(restored().activeView).toBe("all");

    await act(async () => restored().handleSelectView("agents"));
    expect(localStorage.getItem("soreno.workspace.v1")).toBe("agents");
  });
});

describe("revision-aware persistence", () => {
  it("flushes v2 entered during v1 and shares the timer/explicit save", async () => {
    const first = deferred<Note>();
    const second = deferred<Note>();
    const save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    commands.set("update_note", save);
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("v1"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    let flushed!: Promise<Note | null>;
    await act(async () => {
      flushed = current().flushPendingNote("A");
      current().handleContentChange("v2");
    });
    await act(async () => first.resolve(note("A", "v1")));
    expect(current().getCurrentNotes()[0].content).toBe("v2");
    expect(current().hasPendingSave("A")).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].content).toBe("v2");
    await act(async () => {
      second.resolve(note("A", "v2"));
      await flushed;
    });
    expect(current().content).toBe("v2");
    expect(current().hasPendingSaves()).toBe(false);
  });

  it("ignores an old save response after the notes are reset", async () => {
    const response = deferred<Note>();
    commands.set("update_note", () => response.promise);
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("old draft"));
    let saving!: Promise<Note | null>;
    await act(async () => {
      saving = current().flushPendingNote("A");
    });
    await act(async () => {
      current().clearPendingSaves();
      current().replaceNotes([note("A", "new vault")]);
      current().setCurrentContent("new vault");
    });
    await act(async () => {
      response.resolve(note("A", "old draft"));
      await saving;
    });
    expect(current().getCurrentNotes()[0].content).toBe("new vault");
    expect(current().content).toBe("new vault");
  });

  it("keeps pending content after failure and permits a retry", async () => {
    commands.set("update_note", () => Promise.reject(new Error("offline")));
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("draft"));
    await act(async () => {
      await expect(current().flushPendingNote("A")).rejects.toThrow("offline");
    });
    expect(current().hasPendingSave("A")).toBe(true);
    commands.set("update_note", () => note("A", "draft"));
    await act(async () => {
      await current().flushPendingNote("A");
    });
    expect(current().hasPendingSaves()).toBe(false);
  });

  it("debounces and autosaves every pending note without a close flush", async () => {
    const save = vi.fn(({ id, content }) => note(String(id), String(content)));
    commands.set("update_note", save);
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("draft A"));
    await act(async () => current().select("B"));
    await act(async () => current().handleContentChange("draft B"));
    await act(async () => {
      vi.advanceTimersByTime(699);
    });
    expect(save).not.toHaveBeenCalled();
    expect(current().saveState).toBe("saving");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(save.mock.calls.map(([args]) => args.id).sort()).toEqual(["A", "B"]);
    expect(current().hasPendingSaves()).toBe(false);
    expect(current().saveState).toBe("saved");
  });

  it("reports repeated autosave failures once and withdraws them after a successful save", async () => {
    let isOffline = true;
    commands.set("update_note", (args) =>
      isOffline
        ? Promise.reject(new Error("offline"))
        : { ...note(String(args.id), String(args.content)), updatedAt: date },
    );
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("draft A"));
    await act(async () => current().select("B"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => current().handleContentChange("draft B"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(current().hasPendingSave("A")).toBe(true);
    expect(current().saveState).toBe("error");
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        key: "note-save",
        message: "Save failed",
        tone: "error",
      }),
    ]);

    isOffline = false;
    await act(async () => current().select("A"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(current().saveState).toBe("saved");
    expect(getNotifications()).toEqual([]);
  });

  it("closes only after every pending note, including the non-selected one", async () => {
    const first = deferred<Note>();
    const second = deferred<Note>();
    commands.set("update_note", (args) =>
      args.id === "A" ? first.promise : second.promise,
    );
    const current = await mountAutosave();
    await act(async () => current().handleContentChange("draft A"));
    await act(async () => current().select("B"));
    await act(async () => current().handleContentChange("draft B"));
    let closing!: Promise<void>;
    const preventDefault = vi.fn();
    await act(async () => {
      closing = desktop.close!({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    await act(async () => second.resolve(note("B", "draft B")));
    expect(desktop.destroy).not.toHaveBeenCalled();
    await act(async () => {
      first.resolve(note("A", "draft A"));
      await closing;
    });
    expect(desktop.destroy).toHaveBeenCalledOnce();
    expect(current().hasPendingSaves()).toBe(false);
  });
});

describe("coordinated window close", () => {
  it("prepares an updater close once, lets native close continue, and supports cancellation", async () => {
    const preparation = deferred<boolean>();
    const savedNote = deferred<Note>();
    const beforeClose = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(preparation.promise)
      .mockResolvedValue(true);
    const onCloseCancelled = vi.fn();
    const save = vi.fn(() => savedNote.promise);
    commands.set("update_note", save);
    const current = await mount(() =>
      useNotesController({ beforeClose, onCloseCancelled }),
    );
    await act(async () => current().handleContentChange("draft for update"));

    let preparing!: Promise<boolean>;
    act(() => {
      preparing = current().prepareToClose();
    });
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();

    await act(async () => preparation.resolve(true));
    expect(save).toHaveBeenCalledOnce();
    await act(async () => savedNote.resolve(note("A", "draft for update")));
    expect(await preparing).toBe(true);

    const preventDefault = vi.fn();
    await act(async () => desktop.close!({ preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(beforeClose).toHaveBeenCalledOnce();

    act(() => current().cancelPreparedClose());
    expect(onCloseCancelled).toHaveBeenCalledOnce();
    await act(async () => {
      expect(await current().prepareToClose()).toBe(true);
    });
    expect(beforeClose).toHaveBeenCalledTimes(2);
  });

  it("waits for the current close preparation even when notes are clean", async () => {
    const response = deferred<boolean>();
    const oldCallback = vi.fn(async () => true);
    const newCallback = vi.fn(() => response.promise);
    let beforeClose = oldCallback;
    const current = await mount(() => useNotesController({ beforeClose }));
    beforeClose = newCallback;
    await act(async () => current().setSearchQuery("rerender"));
    let closing!: Promise<void>;
    const preventDefault = vi.fn();
    await act(async () => {
      closing = desktop.close!({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).toHaveBeenCalledOnce();
    expect(desktop.destroy).not.toHaveBeenCalled();
    await act(async () => {
      response.resolve(true);
      await closing;
    });
    expect(desktop.destroy).toHaveBeenCalledOnce();
  });

  it.each(["false", "throw"])(
    "does not destroy when close preparation returns %s, and allows retry",
    async (failure) => {
      const beforeClose = vi.fn(async () => {
        if (failure === "throw") throw new Error("preparation failed");
        return false;
      });
      const onCloseCancelled = vi.fn();
      await mount(() => useNotesController({ beforeClose, onCloseCancelled }));
      await act(async () => {
        await desktop.close!({ preventDefault: vi.fn() });
      });
      expect(desktop.destroy).not.toHaveBeenCalled();
      expect(onCloseCancelled).toHaveBeenCalledOnce();
      if (failure === "throw")
        expect(errorNotifications()).toEqual(["errors.saveNote"]);
      beforeClose.mockResolvedValue(true);
      await act(async () => {
        await desktop.close!({ preventDefault: vi.fn() });
      });
      expect(desktop.destroy).toHaveBeenCalledOnce();
      expect(onCloseCancelled).toHaveBeenCalledOnce();
    },
  );

  it.each(["flush", "destroy"])(
    "releases the close lock after %s fails and permits retry",
    async (failure) => {
      const onCloseCancelled = vi.fn();
      const beforeClose = vi.fn(async () => true);
      const save = vi.fn(async () => note("A", "draft"));
      commands.set("update_note", save);
      if (failure === "flush")
        save.mockRejectedValueOnce(new Error("flush failed"));
      else desktop.destroy.mockRejectedValueOnce(new Error("destroy failed"));
      const current = await mount(() =>
        useNotesController({ beforeClose, onCloseCancelled }),
      );
      await act(async () => current().handleContentChange("draft"));
      await act(async () => {
        await desktop.close!({ preventDefault: vi.fn() });
      });
      expect(onCloseCancelled).toHaveBeenCalledOnce();
      expect(errorNotifications()).toEqual(["errors.saveNote"]);
      expect(desktop.destroy).toHaveBeenCalledTimes(
        failure === "flush" ? 0 : 1,
      );
      await act(async () => {
        await desktop.close!({ preventDefault: vi.fn() });
      });
      expect(beforeClose).toHaveBeenCalledTimes(2);
      expect(desktop.destroy).toHaveBeenCalledTimes(
        failure === "flush" ? 1 : 2,
      );
      expect(onCloseCancelled).toHaveBeenCalledOnce();
    },
  );

  it("notifies only the current cancellation callback once for simultaneous close requests", async () => {
    const response = deferred<boolean>();
    const beforeClose = vi.fn(() => response.promise);
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    let onCloseCancelled = oldCallback;
    const current = await mount(() =>
      useNotesController({ beforeClose, onCloseCancelled }),
    );
    let closing!: Promise<void>;
    await act(async () => {
      closing = desktop.close!({ preventDefault: vi.fn() });
    });
    await act(async () => {
      await desktop.close!({ preventDefault: vi.fn() });
    });
    expect(oldCallback).not.toHaveBeenCalled();
    onCloseCancelled = newCallback;
    await act(async () => current().setSearchQuery("rerender"));
    await act(async () => {
      response.resolve(false);
      await closing;
    });
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).toHaveBeenCalledOnce();
    expect(desktop.destroy).not.toHaveBeenCalled();
  });

  it("runs one close operation, waiting for preparation then the latest note content", async () => {
    const preparation = deferred<boolean>();
    const savedNote = deferred<Note>();
    const beforeClose = vi.fn(() => preparation.promise);
    const save = vi.fn(() => savedNote.promise);
    commands.set("update_note", save);
    const current = await mount(() => useNotesController({ beforeClose }));
    await act(async () => current().handleContentChange("draft before close"));
    let closing!: Promise<void>;
    const preventDefault = vi.fn();
    await act(async () => {
      closing = desktop.close!({ preventDefault });
    });
    await act(async () => {
      await desktop.close!({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(desktop.destroy).not.toHaveBeenCalled();
    await act(async () =>
      current().handleContentChange("draft during close preparation"),
    );
    await act(async () => preparation.resolve(true));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]).toEqual([
      {
        id: "A",
        title: "draft during close preparation",
        content: "draft during close preparation",
      },
    ]);
    expect(desktop.destroy).not.toHaveBeenCalled();
    await act(async () => {
      savedNote.resolve(note("A", "draft during close preparation"));
      await closing;
    });
    expect(desktop.destroy).toHaveBeenCalledOnce();
  });
});

describe("metadata and vault generations", () => {
  it.each(["list_note_types", "list_notes"])(
    "keeps the old workspace until both lists load, with %s arriving first",
    async (first) => {
      const renders: ReturnType<typeof useNotesController>[] = [];
      const current = await mount(() => {
        const controller = useNotesController();
        renders.push(controller);
        return controller;
      });
      await act(async () => {
        await current().handleSelectNote(note("B"));
        current().handleSelectView("type:notes");
        current().setSearchQuery("B");
      });
      const previous = {
        notes: current().notes,
        noteTypes: current().noteTypes,
        selectedNote: note("B"),
        content: "B",
        activeView: "type:notes",
        searchQuery: "B",
      };
      const loadedNotes = [
        { ...note("fresh", "new vault content"), kind: "fresh-type" },
      ];
      const loadedTypes = [type("fresh-type")];
      const notes = deferred<Note[]>();
      const types = deferred<ReturnType<typeof type>[]>();
      const listNotes = vi.fn(() => notes.promise);
      const listTypes = vi.fn(() => types.promise);
      commands.set("list_notes", listNotes);
      commands.set("list_note_types", listTypes);
      renders.length = 0;
      let switching!: Promise<void>;
      await act(async () => {
        switching = current().handleSelectVault("new");
      });
      expect(listNotes).toHaveBeenCalledOnce();
      expect(listTypes).toHaveBeenCalledOnce();
      expect(current()).toMatchObject({
        ...previous,
        isLoading: true,
        isChangingVault: true,
      });
      await act(async () => {
        if (first === "list_note_types") types.resolve(loadedTypes);
        else notes.resolve(loadedNotes);
      });
      expect(current()).toMatchObject({
        ...previous,
        isLoading: true,
        isChangingVault: true,
      });
      for (const render of renders) expect(render).toMatchObject(previous);
      renders.length = 0;
      await act(async () => {
        if (first === "list_note_types") notes.resolve(loadedNotes);
        else types.resolve(loadedTypes);
        await switching;
      });
      const replacement = {
        notes: loadedNotes,
        noteTypes: loadedTypes,
        selectedNote: loadedNotes[0],
        content: "new vault content",
        activeView: "all",
        searchQuery: "",
      };
      expect(current()).toMatchObject({
        ...replacement,
        isLoading: false,
        isChangingVault: false,
      });
      for (const render of renders) expect(render).toMatchObject(replacement);
    },
  );

  it.each([
    ["tasks", "tasks"],
    ["favorites", "all"],
  ])("switches vault from %s to %s", async (view, expected) => {
    const current = await mount(useNotesController);
    await act(async () => current().handleSelectView(view as LibraryView));
    commands.set("list_note_types", () => [type("fresh")]);
    commands.set("list_notes", () => [note("fresh")]);
    await act(async () => current().handleSelectVault("new"));
    expect(current().activeView).toBe(expected);
  });

  it.each(["list_note_types", "list_notes", "create_note"])(
    "clears the old workspace before unlocking when %s rejects",
    async (command) => {
      const renders: ReturnType<typeof useNotesController>[] = [];
      const current = await mount(() => {
        const controller = useNotesController();
        renders.push(controller);
        return controller;
      });
      await act(async () => {
        await current().handleSelectNote(note("B"));
        current().handleSelectView("type:notes");
        current().setSearchQuery("B");
      });
      const previous = {
        notes: current().notes,
        noteTypes: current().noteTypes,
        selectedNote: note("B"),
        content: "B",
        activeView: "type:notes",
        searchQuery: "B",
      };
      const failure = deferred<never>();
      const lateNotes = deferred<Note[]>();
      const lateTypes = deferred<ReturnType<typeof type>[]>();
      commands.set("list_notes", () =>
        command === "create_note" ? [] : lateNotes.promise,
      );
      commands.set("list_note_types", () =>
        command === "create_note" ? [type("fresh")] : lateTypes.promise,
      );
      const failingCommand = vi.fn(() => failure.promise);
      commands.set(command, failingCommand);
      renders.length = 0;
      let rejected!: Promise<unknown>;
      await act(async () => {
        rejected = expect(current().handleSelectVault("new")).rejects.toThrow(
          `${command} failed`,
        );
      });
      expect(failingCommand).toHaveBeenCalledOnce();
      expect(current()).toMatchObject({
        ...previous,
        isLoading: true,
        isChangingVault: true,
      });
      await act(async () => {
        failure.reject(new Error(`${command} failed`));
        await rejected;
      });
      const cleared = {
        notes: [],
        noteTypes: [],
        selectedNote: null,
        content: "",
        activeView: "all",
        searchQuery: "",
      };
      expect(current()).toMatchObject({
        ...cleared,
        isLoading: false,
        isChangingVault: false,
      });
      expect(errorNotifications()).toEqual(["errors.selectVault"]);
      const unlocked = renders.filter((render) => !render.isChangingVault);
      expect(unlocked.length).toBeGreaterThan(0);
      for (const render of unlocked) expect(render).toMatchObject(cleared);
      await act(async () => {
        lateNotes.resolve([note("late")]);
        lateTypes.resolve([type("late")]);
      });
      expect(current()).toMatchObject(cleared);
    },
  );

  it("does not reselect A or overwrite the edited B after pinning A", async () => {
    const response = deferred<Note>();
    commands.set("update_note_pinned", () => response.promise);
    const current = await mount(useNotesController);
    let pin!: Promise<void>;
    await act(async () => {
      pin = current().handleToggleNotePinned("A", true);
    });
    await act(async () => {
      await current().handleSelectNote(note("B"));
    });
    await act(async () => current().handleContentChange("B new"));
    await act(async () => {
      response.resolve({ ...note("A"), pinned: true });
      await pin;
    });
    expect(current().selectedNote?.id).toBe("B");
    expect(current().content).toBe("B new");
    expect(current().notes.find((item) => item.id === "A")?.pinned).toBe(true);
    expect(current().saveState).toBe("saving");
  });

  it.each(["pinned", "kind", "archived", "favorite"] as const)(
    "merges only %s while preserving new content",
    async (field) => {
      const response = deferred<Note>();
      commands.set(`update_note_${field}`, () => response.promise);
      const current = await mount(useNotesController);
      let mutation!: Promise<void>;
      await act(async () => {
        mutation =
          field === "kind"
            ? current().handleChangeNoteType("tasks")
            : field === "archived"
              ? current().handleToggleNoteArchived("A", true)
              : field === "favorite"
                ? current().handleToggleNoteFavorite("A", true)
                : current().handleToggleNotePinned("A", true);
      });
      await act(async () => current().handleContentChange("new content"));
      const editedAt = current().notes.find(
        (item) => item.id === "A",
      )!.updatedAt;
      await act(async () => {
        response.resolve({
          ...note("A"),
          [field]: field === "kind" ? "tasks" : true,
        });
        await mutation;
      });
      expect(current().notes.find((item) => item.id === "A")).toMatchObject({
        content: "new content",
        title: "new content",
        updatedAt: editedAt,
      });
      expect(current().saveState).toBe("saving");
    },
  );

  it.each(["A", "B"])(
    "changes the dropped note %s without changing another note's selection or content",
    async (id) => {
      const changeKind = vi.fn(({ id, kind }) => ({ ...note(id), kind }));
      commands.set("update_note_kind", changeKind);
      commands.set("update_note", ({ id, content }) =>
        note(String(id), String(content)),
      );
      const current = await mount(useNotesController);
      await act(async () => {
        current().handleSelectView("type:notes");
        current().handleContentChange("unsaved A");
      });
      await act(async () => {
        await current().handleChangeNoteType("tasks", id);
      });
      expect(changeKind).toHaveBeenCalledExactlyOnceWith({ id, kind: "tasks" });
      expect(current().selectedNote?.id).toBe("A");
      expect(current().content).toBe("unsaved A");
      expect(current().notes.find((item) => item.id === id)?.kind).toBe(
        "tasks",
      );
      expect(current().notes.find((item) => item.id !== id)?.kind).toBe(
        "notes",
      );
      expect(current().noteCounts.byType).toMatchObject({ notes: 1, tasks: 1 });
      expect(current().activeView).toBe(
        id === "A" ? "type:tasks" : "type:notes",
      );
      expect(current().visibleNotes.map((item) => item.id)).toEqual(["A"]);
    },
  );

  it("ignores unchanged, missing or invalid drop targets", async () => {
    const changeKind = vi.fn();
    commands.set("update_note_kind", changeKind);
    const current = await mount(useNotesController);
    await act(async () => {
      await current().handleChangeNoteType("notes", "A");
      await current().handleChangeNoteType("missing-type", "A");
      await current().handleChangeNoteType("tasks", "missing-note");
      await current().handleChangeNoteType("tasks", "");
    });
    expect(changeKind).not.toHaveBeenCalled();
    expect(current().notes.map((item) => item.kind)).toEqual([
      "notes",
      "notes",
    ]);
  });

  it("ignores drops while the vault changes or its notes are loading", async () => {
    const transition = deferred<unknown>();
    const loadedNotes = deferred<Note[]>();
    const changeKind = vi.fn();
    commands.set("select_vault", () => transition.promise);
    commands.set("update_note_kind", changeKind);
    const current = await mount(useNotesController);
    commands.set("list_notes", () => loadedNotes.promise);
    let switching!: Promise<void>;
    await act(async () => {
      switching = current().handleSelectVault("new");
    });
    await act(async () => {
      await current().handleChangeNoteType("tasks", "A");
    });
    await act(async () =>
      transition.resolve({ activeVaultId: "new", vaults: [vault("new")] }),
    );
    expect(current().isLoading).toBe(true);
    await act(async () => {
      await current().handleChangeNoteType("tasks", "A");
    });
    expect(changeKind).not.toHaveBeenCalled();
    await act(async () => {
      loadedNotes.resolve([note("A", "fresh vault")]);
      await switching;
    });
    expect(current().selectedNote).toMatchObject({
      kind: "notes",
      content: "fresh vault",
    });
  });

  it.each(["save", "kind"])(
    "keeps the draft and original type when drop persistence fails at %s",
    async (failure) => {
      const changeKind = vi.fn(() => {
        throw new Error("kind failed");
      });
      commands.set("update_note_kind", changeKind);
      commands.set("update_note", () => {
        if (failure === "save") throw new Error("save failed");
        return note("A", "unsaved A");
      });
      const current = await mount(useNotesController);
      await act(async () => current().handleContentChange("unsaved A"));
      await act(async () => {
        await current().handleChangeNoteType("tasks", "A");
      });
      expect(current().selectedNote).toMatchObject({
        id: "A",
        kind: "notes",
        content: "unsaved A",
      });
      expect(current().content).toBe("unsaved A");
      expect(errorNotifications()).toEqual(["errors.changeKind"]);
      expect(changeKind).toHaveBeenCalledTimes(failure === "save" ? 0 : 1);
    },
  );

  it("persists favorites, keeps their order, and removes unfavorited or archived notes from the view", async () => {
    commands.set("update_note_favorite", ({ id, favorite }) => ({
      ...note(String(id)),
      favorite,
    }));
    const current = await mount(useNotesController);
    await act(async () => {
      await current().handleToggleNoteFavorite("A", true);
    });
    expect(invoke).toHaveBeenCalledWith("update_note_favorite", {
      id: "A",
      favorite: true,
    });
    expect(current().notes.find((item) => item.id === "A")).toMatchObject({
      favorite: true,
      updatedAt: date,
    });
    expect(current().noteCounts.favorites).toBe(1);
    await act(async () => current().handleSelectView("favorites"));
    expect(current().visibleNotes.map((item) => item.id)).toEqual(["A"]);
    commands.set("update_note_favorite", () => {
      throw new Error("offline");
    });
    await act(async () => {
      await current().handleToggleNoteFavorite("A", false);
    });
    expect(errorNotifications()).toEqual(["errors.favoriteNote"]);
    expect(current().noteCounts.favorites).toBe(1);
    commands.set("update_note_favorite", ({ id, favorite }) => ({
      ...note(String(id)),
      favorite,
    }));
    await act(async () => {
      await current().handleToggleNoteFavorite("A", false);
    });
    expect(current().visibleNotes).toEqual([]);
    expect(current().selectedNote).toBeNull();
    await act(async () => {
      await current().handleToggleNoteFavorite("A", true);
    });
    commands.set("update_note_archived", () => ({
      ...note("A"),
      favorite: true,
      archived: true,
    }));
    await act(async () => {
      await current().handleToggleNoteArchived("A", true);
    });
    expect(current().visibleNotes).toEqual([]);
    expect(current().noteCounts.favorites).toBe(0);
    expect(current().notes.find((item) => item.id === "A")?.favorite).toBe(
      true,
    );
  });

  it("selection waits for the latest draft", async () => {
    const first = deferred<Note>();
    const second = deferred<Note>();
    commands.set(
      "update_note",
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    );
    const current = await mount(useNotesController);
    await act(async () => current().handleContentChange("v1"));
    let selection!: Promise<boolean>;
    await act(async () => {
      selection = current().handleSelectNote(note("B"));
    });
    await act(async () => current().handleContentChange("v2"));
    await act(async () => first.resolve(note("A", "v1")));
    expect(current().selectedNote?.id).toBe("A");
    await act(async () => {
      second.resolve(note("A", "v2"));
      await selection;
    });
    expect(current().selectedNote?.id).toBe("B");
    expect(current().notes.find((item) => item.id === "A")?.content).toBe("v2");
  });

  it("autosaves an edited note after archiving it reselects another note", async () => {
    const archived = deferred<Note>();
    const save = vi.fn(({ id, content }) => note(String(id), String(content)));
    commands.set("update_note_archived", () => archived.promise);
    commands.set("update_note", save);
    const current = await mount(useNotesController);
    let archive!: Promise<void>;
    await act(async () => {
      archive = current().handleToggleNoteArchived("A", true);
    });
    await act(async () => current().handleContentChange("draft A"));
    await act(async () => {
      archived.resolve({ ...note("A"), archived: true });
      await archive;
    });
    expect(current().selectedNote?.id).toBe("B");
    expect(current().notes.find((item) => item.id === "A")?.content).toBe(
      "draft A",
    );
    await act(async () => {
      vi.advanceTimersByTime(699);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      id: "A",
      title: "draft A",
      content: "draft A",
    });
    expect(current().saveState).toBe("saved");
  });

  it("flushes a pending non-selected note before switching vaults", async () => {
    const archived = deferred<Note>();
    commands.set("update_note_archived", () => archived.promise);
    const current = await mount(useNotesController);
    let archive!: Promise<void>;
    await act(async () => {
      archive = current().handleToggleNoteArchived("A", true);
    });
    await act(async () => current().handleContentChange("draft A"));
    await act(async () => {
      archived.resolve({ ...note("A"), archived: true });
      await archive;
    });
    expect(current().selectedNote?.id).toBe("B");
    await act(async () => current().handleContentChange("draft B"));
    const first = deferred<Note>();
    const second = deferred<Note>();
    commands.set("update_note", (args) =>
      args.id === "A" ? first.promise : second.promise,
    );
    const selectVault = vi.fn(() => ({
      activeVaultId: "new",
      vaults: [vault("new")],
    }));
    commands.set("select_vault", selectVault);
    let switching!: Promise<void>;
    await act(async () => {
      switching = current().handleSelectVault("new");
    });
    await act(async () => second.resolve(note("B", "draft B")));
    expect(selectVault).not.toHaveBeenCalled();
    await act(async () => {
      first.resolve({ ...note("A", "draft A"), archived: true });
      await switching;
    });
    expect(selectVault).toHaveBeenCalledOnce();
  });

  it("preserves pending note and type creations when deleting an inactive vault", async () => {
    const createdNote = deferred<Note>();
    const createdType = deferred<ReturnType<typeof type>>();
    const deletedVault = deferred<{
      activeVaultId: string;
      vaults: ReturnType<typeof vault>[];
    }>();
    const listNotes = vi.fn(() => [note("A"), note("B")]);
    const listTypes = vi.fn(() => [type("notes"), type("tasks", 1)]);
    commands.set("list_notes", listNotes);
    commands.set("list_note_types", listTypes);
    commands.set("create_note", () => createdNote.promise);
    commands.set("create_note_type", () => createdType.promise);
    commands.set("delete_vault", () => deletedVault.promise);
    const current = await mount(useNotesController);
    let creatingNote!: Promise<Note | null>;
    let creatingType!: Promise<ReturnType<typeof type>>;
    await act(async () => {
      creatingNote = current().handleCreateNote();
      creatingType = current().handleCreateNoteType("ideas", "File", "blue");
    });
    let deleting!: Promise<void>;
    await act(async () => {
      deleting = current().handleDeleteVault("new");
    });
    expect(current().isChangingVault).toBe(false);
    await act(async () => {
      deletedVault.resolve({ activeVaultId: "old", vaults: [vault("old")] });
      await deleting;
    });
    expect(listNotes).toHaveBeenCalledOnce();
    expect(listTypes).toHaveBeenCalledOnce();
    await act(async () => {
      createdNote.resolve(note("created note"));
      await creatingNote;
      createdType.resolve(type("ideas", 2));
      await creatingType;
    });
    expect(current().notes.map((item) => item.id)).toContain("created note");
    expect(current().noteTypes.map((item) => item.id)).toContain("ideas");
    expect(current().selectedNote?.id).toBe("created note");
    expect(current().vaults.map((item) => item.id)).toEqual(["old"]);
  });

  it.each(["create", "delete", "create-error", "delete-error"])(
    "ignores stale note %s after switching vaults",
    async (operation) => {
      const response = deferred<Note>();
      commands.set(
        operation.startsWith("create") ? "create_note" : "delete_note",
        () => response.promise,
      );
      const current = await mount(useNotesController);
      let mutation!: Promise<unknown>;
      await act(async () => {
        mutation = operation.startsWith("create")
          ? current().handleCreateNote()
          : current().handleDeleteNote("A");
      });
      commands.set("list_notes", () => [note("A", "fresh vault")]);
      await act(async () => {
        await current().handleSelectVault("new");
      });
      await act(async () => current().handleContentChange("fresh draft"));
      await act(async () => {
        if (operation.endsWith("error"))
          response.reject(new Error("old failure"));
        else response.resolve(note("stale"));
        await mutation;
      });
      expect(current().notes).toHaveLength(1);
      expect(current().selectedNote).toMatchObject({
        id: "A",
        content: "fresh draft",
      });
      expect(current().content).toBe("fresh draft");
      expect(current().activeView).toBe("all");
      expect(errorNotifications()).toEqual([]);
      expect(current().saveState).toBe("saving");
    },
  );

  it("does not send create after its pending flush crosses a vault transition", async () => {
    const response = deferred<Note>();
    const create = vi.fn(() => note("created"));
    commands.set("update_note", () => response.promise);
    commands.set("create_note", create);
    const current = await mount(useNotesController);
    await act(async () => current().handleContentChange("draft"));
    let creating!: Promise<Note | null>;
    let switching!: Promise<void>;
    await act(async () => {
      creating = current().handleCreateNote();
    });
    await act(async () => {
      switching = current().handleSelectVault("new");
    });
    await act(async () => {
      response.resolve(note("A", "draft"));
      await switching;
      await creating;
    });
    expect(create).not.toHaveBeenCalled();
    expect(await creating).toBeNull();
  });

  it("an old create completion cannot unlock a new vault's pending creation", async () => {
    const oldResponse = deferred<Note>();
    const newResponse = deferred<Note>();
    commands.set(
      "create_note",
      vi
        .fn()
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise),
    );
    const current = await mount(useNotesController);
    let oldCreate!: Promise<Note | null>;
    let newCreate!: Promise<Note | null>;
    await act(async () => {
      oldCreate = current().handleCreateNote();
    });
    await act(async () => {
      await current().handleSelectVault("new");
    });
    await act(async () => {
      newCreate = current().handleCreateNote();
    });
    await act(async () => {
      oldResponse.resolve(note("old created"));
      await oldCreate;
    });
    expect(current().isCreatingNote).toBe(true);
    await act(async () => {
      newResponse.resolve(note("new created"));
      await newCreate;
    });
    expect(current().isCreatingNote).toBe(false);
    expect(current().selectedNote?.id).toBe("new created");
  });

  it("deleting A does not replace B selected and edited during the request", async () => {
    const response = deferred<void>();
    commands.set("delete_note", () => response.promise);
    const current = await mount(useNotesController);
    let deleting!: Promise<void>;
    await act(async () => {
      deleting = current().handleDeleteNote("A");
    });
    await act(async () => {
      await current().handleSelectNote(note("B"));
    });
    await act(async () => current().handleContentChange("B draft"));
    await act(async () => {
      response.resolve();
      await deleting;
    });
    expect(current().selectedNote?.id).toBe("B");
    expect(current().content).toBe("B draft");
    expect(current().notes.map((item) => item.id)).toEqual(["B"]);
    expect(current().saveState).toBe("saving");
  });

  it.each(["pinned", "kind"])(
    "ignores a %s response from the previous vault",
    async (field) => {
      const response = deferred<Note>();
      commands.set(`update_note_${field}`, () => response.promise);
      const current = await mount(useNotesController);
      let mutation!: Promise<void>;
      await act(async () => {
        mutation =
          field === "kind"
            ? current().handleChangeNoteType("tasks", "A")
            : current().handleToggleNotePinned("A", true);
      });
      commands.set("list_notes", () => [note("A", "fresh vault")]);
      await act(async () => {
        await current().handleSelectVault("new");
      });
      await act(async () => {
        response.resolve({ ...note("A"), pinned: true, kind: "tasks" });
        await mutation;
      });
      expect(current().selectedNote).toMatchObject({
        content: "fresh vault",
        pinned: false,
        kind: "notes",
      });
    },
  );

  it("preserves concurrent type creation and rename when deletion completes last", async () => {
    const deletion = deferred<void>();
    const creation = deferred<ReturnType<typeof type>>();
    const update = deferred<ReturnType<typeof type>>();
    commands.set("delete_note_type", () => deletion.promise);
    commands.set("create_note_type", () => creation.promise);
    commands.set("update_note_type", () => update.promise);
    const current = await mount(useNotesController);
    let deleting!: Promise<void>;
    let creating!: Promise<ReturnType<typeof type>>;
    let updating!: Promise<ReturnType<typeof type>>;
    await act(async () => {
      deleting = current().handleDeleteNoteType("tasks");
      creating = current().handleCreateNoteType("ideas", "File", "blue");
      updating = current().handleUpdateNoteType(
        "notes",
        "Renamed",
        "File",
        "blue",
      );
    });
    await act(async () => {
      update.resolve({ ...type("notes"), name: "Renamed" });
      creation.resolve(type("ideas", 2));
      await Promise.all([creating, updating]);
    });
    await act(async () => {
      deletion.resolve();
      await deleting;
    });
    expect(current().noteTypes.map((item) => item.id)).toEqual([
      "notes",
      "ideas",
    ]);
    expect(current().noteTypes[0].name).toBe("Renamed");
    expect(current().activeView).toBe("type:ideas");
  });

  it("preserves concurrent note type deletions", async () => {
    const tasksDeletion = deferred<void>();
    const ideasDeletion = deferred<void>();
    commands.set("list_note_types", () => [
      type("notes"),
      type("tasks", 1),
      type("ideas", 2),
    ]);
    commands.set("delete_note_type", ({ id }) =>
      id === "tasks" ? tasksDeletion.promise : ideasDeletion.promise,
    );
    const current = await mount(useNotesController);
    let deletingTasks!: Promise<void>;
    let deletingIdeas!: Promise<void>;
    await act(async () => {
      deletingTasks = current().handleDeleteNoteType("tasks");
      deletingIdeas = current().handleDeleteNoteType("ideas");
    });
    await act(async () => {
      tasksDeletion.resolve();
      await deletingTasks;
    });
    await act(async () => {
      ideasDeletion.resolve();
      await deletingIdeas;
    });
    expect(current().noteTypes.map((item) => item.id)).toEqual(["notes"]);
  });

  it.each([
    ["notes", [type("notes"), type("tasks", 1)], "noteTypes.error.deleteUsed"],
    ["tasks", [type("tasks")], "noteTypes.error.deleteLast"],
  ])(
    "reports why type %s cannot be deleted",
    async (id, noteTypes, message) => {
      commands.set("list_note_types", () => noteTypes);
      const deletion = vi.fn();
      commands.set("delete_note_type", deletion);
      const current = await mount(useNotesController);
      await act(async () => {
        await expect(current().handleDeleteNoteType(id)).rejects.toThrow();
      });
      expect(deletion).not.toHaveBeenCalled();
      expect(errorNotifications()).toEqual([message]);
    },
  );

  it.each(["create", "update", "delete", "reorder", "reorder-error"])(
    "ignores stale type %s even before the next vault loads",
    async (operation) => {
      const response = deferred<unknown>();
      const transition = deferred<unknown>();
      const command = operation.startsWith("reorder")
        ? "reorder_note_types"
        : `${operation}_note_type`;
      commands.set(command, () => response.promise);
      commands.set("select_vault", () => transition.promise);
      const current = await mount(useNotesController);
      let mutation!: Promise<unknown>;
      await act(async () => {
        mutation =
          operation === "create"
            ? current().handleCreateNoteType("new type", "File", "blue")
            : operation === "update"
              ? current().handleUpdateNoteType(
                  "tasks",
                  "Renamed",
                  "File",
                  "blue",
                )
              : operation === "delete"
                ? current().handleDeleteNoteType("tasks")
                : current().handleReorderNoteTypes(["tasks", "notes"]);
        mutation = mutation.catch(() => undefined);
      });
      let switching!: Promise<void>;
      await act(async () => {
        switching = current().handleSelectVault("new");
      });
      const before = current().noteTypes;
      await act(async () => {
        if (operation === "reorder-error")
          response.reject(new Error("old failure"));
        else
          response.resolve(
            operation === "reorder" ? [type("stale")] : type("stale"),
          );
        await mutation;
      });
      expect(current().noteTypes).toEqual(before);
      expect(current().activeView).toBe("all");
      expect(errorNotifications()).toEqual([]);
      commands.set("list_note_types", () => [type("fresh")]);
      commands.set("list_notes", () => [note("fresh")]);
      await act(async () => {
        transition.resolve({ activeVaultId: "new", vaults: [vault("new")] });
        await switching;
      });
      expect(current().noteTypes.map((item) => item.id)).toEqual(["fresh"]);
    },
  );
});

describe("encrypted notes", () => {
  const image = `asset://localhost/${encodeURIComponent("/data/vaults/old/attachments/images/shot.webp")}`;

  it("saves edits encrypted and forgets the text once locked", async () => {
    const { key, wrappedKey } = await createNoteKey("passphrase");
    let stored = await encryptNoteContent(key, "Secret\n\nbody");
    commands.set("list_notes", () => [
      note("A"),
      { ...note("S"), title: "", content: stored },
    ]);
    commands.set("get_note_encryption_key", () => wrappedKey);
    const save = vi.fn((args: Record<string, unknown>) => {
      stored = String(args.content);
      return { ...note("S"), title: String(args.title), content: stored };
    });
    commands.set("update_note", save);
    const current = await mount(useNotesController);
    const secret = () => current().notes.find((item) => item.id === "S")!;
    expect(secret()).toMatchObject({ content: "", encryption: "locked" });

    await act(async () => current().noteEncryption.unlock("passphrase"));
    expect(secret()).toMatchObject({
      content: "Secret\n\nbody",
      title: "Secret",
      encryption: "unlocked",
    });
    await act(async () => {
      await current().handleSelectNote(secret());
    });
    await act(async () => current().handleContentChange("Secret\n\nedited"));
    await act(async () => current().noteEncryption.lock());

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].title).toBe("Secret");
    expect(stored).not.toContain("edited");
    expect(await decryptNoteContent(key, stored)).toBe("Secret\n\nedited");
    expect(secret()).toMatchObject({
      content: "",
      title: "Secret",
      encryption: "locked",
    });
    expect(current().content).toBe("");
  }, 30_000);

  it("a reset saves pending edits, then reloads the vault without its encrypted notes", async () => {
    const events: string[] = [];
    let stored = [note("A"), { ...note("S"), content: "soreno-enc:v1:QUJD" }];
    commands.set("list_notes", () => stored);
    commands.set("get_note_encryption_key", () => "wrapped");
    commands.set("update_note", (args) => {
      events.push(`update ${args.content}`);
      stored = stored.map((item) =>
        item.id === args.id ? { ...item, content: String(args.content) } : item,
      );
      return stored.find((item) => item.id === args.id);
    });
    commands.set("reset_note_encryption_key", (args) => {
      events.push(`reset ${args.wrappedKey}`);
      stored = stored.filter((item) => item.id !== "S");
    });
    const current = await mount(useNotesController);
    await act(async () => {
      await current().handleSelectNote(
        current().notes.find((item) => item.id === "A")!,
      );
    });
    await act(async () => current().handleContentChange("edited"));

    await act(async () => current().noteEncryption.resetPassphrase());

    expect(events).toEqual(["update edited", "reset wrapped"]);
    expect(current().notes).toMatchObject([{ id: "A", content: "edited" }]);
    expect(current().noteEncryption.keyStatus).toBe("none");
  });

  it.each([true, false])(
    "replaces images with encrypted copies and keeps the clear ones until the note is saved (save ok: %s)",
    async (saves) => {
      const events: string[] = [];
      const files = new Map<string, string>();
      let storedKey = "";
      commands.set("list_notes", () => [
        note("A", `![](${image})\n\nshot.webp`),
      ]);
      commands.set("get_note_encryption_key", () => storedKey || null);
      commands.set("store_note_encryption_key", (args) => {
        storedKey ||= String(args.wrappedKey);
        return storedKey;
      });
      commands.set(
        "read_attachment_image",
        () => new Uint8Array([7, 8]).buffer,
      );
      commands.set("save_encrypted_attachment", (args) => {
        events.push(`save ${args.name}`);
        files.set(String(args.name), String(args.dataBase64));
      });
      commands.set("update_note", (args) => {
        events.push("update");
        if (!saves) throw new Error("disk full");
        return { ...note("A"), content: String(args.content) };
      });
      commands.set("delete_attachment_image", (args) => {
        events.push(`delete ${args.name}`);
      });
      commands.set("compact_vault_database", () => {
        events.push("compact");
      });
      const current = await mount(useNotesController);
      await act(async () => current().noteEncryption.createPassphrase("pass"));
      await act(async () => current().noteEncryption.encryptNote("A"));

      const [encrypted] = [...files.keys()];
      const stored = current().notes[0];
      if (!saves) {
        expect(events).toEqual([
          `save ${encrypted}`,
          "update",
          `delete ${encrypted}`,
        ]);
        expect(stored.encryption).toBeUndefined();
        expect(errorNotifications()).toEqual(["errors.encryptNote"]);
        return;
      }
      expect(events).toEqual([
        `save ${encrypted}`,
        "update",
        "delete shot.webp",
        "compact",
      ]);
      expect(stored).toMatchObject({
        content: `![](soreno-encrypted:${encrypted})\n\nshot.webp`,
        encryption: "unlocked",
      });
      const key = await unlockNoteKey(storedKey, "pass");
      const sealed = Uint8Array.from(atob(files.get(encrypted)!), (c) =>
        c.charCodeAt(0),
      );
      expect(await decryptImage(key, sealed)).toEqual({
        bytes: new Uint8Array([7, 8]),
        mimeType: "image/webp",
      });
    },
    30_000,
  );
});
