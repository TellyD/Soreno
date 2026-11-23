import type { ForgeKind } from "../domain/forge";
import { readPreference, writePreference } from "./localStoragePreference";

// Names the requests tab before the remote read answers, so GitLab projects never flash "Pull requests".
const storageKey = (projectId: string) =>
  `soreno:forge-kind:${encodeURIComponent(projectId)}`;

export function readCachedForgeKind(projectId: string): ForgeKind | null {
  const kind = readPreference(storageKey(projectId));
  return kind === "github" || kind === "gitlab" ? kind : null;
}

export function writeCachedForgeKind(projectId: string, kind: ForgeKind) {
  writePreference(storageKey(projectId), kind);
}
