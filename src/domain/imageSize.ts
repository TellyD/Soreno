export const minImageWidth = 48;
export const maxImageWidth = 4096;

// Soreno-only display metadata; other Markdown readers still render the original image.
// Notes written before the Telaoi → Soreno rename keep the `telaoi:` prefix.
export const imageWidthPrefixes = [
  "soreno:image-width=",
  "telaoi:image-width=",
];

export function parseImageWidth(comment: string): number | undefined {
  const match = /^<!-- (?:soreno|telaoi):image-width=(\d{1,4}) -->$/u.exec(
    comment,
  );
  const width = match ? Number(match[1]) : NaN;
  return width >= minImageWidth && width <= maxImageWidth ? width : undefined;
}

export function imageWidthComment(width: number): string {
  return `<!-- soreno:image-width=${Math.round(Math.min(maxImageWidth, Math.max(minImageWidth, width)))} -->`;
}

type ImageDimensions = {
  height: number;
  width: number;
};

export function constrainedImageDimensions(
  dimensions: ImageDimensions,
  maxDimension: number,
): ImageDimensions {
  const largestDimension = Math.max(dimensions.width, dimensions.height);

  if (largestDimension <= maxDimension) {
    return dimensions;
  }

  const scale = maxDimension / largestDimension;

  return {
    height: Math.max(1, Math.round(dimensions.height * scale)),
    width: Math.max(1, Math.round(dimensions.width * scale)),
  };
}
