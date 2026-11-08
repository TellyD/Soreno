import { describe, expect, it } from "vitest";
import {
  getFallbackNoteType,
  moveNoteType,
  nextAvailableNoteTypeName,
  orderNoteTypesByIds,
  validateNoteTypeName,
  type NoteType,
} from "./noteTypes";

function noteType(id: string, name: string, sortOrder = 0): NoteType {
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

describe("validateNoteTypeName", () => {
  it("rejects blank, duplicate, and too long names", () => {
    const noteTypes = [noteType("work", "Travail")];

    expect(validateNoteTypeName(" ", noteTypes)).toBe("empty");
    expect(validateNoteTypeName("travail", noteTypes)).toBe("duplicate");
    expect(validateNoteTypeName("x".repeat(41), noteTypes)).toBe("too-long");
  });

  it("allows the current type to keep its own name", () => {
    expect(
      validateNoteTypeName("Travail", [noteType("work", "Travail")], "work"),
    ).toBeNull();
  });
});

describe("nextAvailableNoteTypeName", () => {
  it("uses the base name when it is free", () => {
    expect(nextAvailableNoteTypeName([], "Nouveau type")).toBe("Nouveau type");
  });

  it("adds the first available numeric suffix", () => {
    const noteTypes = [
      noteType("type-1", "Nouveau type"),
      noteType("type-2", "Nouveau type 2"),
    ];

    expect(nextAvailableNoteTypeName(noteTypes, "Nouveau type")).toBe(
      "Nouveau type 3",
    );
  });
});

describe("getFallbackNoteType", () => {
  it("uses display order instead of giving Notes priority, without mutating the list", () => {
    const notes = noteType("notes", "Notes", 1);
    const work = noteType("work", "Travail", 0);
    const noteTypes = [notes, work];

    expect(getFallbackNoteType(noteTypes)).toBe(work);
    expect(noteTypes).toEqual([notes, work]);
    expect(getFallbackNoteType(moveNoteType(noteTypes, "notes", 0))?.id).toBe(
      "notes",
    );
    expect(getFallbackNoteType([work])).toBe(work);
    expect(getFallbackNoteType([])).toBeNull();
  });
});

describe("moveNoteType", () => {
  it("moves a type to the requested position and normalizes sort order", () => {
    const noteTypes = [
      noteType("notes", "Notes", 0),
      noteType("weekly", "Weekly", 1),
      noteType("dashpro", "DashPro", 2),
    ];

    const movedTypes = moveNoteType(noteTypes, "dashpro", 1);

    expect(movedTypes.map((noteType) => noteType.id)).toEqual([
      "notes",
      "dashpro",
      "weekly",
    ]);
    expect(movedTypes.map((noteType) => noteType.sortOrder)).toEqual([0, 1, 2]);
  });

  it("clamps the target position", () => {
    const noteTypes = [
      noteType("notes", "Notes", 0),
      noteType("weekly", "Weekly", 1),
    ];

    expect(
      moveNoteType(noteTypes, "weekly", -1).map((noteType) => noteType.id),
    ).toEqual(["weekly", "notes"]);
    expect(
      moveNoteType(noteTypes, "notes", 99).map((noteType) => noteType.id),
    ).toEqual(["weekly", "notes"]);
  });
});

describe("orderNoteTypesByIds", () => {
  it("orders types by ids and normalizes sort order", () => {
    const noteTypes = [
      noteType("notes", "Notes", 0),
      noteType("weekly", "Weekly", 1),
      noteType("dashpro", "DashPro", 2),
    ];

    const orderedTypes = orderNoteTypesByIds(noteTypes, [
      "dashpro",
      "notes",
      "weekly",
    ]);

    expect(orderedTypes?.map((noteType) => noteType.id)).toEqual([
      "dashpro",
      "notes",
      "weekly",
    ]);
    expect(orderedTypes?.map((noteType) => noteType.sortOrder)).toEqual([
      0, 1, 2,
    ]);
  });

  it("rejects missing, unknown, and duplicate ids", () => {
    const noteTypes = [
      noteType("notes", "Notes", 0),
      noteType("weekly", "Weekly", 1),
    ];

    expect(orderNoteTypesByIds(noteTypes, ["notes"])).toBeNull();
    expect(orderNoteTypesByIds(noteTypes, ["notes", "missing"])).toBeNull();
    expect(orderNoteTypesByIds(noteTypes, ["notes", "notes"])).toBeNull();
  });
});
