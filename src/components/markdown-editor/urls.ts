import { decodeString } from "micromark-util-decode-string";
import { encryptedImageName } from "../../domain/noteEncryption";

export function safeLinkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function safeImageUrl(value: string): string | null {
  if (
    encryptedImageName(value) ||
    /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\r\n]+$/iu.test(
      value,
    )
  )
    return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "asset:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function markdownDestination(value: string): string {
  return decodeString(value.replace(/^<([\s\S]*)>$/u, "$1"));
}
