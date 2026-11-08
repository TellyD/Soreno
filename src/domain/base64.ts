// Spread in chunks: one argument per byte overflows the call stack on large images.
const BINARY_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + BINARY_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
