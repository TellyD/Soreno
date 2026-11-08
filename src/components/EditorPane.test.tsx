// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";
import { TaskLinkedNoteEditor } from "./tasks/TaskLinkedNoteEditor";
import type { Note } from "../domain/notes";
import { stubEditorGeometry } from "./markdown-editor/testGeometry";

vi.mock("../i18n", () => {
  const value = { language: "fr", t: (key: string) => key };
  return { useI18n: () => value };
});
vi.mock("../theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./note-types/NoteTypePicker", () => ({
  NoteTypePicker: () => <button aria-label="editor.title.noteKind" />,
}));
const note: Note = {
  id: "A",
  title: "Title",
  content: "# Title\n\nText",
  kind: "note",
  archived: false,
  favorite: false,
  pinned: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
function finishAnimation(
  target: Element,
  animationName = "task-linked-note-editor-slide-out",
) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  target.dispatchEvent(event);
}

const props = {
  content: note.content,
  noteTypes: [],
  onChangeNoteType: vi.fn(),
  onContentChange: vi.fn(),
  onCreateNote: vi.fn(),
  onDeleteNote: vi.fn(),
  onToggleNoteArchived: vi.fn(),
  onToggleNotePinned: vi.fn(),
  onToggleNoteFavorite: vi.fn(),
};
it("labels the note list toggle with its current action and expanded state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onToggleNoteBrowser = vi.fn();
  try {
    for (const visible of [true, false]) {
      await act(async () =>
        root.render(
          <EditorPane
            {...props}
            selectedNote={null}
            isNoteBrowserVisible={visible}
            onToggleNoteBrowser={onToggleNoteBrowser}
          />,
        ),
      );
      const browser = container.querySelector<HTMLButtonElement>(
        '[aria-controls="workspace-note-browser"]',
      )!;
      expect(browser.getAttribute("aria-expanded")).toBe(String(visible));
      await act(async () => browser.click());
    }
    expect(onToggleNoteBrowser).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["Escape", "backdrop"])(
  "dismisses only toolbar customization inside a linked note with %s",
  async (method) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("PointerEvent", MouseEvent);
    const restoreGeometry = stubEditorGeometry();
    const storageKey = "soreno:markdown-toolbar:v1";
    const preference = window.localStorage.getItem(storageKey);
    window.localStorage.removeItem(storageKey);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const closed = vi.fn();
    function Parent() {
      const [open, setOpen] = useState(true);
      return open ? (
        <TaskLinkedNoteEditor
          {...props}
          note={note}
          onClose={() => {
            closed();
            setOpen(false);
          }}
        />
      ) : null;
    }
    async function click(target: HTMLElement) {
      await act(async () => {
        target.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
        );
        target.focus();
        target.click();
      });
    }
    try {
      await act(async () => root.render(<Parent />));
      const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="editor.toolbar.title"]',
      )!;
      await click(trigger);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      const checkbox = [
        ...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find(
        (input) => input.labels?.[0].textContent === "editor.command.strike",
      )!;
      await click(checkbox);
      expect(checkbox.checked).toBe(true);
      expect(closed).not.toHaveBeenCalled();
      expect(
        container.querySelector(".task-linked-note-editor"),
      ).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      const first = dialog.querySelector<HTMLButtonElement>(
        '[aria-label="editor.toolbar.close"]',
      )!;
      const done = [
        ...dialog.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "editor.toolbar.done")!;
      await act(async () => {
        done.focus();
        done.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.activeElement).toBe(first);
      await act(async () => {
        first.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.activeElement).toBe(done);
      await act(async () => {
        if (method === "Escape")
          done.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        else
          dialog.parentElement!.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
            }),
          );
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(closed).not.toHaveBeenCalled();
      expect(
        container.querySelector(".task-linked-note-editor"),
      ).not.toBeNull();
      expect(document.activeElement).toBe(trigger);
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      const panel = container.querySelector(".task-linked-note-editor")!;
      expect(panel.getAttribute("data-closing")).toBe("true");
      expect(panel.hasAttribute("inert")).toBe(true);
      expect(closed).not.toHaveBeenCalled();
      await act(async () => {
        finishAnimation(panel, "task-linked-note-editor-slide-in");
        finishAnimation(trigger);
      });
      expect(closed).not.toHaveBeenCalled();
      await act(async () => finishAnimation(panel));
      expect(closed).toHaveBeenCalledOnce();
      expect(container.querySelector(".task-linked-note-editor")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      restoreGeometry();
      vi.unstubAllGlobals();
      if (preference === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, preference);
    }
  },
);

