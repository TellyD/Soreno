import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  deleteAttachmentImage,
  readAttachmentImage,
  saveAttachmentImage,
  saveEncryptedAttachment,
} from "../data/attachmentsApi";
import {
  compactVaultDatabase,
  getNoteEncryptionKey,
  replaceNoteEncryptionKey,
  resetNoteEncryptionKey,
  storeNoteEncryptionKey,
} from "../data/noteEncryptionApi";
import { listNotes, updateNote } from "../data/notesApi";
import { bytesToBase64 } from "../domain/base64";
import {
  attachmentImageName,
  attachmentImageUrls,
  createNoteKey,
  decryptImage,
  decryptNoteContent,
  encryptedImageName,
  encryptedImageUrl,
  encryptedImageUrls,
  encryptImage,
  imageMimeType,
  isEncryptedNoteContent,
  replaceUrls,
  rewrapNoteKey,
  unlockNoteKey,
} from "../domain/noteEncryption";
import { deriveNoteTitle, sortNotes, type Note } from "../domain/notes";
import type { I18nContextValue, TranslationKey } from "../i18n";
import { notifyError } from "../notifications";

type NotesAutosave = {
  flushPendingNote: (noteId: string) => Promise<Note | null>;
  flushPendingNotes: () => Promise<void>;
  getCurrentNotes: () => Note[];
  markError: () => void;
  notifySaveError: () => void;
  recordSavedAt: (savedAt: string) => void;
  setCurrentContent: (content: string) => void;
  updateNotes: (update: (notes: Note[]) => Note[]) => void;
};

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel"];
const IDLE_CHECK_MS = 15_000;

export type NoteKeyStatus = "unknown" | "none" | "locked" | "unlocked";

export type NoteEncryption = {
  /** Note being encrypted or decrypted; its editor stays read-only meanwhile. */
  busyNoteId: string | null;
  changePassphrase: (current: string, next: string) => Promise<void>;
  createPassphrase: (passphrase: string) => Promise<void>;
  decryptNote: (noteId: string) => Promise<void>;
  encryptNote: (noteId: string) => Promise<void>;
  getKey: () => CryptoKey | null;
  keyStatus: NoteKeyStatus;
  lock: () => Promise<void>;
  openNotes: (notes: Note[]) => Promise<Note[]>;
  /** Running encryption or decryption, to await before leaving the vault or closing. */
  pendingConversion: () => Promise<void> | null;
  /** Forgets the passphrase and deletes, in every vault, the notes and images it encrypted. */
  resetPassphrase: () => Promise<void>;
  resolveImageUrl: (url: string) => Promise<string> | null;
  resolveKeyStatus: () => Promise<NoteKeyStatus>;
  unlock: (passphrase: string) => Promise<void>;
};

type UseNoteEncryptionOptions = {
  autosave: NotesAutosave;
  generation: MutableRefObject<number>;
  getSelectedId: () => string | null;
  keyRef: MutableRefObject<CryptoKey | null>;
  locale: string;
  lockMinutes: number;
  reloadNotes: () => Promise<void>;
  t: I18nContextValue["t"];
};

