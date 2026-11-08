import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { updateNote } from "../data/notesApi";
import { isNewer } from "../domain/dateTime";
import { deriveNoteTitle, sortNotes, type Note } from "../domain/notes";
import { dismissNotification, notifyError } from "../notifications";
import { useSaveStatus } from "./useSaveStatus";

const SAVE_ERROR_NOTIFICATION_KEY = "note-save";
const AUTOSAVE_DELAY_MS = 700;

type UseAutosaveOptions = {
  beforeClose?: () => Promise<boolean>;
  closeGuardErrorMessage: string;
  getNoteKey?: () => CryptoKey | null;
  onCloseCancelled?: () => void;
  locale: string;
  pendingConversion?: () => Promise<void> | null;
  noteFallbackTitle: string;
  notes: Note[];
  saveNoteErrorMessage: string;
  selectedId: string | null;
  setNotes: Dispatch<SetStateAction<Note[]>>;
};

export function useAutosave({
  beforeClose,
  closeGuardErrorMessage,
  getNoteKey,
  onCloseCancelled,
  locale,
  pendingConversion,
  noteFallbackTitle,
  notes,
  saveNoteErrorMessage,
  selectedId,
  setNotes,
}: UseAutosaveOptions) {
  const [content, setContent] = useState("");
  const saveStatus = useSaveStatus();
  const isClosingAfterFlush = useRef(false);
  const isPreparingClose = useRef(false);
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;
  const onCloseCancelledRef = useRef(onCloseCancelled);
  onCloseCancelledRef.current = onCloseCancelled;
  const pendingConversionRef = useRef(pendingConversion);
  pendingConversionRef.current = pendingConversion;
  const pendingSaveIds = useRef(new Set<string>());
  const saveQueues = useRef(new Map<string, Promise<Note | null>>());
  const revisions = useRef(new Map<string, number>());
  const generation = useRef(0);
  const notesRef = useRef(notes);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    if (!hasPendingSaves()) return;

    const currentGeneration = generation.current;
    saveStatus.beginSave();

    const timeoutId = window.setTimeout(async () => {
      if (generation.current !== currentGeneration) return;
      try {
        await flushPendingNotes();
        if (generation.current !== currentGeneration) return;
        markSaved();
      } catch {
        if (generation.current !== currentGeneration) return;
        saveStatus.markError();
        notifySaveError();
      }
    }, AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [content, locale, noteFallbackTitle, saveNoteErrorMessage, selectedId]);

  function cancelPreparedClose() {
    const wasPreparing =
      isPreparingClose.current || isClosingAfterFlush.current;
    isPreparingClose.current = false;
    isClosingAfterFlush.current = false;
    if (wasPreparing) onCloseCancelledRef.current?.();
  }

  async function prepareToClose(): Promise<boolean> {
    if (isClosingAfterFlush.current) return true;
    if (isPreparingClose.current) return false;
    isPreparingClose.current = true;

    try {
      if (beforeCloseRef.current && !(await beforeCloseRef.current())) {
        cancelPreparedClose();
        return false;
      }
      // An interrupted encryption would leave clear images of an encrypted note on disk.
      await pendingConversionRef.current?.();
      await flushPendingNotes();
      isClosingAfterFlush.current = true;
      return true;
    } catch {
      saveStatus.markError();
      notifySaveError();
      cancelPreparedClose();
      return false;
    } finally {
      isPreparingClose.current = false;
    }
  }

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const window = getCurrentWindow();
    let isSubscribed = true;
    let removeCloseListener: (() => void) | null = null;

    void window
      .onCloseRequested(async (event) => {
        if (isClosingAfterFlush.current) return;
        if (
          !hasPendingSaves() &&
          !beforeCloseRef.current &&
          !isPreparingClose.current &&
          !pendingConversionRef.current?.()
        ) {
          return;
        }

        event.preventDefault();
        if (!(await prepareToClose())) return;

        try {
          await window.destroy();
        } catch {
          saveStatus.markError();
          notifySaveError();
          cancelPreparedClose();
        }
      })
      .then((unlisten) => {
        if (isSubscribed) {
          removeCloseListener = unlisten;
          return;
        }

        unlisten();
      })
      .catch(() => notifyError(closeGuardErrorMessage));

    return () => {
      isSubscribed = false;

      if (removeCloseListener) {
        removeCloseListener();
      }
    };
  }, [closeGuardErrorMessage, locale, noteFallbackTitle, saveNoteErrorMessage]);

  function notifySaveError() {
    notifyError(saveNoteErrorMessage, { key: SAVE_ERROR_NOTIFICATION_KEY });
  }

  function setCurrentContent(nextContent: string) {
    setContent(nextContent);
  }

  function getCurrentNotes(): Note[] {
    return notesRef.current;
  }

  function replaceNotes(nextNotes: Note[]) {
    notesRef.current = nextNotes;
    setNotes(nextNotes);
  }

  function updateNotes(update: (currentNotes: Note[]) => Note[]) {
    replaceNotes(update(notesRef.current));
  }

  function clearPendingSave(noteId: string) {
    pendingSaveIds.current.delete(noteId);
  }

  function clearPendingSaves() {
    generation.current += 1;
    pendingSaveIds.current.clear();
    revisions.current.clear();
    saveQueues.current.clear();
  }

  function hasPendingSave(noteId: string): boolean {
    return pendingSaveIds.current.has(noteId);
  }

  function hasPendingSaves(): boolean {
    return pendingSaveIds.current.size > 0;
  }

  function markSaved() {
    if (!hasPendingSaves()) saveStatus.markSaved();
  }

  async function flushPendingNotes(): Promise<void> {
    while (hasPendingSaves()) {
      await Promise.all([...pendingSaveIds.current].map(flushPendingNote));
    }
  }

  async function flushPendingNote(noteId: string | null): Promise<Note | null> {
    if (!noteId || !hasPendingSave(noteId)) return null;
    const existingSave = saveQueues.current.get(noteId);
    if (existingSave) return existingSave;

    const currentGeneration = generation.current;
    const save = persistPendingContent(noteId, currentGeneration).finally(
      () => {
        if (saveQueues.current.get(noteId) === save) {
          saveQueues.current.delete(noteId);
        }
      },
    );
    saveQueues.current.set(noteId, save);
    return save;
  }

  async function persistPendingContent(
    noteId: string,
    currentGeneration: number,
  ): Promise<Note | null> {
    let persistedNote: Note | null = null;
    while (generation.current === currentGeneration && hasPendingSave(noteId)) {
      const note = notesRef.current.find((note) => note.id === noteId);
      if (!note) {
        clearPendingSave(noteId);
        break;
      }
      const revision = revisions.current.get(noteId);
      const key = note.encryption ? (getNoteKey?.() ?? null) : undefined;
      // A locked note holds no content: saving it would erase the stored one.
      if (note.encryption === "locked" || key === null) {
        throw new Error("Encrypted note is locked");
      }
      saveStatus.beginSave();
      const savedNote = await updateNote(
        noteId,
        deriveNoteTitle(note.content, noteFallbackTitle),
        note.content,
        key,
      );
      if (generation.current !== currentGeneration) return null;
      if (revision !== revisions.current.get(noteId)) continue;
      if (!hasPendingSave(noteId)) break;

      pendingSaveIds.current.delete(noteId);
      dismissNotification(SAVE_ERROR_NOTIFICATION_KEY);
      saveStatus.recordSavedAt(savedNote.updatedAt);
      updateNotes((currentNotes) =>
        sortNotes(
          currentNotes.map((currentNote) =>
            currentNote.id === noteId
              ? {
                  ...currentNote,
                  title: savedNote.title,
                  content: savedNote.content,
                  updatedAt: isNewer(currentNote, savedNote)
                    ? currentNote.updatedAt
                    : savedNote.updatedAt,
                }
              : currentNote,
          ),
          "updated-desc",
          locale,
        ),
      );
      persistedNote =
        notesRef.current.find((note) => note.id === noteId) ?? null;
    }
    return persistedNote;
  }

  function handleContentChange(nextContent: string) {
    setCurrentContent(nextContent);

    if (
      !selectedId ||
      notesRef.current.find((note) => note.id === selectedId)?.encryption ===
        "locked"
    ) {
      return;
    }

    revisions.current.set(
      selectedId,
      (revisions.current.get(selectedId) ?? 0) + 1,
    );
    pendingSaveIds.current.add(selectedId);
    saveStatus.beginSave();
    const optimisticUpdatedAt = new Date().toISOString();

    updateNotes((currentNotes) =>
      sortNotes(
        currentNotes.map((note) =>
          note.id === selectedId
            ? {
                ...note,
                title: deriveNoteTitle(nextContent, noteFallbackTitle),
                content: nextContent,
                updatedAt: optimisticUpdatedAt,
              }
            : note,
        ),
        "updated-desc",
        locale,
      ),
    );
  }

  return {
    cancelPreparedClose,
    clearPendingSave,
    clearPendingSaves,
    content,
    flushPendingNote,
    flushPendingNotes,
    getCurrentNotes,
    handleContentChange,
    hasPendingSave,
    hasPendingSaves,
    lastSavedAt: saveStatus.lastSavedAt,
    markError: saveStatus.markError,
    markSaved,
    beginSave: saveStatus.beginSave,
    notifySaveError,
    prepareToClose,
    replaceNotes,
    recordSavedAt: saveStatus.recordSavedAt,
    resetSaveStatus: saveStatus.resetSaveStatus,
    saveState: saveStatus.saveState,
    saveStateText: saveStatus.saveStateText,
    setCurrentContent,
    updateNotes,
  };
}
