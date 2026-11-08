import { invoke } from "@tauri-apps/api/core";

/** The active vault's wrapped note key, or another vault's when it has none. */
export function getNoteEncryptionKey(): Promise<string | null> {
  return invoke<string | null>("get_note_encryption_key");
}

/** Resolves to the key the vault keeps, which is an older one if it had any. */
export function storeNoteEncryptionKey(wrappedKey: string): Promise<string> {
  return invoke<string>("store_note_encryption_key", { wrappedKey });
}

export function replaceNoteEncryptionKey(
  previous: string,
  next: string,
): Promise<void> {
  return invoke("replace_note_encryption_key", { previous, next });
}

/** Forgets the key in every vault that holds it, with the notes and images it encrypted. */
export function resetNoteEncryptionKey(wrappedKey: string): Promise<void> {
  return invoke("reset_note_encryption_key", { wrappedKey });
}

/** Rewrites the vault database so deleted plaintext no longer lingers in free pages. */
export function compactVaultDatabase(): Promise<void> {
  return invoke("compact_vault_database");
}
