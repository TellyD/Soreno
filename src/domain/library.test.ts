import { describe, expect, it } from "vitest";
import {
  countNotesByView,
  defaultNoteTypeForView,
  getVisibleNotes,
  isNoteCollectionView,
  normalizeLibraryView,
  noteTypeIdForView,
  noteTypeView,
  selectVisibleNoteForView,
  selectNotesForView,
  viewAfterCreatingNote,
  type LibraryView,
} from "./library";
import type { Note } from "./notes";
import type { NoteType } from "./noteTypes";

const baseNote = {
  createdAt: "2026-06-28T10:00:00.000Z",
};

const noteTypes: NoteType[] = [
  noteType("notes", "Notes", 0),
  noteType("work", "Travail", 1),
  noteType("personal", "Personnel", 2),
  noteType("projects", "Projets", 3),
];

function note(
  id: string,
  kind: string,
  title: string,
  content: string,
  updatedAt: string,
  archived = false,
): Note {
  return {
    ...baseNote,
    archived,
    content,
    id,
    kind,
    pinned: false,
    favorite: false,
    title,
    updatedAt,
  };
}

function noteType(id: string, name: string, sortOrder: number): NoteType {
  return {
    color: "#608ef8",
    createdAt: "2026-06-28T10:00:00.000Z",
    icon: "book-open",
    id,
    name,
    sortOrder,
    updatedAt: "2026-06-28T10:00:00.000Z",
  };
}

const notes = [
  note("note", "notes", "Courses", "Pain et cafe", "2026-06-28T10:00:00.000Z"),
  note("work", "work", "Client", "Compte rendu", "2026-06-28T12:00:00.000Z"),
  note(
    "personal",
    "personal",
    "Famille",
    "Vacances",
    "2026-06-28T11:00:00.000Z",
  ),
  note(
    "project",
    "projects",
    "Projet Soreno",
    "Backlog",
    "2026-06-28T09:00:00.000Z",
  ),
];

describe("countNotesByView", () => {
  it("counts archived notes outside active views", () => {
    const archivedNotes = [
      ...notes,
      note(
        "archived",
        "work",
        "Old client",
        "",
        "2026-06-28T13:00:00.000Z",
        true,
      ),
    ];

    expect(countNotesByView(archivedNotes, noteTypes)).toEqual({
      all: 4,
      archive: 1,
      favorites: 0,
      byType: {
        notes: 1,
        personal: 1,
        projects: 1,
        work: 1,
      },
    });
  });
});

describe("selectNotesForView", () => {
  it("sorts all notes by newest update first", () => {
    expect(
      selectNotesForView(notes, "all").map((currentNote) => currentNote.id),
    ).toEqual(["work", "personal", "note", "project"]);
  });

  it("keeps the task view outside note collection views", () => {
    expect(isNoteCollectionView("tasks")).toBe(false);
    expect(isNoteCollectionView("all")).toBe(true);
    expect(isNoteCollectionView(noteTypeView("notes"))).toBe(true);
  });

  it("filters dynamic type views by note type id", () => {
    expect(
      selectNotesForView(notes, noteTypeView("notes")).map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["note"]);
    expect(
      selectNotesForView(notes, noteTypeView("work")).map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["work"]);
    expect(
      selectNotesForView(notes, noteTypeView("projects")).map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["project"]);
  });

  it("keeps archived notes out of active note views", () => {
    const archivedNotes = [
      ...notes,
      note(
        "archived",
        "work",
        "Old client",
        "",
        "2026-06-28T13:00:00.000Z",
        true,
      ),
    ];

    expect(
      selectNotesForView(archivedNotes, "all").map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["work", "personal", "note", "project"]);
    expect(
      selectNotesForView(archivedNotes, noteTypeView("work")).map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["work"]);
  });

  it("selects archived notes in the archive view", () => {
    const archivedNotes = [
      note("old", "notes", "Old", "", "2026-06-28T09:00:00.000Z", true),
      note("new", "work", "New", "", "2026-06-28T13:00:00.000Z", true),
      ...notes,
    ];

    expect(
      selectNotesForView(archivedNotes, "archive").map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["new", "old"]);
  });

  it("filters and counts active favorites without changing their type or usual sort", () => {
    const favorites = notes.map((item) => ({
      ...item,
      favorite: item.id !== "personal",
    }));
    favorites.push({
      ...notes[1],
      id: "archived",
      favorite: true,
      archived: true,
    });
    expect(isNoteCollectionView("favorites")).toBe(true);
    expect(
      selectNotesForView(favorites, "favorites").map((item) => item.id),
    ).toEqual(["work", "note", "project"]);
    expect(
      selectNotesForView(favorites, "favorites", "title-desc").map(
        (item) => item.id,
      ),
    ).toEqual(["project", "note", "work"]);
    expect(
      getVisibleNotes(favorites, "favorites", "backlog").map((item) => item.id),
    ).toEqual(["project"]);
    expect(countNotesByView(favorites, noteTypes)).toMatchObject({
      all: 4,
      archive: 1,
      favorites: 3,
      byType: { notes: 1, work: 1, personal: 1, projects: 1 },
    });
    expect(selectNotesForView(favorites, noteTypeView("work"))).toEqual([
      favorites[1],
    ]);
    expect(selectNotesForView(notes, "favorites")).toEqual([]);
  });
});