export function useNoteEncryption({
  autosave,
  generation,
  getSelectedId,
  keyRef,
  locale,
  lockMinutes,
  reloadNotes,
  t,
}: UseNoteEncryptionOptions): NoteEncryption {
  const wrappedKeyRef = useRef<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<NoteKeyStatus>("unknown");
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const conversionRef = useRef<Promise<void> | null>(null);
  // shortcut: entries of images deleted by a conversion stay until the next lock or vault load; revoke them in deleteUnusedImages if conversions are repeated a lot.
  const imageUrls = useRef(new Map<string, Promise<string>>());
  const lastActivity = useRef(Date.now());
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const fallbackTitle = t("note.fallbackTitle");

  useEffect(() => {
    if (keyStatus !== "unlocked") return;
    const touch = () => {
      lastActivity.current = Date.now();
    };
    touch();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, touch, { capture: true, passive: true });
    }
    // Wall-clock check rather than one long timeout: it also catches time spent asleep.
    const interval = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= lockMinutes * 60_000) {
        void lockRef.current();
      }
    }, IDLE_CHECK_MS);
    return () => {
      window.clearInterval(interval);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, touch, { capture: true });
      }
    };
  }, [keyStatus, lockMinutes]);

  const resolveImageUrl = useCallback(
    (url: string): Promise<string> | null => {
      const name = encryptedImageName(url);
      if (!name) return null;
      const key = keyRef.current;
      if (!key) return Promise.reject(new Error("Notes are locked"));
      let imageUrl = imageUrls.current.get(name);
      if (!imageUrl) {
        const pending = readAttachmentImage(name)
          .then((sealed) => decryptImage(key, sealed))
          .then(({ bytes, mimeType }) =>
            URL.createObjectURL(new Blob([bytes], { type: mimeType })),
          );
        imageUrls.current.set(name, pending);
        pending.catch(() => {
          if (imageUrls.current.get(name) === pending) {
            imageUrls.current.delete(name);
          }
        });
        imageUrl = pending;
      }
      return imageUrl;
    },
    [keyRef],
  );

  function revokeImageUrls() {
    for (const imageUrl of imageUrls.current.values()) {
      void imageUrl.then(URL.revokeObjectURL, () => undefined);
    }
    imageUrls.current.clear();
  }

  function setKey(key: CryptoKey | null) {
    keyRef.current = key;
    if (!key) revokeImageUrls();
    setKeyStatus(key ? "unlocked" : wrappedKeyRef.current ? "locked" : "none");
  }

  function lockedNote(note: Note): Note {
    return {
      ...note,
      content: "",
      // Notes encrypted before titles stayed readable have a blank stored title.
      title: note.title || t("note.encryptedTitle"),
      encryption: "locked",
    };
  }

  async function loadWrappedKey(): Promise<string | null> {
    const wrappedKey = await getNoteEncryptionKey();
    const changed = wrappedKey !== wrappedKeyRef.current;
    wrappedKeyRef.current = wrappedKey;
    setKey(changed ? null : keyRef.current);
    return wrappedKey;
  }

  async function resolveKeyStatus(): Promise<NoteKeyStatus> {
    if (keyRef.current) return "unlocked";
    return (await loadWrappedKey()) ? "locked" : "none";
  }

  async function openNote(note: Note): Promise<Note> {
    if (!isEncryptedNoteContent(note.content)) return note;
    const key = keyRef.current;
    if (!key) return lockedNote(note);
    const content = await decryptNoteContent(key, note.content);
    return {
      ...note,
      content,
      title: deriveNoteTitle(content, fallbackTitle),
      encryption: "unlocked",
    };
  }

  /** Decrypts what the current key opens; any other encrypted note stays locked. */
  async function openNotes(notes: Note[]): Promise<Note[]> {
    revokeImageUrls();
    if (
      keyRef.current ||
      notes.some((note) => isEncryptedNoteContent(note.content))
    ) {
      try {
        await loadWrappedKey();
      } catch {
        setKey(null);
        notifyError(t("errors.noteKey"));
      }
    }
    let failed = false;
    const openedNotes = await Promise.all(
      notes.map((note) =>
        openNote(note).catch(() => {
          failed = true;
          return lockedNote(note);
        }),
      ),
    );
    if (failed) notifyError(t("errors.decryptNotes"));
    return openedNotes;
  }

  async function revealLockedNotes() {
    if (
      !autosave.getCurrentNotes().some((note) => note.encryption === "locked")
    )
      return;
    const currentGeneration = generation.current;
    const storedNotes = await listNotes();
    const openedNotes = new Map<string, Note>();
    let failed = false;
    for (const note of storedNotes) {
      if (!isEncryptedNoteContent(note.content)) continue;
      try {
        openedNotes.set(note.id, await openNote(note));
      } catch {
        failed = true;
      }
    }
    if (generation.current !== currentGeneration || !keyRef.current) return;
    if (failed) notifyError(t("errors.decryptNotes"));
    const selectedId = getSelectedId();
    const wasSelectedLocked =
      autosave.getCurrentNotes().find((note) => note.id === selectedId)
        ?.encryption === "locked";
    autosave.updateNotes((notes) =>
      notes.map((note) => {
        const openedNote = openedNotes.get(note.id);
        return note.encryption === "locked" &&
          openedNote?.encryption === "unlocked"
          ? {
              ...note,
              content: openedNote.content,
              title: openedNote.title,
              encryption: "unlocked",
            }
          : note;
      }),
    );
    const selectedNote = autosave
      .getCurrentNotes()
      .find((note) => note.id === selectedId);
    if (wasSelectedLocked && selectedNote?.encryption === "unlocked") {
      autosave.setCurrentContent(selectedNote.content);
    }
  }

  async function createPassphrase(passphrase: string) {
    const { key, wrappedKey } = await createNoteKey(passphrase);
    const storedKey = await storeNoteEncryptionKey(wrappedKey);
    wrappedKeyRef.current = storedKey;
    if (storedKey !== wrappedKey) {
      setKey(null);
      throw new Error("The vault already has a note key");
    }
    setKey(key);
  }

  async function unlock(passphrase: string) {
    const wrappedKey = wrappedKeyRef.current ?? (await loadWrappedKey());
    if (!wrappedKey) throw new Error("No note key");
    setKey(await unlockNoteKey(wrappedKey, passphrase));
    await revealLockedNotes().catch(() =>
      notifyError(t("errors.decryptNotes")),
    );
  }

  async function changePassphrase(currentPassphrase: string, next: string) {
    const previous = await loadWrappedKey();
    if (!previous) throw new Error("No note key");
    const rewrapped = await rewrapNoteKey(previous, currentPassphrase, next);
    await replaceNoteEncryptionKey(previous, rewrapped);
    wrappedKeyRef.current = rewrapped;
  }

  // shortcut: an image upload still running in the editor can write an orphan .enc file after the reset; drain uploads first if it is reported.
  // shortcut: after a partial failure the status reads "none" until Settings reopens, although another vault kept the key; re-resolve it if it is reported.
  async function resetPassphrase() {
    await conversionRef.current;
    // Reloading the vault drops pending saves.
    await autosave.flushPendingNotes();
    const wrappedKey = await loadWrappedKey();
    try {
      if (wrappedKey) await resetNoteEncryptionKey(wrappedKey);
    } finally {
      wrappedKeyRef.current = null;
      setKey(null);
      await reloadNotes();
    }
  }

  async function lock() {
    if (!keyRef.current || busyRef.current) return;
    try {
      // Edits typed before locking must reach the disk encrypted, never be dropped.
      await autosave.flushPendingNotes();
    } catch {
      autosave.markError();
      autosave.notifySaveError();
      return;
    }
    if (busyRef.current) return;
    setKey(null);
    autosave.updateNotes((notes) =>
      notes.map((note) =>
        note.encryption === "unlocked" ? lockedNote(note) : note,
      ),
    );
    const selectedId = getSelectedId();
    if (
      autosave.getCurrentNotes().find((note) => note.id === selectedId)
        ?.encryption
    ) {
      autosave.setCurrentContent("");
    }
  }

  async function storeKeyInVault() {
    const wrappedKey = wrappedKeyRef.current;
    if (
      !wrappedKey ||
      (await storeNoteEncryptionKey(wrappedKey)) !== wrappedKey
    )
      throw new Error("The vault has another note key");
  }

  async function withBusyNote(
    noteId: string,
    errorKey: TranslationKey,
    operation: (
      key: CryptoKey,
      note: Note,
      assertCurrent: () => void,
    ) => Promise<Note | null>,
  ) {
    const key = keyRef.current;
    if (!key || busyRef.current) return;
    busyRef.current = true;
    setBusyNoteId(noteId);
    const currentGeneration = generation.current;
    // The images and the note belong to the active vault: stop if it changes.
    const assertCurrent = () => {
      if (generation.current !== currentGeneration)
        throw new Error("The vault changed");
    };
    const conversion = (async () => {
      try {
        await autosave.flushPendingNote(noteId);
        const note = autosave.getCurrentNotes().find(({ id }) => id === noteId);
        const savedNote = note
          ? await operation(key, note, assertCurrent)
          : null;
        if (!savedNote || generation.current !== currentGeneration) return;
        autosave.updateNotes((notes) =>
          sortNotes(
            notes.map((current) =>
              current.id === savedNote.id
                ? {
                    ...current,
                    title: savedNote.title,
                    content: savedNote.content,
                    encryption: savedNote.encryption,
                    updatedAt: savedNote.updatedAt,
                  }
                : current,
            ),
            "updated-desc",
            locale,
          ),
        );
        autosave.recordSavedAt(savedNote.updatedAt);
        if (getSelectedId() === savedNote.id) {
          autosave.setCurrentContent(savedNote.content);
        }
      } catch {
        if (generation.current === currentGeneration) notifyError(t(errorKey));
      }
    })();
    conversionRef.current = conversion;
    try {
      await conversion;
    } finally {
      busyRef.current = false;
      conversionRef.current = null;
      setBusyNoteId(null);
    }
  }

  async function deleteUnusedImages(names: string[], savedNote: Note) {
    const notes = autosave.getCurrentNotes();
    // shortcut: only the active vault's notes are checked; an image link pasted into another vault breaks once its file is deleted. Scan every vault if reported.
    const used = new Set(
      notes.flatMap(({ id, content }) => {
        const text = id === savedNote.id ? savedNote.content : content;
        return [
          ...attachmentImageUrls(text).map(attachmentImageName),
          ...encryptedImageUrls(text).map(encryptedImageName),
        ];
      }),
    );
    const unused = names.filter((name) => !used.has(name));
    if (unused.length === 0) return;
    // A locked note's content is unknown: it may still show these images.
    const results = notes.some((note) => note.encryption === "locked")
      ? null
      : await Promise.allSettled(unused.map(deleteAttachmentImage));
    if (!results || results.some(({ status }) => status === "rejected")) {
      notifyError(t("errors.deleteNoteImages"));
    }
  }

  function encryptNote(noteId: string) {
    return withBusyNote(
      noteId,
      "errors.encryptNote",
      async (key, note, assertCurrent) => {
        if (note.encryption) return null;
        await storeKeyInVault();
        const replacements = new Map<string, string>();
        const clearNames: string[] = [];
        const encryptedNames: string[] = [];
        let skipped = false;
        let savedNote: Note;
        try {
          for (const url of attachmentImageUrls(note.content)) {
            const name = attachmentImageName(url) ?? "";
            const mimeType = imageMimeType(name);
            assertCurrent();
            const bytes = mimeType
              ? await readAttachmentImage(name).catch(() => null)
              : null;
            if (!bytes || !mimeType) {
              skipped = true;
              continue;
            }
            const encryptedName = `${crypto.randomUUID()}.enc`;
            const sealed = await encryptImage(key, bytes, mimeType);
            assertCurrent();
            await saveEncryptedAttachment(encryptedName, bytesToBase64(sealed));
            encryptedNames.push(encryptedName);
            clearNames.push(name);
            replacements.set(url, encryptedImageUrl(encryptedName));
          }
          assertCurrent();
          const content = replaceUrls(note.content, replacements);
          savedNote = await updateNote(
            note.id,
            deriveNoteTitle(content, fallbackTitle),
            content,
            key,
          );
        } catch (error) {
          await Promise.allSettled(encryptedNames.map(deleteAttachmentImage));
          throw error;
        }
        if (skipped) notifyError(t("errors.noteImagesSkipped"));
        assertCurrent();
        await deleteUnusedImages(clearNames, savedNote);
        assertCurrent();
        // Older plaintext versions of the note may linger in SQLite free pages.
        await compactVaultDatabase().catch(() =>
          notifyError(t("errors.compactVault")),
        );
        return savedNote;
      },
    );
  }

  function decryptNote(noteId: string) {
    return withBusyNote(
      noteId,
      "errors.decryptNote",
      async (key, note, assertCurrent) => {
        if (note.encryption !== "unlocked") return null;
        const replacements = new Map<string, string>();
        const clearNames: string[] = [];
        const encryptedNames: string[] = [];
        let skipped = false;
        let savedNote: Note;
        try {
          for (const url of encryptedImageUrls(note.content)) {
            const name = encryptedImageName(url) ?? "";
            assertCurrent();
            const sealed = await readAttachmentImage(name).catch(() => null);
            if (!sealed) {
              skipped = true;
              continue;
            }
            const { bytes, mimeType } = await decryptImage(key, sealed);
            assertCurrent();
            const clearUrl = await saveAttachmentImage(
              bytesToBase64(bytes),
              mimeType,
              note.id,
              "image",
            );
            clearNames.push(attachmentImageName(clearUrl) ?? "");
            encryptedNames.push(name);
            replacements.set(url, clearUrl);
          }
          assertCurrent();
          const content = replaceUrls(note.content, replacements);
          savedNote = await updateNote(
            note.id,
            deriveNoteTitle(content, fallbackTitle),
            content,
          );
        } catch (error) {
          await Promise.allSettled(
            clearNames.filter(Boolean).map(deleteAttachmentImage),
          );
          throw error;
        }
        if (skipped) notifyError(t("errors.noteImagesSkipped"));
        assertCurrent();
        await deleteUnusedImages(encryptedNames, savedNote);
        return savedNote;
      },
    );
  }

  return {
    busyNoteId,
    changePassphrase,
    createPassphrase,
    decryptNote,
    encryptNote,
    getKey: () => keyRef.current,
    keyStatus,
    lock,
    openNotes,
    pendingConversion: () => conversionRef.current,
    resetPassphrase,
    resolveImageUrl,
    resolveKeyStatus,
    unlock,
  };
}
