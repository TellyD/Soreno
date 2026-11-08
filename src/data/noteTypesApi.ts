import { invoke } from "@tauri-apps/api/core";
import type { NoteType, NoteTypeId } from "../domain/noteTypes";

export async function listNoteTypes(): Promise<NoteType[]> {
  return invoke<NoteType[]>("list_note_types");
}

export async function createNoteType(
  name: string,
  icon: string,
  color: string,
): Promise<NoteType> {
  return invoke<NoteType>("create_note_type", {
    color,
    icon,
    id: crypto.randomUUID(),
    name,
  });
}

export async function updateNoteType(
  id: string,
  name: string,
  icon: string,
  color: string,
): Promise<NoteType> {
  return invoke<NoteType>("update_note_type", {
    color,
    icon,
    id,
    name,
  });
}

export async function reorderNoteTypes(ids: NoteTypeId[]): Promise<NoteType[]> {
  return invoke<NoteType[]>("reorder_note_types", { ids });
}

export async function deleteNoteType(id: string): Promise<void> {
  return invoke("delete_note_type", { id });
}
