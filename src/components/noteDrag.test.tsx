// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createEmptyViewCounts } from "../domain/library";
import type { NoteType } from "../domain/noteTypes";
import type { Note } from "../domain/notes";
import { NoteBrowser } from "./NoteBrowser";
import { Sidebar } from "./Sidebar";
import { setInputValue } from "./ui/testInput";

vi.mock("../i18n", () => ({
  useI18n: () => ({ locale: "fr-FR", t: (key: string) => key }),
}));

const mime = "application/x-soreno-note-id";
function transfer(values: Record<string, string> = {}) {
  return {
    types: Object.keys(values),
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData: vi.fn(function (
      this: { types: string[] },
      type: string,
      value: string,
    ) {
      values[type] = value;
      this.types = Object.keys(values);
    }),
    getData: vi.fn((type: string) => values[type] ?? ""),
  };
}
function drag(
  target: EventTarget,
  type: string,
  dataTransfer: ReturnType<typeof transfer>,
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer, relatedTarget });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it("moves the dragged unselected note to a sidebar type without selecting, and cleans up valid targets", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const savedSections = localStorage.getItem("soreno:sidebar-sections");
  localStorage.removeItem("soreno:sidebar-sections");
  const noteTypes: NoteType[] = ["notes", "work"].map((id, sortOrder) => ({
    id,
    name: id,
    icon: "book-open",
    color: "#123456",
    sortOrder,
    createdAt: "",
    updatedAt: "",
  }));
  const notes: Note[] = ["selected-note", "other-note"].map((id) => ({
    id,
    kind: "notes",
    title: id,
    content: "",
    archived: false,
    favorite: false,
    pinned: false,
    createdAt: "2026-06-29T10:00:00",
    updatedAt: "2026-06-30T14:05:00",
  }));
  const onSelectNote = vi.fn();
  const onSelectView = vi.fn();
  const onDropNote = vi.fn();
  const onReorderNoteTypes = vi.fn(async () => {});
  let finishSave!: (type: NoteType) => void;
  const onUpdateNoteType = vi.fn(
    () =>
      new Promise<NoteType>((resolve) => {
        finishSave = resolve;
      }),
  );
  try {
    await act(async () =>
      root.render(
        <>
          <NoteBrowser
            activeView="all"
            isCreateNoteDisabled={false}
            isLoading={false}
            notes={notes}
            noteTypes={noteTypes}
            onChangeSortOrder={vi.fn()}
            onCreateNote={vi.fn()}
            onSearchChange={vi.fn()}
            onSelectNote={onSelectNote}
            searchQuery=""
            selectedNoteId={notes[0].id}
            sortOrder="updated-desc"
          />
          <Sidebar
            activeView="all"
            counts={createEmptyViewCounts()}
            noteTypes={noteTypes}
            onCreateNoteType={vi.fn()}
            onDeleteNoteType={vi.fn()}
            onDropNote={onDropNote}
            onReorderNoteTypes={onReorderNoteTypes}
            onSelectView={onSelectView}
            onUpdateNoteType={onUpdateNoteType}
          />
        </>,
      ),
    );
    const source =
      container.querySelectorAll<HTMLButtonElement>(".note-list-item")[1];
    const rows = container.querySelectorAll<HTMLElement>(".type-nav-row");
    const target = rows[1];
    const child = target.querySelector("span")!;
    const data = transfer();
    expect(source.draggable).toBe(true);
    expect(source.classList.contains("selected")).toBe(false);
    drag(source, "dragstart", data);
    expect(data.setData).toHaveBeenCalledExactlyOnceWith(mime, "other-note");
    expect(data.types).toEqual([mime]);
    expect(data.effectAllowed).toBe("move");
    expect(onSelectNote).not.toHaveBeenCalled();
    drag(target, "dragenter", data);
    expect(drag(child, "dragover", data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("move");
    expect(target.classList.contains("note-drop-target")).toBe(true);
    // Native dragenter for a child precedes dragleave for its parent, even with null relatedTarget.
    drag(child, "dragenter", data);
    drag(target, "dragleave", data);
    expect(target.classList.contains("note-drop-target")).toBe(true);
    expect(data.getData).not.toHaveBeenCalled();
    expect(drag(child, "drop", data).defaultPrevented).toBe(true);
    expect(onDropNote).toHaveBeenCalledExactlyOnceWith("other-note", "work");
    expect(target.classList.contains("note-drop-target")).toBe(false);
    expect(onSelectNote).not.toHaveBeenCalled();
    expect(onSelectView).not.toHaveBeenCalled();
    expect(onReorderNoteTypes).not.toHaveBeenCalled();

    for (const foreign of [
      transfer({ "text/plain": "other-note" }),
      transfer({ Files: "file" }),
    ]) {
      drag(target, "dragenter", foreign);
      expect(drag(target, "dragover", foreign).defaultPrevented).toBe(false);
      expect(target.classList.contains("note-drop-target")).toBe(false);
      expect(drag(target, "drop", foreign).defaultPrevented).toBe(false);
      expect(foreign.getData).not.toHaveBeenCalled();
    }
    for (const id of ["", "   "]) {
      const empty = transfer({ [mime]: id });
      drag(target, "dragenter", empty);
      expect(drag(target, "drop", empty).defaultPrevented).toBe(true);
      expect(target.classList.contains("note-drop-target")).toBe(false);
    }
    expect(onDropNote).toHaveBeenCalledTimes(1);
    drag(target, "dragenter", data);
    drag(target, "dragleave", data);
    expect(target.classList.contains("note-drop-target")).toBe(false);
    for (const end of ["dragend", "drop", "Escape"]) {
      drag(target, "dragenter", data);
      expect(target.classList.contains("note-drop-target")).toBe(true);
      if (end === "Escape") {
        act(() =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape" }),
          ),
        );
      } else drag(source, end, data);
      expect(target.classList.contains("note-drop-target")).toBe(false);
    }
    act(() => source.click());
    expect(onSelectNote).toHaveBeenCalledExactlyOnceWith(notes[1]);
    act(() => target.querySelector<HTMLButtonElement>("button")!.click());
    expect(onSelectView).toHaveBeenCalledExactlyOnceWith("type:work");

    // Pointer reordering remains separate and blocks all HTML drop targets while active.
    function pointer(target: EventTarget, type: string, clientY: number) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientY,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      act(() => {
        target.dispatchEvent(event);
      });
    }
    pointer(rows[0], "pointerdown", 0);
    pointer(document, "pointermove", 20);
    expect(container.querySelector(".type-nav-reordering")).not.toBeNull();
    expect(drag(target, "dragover", data).defaultPrevented).toBe(false);
    drag(target, "drop", data);
    expect(onDropNote).toHaveBeenCalledTimes(1);
    pointer(document, "pointercancel", 20);
    expect(container.querySelector(".type-nav-reordering")).toBeNull();

    act(() =>
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".app-menu-item")]
        .find((button) => button.textContent === "noteTypes.renameContext")!
        .click(),
    );
    const input = target.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();
    expect(drag(input, "dragover", data).defaultPrevented).toBe(false);
    drag(input, "drop", data);
    expect(onDropNote).toHaveBeenCalledTimes(1);
    act(() => {
      setInputValue(input, "Renamed");
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onUpdateNoteType).toHaveBeenCalledOnce();
    expect(drag(rows[0], "dragover", data).defaultPrevented).toBe(false);
    drag(rows[0], "drop", data);
    expect(onDropNote).toHaveBeenCalledTimes(1);
    await act(async () => finishSave({ ...noteTypes[1], name: "Renamed" }));
    expect(drag(target, "dragover", data).defaultPrevented).toBe(true);
    drag(source, "dragend", data);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (savedSections === null)
      localStorage.removeItem("soreno:sidebar-sections");
    else localStorage.setItem("soreno:sidebar-sections", savedSections);
  }
});
