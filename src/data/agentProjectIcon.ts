const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const ICON_SIZE = 64;
export const PROJECT_ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Store a small, self-contained raster image, never a path to the original file. */
export async function importAgentProjectIcon(file: File): Promise<string> {
  if (
    !PROJECT_ICON_ACCEPT.split(",").includes(file.type) ||
    !file.size ||
    file.size > MAX_SOURCE_BYTES
  ) {
    throw new Error("Invalid project icon file");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to decode project icon"));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("Empty project icon");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    const scale = Math.min(
      ICON_SIZE / image.naturalWidth,
      ICON_SIZE / image.naturalHeight,
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(
      image,
      (ICON_SIZE - width) / 2,
      (ICON_SIZE - height) / 2,
      width,
      height,
    );
    const dataUrl = canvas.toDataURL("image/png");
    if (
      !dataUrl.startsWith("data:image/png;base64,") ||
      dataUrl.length > 32 * 1024
    ) {
      throw new Error("Unable to encode project icon");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}