describe("getVisibleNotes", () => {
  it("combines the selected view and search query", () => {
    expect(
      getVisibleNotes(notes, "all", "backlog").map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["project"]);
    expect(
      getVisibleNotes(notes, noteTypeView("notes"), "pain").map(
        (currentNote) => currentNote.id,
      ),
    ).toEqual(["note"]);
  });
});

describe("selectVisibleNoteForView", () => {
  const options = {
    locale: "fr-FR",
    query: "",
    sortOrder: "updated-desc" as const,
  };

  it("keeps the preferred note when it is still visible", () => {
    expect(
      selectVisibleNoteForView(notes, "all", {
        ...options,
        preferredNoteId: "personal",
      })?.id,
    ).toBe("personal");
  });

  it("falls back to the first visible note when the preferred note left the view", () => {
    const archivedNotes = [
      note(
        "archived",
        "notes",
        "Archived",
        "",
        "2026-06-28T13:00:00.000Z",
        true,
      ),
      ...notes,
    ];

    expect(
      selectVisibleNoteForView(archivedNotes, "all", {
        ...options,
        preferredNoteId: "archived",
      })?.id,
    ).toBe("work");
  });

  it("returns null when no notes match the view and search", () => {
    expect(
      selectVisibleNoteForView(notes, "all", {
        ...options,
        query: "missing",
      }),
    ).toBeNull();
  });
});

describe("dynamic note type views", () => {
  it("maps type ids to dynamic views and back", () => {
    const view = noteTypeView("projects");

    expect(view).toBe("type:projects");
    expect(noteTypeIdForView(view)).toBe("projects");
    expect(noteTypeIdForView("all")).toBeNull();
  });

  it("defaults global creation to the fallback type", () => {
    expect(defaultNoteTypeForView("all", "notes")).toBe("notes");
    expect(defaultNoteTypeForView(noteTypeView("projects"), "notes")).toBe(
      "projects",
    );
  });

  it("keeps newly-created notes visible in the active browser view", () => {
    expect(viewAfterCreatingNote("all", "notes")).toBe("all");
    expect(viewAfterCreatingNote("tasks", "notes")).toBe("type:notes");
    expect(viewAfterCreatingNote(noteTypeView("projects"), "projects")).toBe(
      "type:projects",
    );
    expect(viewAfterCreatingNote("archive", "notes")).toBe("type:notes");
    expect(viewAfterCreatingNote("favorites", "notes")).toBe("type:notes");
    expect(viewAfterCreatingNote(noteTypeView("personal"), "projects")).toBe(
      "type:projects",
    );
  });

  it("falls back to all notes when a dynamic type view no longer exists", () => {
    expect(
      normalizeLibraryView(noteTypeView("missing") as LibraryView, noteTypes),
    ).toBe("all");
    expect(normalizeLibraryView(noteTypeView("work"), noteTypes)).toBe(
      "type:work",
    );
  });
});
