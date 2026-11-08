import { describe, expect, it } from "vitest";
import { deriveNoteTitle, filterNotes, sortNotes, type Note } from "./notes";

const legacyBlankLineMarker = "<!-- telaoi:blank-line -->";
const emptyCheckListItemMarker = "<!-- telaoi:empty-check-list-item -->";
const checkedEmptyCheckListItemMarker =
  "<!-- telaoi:checked-empty-check-list-item -->";

const baseNote = {
  archived: false,
  favorite: false,
  content: "",
  createdAt: "2026-06-28T10:00:00.000Z",
  kind: "note" as const,
  pinned: false,
};

describe("deriveNoteTitle", () => {
  it("uses the first non-empty Markdown line", () => {
    expect(deriveNoteTitle("\n\n# Roadmap\nDetails")).toBe("Roadmap");
  });

  it("falls back for empty content", () => {
    expect(deriveNoteTitle("   \n")).toBe("Sans titre");
  });

  it("ignores internal blank-line markers", () => {
    expect(deriveNoteTitle(`\n${legacyBlankLineMarker}\n# Roadmap`)).toBe(
      "Roadmap",
    );
  });

  it("ignores internal empty checklist markers", () => {
    expect(
      deriveNoteTitle(
        `\n${emptyCheckListItemMarker}\n${checkedEmptyCheckListItemMarker}\n# Roadmap`,
      ),
    ).toBe("Roadmap");
  });

  it("uses image alt text instead of embedded image data", () => {
    expect(
      deriveNoteTitle("![screenshot](data:image/png;base64,AAEC/f7/)"),
    ).toBe("screenshot");
  });

  it("keeps non-heading hash characters in titles", () => {
    expect(deriveNoteTitle("C# reference")).toBe("C# reference");
  });

  it("unescapes Markdown punctuation in titles", () => {
    expect(deriveNoteTitle('# Plan \\"A\\"')).toBe('Plan "A"');
  });

  it("counts emoji as single characters when limiting titles", () => {
    const title = `x${"😀".repeat(40)}`;

    expect(deriveNoteTitle(title)).toBe(title);
  });

  it("limits titles to 80 code points", () => {
    expect(deriveNoteTitle("x".repeat(80))).toBe("x".repeat(80));
    expect(deriveNoteTitle("x".repeat(81))).toBe("x".repeat(80));
  });
});

describe("sortNotes updated-desc", () => {
  it("orders the most recently updated note first", () => {
    const notes: Note[] = [
      {
        ...baseNote,
        id: "old",
        title: "Old",
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
      {
        ...baseNote,
        id: "new",
        title: "New",
        updatedAt: "2026-06-28T12:00:00.000Z",
      },
    ];

    expect(sortNotes(notes, "updated-desc").map((note) => note.id)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("sortNotes", () => {
  const notes: Note[] = [
    {
      ...baseNote,
      id: "beta",
      title: "Beta",
      createdAt: "2026-06-28T08:00:00.000Z",
      updatedAt: "2026-06-28T12:00:00.000Z",
    },
    {
      ...baseNote,
      id: "alpha",
      title: "Alpha",
      createdAt: "2026-06-28T09:00:00.000Z",
      updatedAt: "2026-06-28T11:00:00.000Z",
    },
    {
      ...baseNote,
      id: "gamma",
      title: "Gamma",
      createdAt: "2026-06-28T10:00:00.000Z",
      updatedAt: "2026-06-28T10:00:00.000Z",
    },
  ];

  it("orders notes by oldest update first", () => {
    expect(sortNotes(notes, "updated-asc").map((note) => note.id)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
  });

  it("orders notes by creation date", () => {
    expect(sortNotes(notes, "created-desc").map((note) => note.id)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(sortNotes(notes, "created-asc").map((note) => note.id)).toEqual([
      "beta",
      "alpha",
      "gamma",
    ]);
  });

  it("orders notes by title", () => {
    expect(sortNotes(notes, "title-asc").map((note) => note.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(sortNotes(notes, "title-desc").map((note) => note.id)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("keeps pinned notes first while preserving the selected sort order", () => {
    const mixedNotes: Note[] = [
      {
        ...baseNote,
        id: "unpinned-new",
        title: "Aardvark",
        createdAt: "2026-06-28T12:00:00.000Z",
        updatedAt: "2026-06-28T12:00:00.000Z",
      },
      {
        ...baseNote,
        id: "pinned-old",
        pinned: true,
        title: "Zulu",
        createdAt: "2026-06-28T09:00:00.000Z",
        updatedAt: "2026-06-28T09:00:00.000Z",
      },
      {
        ...baseNote,
        id: "pinned-new",
        pinned: true,
        title: "Bravo",
        createdAt: "2026-06-28T10:00:00.000Z",
        updatedAt: "2026-06-28T11:00:00.000Z",
      },
    ];

    expect(
      sortNotes(mixedNotes, "updated-desc").map((note) => note.id),
    ).toEqual(["pinned-new", "pinned-old", "unpinned-new"]);
    expect(
      sortNotes(mixedNotes, "created-desc").map((note) => note.id),
    ).toEqual(["pinned-new", "pinned-old", "unpinned-new"]);
    expect(sortNotes(mixedNotes, "title-asc").map((note) => note.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "unpinned-new",
    ]);
  });

  it("uses the provided locale when ordering titles", () => {
    const localizedNotes: Note[] = [
      {
        ...baseNote,
        id: "z",
        title: "z",
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
      {
        ...baseNote,
        id: "ä",
        title: "ä",
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
    ];

    expect(
      sortNotes(localizedNotes, "title-asc", "sv-SE").map((note) => note.id),
    ).toEqual(["z", "ä"]);
    expect(
      sortNotes(localizedNotes, "title-asc", "en-US").map((note) => note.id),
    ).toEqual(["ä", "z"]);
  });
});

describe("filterNotes", () => {
  it("matches title and content case-insensitively", () => {
    const notes: Note[] = [
      {
        ...baseNote,
        id: "a",
        title: "Courses",
        content: "Pain et cafe",
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
      {
        ...baseNote,
        id: "b",
        title: "Projet",
        content: "Architecture Tauri",
        updatedAt: "2026-06-28T11:00:00.000Z",
      },
    ];

    expect(filterNotes(notes, "tauri").map((note) => note.id)).toEqual(["b"]);
    expect(filterNotes(notes, "COUR").map((note) => note.id)).toEqual(["a"]);
  });

  it("uses the provided locale for case folding", () => {
    const notes: Note[] = [
      {
        ...baseNote,
        id: "istanbul",
        title: "İstanbul",
        content: "",
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
    ];

    expect(filterNotes(notes, "istanbul", "tr-TR")).toHaveLength(1);
  });

  it("does not match internal blank-line markers", () => {
    const notes: Note[] = [
      {
        ...baseNote,
        id: "a",
        title: "Weekly",
        content: legacyBlankLineMarker,
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
    ];

    expect(filterNotes(notes, "telaoi")).toEqual([]);
  });

  it("does not match internal empty checklist markers", () => {
    const notes: Note[] = [
      {
        ...baseNote,
        id: "a",
        title: "Weekly",
        content: emptyCheckListItemMarker,
        updatedAt: "2026-06-28T10:00:00.000Z",
      },
    ];

    expect(filterNotes(notes, "empty-check-list-item")).toEqual([]);
  });
});
