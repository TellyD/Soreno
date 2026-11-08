import { interleaveMentionPaths } from "./agentConversationMentions";
import { isWindowsPath, type GitFile, type GitSide } from "./projectGit";

export type ProjectFileKind = "directory" | "file";

export type ProjectFileEntry = {
  name: string;
  path: string;
  kind: ProjectFileKind;
  editable: boolean;
  previewable?: boolean;
  symlink?: boolean;
};

export type ProjectFileListing = {
  entries: ProjectFileEntry[];
  truncated: boolean;
};

export type ProjectFileSearchResult = ProjectFileListing & {
  /** Number of leading `entries` taken from the recently opened files. */
  recentCount: number;
};

export type ProjectTextSearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type ProjectTextSearchLine = {
  line: number;
  preview: string;
  ranges: [number, number][];
  selection: [number, number] | null;
};

export type ProjectTextSearchFile = {
  path: string;
  lines: ProjectTextSearchLine[];
};

export type ProjectTextSearchResult = {
  files: ProjectTextSearchFile[];
  lineCount: number;
  truncated: boolean;
};

export type ProjectFileContent = {
  path: string;
  content: string;
  version: string;
  mediaType?: string | null;
};

export type ProjectFileWriteResult = {
  version: string;
};

export type ProjectFileError = {
  code: string | null;
  message: string;
};

export function projectFileError(error: unknown): ProjectFileError {
  if (error && typeof error === "object") {
    const code = "code" in error ? String(error.code) : null;
    const message = "message" in error ? String(error.message) : String(error);
    return { code, message };
  }
  return { code: null, message: String(error) };
}

/** A project searched by Ctrl+P or Ctrl+Shift+F; `label` prefixes its paths, empty outside a group overview. */
export type ProjectSearchRoot = { projectId: string; label: string };

/** `path` is shown, `projectPath` opens it in `projectId`. */
type ProjectSearchHit = {
  path: string;
  projectId: string;
  projectPath: string;
};
export type ProjectFileSearchHit = ProjectFileEntry & ProjectSearchHit;
export type ProjectTextSearchHit = ProjectTextSearchFile & ProjectSearchHit;
export type ProjectFileSearchHits = Omit<ProjectFileSearchResult, "entries"> & {
  entries: ProjectFileSearchHit[];
};
export type ProjectTextSearchHits = Omit<ProjectTextSearchResult, "files"> & {
  files: ProjectTextSearchHit[];
};

export function projectSearchHit<T extends { path: string }>(
  root: ProjectSearchRoot,
  item: T,
): T & ProjectSearchHit {
  return {
    ...item,
    path: root.label ? `${root.label}/${item.path}` : item.path,
    projectId: root.projectId,
    projectPath: item.path,
  };
}

// A failing member hides none of the others; only a failure of every root is reported.
function settledByRoot<T>(
  roots: readonly ProjectSearchRoot[],
  settled: readonly PromiseSettledResult<T>[],
): [ProjectSearchRoot, T][] {
  const values = settled.flatMap((result, index): [ProjectSearchRoot, T][] =>
    result.status === "fulfilled" ? [[roots[index], result.value]] : [],
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure && values.length === 0) throw failure.reason;
  return values;
}

export function mergeProjectFileSearches(
  roots: readonly ProjectSearchRoot[],
  settled: readonly PromiseSettledResult<ProjectFileSearchResult>[],
): ProjectFileSearchHits {
  const results = settledByRoot(roots, settled).map(([root, result]) => ({
    entries: result.entries.map((entry) => projectSearchHit(root, entry)),
    recentCount: result.recentCount,
    truncated: result.truncated,
  }));
  const recent = interleaveMentionPaths(
    results.map(({ entries, recentCount }) => entries.slice(0, recentCount)),
    Infinity,
  );
  const others = interleaveMentionPaths(
    results.map(({ entries, recentCount }) => entries.slice(recentCount)),
    Infinity,
  );
  return {
    entries: [...recent, ...others],
    recentCount: recent.length,
    truncated: results.some((result) => result.truncated),
  };
}

