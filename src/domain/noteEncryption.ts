import { assetFileName } from "./assetUrl";
import { base64ToBytes, bytesToBase64 } from "./base64";

const CONTENT_PREFIX = "soreno-enc:v1:";
const ENCRYPTED_CONTENT = /^soreno-enc:v1:[A-Za-z0-9+/]+={0,2}$/;
const ENCRYPTED_IMAGE_PREFIX = "soreno-encrypted:";
const ENCRYPTED_IMAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc$/;
const ENCRYPTED_IMAGE_URLS =
  /soreno-encrypted:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc/g;
// convertFileSrc leaves ' ( ) ! * unescaped, so match up to the sanitized stored file name without crossing another asset URL.
// shortcut: a URL hand-edited with a ?query or #fragment is not recognized (neither converted nor counted as a reference); parse the pathname if users do this.
const ASSET_URLS =
  /(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(?:(?!asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)[^\s"<>])*?attachments(?:%2F|%5C)images(?:%2F|%5C)[A-Za-z0-9._-]+(?=[\s"'<>)]|$)/gi;
const ASSET_URL = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.+)$/;
const ATTACHMENT_PATH = /(?:^|\/)attachments\/images\/([^/]+)$/;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_GCM = { name: "AES-GCM", length: 256 } as const;
const imageMimeTypes: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type WrappedNoteKey = {
  version: 1;
  salt: string;
  iterations: number;
  iv: string;
  key: string;
};

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

export function isEncryptedNoteContent(content: string): boolean {
  return ENCRYPTED_CONTENT.test(content);
}

/** A random note key, plus its copy wrapped by the passphrase for storage. */
export async function createNoteKey(
  passphrase: string,
): Promise<{ key: CryptoKey; wrappedKey: string }> {
  const extractable = await crypto.subtle.generateKey(AES_GCM, true, [
    "encrypt",
    "decrypt",
  ]);
  const wrappedKey = await wrapNoteKey(extractable, passphrase);
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.exportKey("raw", extractable),
    AES_GCM,
    false,
    ["encrypt", "decrypt"],
  );
  return { key, wrappedKey };
}

export function unlockNoteKey(
  wrappedKey: string,
  passphrase: string,
): Promise<CryptoKey> {
  return unwrapNoteKey(wrappedKey, passphrase, false);
}

/** Rewraps the same note key: existing notes stay readable without re-encryption. */
export async function rewrapNoteKey(
  wrappedKey: string,
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<string> {
  return wrapNoteKey(
    await unwrapNoteKey(wrappedKey, currentPassphrase, true),
    nextPassphrase,
  );
}

export async function encryptNoteContent(
  key: CryptoKey,
  content: string,
): Promise<string> {
  return (
    CONTENT_PREFIX +
    bytesToBase64(await seal(key, new TextEncoder().encode(content)))
  );
}

export async function decryptNoteContent(
  key: CryptoKey,
  content: string,
): Promise<string> {
  if (!isEncryptedNoteContent(content)) throw new Error("Not encrypted");
  return new TextDecoder().decode(
    await open(key, base64ToBytes(content.slice(CONTENT_PREFIX.length))),
  );
}

export async function encryptImage(
  key: CryptoKey,
  bytes: Uint8Array,
  mimeType: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const mime = new TextEncoder().encode(mimeType);
  if (mime.length > 255) throw new Error("Invalid image type");
  const payload = new Uint8Array(1 + mime.length + bytes.length);
  payload[0] = mime.length;
  payload.set(mime, 1);
  payload.set(bytes, 1 + mime.length);
  return seal(key, payload);
}

export async function decryptImage(
  key: CryptoKey,
  sealed: Uint8Array,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> {
  const payload = await open(key, sealed);
  const mimeEnd = 1 + payload[0];
  return {
    bytes: payload.slice(mimeEnd),
    mimeType: new TextDecoder().decode(payload.subarray(1, mimeEnd)),
  };
}

export function encryptedImageUrl(name: string): string {
  return ENCRYPTED_IMAGE_PREFIX + name;
}

export function encryptedImageName(url: string): string | null {
  const name = url.startsWith(ENCRYPTED_IMAGE_PREFIX)
    ? url.slice(ENCRYPTED_IMAGE_PREFIX.length)
    : "";
  return ENCRYPTED_IMAGE_NAME.test(name) ? name : null;
}

export function encryptedImageUrls(content: string): string[] {
  return [...new Set(content.match(ENCRYPTED_IMAGE_URLS) ?? [])];
}

/** File name of a note image from its `convertFileSrc` URL, or null for any other URL. */
export function attachmentImageName(url: string): string | null {
  return assetFileName(url, ASSET_URL, ATTACHMENT_PATH);
}

export function attachmentImageUrls(content: string): string[] {
  return [...new Set(content.match(ASSET_URLS) ?? [])].filter(
    (url) => attachmentImageName(url) !== null,
  );
}

export function imageMimeType(name: string): string | null {
  return imageMimeTypes[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export function replaceUrls(
  content: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let next = content;
  for (const [from, to] of replacements) next = next.split(from).join(to);
  return next;
}

async function wrapNoteKey(key: CryptoKey, passphrase: string) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const wrapping = await deriveWrappingKey(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapped = await crypto.subtle.wrapKey("raw", key, wrapping, {
    name: "AES-GCM",
    iv,
  });
  return JSON.stringify({
    version: 1,
    salt: bytesToBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    iv: bytesToBase64(iv),
    key: bytesToBase64(new Uint8Array(wrapped)),
  } satisfies WrappedNoteKey);
}

async function unwrapNoteKey(
  wrappedKey: string,
  passphrase: string,
  extractable: boolean,
): Promise<CryptoKey> {
  const stored = JSON.parse(wrappedKey) as WrappedNoteKey;
  if (
    stored.version !== 1 ||
    !Number.isInteger(stored.iterations) ||
    stored.iterations < 1
  ) {
    throw new Error("Unsupported note key");
  }
  const wrapping = await deriveWrappingKey(
    passphrase,
    base64ToBytes(stored.salt),
    stored.iterations,
  );
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      base64ToBytes(stored.key),
      wrapping,
      { name: "AES-GCM", iv: base64ToBytes(stored.iv) },
      AES_GCM,
      extractable,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    AES_GCM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.length);
  sealed.set(iv);
  sealed.set(ciphertext, IV_BYTES);
  return sealed;
}

async function open(
  key: CryptoKey,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, IV_BYTES) },
      key,
      sealed.slice(IV_BYTES),
    ),
  );
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}
