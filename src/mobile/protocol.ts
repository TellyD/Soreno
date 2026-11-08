import { base64ToBytes, bytesToBase64 } from "@/domain/base64";

// Mirrors `src-tauri/crates/soreno-mobile-protocol`, which defines the protocol.
export type Bytes = Uint8Array<ArrayBuffer>;

export const NOISE = "Noise_IK_25519_AESGCM_SHA256";
/** Phone ↔ server, end to end. */
export const PHONE_PROLOGUE: Bytes = new TextEncoder().encode(
  "soreno-mobile/1",
);
export const KEY_LENGTH = 32;
export const TAG_LENGTH = 16;
/** Application bytes per end-to-end chunk. */
export const CHUNK_LIMIT = 63 * 1024;
/** A whole application message once reassembled. */
export const MESSAGE_LIMIT = 8 << 20;
/** The largest phone Noise message the relay forwards. */
export const PHONE_FRAME_LIMIT = 1 + CHUNK_LIMIT + TAG_LENGTH;

const MORE = 1;
const LAST = 0;
const ENCODED_KEY = /^[A-Za-z0-9_-]{43}$/;
/** Chunks of the longest message; empty continuations would otherwise pile up. */
const MAX_PIECES = Math.floor(MESSAGE_LIMIT / CHUNK_LIMIT) + 1;

export function encodeKey(key: Uint8Array) {
  return bytesToBase64(key)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeKey(text: string): Bytes | null {
  if (!ENCODED_KEY.test(text)) return null;
  const key = base64ToBytes(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  // Unused trailing bits must be zero, as the Rust decoder requires.
  return encodeKey(key) === text ? key : null;
}

/** One application message as the plaintexts of successive transport messages. */
export function chunks(message: Uint8Array): Bytes[] {
  const parts: Bytes[] = [];
  let start = 0;
  do {
    const part = message.subarray(start, start + CHUNK_LIMIT);
    start += CHUNK_LIMIT;
    const chunk = new Uint8Array(part.length + 1);
    chunk[0] = start >= message.length ? LAST : MORE;
    chunk.set(part, 1);
    parts.push(chunk);
  } while (start < message.length);
  return parts;
}

export class ChunkError extends Error {
  constructor(readonly kind: "malformed" | "tooLong") {
    super(kind);
  }
}

/** Gathers chunks back into application messages. */
export class Reassembly {
  private pending: Uint8Array[] = [];
  private length = 0;
  private pieces = 0;

  push(chunk: Uint8Array): Bytes | null {
    if (chunk.length === 0) throw new ChunkError("malformed");
    const flag = chunk[0];
    const part = chunk.subarray(1);
    if (part.length > CHUNK_LIMIT || flag > MORE)
      throw new ChunkError("malformed");
    if (this.length + part.length > MESSAGE_LIMIT || this.pieces >= MAX_PIECES)
      throw new ChunkError("tooLong");
    if (part.length > 0) this.pending.push(part);
    this.pieces += 1;
    this.length += part.length;
    if (flag !== LAST) return null;
    const message = new Uint8Array(this.length);
    let offset = 0;
    for (const piece of this.pending) {
      message.set(piece, offset);
      offset += piece.length;
    }
    this.pending = [];
    this.pieces = 0;
    this.length = 0;
    return message;
  }
}
