const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type VersionParts = [number, number, number];

function parseVersion(version: string): VersionParts | null {
  const match = versionPattern.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareParts(left: VersionParts, right: VersionParts): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Versions whose changelog the user has not seen yet, newest first, or `null`
 * when the app is not newer than the last seen version. A missing or unreadable
 * `lastSeen` comes from an update of a version without release notes: only the
 * current changelog is shown.
 */
export function pendingReleaseNotes(
  lastSeen: string | null,
  current: string,
  availableVersions: readonly string[],
): string[] | null {
  const currentParts = parseVersion(current);
  if (!currentParts) return null;
  const lastSeenParts = lastSeen === null ? null : parseVersion(lastSeen);
  if (lastSeenParts && compareParts(lastSeenParts, currentParts) >= 0) {
    return null;
  }

  return availableVersions
    .flatMap((version) => {
      const parts = parseVersion(version);
      if (!parts || compareParts(parts, currentParts) > 0) return [];
      if (lastSeenParts) {
        return compareParts(parts, lastSeenParts) > 0
          ? [{ parts, version }]
          : [];
      }
      return compareParts(parts, currentParts) === 0
        ? [{ parts, version }]
        : [];
    })
    .sort((left, right) => compareParts(right.parts, left.parts))
    .map(({ version }) => version);
}
