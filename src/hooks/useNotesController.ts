import { useEffect, useMemo, useRef, useState } from "react";
import {
  createNote,
  deleteNote,
  listNotes,
  updateNoteArchived,
  updateNoteFavorite,
  updateNoteKind,
  updateNotePinned,
} from "../data/notesApi";
import { listNoteTypes } from "../data/noteTypesApi";
import { isNewer } from "../domain/dateTime";
import {
  countNotesByView,
  defaultNoteTypeForView,
  getVisibleNotes,
  isNoteCollectionView,
  normalizeLibraryView,
  noteTypeIdForView,
  noteTypeView,
  selectVisibleNoteForView,
  type LibraryView,
  viewAfterCreatingNote,
} from "../domain/library";
import {
  noteSortOrders,
  sortNotes,
  type Note,
  type NoteSortOrder,
} from "../domain/notes";
import {
  defaultNoteTypeId,
  getFallbackNoteType,
  type NoteTypeId,
} from "../domain/noteTypes";
import { defaultAppSettings } from "../data/settingsApi";
import { useI18n } from "../i18n";
import { notifyError } from "../notifications";
import { useAutosave } from "./useAutosave";
import { useNoteTypes } from "./useNoteTypes";
import { useNoteEncryption } from "./useNoteEncryption";
import { useVaults } from "./useVaults";

const NOTE_SORT_STORAGE_KEY = "soreno.noteSortOrder";
const WORKSPACE_STORAGE_KEY = "soreno.workspace.v1";

type UseNotesControllerOptions = {
  beforeClose?: () => Promise<boolean>;
  noteLockMinutes?: number;
  onCloseCancelled?: () => void;
};

