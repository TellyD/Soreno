import { isProjectFileWithin, movedProjectFilePath } from "./projectFiles";
import { sameItems } from "./sameItems";

export const recentProjectFilesKey = "soreno.agents.recent-files.v1";
const recentProjectFileLimit = 50;

type RecentProjectFiles = Record<string, string[]>;

const validPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && path.length <= 4096;

function readAll(): RecentProjectFiles {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(recentProjectFilesKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([projectId, paths]) =>
        Array.isArray(paths)
          ? [
              [
                projectId,
                [...new Set(paths.filter(validPath))].slice(
                  0,
                  recentProjectFileLimit,
                ),
              ],
            ]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

function writeAll(files: RecentProjectFiles) {
  try {
    localStorage.setItem(recentProjectFilesKey, JSON.stringify(files));
  } catch {
    /* History is optional: opening files must not depend on storage. */
  }
}

function update(projectId: string, change: (paths: string[]) => string[]) {
  const files = readAll();
  const previous = files[projectId] ?? [];
  const next = [...new Set(change(previous))].slice(0, recentProjectFileLimit);
  if (sameItems(next, previous)) return;
  if (next.length) files[projectId] = next;
  else delete files[projectId];
  writeAll(files);
}

/** Most recent first. */
export function readRecentProjectFiles(projectId: string): string[] {
  return readAll()[projectId] ?? [];
}

export function recordRecentProjectFile(projectId: string, path: string) {
  update(projectId, (paths) => [path, ...paths]);
}

/** Follows a renamed file or directory. */
export function moveRecentProjectFiles(
  projectId: string,
  from: string,
  to: string,
) {
  update(projectId, (paths) =>
    paths.map((path) => movedProjectFilePath(path, from, to) ?? path),
  );
}

export function forgetRecentProjectFile(projectId: string, path: string) {
  update(projectId, (paths) => paths.filter((recent) => recent !== path));
}

/** Forgets a file, or every file below a directory. */
export function forgetRecentProjectFiles(projectId: string, path: string) {
  update(projectId, (paths) =>
    paths.filter((recent) => !isProjectFileWithin(recent, path)),
  );
}

export function pruneRecentProjectFiles(projectIds: Iterable<string>) {
  const kept = new Set(projectIds);
  const files = readAll();
  const removed = Object.keys(files).filter((id) => !kept.has(id));
  if (!removed.length) return;
  removed.forEach((id) => delete files[id]);
  writeAll(files);
}
