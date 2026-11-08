import { describe, expect, it, vi } from "vitest";
import { constrainedImageDimensions } from "../../domain/imageSize";
import {
  fileToDataUrl,
  MAX_IMAGE_DIMENSION,
  MAX_SOURCE_IMAGE_SIZE_BYTES,
  prepareImageForUpload,
  uploadAttachmentImage,
} from "./fileUpload";

function imageFile(parts: BlobPart[], name: string, type: string): File {
  return new File(parts, name, { type });
}

describe("constrainedImageDimensions", () => {
  it("redimensionne une image plus grande que 1920 px", () => {
    expect(
      constrainedImageDimensions(
        { height: 3000, width: 4000 },
        MAX_IMAGE_DIMENSION,
      ),
    ).toEqual({
      height: 1440,
      width: MAX_IMAGE_DIMENSION,
    });
  });

  it("ne redimensionne pas une image plus petite", () => {
    expect(
      constrainedImageDimensions(
        { height: 900, width: 1200 },
        MAX_IMAGE_DIMENSION,
      ),
    ).toEqual({
      height: 900,
      width: 1200,
    });
  });
});

describe("prepareImageForUpload", () => {
  it("convertit les images raster en WebP via l'optimizer", async () => {
    const optimizer = vi
      .fn()
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    await expect(
      prepareImageForUpload(
        imageFile(["png"], "Capture 01.png", "image/png"),
        optimizer,
      ),
    ).resolves.toMatchObject({
      mimeType: "image/webp",
      originalFilename: "Capture 01.png",
    });
    expect(optimizer).toHaveBeenCalledOnce();
  });

  it("conserve les GIF sans conversion pour préserver l'animation", async () => {
    const optimizer = vi.fn();
    const file = imageFile(["gif"], "animation.gif", "image/gif");

    await expect(prepareImageForUpload(file, optimizer)).resolves.toEqual({
      blob: file,
      mimeType: "image/gif",
      originalFilename: "animation.gif",
    });
    expect(optimizer).not.toHaveBeenCalled();
  });

  it("refuse un fichier non image", async () => {
    await expect(
      prepareImageForUpload(
        imageFile(["text"], "notes.txt", "text/plain"),
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: "unsupported-type",
    });
  });

  it("refuse une image source de plus de 50 MB", async () => {
    const file = imageFile(["x"], "huge.png", "image/png");
    Object.defineProperty(file, "size", {
      value: MAX_SOURCE_IMAGE_SIZE_BYTES + 1,
    });

    await expect(prepareImageForUpload(file, vi.fn())).rejects.toMatchObject({
      code: "source-too-large",
    });
  });

  it("refuse une optimisation qui ne produit pas du WebP", async () => {
    const optimizer = vi
      .fn()
      .mockResolvedValue(new Blob(["png"], { type: "image/png" }));

    await expect(
      prepareImageForUpload(
        imageFile(["png"], "Capture 01.png", "image/png"),
        optimizer,
      ),
    ).rejects.toMatchObject({
      code: "encoding-failed",
    });
  });
});

describe("fileToDataUrl", () => {
  it("converts a file to a base64 data URL", async () => {
    const file = imageFile(
      [new Uint8Array([0, 1, 2, 253, 254, 255])],
      "screenshot.png",
      "image/png",
    );

    await expect(fileToDataUrl(file)).resolves.toBe(
      "data:image/png;base64,AAEC/f7/",
    );
  });
});

describe("uploadAttachmentImage", () => {
  it("garde le fallback data URL hors runtime Tauri", async () => {
    await expect(
      uploadAttachmentImage(
        imageFile(["hello"], "pasted.png", "image/png"),
        "note-1",
      ),
    ).resolves.toBe("data:image/png;base64,aGVsbG8=");
  });
});