export function useNotesController({
  beforeClose,
  noteLockMinutes = defaultAppSettings.noteLockMinutes,
  onCloseCancelled,
}: UseNotesControllerOptions = {}) {
  const { locale, t } = useI18n();
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeView, setActiveView] =
    useState<LibraryView>(readStoredWorkspace);
  const [noteSortOrder, setNoteSortOrder] = useState<NoteSortOrder>(
    readStoredNoteSortOrder,
  );
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const didBootstrap = useRef(false);
  const isCreatingNoteRef = useRef<number | null>(null);
  const generation = useRef(0);
  const currentState = useRef({
    selectedId,
    activeView,
    searchQuery,
    noteSortOrder,
  });
  currentState.current = { selectedId, activeView, searchQuery, noteSortOrder };
  const noteKey = useRef<CryptoKey | null>(null);
  const pendingConversion = useRef<() => Promise<void> | null>(() => null);

  const autosave = useAutosave({
    beforeClose,
    onCloseCancelled,
    locale,
    noteFallbackTitle: t("note.fallbackTitle"),
    notes,
    saveNoteErrorMessage: t("errors.saveNote"),
    closeGuardErrorMessage: t("errors.closeGuard"),
    getNoteKey: () => noteKey.current,
    pendingConversion: () => pendingConversion.current(),
    selectedId,
    setNotes,
  });
  const noteEncryption = useNoteEncryption({
    autosave,
    generation,
    getSelectedId: () => currentState.current.selectedId,
    keyRef: noteKey,
    locale,
    lockMinutes: noteLockMinutes,
    reloadNotes: () => loadCurrentVaultNotes(),
    t,
  });
  pendingConversion.current = noteEncryption.pendingConversion;
  const noteTypesController = useNoteTypes({
    getCurrentNotes: autosave.getCurrentNotes,
    messages: {
      create: t("noteTypes.error.create"),
      delete: t("noteTypes.error.delete"),
      deleteLast: t("noteTypes.error.deleteLast"),
      deleteUsed: t("noteTypes.error.deleteUsed"),
      reorder: t("noteTypes.error.reorder"),
      save: t("noteTypes.error.save"),
    },
    setActiveView,
  });
  const vaultsController = useVaults({
    messages: {
      create: t("errors.createVault"),
      delete: t("errors.deleteVault"),
      rename: t("errors.renameVault"),
      select: t("errors.selectVault"),
    },
    onBeforeVaultChange: async () => {
      // A conversion cut short would leave clear images of an encrypted note behind.
      await noteEncryption.pendingConversion();
      generation.current += 1;
      isCreatingNoteRef.current = null;
      setIsCreatingNote(false);
      noteTypesController.invalidatePendingMutations();
      await autosave.flushPendingNotes();
    },
    onVaultChanged: loadCurrentVaultNotes,
  });
  const noteTypes = noteTypesController.noteTypes;

  const selectedNote = useMemo(() => {
    return notes.find((note) => note.id === selectedId) ?? null;
  }, [notes, selectedId]);

  const visibleNotes = useMemo(() => {
    if (!isNoteCollectionView(activeView)) {
      return [];
    }

    return getVisibleNotes(
      notes,
      activeView,
      searchQuery,
      noteSortOrder,
      locale,
    );
  }, [activeView, locale, noteSortOrder, notes, searchQuery]);

  const noteCounts = useMemo(() => {
    return countNotesByView(notes, noteTypes);
  }, [noteTypes, notes]);

  useEffect(() => {
    writeStoredNoteSortOrder(noteSortOrder);
  }, [noteSortOrder]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        activeView === "agents" ? "agents" : "notes",
      );
    } catch {
      /* Workspace persistence is optional. */
    }
  }, [activeView]);

  useEffect(() => {
    if (didBootstrap.current) {
      return;
    }

    didBootstrap.current = true;

    async function bootstrap() {
      try {
        await vaultsController.loadVaultState();
        await loadCurrentVaultNotes();
      } catch {
        notifyError(t("errors.loadVaults"));
      } finally {
        setIsBootstrapping(false);
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, [locale, t]);

  function setSelectedNoteState(note: Note | null) {
    currentState.current.selectedId = note?.id ?? null;
    setSelectedId(note?.id ?? null);
    autosave.setCurrentContent(note?.content ?? "");
  }

  async function loadCurrentVaultNotes(options: { resetView?: boolean } = {}) {
    const currentGeneration = ++generation.current;
    isCreatingNoteRef.current = null;
    setIsCreatingNote(false);
    noteTypesController.invalidatePendingMutations();
    setIsLoading(true);
    autosave.clearPendingSaves();
    // Keep the inert workspace visible until notes and types can be replaced together.

    try {
      const [loadedNoteTypes, loadedNotes] = await Promise.all([
        listNoteTypes(),
        listNotes(),
      ]);
      if (generation.current !== currentGeneration) return;
      const fallbackNoteTypeId =
        getFallbackNoteType(loadedNoteTypes)?.id ?? defaultNoteTypeId;
      // Always resync the note key, even for an empty vault.
      const openedNotes = await noteEncryption.openNotes(loadedNotes);
      if (generation.current !== currentGeneration) return;
      const initialNotes =
        openedNotes.length > 0
          ? openedNotes
          : [await createNote(fallbackNoteTypeId)];
      if (generation.current !== currentGeneration) return;
      const sortedNotes = sortNotes(initialNotes, "updated-desc", locale);
      const firstNote = sortedNotes.find((note) => !note.archived) ?? null;

      noteTypesController.setNoteTypes(loadedNoteTypes);
      autosave.replaceNotes(sortedNotes);
      setSelectedNoteState(firstNote);
      setSearchQuery("");

      setActiveView((currentView) =>
        // Tasks is its own tab: a vault change keeps it, other views restart at All notes.
        options.resetView && currentView !== "tasks"
          ? "all"
          : normalizeLibraryView(currentView, loadedNoteTypes),
      );

      if (firstNote) {
        autosave.recordSavedAt(firstNote.updatedAt);
        autosave.markSaved();
      } else {
        autosave.resetSaveStatus();
      }
    } catch (error) {
      if (generation.current === currentGeneration) {
        // The native vault has changed: never unlock with the previous vault's data.
        autosave.replaceNotes([]);
        noteTypesController.setNoteTypes([]);
        setSelectedNoteState(null);
        setActiveView("all");
        setSearchQuery("");
        autosave.resetSaveStatus();
      }
      throw error;
    } finally {
      if (generation.current === currentGeneration) setIsLoading(false);
    }
  }

  async function handleCreateNote(): Promise<Note | null> {
    if (isCreatingNoteRef.current !== null) {
      return null;
    }

    const currentGeneration = generation.current;
    isCreatingNoteRef.current = currentGeneration;
    setIsCreatingNote(true);

    try {
      await autosave.flushPendingNote(currentState.current.selectedId);
      if (generation.current !== currentGeneration) return null;
      const { activeView } = currentState.current;
      const fallbackTypeId =
        getFallbackNoteType(noteTypes)?.id ?? defaultNoteTypeId;
      const noteTypeId = isNoteCollectionView(activeView)
        ? defaultNoteTypeForView(activeView, fallbackTypeId)
        : fallbackTypeId;
      const note = await createNote(noteTypeId);
      if (generation.current !== currentGeneration) return null;

      autosave.clearPendingSave(note.id);
      autosave.updateNotes((currentNotes) =>
        sortNotes([note, ...currentNotes], "updated-desc", locale),
      );
      setSearchQuery("");
      setActiveView(viewAfterCreatingNote(activeView, note.kind));
      setSelectedNoteState(note);
      autosave.recordSavedAt(note.updatedAt);
      autosave.markSaved();
      return note;
    } catch {
      if (generation.current !== currentGeneration) return null;
      autosave.markError();
      notifyError(t("errors.createNote"));
      return null;
    } finally {
      if (isCreatingNoteRef.current === currentGeneration) {
        isCreatingNoteRef.current = null;
        setIsCreatingNote(false);
      }
    }
  }

  async function handleChangeNoteType(
    kind: NoteTypeId,
    noteId = currentState.current.selectedId,
  ) {
    if (
      !noteId ||
      isLoading ||
      vaultsController.isChangingVault ||
      !noteTypes.some((noteType) => noteType.id === kind)
    ) {
      return;
    }

    await persistNoteUpdate({
      errorMessage: t("errors.changeKind"),
      noteId,
      field: "kind",
      shouldUpdate: (note) => note.kind !== kind,
      updateNote: (note) => updateNoteKind(note.id, kind),
    });
  }

  type PersistNoteUpdateOptions = {
    errorMessage: string;
    noteId: string;
    field: "kind" | "archived" | "pinned" | "favorite";
    shouldUpdate: (note: Note) => boolean;
    updateNote: (note: Note) => Promise<Note>;
  };

  function replacePersistedNote(
    updatedNote: Note,
    field: PersistNoteUpdateOptions["field"],
  ) {
    const { selectedId, activeView, searchQuery, noteSortOrder } =
      currentState.current;
    autosave.recordSavedAt(updatedNote.updatedAt);

    const nextNotes = sortNotes(
      autosave.getCurrentNotes().map((note) =>
        note.id === updatedNote.id
          ? {
              ...note,
              [field]: updatedNote[field],
              updatedAt:
                autosave.hasPendingSave(note.id) || isNewer(note, updatedNote)
                  ? note.updatedAt
                  : updatedNote.updatedAt,
            }
          : note,
      ),
      "updated-desc",
      locale,
    );
    autosave.replaceNotes(nextNotes);

    if (selectedId === updatedNote.id) {
      const activeViewKind = noteTypeIdForView(activeView);
      const nextView =
        field === "kind" &&
        activeViewKind &&
        activeViewKind !== updatedNote.kind
          ? noteTypeView(updatedNote.kind)
          : activeView;
      if (nextView !== activeView) setActiveView(nextView);
      const nextNote = isNoteCollectionView(nextView)
        ? selectVisibleNoteForView(nextNotes, nextView, {
            locale,
            preferredNoteId: updatedNote.id,
            query: searchQuery,
            sortOrder: noteSortOrder,
          })
        : (nextNotes.find((note) => note.id === updatedNote.id) ?? null);

      setSelectedNoteState(nextNote);
    }

    if (!autosave.hasPendingSaves()) {
      autosave.markSaved();
    }
  }

  async function persistNoteUpdate({
    errorMessage,
    noteId,
    field,
    shouldUpdate,
    updateNote,
  }: PersistNoteUpdateOptions) {
    const noteToUpdate = autosave
      .getCurrentNotes()
      .find((note) => note.id === noteId);

    if (!noteToUpdate || !shouldUpdate(noteToUpdate)) {
      return;
    }

    const currentGeneration = generation.current;
    try {
      await autosave.flushPendingNote(noteToUpdate.id);
      if (generation.current !== currentGeneration) return;
      const updatedNote = await updateNote(noteToUpdate);
      if (generation.current !== currentGeneration) return;
      replacePersistedNote(updatedNote, field);
    } catch {
      if (generation.current !== currentGeneration) return;
      autosave.markError();
      notifyError(errorMessage);
    }
  }

  async function handleToggleNoteArchived(noteId: string, archived: boolean) {
    await persistNoteUpdate({
      errorMessage: t("errors.archiveNote"),
      noteId,
      field: "archived",
      shouldUpdate: (note) => note.archived !== archived,
      updateNote: (note) => updateNoteArchived(note.id, archived),
    });
  }

  async function handleToggleNoteFavorite(noteId: string, favorite: boolean) {
    await persistNoteUpdate({
      errorMessage: t("errors.favoriteNote"),
      noteId,
      field: "favorite",
      shouldUpdate: (note) => note.favorite !== favorite,
      updateNote: (note) => updateNoteFavorite(note.id, favorite),
    });
  }

  async function handleToggleNotePinned(noteId: string, pinned: boolean) {
    await persistNoteUpdate({
      errorMessage: t("errors.pinNote"),
      noteId,
      field: "pinned",
      shouldUpdate: (note) => note.pinned !== pinned,
      updateNote: (note) => updateNotePinned(note.id, pinned),
    });
  }

  async function handleSelectNote(note: Note): Promise<boolean> {
    let flushedNote: Note | null = null;
    const currentGeneration = generation.current;

    try {
      flushedNote = await autosave.flushPendingNote(
        currentState.current.selectedId,
      );
      if (generation.current !== currentGeneration) return false;
    } catch {
      if (generation.current !== currentGeneration) return false;
      autosave.markError();
      autosave.notifySaveError();
      return false;
    }

    const noteToSelect =
      flushedNote?.id === note.id
        ? flushedNote
        : (autosave
            .getCurrentNotes()
            .find((currentNote) => currentNote.id === note.id) ?? note);

    setSelectedNoteState(noteToSelect);
    if (autosave.hasPendingSaves()) {
      autosave.beginSave();
    } else {
      autosave.markSaved();
    }
    return true;
  }

  async function handleDeleteNote(noteId: string) {
    const noteToDelete = autosave
      .getCurrentNotes()
      .find((note) => note.id === noteId);

    if (!noteToDelete) {
      return;
    }

    const currentGeneration = generation.current;
    try {
      await deleteNote(noteToDelete.id);
      if (generation.current !== currentGeneration) return;
      const { selectedId, activeView, searchQuery, noteSortOrder } =
        currentState.current;
      autosave.clearPendingSave(noteToDelete.id);
      autosave.recordSavedAt(new Date().toISOString());

      const remainingNotes = autosave
        .getCurrentNotes()
        .filter((note) => note.id !== noteToDelete.id);
      const nextNote = isNoteCollectionView(activeView)
        ? selectVisibleNoteForView(remainingNotes, activeView, {
            locale,
            query: searchQuery,
            sortOrder: noteSortOrder,
          })
        : null;

      autosave.replaceNotes(remainingNotes);

      if (selectedId === noteToDelete.id) {
        setSelectedNoteState(nextNote);
      }

      if (!autosave.hasPendingSaves()) {
        autosave.markSaved();
      }
    } catch {
      if (generation.current !== currentGeneration) return;
      autosave.markError();
      notifyError(t("errors.deleteNote"));
    }
  }

  function handleSelectView(view: LibraryView) {
    setActiveView(view);
    setSearchQuery("");
  }

  return {
    activeView,
    activeVault: vaultsController.activeVault,
    cancelPreparedClose: autosave.cancelPreparedClose,
    content: autosave.content,
    flushPendingNotes: autosave.flushPendingNotes,
    isBootstrapping,
    isCreatingNote,
    isChangingVault: vaultsController.isChangingVault,
    isLoading,
    lastSavedAt: autosave.lastSavedAt,
    noteCounts,
    noteSortOrder,
    noteTypes,
    notes,
    prepareToClose: autosave.prepareToClose,
    saveState: autosave.saveState,
    saveStateText: autosave.saveStateText,
    searchQuery,
    selectedNote,
    vaults: vaultsController.vaults,
    visibleNotes,
    handleContentChange: autosave.handleContentChange,
    handleChangeNoteType,
    handleCreateNote,
    handleCreateNoteType: noteTypesController.handleCreateNoteType,
    handleCreateVault: vaultsController.handleCreateVault,
    handleDeleteNoteType: noteTypesController.handleDeleteNoteType,
    handleDeleteVault: vaultsController.handleDeleteVault,
    handleDeleteNote,
    handleRenameVault: vaultsController.handleRenameVault,
    handleReorderNoteTypes: noteTypesController.handleReorderNoteTypes,
    handleSelectNote,
    handleSelectVault: vaultsController.handleSelectVault,
    handleSelectView,
    handleToggleNoteArchived,
    handleToggleNoteFavorite,
    handleToggleNotePinned,
    handleUpdateNoteType: noteTypesController.handleUpdateNoteType,
    noteEncryption,
    setNoteSortOrder,
    setSearchQuery,
  };
}

// A first launch has nothing stored and opens on Agents.
function readStoredWorkspace(): LibraryView {
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY) === "notes"
      ? "all"
      : "agents";
  } catch {
    return "agents";
  }
}

function readStoredNoteSortOrder(): NoteSortOrder {
  try {
    const storedValue = window.localStorage.getItem(NOTE_SORT_STORAGE_KEY);

    return isNoteSortOrder(storedValue) ? storedValue : "updated-desc";
  } catch {
    return "updated-desc";
  }
}

function writeStoredNoteSortOrder(sortOrder: NoteSortOrder) {
  try {
    window.localStorage.setItem(NOTE_SORT_STORAGE_KEY, sortOrder);
  } catch {
    return;
  }
}

function isNoteSortOrder(value: string | null): value is NoteSortOrder {
  return noteSortOrders.some((sortOrder) => sortOrder === value);
}
