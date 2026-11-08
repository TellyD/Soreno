import { describe, expect, it } from "vitest";
import {
  CHUNK_LIMIT,
  ChunkError,
  MESSAGE_LIMIT,
  PHONE_FRAME_LIMIT,
  Reassembly,
  TAG_LENGTH,
  chunks,
  decodeKey,
  encodeKey,
} from "./protocol";

describe("mobile protocol", () => {
  it("encodes keys like the Rust crate, in unpadded base64url", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => 250 - index);
    const text = encodeKey(key);
    expect(text).toHaveLength(43);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKey(text)).toEqual(key);
    expect(encodeKey(new Uint8Array(32).fill(0xff))).toBe(`${"_".repeat(42)}8`);
    expect(decodeKey(`${"_".repeat(42)}9`)).toBeNull();
    expect(decodeKey("short")).toBeNull();
    expect(decodeKey(`${"A".repeat(42)}+`)).toBeNull();
  });

  it("cuts messages into flagged chunks that fit a phone frame", () => {
    expect(chunks(new Uint8Array())).toEqual([Uint8Array.of(0)]);
    const message = Uint8Array.from(
      { length: 2 * CHUNK_LIMIT + 5 },
      (_, index) => index % 251,
    );
    const parts = chunks(message);
    expect(parts.map((part) => [part[0], part.length])).toEqual([
      [1, CHUNK_LIMIT + 1],
      [1, CHUNK_LIMIT + 1],
      [0, 6],
    ]);
    expect(CHUNK_LIMIT + 1 + TAG_LENGTH).toBe(PHONE_FRAME_LIMIT);
    expect(chunks(new Uint8Array(CHUNK_LIMIT)).map((part) => part[0])).toEqual([
      0,
    ]);

    const reassembly = new Reassembly();
    expect(reassembly.push(parts[0])).toBeNull();
    expect(reassembly.push(parts[1])).toBeNull();
    const whole = reassembly.push(parts[2]);
    expect(whole && Buffer.compare(whole, message)).toBe(0);
    expect(reassembly.push(Uint8Array.of(0, 7))).toEqual(Uint8Array.of(7));
  });

  it("refuses malformed chunks and oversized messages", () => {
    const reassembly = new Reassembly();
    expect(() => reassembly.push(new Uint8Array())).toThrow(ChunkError);
    expect(() => reassembly.push(Uint8Array.of(2))).toThrow(ChunkError);
    expect(() => reassembly.push(new Uint8Array(CHUNK_LIMIT + 2))).toThrow(
      ChunkError,
    );
    const more = new Uint8Array(CHUNK_LIMIT + 1);
    more[0] = 1;
    let error: unknown = null;
    try {
      for (let total = 0; total <= MESSAGE_LIMIT; total += CHUNK_LIMIT)
        reassembly.push(more);
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(new ChunkError("tooLong"));
  });

  it("bounds a message of empty continuations by its chunk count", () => {
    const reassembly = new Reassembly();
    const largest = chunks(new Uint8Array(MESSAGE_LIMIT));
    const pieces = largest.map((part) => reassembly.push(part));
    const whole = pieces[pieces.length - 1];
    expect(whole).toHaveLength(MESSAGE_LIMIT);

    let pushed = 0;
    expect(() => {
      for (; pushed <= largest.length; pushed++)
        reassembly.push(Uint8Array.of(1));
    }).toThrow(new ChunkError("tooLong"));
    expect(pushed).toBe(largest.length);
  });
});
