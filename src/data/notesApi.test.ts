import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../domain/notes";
import {
  createNote,
  listNotes,
  updateNote,
  updateNoteArchived,
  updateNoteKind,
  updateNotePinned,
  updateNoteFavorite,
} from "./notesApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const blankLineMarker = "<!-- telaoi:blank-line -->";
const note: Note = {
  id: "old",
  title: "A",
  content: `A\n${blankLineMarker}\nB`,
  kind: "notes",
  archived: false,
  favorite: false,
  pinned: false,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};
beforeEach(() => vi.resetAllMocks());

describe("legacy note content at the API boundary", () => {
  it("cleans loaded notes without writing or changing their timestamps", async () => {
    vi.mocked(invoke).mockResolvedValue([note]);
    expect(await listNotes()).toEqual([{ ...note, content: "A\n\nB" }]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_notes");
    expect(note.content).toContain(blankLineMarker);
  });

  it.each([
    ["create_note", () => createNote()],
    ["update_note_kind", () => updateNoteKind("old", "notes")],
    ["update_note_archived", () => updateNoteArchived("old", true)],
    ["update_note_pinned", () => updateNotePinned("old", true)],
    ["update_note_favorite", () => updateNoteFavorite("old", true)],
  ] as const)(
    "does not reintroduce markers from %s responses",
    async (command, operation) => {
      vi.mocked(invoke).mockResolvedValue(note);
      expect(await operation()).toEqual({ ...note, content: "A\n\nB" });
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        command,
        expect.any(Object),
      );
    },
  );

  it.each([note.content, "\nA\n\n\nB\n\n"])(
    "saves clean content without losing blanks: %j",
    async (content) => {
      vi.mocked(invoke).mockResolvedValue(note);
      expect((await updateNote("old", "A", content)).content).toBe("A\n\nB");
      expect(invoke).toHaveBeenCalledExactlyOnceWith("update_note", {
        id: "old",
        title: "A",
        content: content === note.content ? "A\n\nB" : content,
      });
    },
  );

  it("preserves literal markers in code and propagates save failures", async () => {
    const content = `\`\`\`md\n${blankLineMarker}\n\`\`\`\n\n`;
    vi.mocked(invoke).mockResolvedValue([{ ...note, content }]);
    expect((await listNotes())[0].content).toBe(content);
    vi.mocked(invoke).mockRejectedValue(new Error("offline"));
    await expect(updateNote("old", "Code", content)).rejects.toThrow("offline");
    expect(invoke).toHaveBeenLastCalledWith("update_note", {
      id: "old",
      title: "Code",
      content,
    });
  });
});
