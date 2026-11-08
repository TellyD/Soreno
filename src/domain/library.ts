import { filterNotes, sortNotes, type Note, type NoteSortOrder } from "./notes";
import { defaultNoteTypeId, type NoteType, type NoteTypeId } from "./noteTypes";

export const noteLibraryViews = ["all", "archive", "favorites"] as const;
const staticLibraryViews = [...noteLibraryViews, "tasks", "agents"] as const;

export type NoteLibraryView = (typeof noteLibraryViews)[number];
type StaticLibraryView = (typeof staticLibraryViews)[number];
type NoteTypeView = `type:${NoteTypeId}`;
export type LibraryView = StaticLibraryView | NoteTypeView;
export type NoteCollectionView = NoteLibraryView | NoteTypeView;

export type ViewCounts = {
  all: number;
  archive: number;
  favorites: number;
  byType: Record<NoteTypeId, number>;
};

export function createEmptyViewCounts(noteTypes: NoteType[] = []): ViewCounts {
  return {
    all: 0,
    archive: 0,
    favorites: 0,
    byType: Object.fromEntries(
      noteTypes.map((noteType) => [noteType.id, 0]),
    ) as Record<NoteTypeId, number>,
  };
}

export function countNotesByView(
  notes: Note[],
  noteTypes: NoteType[] = [],
): ViewCounts {
  const counts = createEmptyViewCounts(noteTypes);

  notes.forEach((note) => {
    if (note.archived) {
      counts.archive += 1;
      return;
    }

    if (note.favorite) counts.favorites += 1;
    counts.all += 1;
    counts.byType[note.kind] = (counts.byType[note.kind] ?? 0) + 1;
  });

  return counts;
}

export function selectNotesForView(
  notes: Note[],
  view: NoteCollectionView,
  sortOrder: NoteSortOrder = "updated-desc",
  locale = "fr-FR",
): Note[] {
  const sortedNotes = sortNotes(notes, sortOrder, locale);

  if (view === "archive") {
    return sortedNotes.filter((note) => note.archived);
  }

  const activeNotes = sortedNotes.filter((note) => !note.archived);

  if (view === "all") {
    return activeNotes;
  }

  if (view === "favorites") {
    return activeNotes.filter((note) => note.favorite);
  }

  const typeId = noteTypeIdForView(view);

  if (typeId) {
    return activeNotes.filter((note) => note.kind === typeId);
  }

  return [];
}

export function getVisibleNotes(
  notes: Note[],
  view: NoteCollectionView,
  query: string,
  sortOrder: NoteSortOrder = "updated-desc",
  locale = "fr-FR",
): Note[] {
  return filterNotes(
    selectNotesForView(notes, view, sortOrder, locale),
    query,
    locale,
  );
}

type VisibleNoteSelectionOptions = {
  locale: string;
  preferredNoteId?: string;
  query: string;
  sortOrder: NoteSortOrder;
};

export function selectVisibleNoteForView(
  notes: Note[],
  view: NoteCollectionView,
  options: VisibleNoteSelectionOptions,
): Note | null {
  const visibleNotes = getVisibleNotes(
    notes,
    view,
    options.query,
    options.sortOrder,
    options.locale,
  );

  return (
    visibleNotes.find((note) => note.id === options.preferredNoteId) ??
    visibleNotes[0] ??
    null
  );
}

export function noteTypeView(noteTypeId: NoteTypeId): NoteTypeView {
  return `type:${noteTypeId}`;
}

export function noteTypeIdForView(view: LibraryView): NoteTypeId | null {
  return view.startsWith("type:") ? view.slice("type:".length) : null;
}

export function isNoteCollectionView(
  view: LibraryView,
): view is NoteCollectionView {
  return isNoteLibraryView(view) || noteTypeIdForView(view) !== null;
}

export function isNoteLibraryView(view: LibraryView): view is NoteLibraryView {
  return noteLibraryViews.some((noteView) => noteView === view);
}

export function defaultNoteTypeForView(
  view: NoteCollectionView,
  fallbackTypeId: NoteTypeId = defaultNoteTypeId,
): NoteTypeId {
  return noteTypeIdForView(view) ?? fallbackTypeId;
}

export function viewAfterCreatingNote(
  currentView: LibraryView,
  createdTypeId: NoteTypeId,
): LibraryView {
  const currentTypeId = noteTypeIdForView(currentView);

  if (currentView === "all" || currentTypeId === createdTypeId) {
    return currentView;
  }

  return noteTypeView(createdTypeId);
}

export function normalizeLibraryView(
  view: LibraryView,
  noteTypes: NoteType[],
): LibraryView {
  const typeId = noteTypeIdForView(view);

  if (!typeId) {
    return view;
  }

  return noteTypes.some((noteType) => noteType.id === typeId) ? view : "all";
}