export function mergeProjectTextSearches(
  roots: readonly ProjectSearchRoot[],
  settled: readonly PromiseSettledResult<ProjectTextSearchResult>[],
): ProjectTextSearchHits {
  const results = settledByRoot(roots, settled);
  return {
    files: results.flatMap(([root, result]) =>
      result.files.map((file) => projectSearchHit(root, file)),
    ),
    lineCount: results.reduce((sum, [, result]) => sum + result.lineCount, 0),
    truncated: results.some(([, result]) => result.truncated),
  };
}

/** Project-relative paths use `/`; the root directory is `""`. */
export function projectFileParent(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function projectFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isMarkdownProjectFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(projectFileName(path));
}

/** Directories that must be expanded to show `path`, outermost first. */
export function projectFileAncestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function isProjectFileWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Rewrites `path` when it is `from` or lies inside it; otherwise `null`. */
export function movedProjectFilePath(
  path: string,
  from: string,
  to: string,
): string | null {
  return isProjectFileWithin(path, from) ? to + path.slice(from.length) : null;
}

/** Normalizes a typed relative path; `null` when it cannot stay inside the project. */
export function normalizeProjectFileInput(value: string): string | null {
  const parts = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "");
  if (
    parts.length === 0 ||
    /^\/|^[A-Za-z]:/.test(value.trim()) ||
    parts.some(
      (part) => part === "." || part === ".." || part.toLowerCase() === ".git",
    )
  )
    return null;
  return parts.join("/");
}

export function absoluteProjectFilePath(
  projectPath: string,
  relative: string,
): string {
  if (isWindowsPath(projectPath))
    return `${projectPath.replace(/[\\/]+$/, "")}\\${relative.replace(/\//g, "\\")}`;
  return `${projectPath.replace(/\/+$/, "")}/${relative}`;
}

export type ProjectFileGitBadge = "M" | "A" | "D" | "R" | "U" | "?";

export type ProjectFileGitChange = {
  badge: ProjectFileGitBadge;
  /** Path relative to the Git root, as shown in Changes. */
  gitPath: string;
  side: GitSide;
};

export type ProjectFileGitStatus = {
  files: Map<string, ProjectFileGitChange>;
  /** Project directories containing at least one changed file. */
  directories: Set<string>;
};

const unchanged = (status: string) => status === "." || status === " ";

function projectFileGitBadge(file: GitFile): ProjectFileGitBadge | null {
  if (file.conflict) return "U";
  if (file.worktreeStatus === "?") return "?";
  if (file.indexStatus === "A" || file.indexStatus === "C") return "A";
  if (file.indexStatus === "R") return "R";
  if (file.indexStatus === "D" || file.worktreeStatus === "D") return "D";
  return unchanged(file.indexStatus) && unchanged(file.worktreeStatus)
    ? null
    : "M";
}

/** Project-relative form of a Git root-relative path; `null` outside the project `prefix`. */
export function projectPathFromGit(
  gitPath: string,
  prefix: string,
): string | null {
  return gitPath.startsWith(prefix)
    ? gitPath.slice(prefix.length) || null
    : null;
}

/** Maps Git status (root-relative) onto project-relative paths below `prefix`. */
export function projectFileGitStatus(
  files: readonly GitFile[],
  prefix: string,
): ProjectFileGitStatus {
  const status: ProjectFileGitStatus = {
    files: new Map(),
    directories: new Set(),
  };
  for (const file of files) {
    const path = projectPathFromGit(file.path, prefix);
    if (!path) continue;
    const badge = projectFileGitBadge(file);
    if (!badge) continue;
    status.files.set(path, {
      badge,
      gitPath: file.path,
      side:
        file.conflict || !unchanged(file.worktreeStatus)
          ? "unstaged"
          : "staged",
    });
    for (const directory of projectFileAncestors(path))
      status.directories.add(directory);
    // Submodules are listed as directory rows, which only read `directories`.
    if (file.submodule || file.mode === "160000") status.directories.add(path);
  }
  return status;
}
