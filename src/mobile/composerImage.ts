import { constrainedImageDimensions } from "@/domain/imageSize";

/** What the server saves, as for an image pasted in Soreno desktop. */
const IMAGE_LIMIT = 4 * 1024 * 1024;
const SAVED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// Largest first: a screenshot keeps its text legible as long as it fits.
const DIMENSIONS = [4096, 2560, 1920];
const QUALITY = 0.85;

export type ComposerImage = { mimeType: string; data: string };

export class ComposerImageError extends Error {
  constructor(readonly reason: "unsupported" | "tooLarge") {
    super(reason);
  }
}

/** The file as sent to the server: kept when it can be saved as is, re-encoded smaller otherwise. */
export async function composerImage(file: File): Promise<ComposerImage> {
  const blob =
    SAVED_TYPES.includes(file.type) && file.size <= IMAGE_LIMIT
      ? file
      : await reencoded(file);
  return { mimeType: blob.type, data: await base64(blob) };
}

async function reencoded(file: File): Promise<Blob> {
  const image = await decoded(file);
  for (const largest of DIMENSIONS) {
    const { width, height } = constrainedImageDimensions(
      { width: image.naturalWidth, height: image.naturalHeight },
      largest,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new ComposerImageError("unsupported");
    // JPEG has no transparency.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await encoded(canvas);
    if (blob.size <= IMAGE_LIMIT) return blob;
  }
  throw new ComposerImageError("tooLarge");
}

function decoded(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ComposerImageError("unsupported"));
    };
    image.src = url;
  });
}

/** WebP, or JPEG where the browser only encodes WebP as PNG (Safari). */
async function encoded(canvas: HTMLCanvasElement) {
  const webp = await canvasBlob(canvas, "image/webp");
  return webp.type === "image/webp" ? webp : canvasBlob(canvas, "image/jpeg");
}

function canvasBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new ComposerImageError("unsupported")),
      type,
      QUALITY,
    ),
  );
}

function base64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unreadable file"));
    reader.readAsDataURL(blob);
  });
}
