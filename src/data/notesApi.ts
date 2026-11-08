import { invoke } from "@tauri-apps/api/core";
import { defaultNoteTypeId, type NoteTypeId } from "../domain/noteTypes";
import type { Note } from "../domain/notes";
import { normalizeLegacyMarkdown } from "../domain/markdown";
import { encryptNoteContent } from "../domain/noteEncryption";

function normalizeNote(note: Note): Note {
  const content = normalizeLegacyMarkdown(note.content);
  return content === note.content ? note : { ...note, content };
}

export async function listNotes(): Promise<Note[]> {
  return (await invoke<Note[]>("list_notes")).map(normalizeNote);
}

export async function createNote(
  kind: NoteTypeId = defaultNoteTypeId,
): Promise<Note> {
  return invoke<Note>("create_note", { id: crypto.randomUUID(), kind }).then(
    normalizeNote,
  );
}

/** With a key, only the content is stored encrypted; the title stays readable, like Apple Notes. */
export async function updateNote(
  id: string,
  title: string,
  content: string,
  key?: CryptoKey,
): Promise<Note> {
  const normalizedContent = normalizeLegacyMarkdown(content);
  if (!key) {
    return invoke<Note>("update_note", {
      id,
      title,
      content: normalizedContent,
    }).then(normalizeNote);
  }
  const savedNote = await invoke<Note>("update_note", {
    id,
    title,
    content: await encryptNoteContent(key, normalizedContent),
  });
  return {
    ...savedNote,
    title,
    content: normalizedContent,
    encryption: "unlocked",
  };
}

export async function updateNoteKind(
  id: string,
  kind: NoteTypeId,
): Promise<Note> {
  return invoke<Note>("update_note_kind", { id, kind }).then(normalizeNote);
}

export async function updateNoteArchived(
  id: string,
  archived: boolean,
): Promise<Note> {
  return invoke<Note>("update_note_archived", { id, archived }).then(
    normalizeNote,
  );
}

export async function updateNotePinned(
  id: string,
  pinned: boolean,
): Promise<Note> {
  return invoke<Note>("update_note_pinned", { id, pinned }).then(normalizeNote);
}

export async function updateNoteFavorite(
  id: string,
  favorite: boolean,
): Promise<Note> {
  return invoke<Note>("update_note_favorite", { id, favorite }).then(
    normalizeNote,
  );
}

export async function deleteNote(id: string): Promise<void> {
  return invoke("delete_note", { id });
}
