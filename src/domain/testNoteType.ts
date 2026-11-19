import type { NoteType } from "./noteTypes";

export function noteType(id: string, name: string, sortOrder = 0): NoteType {
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
