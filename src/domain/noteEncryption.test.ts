import { describe, expect, it } from "vitest";
import {
  attachmentImageName,
  attachmentImageUrls,
  createNoteKey,
  decryptImage,
  decryptNoteContent,
  encryptImage,
  encryptNoteContent,
  isEncryptedNoteContent,
  rewrapNoteKey,
  unlockNoteKey,
  WrongPassphraseError,
} from "./noteEncryption";

describe("note key", () => {
  it("only the right passphrase unlocks notes, also after a passphrase change", async () => {
    const { key, wrappedKey } = await createNoteKey("first secret");
    const sealed = await encryptNoteContent(key, "# Journal\n\nTexte privé é");

    await expect(unlockNoteKey(wrappedKey, "wrong")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    const rewrapped = await rewrapNoteKey(
      wrappedKey,
      "first secret",
      "second secret",
    );
    await expect(unlockNoteKey(rewrapped, "first secret")).rejects.toThrow(
      WrongPassphraseError,
    );
    const unlocked = await unlockNoteKey(rewrapped, "second secret");
    expect(await decryptNoteContent(unlocked, sealed)).toBe(
      "# Journal\n\nTexte privé é",
    );
    await expect(
      rewrapNoteKey(wrappedKey, "wrong", "third"),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 30_000);
});

describe("encrypted content", () => {
  it("hides the text, never reuses a nonce and rejects tampering", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const first = await encryptNoteContent(key, "secret");
    const second = await encryptNoteContent(key, "secret");

    expect(isEncryptedNoteContent(first)).toBe(true);
    expect(first).not.toContain("secret");
    expect(first).not.toBe(second);
    const tampered =
      first.slice(0, -4) + (first.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptNoteContent(key, tampered)).rejects.toThrow();
    expect(isEncryptedNoteContent("soreno-enc:v1: un texte tapé")).toBe(false);
    expect(isEncryptedNoteContent("")).toBe(false);
  });

  it("restores image bytes and their type", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 255]);
    const sealed = await encryptImage(key, bytes, "image/webp");

    expect(await decryptImage(key, sealed)).toEqual({
      bytes,
      mimeType: "image/webp",
    });
  });
});

describe("attachment images", () => {
  const unix = `asset://localhost/${encodeURIComponent("/home/me/.local/share/soreno/vaults/v/attachments/images/a-b.webp")}`;
  const windows = `http://asset.localhost/${encodeURIComponent("C:\\Users\\Me (Work)\\AppData\\Soreno\\vaults\\v\\attachments\\images\\shot.png")}`;
  const apostrophe = `http://asset.localhost/${encodeURIComponent("C:\\Users\\O'Brien\\AppData\\Soreno\\vaults\\v\\attachments\\images\\x.png")}`;
  const unbalanced = `asset://localhost/${encodeURIComponent("/home/me/notes (old/vaults/v/attachments/images/y.png")}`;
  const kanban = `asset://localhost/${encodeURIComponent("/home/me/kanban-images/x.png")}`;

  it("finds stored note images on every platform and ignores other URLs", () => {
    expect(attachmentImageName(unix)).toBe("a-b.webp");
    expect(attachmentImageName(windows)).toBe("shot.png");
    expect(attachmentImageName(kanban)).toBeNull();
    expect(
      attachmentImageName("https://example.com/attachments/images/x.png"),
    ).toBeNull();
    expect(
      attachmentImageUrls(
        `![a](${unix})![b](<${windows}> "t") ![c](${kanban}) ![a](${unix})`,
      ),
    ).toEqual([unix, windows]);
    expect(
      attachmentImageUrls(
        `![k](${kanban})![o](${apostrophe}) ![p](${unbalanced})`,
      ),
    ).toEqual([apostrophe, unbalanced]);
  });
});
