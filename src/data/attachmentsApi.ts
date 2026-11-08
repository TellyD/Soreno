import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type AttachmentImage = {
  filename: string;
  path: string;
};

/** Stores a note image in the active vault and returns its display URL. */
export async function saveAttachmentImage(
  dataBase64: string,
  mimeType: string,
  noteId: string,
  originalFilename: string,
): Promise<string> {
  const savedImage = await invoke<AttachmentImage>("save_attachment_image", {
    dataBase64,
    mimeType,
    noteId,
    originalFilename,
  });
  return convertFileSrc(savedImage.path);
}

export function saveEncryptedAttachment(
  name: string,
  dataBase64: string,
): Promise<void> {
  return invoke("save_encrypted_attachment", { name, dataBase64 });
}

export async function readAttachmentImage(
  name: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await invoke<ArrayBuffer>("read_attachment_image", { name }),
  );
}

export function deleteAttachmentImage(name: string): Promise<void> {
  return invoke("delete_attachment_image", { name });
}
