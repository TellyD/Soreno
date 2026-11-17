import type { ForgeKind } from "../domain/forge";

// Names the requests tab before the remote read answers, so GitLab projects never flash "Pull requests".
const storageKey = (projectId: string) =>
  `soreno:forge-kind:${encodeURIComponent(projectId)}`;

export function readCachedForgeKind(projectId: string): ForgeKind | null {
  try {
    const kind = localStorage.getItem(storageKey(projectId));
    return kind === "github" || kind === "gitlab" ? kind : null;
  } catch {
    return null;
  }
}

export function writeCachedForgeKind(projectId: string, kind: ForgeKind) {
  try {
    localStorage.setItem(storageKey(projectId), kind);
  } catch {
    /* Only the first label of the next mount is affected. */
  }
}