it.each(["back", "outside"])(
  "animates linked-note dismissal via %s",
  async (method) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const restoreGeometry = stubEditorGeometry();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    try {
      await act(async () =>
        root.render(
          <TaskLinkedNoteEditor {...props} note={note} onClose={onClose} />,
        ),
      );
      const panel = container.querySelector(".task-linked-note-editor")!;
      await act(async () => {
        if (method === "back")
          container
            .querySelector<HTMLButtonElement>(".editor-back-button")!
            .click();
        else
          document.body.dispatchEvent(
            new MouseEvent("pointerdown", { bubbles: true }),
          );
      });
      expect(panel.getAttribute("data-closing")).toBe("true");
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => finishAnimation(panel));
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      restoreGeometry();
      vi.unstubAllGlobals();
    }
  },
);

it.each([false, true])(
  "exposes archive and delete directly while confirming deletion (archived=%s)",
  async (archived) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("PointerEvent", MouseEvent);
    const restoreGeometry = stubEditorGeometry();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    const onDeleteNote = vi.fn();
    const onToggleNoteArchived = vi.fn();
    async function click(target: HTMLElement) {
      await act(async () => {
        target.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
        );
        target.focus();
        target.click();
      });
    }
    try {
      await act(async () =>
        root.render(
          <TaskLinkedNoteEditor
            {...props}
            note={{ ...note, archived }}
            onClose={onClose}
            onDeleteNote={onDeleteNote}
            onToggleNoteArchived={onToggleNoteArchived}
          />,
        ),
      );
      const archive = container.querySelector<HTMLButtonElement>(
        `.toolbar-actions [aria-label="editor.title.${archived ? "restore" : "archive"}Aria"]`,
      )!;
      expect(archive).not.toBeNull();
      await click(archive);
      expect(onToggleNoteArchived).toHaveBeenCalledWith("A", !archived);
      expect(onClose).not.toHaveBeenCalled();
      await click(
        container.querySelector<HTMLButtonElement>(
          '.toolbar-actions [aria-label="editor.title.deleteAria"]',
        )!,
      );
      expect(onDeleteNote).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await click(
        document.querySelector<HTMLButtonElement>(
          ".confirmation-dialog-confirm",
        )!,
      );
      expect(onDeleteNote).toHaveBeenCalledWith("A");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      restoreGeometry();
      vi.unstubAllGlobals();
    }
  },
);

it.each([false, true])(
  "keeps the editor instance and selection when toggling modes (linked=%s)",
  async (linked) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const restoreGeometry = stubEditorGeometry();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          linked ? (
            <TaskLinkedNoteEditor {...props} note={note} onClose={() => {}} />
          ) : (
            <EditorPane {...props} selectedNote={note} />
          ),
        ),
      );
      const favorite = container.querySelector<HTMLButtonElement>(
        '[aria-label="editor.title.favorite"]',
      )!;
      expect(favorite.getAttribute("aria-pressed")).toBe("false");
      await act(async () => favorite.click());
      expect(props.onToggleNoteFavorite).toHaveBeenLastCalledWith("A", true);
      await act(async () =>
        root.render(
          linked ? (
            <TaskLinkedNoteEditor
              {...props}
              note={{ ...note, favorite: true }}
              onClose={() => {}}
            />
          ) : (
            <EditorPane {...props} selectedNote={{ ...note, favorite: true }} />
          ),
        ),
      );
      expect(favorite.getAttribute("aria-pressed")).toBe("true");
      await act(async () => favorite.click());
      expect(props.onToggleNoteFavorite).toHaveBeenLastCalledWith("A", false);
      const editor = EditorView.findFromDOM(
        container.querySelector(".cm-editor")!,
      )!;
      await act(async () => editor.dispatch({ selection: { anchor: 3 } }));
      for (let i = 0; i < 2; i++) {
        await act(async () =>
          (
            container.querySelector(
              '[aria-label="editor.title.rawAria"], [aria-label="editor.title.richAria"]',
            ) as HTMLButtonElement
          ).click(),
        );
        expect(
          EditorView.findFromDOM(container.querySelector(".cm-editor")!),
        ).toBe(editor);
        expect(editor.state.selection.main.anchor).toBe(3);
        expect(editor.state.sliceDoc()).toBe(note.content);
      }
      expect(props.onContentChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      restoreGeometry();
      vi.unstubAllGlobals();
    }
  },
);
