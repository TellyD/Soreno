import { isTauri } from "@tauri-apps/api/core";
import type { Image } from "@tauri-apps/api/image";
import {
  readImage,
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import { bytesToBase64 } from "../domain/base64";

const MAX_REMOTE_IMAGE_BYTES = 4 * 1024 * 1024;

export type TerminalClipboard =
  | { type: "image"; dataBase64?: string; mimeType?: string }
  | { type: "text"; text: string };

export async function readClipboardText(): Promise<string> {
  if (isTauri()) return readText();
  if (!navigator.clipboard?.readText)
    throw new Error("Clipboard API unavailable");
  return navigator.clipboard.readText();
}

export async function blobBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export async function terminalClipboardImage(
  blob: Blob,
): Promise<TerminalClipboard> {
  if (!blob.type.startsWith("image/") || blob.size > MAX_REMOTE_IMAGE_BYTES)
    throw new Error("Clipboard image unavailable");
  return {
    type: "image",
    dataBase64: await blobBase64(blob),
    mimeType: blob.type,
  };
}

async function nativeClipboardImage(image: Image): Promise<TerminalClipboard> {
  try {
    const [{ width, height }, rgba] = await Promise.all([
      image.size(),
      image.rgba(),
    ]);
    if (!width || !height || rgba.length !== width * height * 4)
      throw new Error("Clipboard image unavailable");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Clipboard image unavailable");
    const pixels = context.createImageData(width, height);
    pixels.data.set(rgba);
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Clipboard image unavailable")),
        "image/webp",
        0.82,
      ),
    );
    return terminalClipboardImage(blob);
  } finally {
    await image.close();
  }
}

export async function readTerminalClipboard(
  includeImageData = false,
): Promise<TerminalClipboard> {
  if (isTauri()) {
    let image;
    try {
      image = await readImage();
    } catch {
      return { type: "text", text: await readClipboardText() };
    }
    if (includeImageData) return nativeClipboardImage(image);
    await image.close();
    return { type: "image" };
  }
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const mimeType = item.types.find((type) => type.startsWith("image/"));
      if (mimeType)
        return includeImageData
          ? terminalClipboardImage(await item.getType(mimeType))
          : { type: "image" };
    }
  }
  return { type: "text", text: await readClipboardText() };
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) return writeText(text);
  if (!navigator.clipboard?.writeText)
    throw new Error("Clipboard API unavailable");
  return navigator.clipboard.writeText(text);
}
