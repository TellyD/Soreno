/**
 * File name `filePath` captures in the decoded path of a `convertFileSrc` URL
 * matching `assetUrl`, or null for any other URL.
 */
export function assetFileName(
  url: string,
  assetUrl: RegExp,
  filePath: RegExp,
): string | null {
  const match = assetUrl.exec(url);
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return filePath.exec(path.replace(/\\/g, "/"))?.[1] ?? null;
}
