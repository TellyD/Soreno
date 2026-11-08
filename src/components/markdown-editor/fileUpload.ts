import { isTauri } from "@tauri-apps/api/core";
import {
  saveAttachmentImage,
  saveEncryptedAttachment,
} from "../../data/attachmentsApi";
import { blobBase64 } from "../../data/clipboard";
import { bytesToBase64 } from "../../domain/base64";
import { constrainedImageDimensions } from "../../domain/imageSize";
import { encryptedImageUrl, encryptImage } from "../../domain/noteEncryption";

const DEFAULT_MIME_TYPE = "application/octet-stream";
const WEBP_MIME_TYPE = "image/webp";
const GIF_MIME_TYPE = "image/gif";

export const MAX_IMAGE_DIMENSION = 1920;
const WEBP_QUALITY = 0.82;
export const MAX_SOURCE_IMAGE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_STORED_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

export type ImageUploadErrorCode =
  | "canvas-unavailable"
  | "encoding-failed"
  | "source-too-large"
  | "stored-too-large"
  | "unsupported-type";

export class ImageUploadError extends Error {
  constructor(
    public readonly code: ImageUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageUploadError";
  }
}

type PreparedAttachmentImage = {
  blob: Blob;
  mimeType: string;
  originalFilename: string;
};

type ImageOptimizer = (file: File) => Promise<Blob>;

export async function fileToDataUrl(file: File): Promise<string> {
  const base64 = await blobBase64(file);
  const mimeType = file.type || DEFAULT_MIME_TYPE;

  return `data:${mimeType};base64,${base64}`;
}

export async function prepareImageForUpload(
  file: File,
  optimizer: ImageOptimizer = optimizeImageWithCanvas,
): Promise<PreparedAttachmentImage> {
  validateSourceImage(file);

  if (file.type === GIF_MIME_TYPE) {
    validateStoredImageSize(file.size);

    return {
      blob: file,
      mimeType: GIF_MIME_TYPE,
      originalFilename: file.name,
    };
  }

  const optimizedBlob = await optimizer(file);
  validateOptimizedImage(optimizedBlob);
  validateStoredImageSize(optimizedBlob.size);

  return {
    blob: optimizedBlob,
    mimeType: WEBP_MIME_TYPE,
    originalFilename: file.name,
  };
}

export async function uploadAttachmentImage(
  file: File,
  noteId: string,
): Promise<string> {
  if (!isTauri()) {
    validateSourceImage(file);
    return fileToDataUrl(file);
  }

  const preparedImage = await prepareImageForUpload(file);
  return saveAttachmentImage(
    await blobBase64(preparedImage.blob),
    preparedImage.mimeType,
    noteId,
    preparedImage.originalFilename,
  );
}

/** Stores the image encrypted under a random name, which reveals nothing of the original. */
export async function uploadEncryptedAttachmentImage(
  file: File,
  key: CryptoKey,
): Promise<string> {
  const preparedImage = await prepareImageForUpload(file);
  const name = `${crypto.randomUUID()}.enc`;
  const sealed = await encryptImage(
    key,
    new Uint8Array(await preparedImage.blob.arrayBuffer()),
    preparedImage.mimeType,
  );
  await saveEncryptedAttachment(name, bytesToBase64(sealed));
  return encryptedImageUrl(name);
}

function validateSourceImage(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new ImageUploadError(
      "unsupported-type",
      "Only images can be pasted into notes.",
    );
  }

  if (file.size > MAX_SOURCE_IMAGE_SIZE_BYTES) {
    throw new ImageUploadError(
      "source-too-large",
      "The source image is too large.",
    );
  }
}

function validateStoredImageSize(size: number) {
  if (size > MAX_STORED_IMAGE_SIZE_BYTES) {
    throw new ImageUploadError(
      "stored-too-large",
      "The optimized image is too large.",
    );
  }
}

function validateOptimizedImage(blob: Blob) {
  if (blob.type !== WEBP_MIME_TYPE) {
    throw new ImageUploadError(
      "encoding-failed",
      "The image could not be encoded as WebP.",
    );
  }
}

async function optimizeImageWithCanvas(file: File): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new ImageUploadError(
      "canvas-unavailable",
      "Image optimization is not available in this environment.",
    );
  }

  const image = await loadImage(file);
  const dimensions = constrainedImageDimensions(
    {
      height: image.naturalHeight,
      width: image.naturalWidth,
    },
    MAX_IMAGE_DIMENSION,
  );
  const canvas = document.createElement("canvas");
  canvas.height = dimensions.height;
  canvas.width = dimensions.width;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new ImageUploadError(
      "canvas-unavailable",
      "Image optimization is not available in this environment.",
    );
  }

  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);

  return canvasToBlob(canvas, WEBP_MIME_TYPE, WEBP_QUALITY);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(
        new ImageUploadError(
          "encoding-failed",
          "The image could not be decoded.",
        ),
      );
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(
            new ImageUploadError(
              "encoding-failed",
              "The image could not be encoded.",
            ),
          );
          return;
        }

        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}
