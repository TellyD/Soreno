import type { AgentEnvironment } from "./agentSessions";

export type GitCloneRequest = {
  id: string;
  name: string;
  environment: AgentEnvironment;
  parentPath: string;
  folderName: string;
  url: string;
};
export function gitRepositoryName(url: string): string {
  return (
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .pop()
      ?.replace(/\.git$/i, "") ?? ""
  );
}

export function isWindowsPath(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  );
}

export function gitPathParts(path: string) {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return {
    parent: path.slice(0, separator + 1),
    name: path.slice(separator + 1),
  };
}

export type GitIdentity = { root: string; gitDir: string; commonDir: string };
export type GitFile = {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  conflict: boolean;
  submodule: boolean;
  actionable: boolean;
  mode: string;
  added: number | null;
  deleted: number | null;
};
export type GitSnapshot = {
  projectId: string;
  scope: string;
  version: string;
};

export function isGitSnapshotCurrent(
  snapshot: GitSnapshot,
  current: GitSnapshot | null | undefined,
): boolean {
  return (
    snapshot.projectId === current?.projectId &&
    snapshot.scope === current.scope &&
    snapshot.version === current.version
  );
}

const isGitSubmodule = (file: GitFile) =>
  file.submodule || file.mode === "160000";

export function canRestoreGitFile(file: GitFile | undefined): boolean {
  return !!file && file.actionable && !isGitSubmodule(file);
}

export function canResolveGitFile(file: GitFile | undefined): boolean {
  return !!file && file.conflict && !isGitSubmodule(file);
}

export function hasGitConflictMarkers(
  text: string | null | undefined,
): boolean {
  return /^<<<<<<<|^=======|^>>>>>>>/mu.test(text ?? "");
}

export type GitRepository = {
  availability: "ready" | "notRepository" | "bare";
  identity: GitIdentity | null;
  version: string;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  trackingKnown?: boolean;
  operation: string | null;
  mergeMessage: string | null;
  files: GitFile[];
  limited: boolean;
  truncated: boolean;
};
export type GitContent = {
  text: string | null;
  oid: string | null;
  size: number;
  mode: string;
  reason: string | null;
  imageDataUrl?: string;
};
export type GitComparison = {
  path: string;
  oldPath: string | null;
  version: string;
  before: GitContent;
  after: GitContent;
  conflictStages?: { stage: number; content: GitContent }[];
};
export type GitSide = "staged" | "unstaged";
export type GitChange = { file: GitFile; side: GitSide };
export type GitGroup = {
  key: "conflicts" | "unstaged" | "staged";
  changes: GitChange[];
};
export const gitChangeOrders = ["path", "mostChanged", "leastChanged"] as const;
export type GitChangeOrder = (typeof gitChangeOrders)[number];

export function isGitChangeOrder(value: unknown): value is GitChangeOrder {
  return gitChangeOrders.includes(value as GitChangeOrder);
}

export function clampGitPanelRatio(
  ratio: number,
  minRatio: number,
  maxRatio: number,
) {
  return Math.min(maxRatio, Math.max(minRatio, ratio));
}

export function parseGitPanelRatio(
  stored: string | null,
  defaultRatio: number,
  minRatio: number,
  maxRatio: number,
) {
  const ratio = stored === null ? defaultRatio : Number(stored);
  return Number.isFinite(ratio)
    ? clampGitPanelRatio(ratio, minRatio, maxRatio)
    : defaultRatio;
}

/** Files without line counts (binary, untracked) stay last; ties keep Git's path order. */
function sortGitChanges(changes: GitChange[], order: GitChangeOrder) {
  if (order === "path") return changes;
  const direction = order === "mostChanged" ? -1 : 1;
  return changes
    .map((change) => ({
      change,
      lines:
        change.file.added === null && change.file.deleted === null
          ? null
          : (change.file.added ?? 0) + (change.file.deleted ?? 0),
    }))
    .sort((a, b) =>
      a.lines === null || b.lines === null
        ? Number(a.lines === null) - Number(b.lines === null)
        : (a.lines - b.lines) * direction,
    )
    .map(({ change }) => change);
}

export function groupGitChanges(
  files: GitFile[],
  order: GitChangeOrder = "path",
): GitGroup[] {
  const conflicts: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const staged: GitChange[] = [];
  for (const file of files) {
    if (file.conflict) conflicts.push({ file, side: "unstaged" });
    else {
      if (file.worktreeStatus !== "." && file.worktreeStatus !== " ")
        unstaged.push({ file, side: "unstaged" });
      if (
        file.indexStatus !== "." &&
        file.indexStatus !== " " &&
        file.indexStatus !== "?"
      )
        staged.push({ file, side: "staged" });
    }
  }
  // Git lists untracked files after tracked ones; interleave them by path.
  unstaged.sort(({ file: a }, { file: b }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return [
    { key: "conflicts", changes: sortGitChanges(conflicts, order) },
    { key: "unstaged", changes: sortGitChanges(unstaged, order) },
    { key: "staged", changes: sortGitChanges(staged, order) },
  ];
}

export type GitCommitReference = {
  name: string;
  kind: "head" | "localBranch" | "remoteBranch" | "tag";
};
export type GitCommit = {
  oid: string;
  parents: string[];
  references: GitCommitReference[];
  author: string;
  date: string;
  subject: string;
};
export type GitGraphLine = { from: number; to: number; color: number };
export type GitGraphRow = {
  nodeLane: number;
  nodeColor: number;
  incoming: GitGraphLine | null;
  through: GitGraphLine[];
  outgoing: GitGraphLine[];
  laneCount: number;
};

export function buildGitGraphRows(commits: GitCommit[]): GitGraphRow[] {
  type Lane = { oid: string; color: number };
  const active: Lane[] = [];
  let nextColor = 0;

  return commits.map((commit) => {
    const before = [...active];
    let nodeLane = active.findIndex((lane) => lane.oid === commit.oid);
    if (nodeLane < 0) {
      nodeLane = active.length;
      active.push({ oid: commit.oid, color: nextColor++ });
    }
    const node = active[nodeLane];
    const incomingIndex = before.findIndex((lane) => lane.oid === commit.oid);
    active.splice(nodeLane, 1);

    for (const [index, parent] of commit.parents.entries()) {
      if (active.some((lane) => lane.oid === parent)) continue;
      active.splice(nodeLane + index, 0, {
        oid: parent,
        color: index === 0 ? node.color : nextColor++,
      });
    }

    const through = before.flatMap((lane, from) => {
      if (lane.oid === commit.oid) return [];
      const to = active.findIndex((candidate) => candidate.oid === lane.oid);
      return to < 0 ? [] : [{ from, to, color: lane.color }];
    });
    const outgoing = commit.parents.flatMap((parent) => {
      const to = active.findIndex((lane) => lane.oid === parent);
      return to < 0 ? [] : [{ from: nodeLane, to, color: active[to].color }];
    });

    return {
      nodeLane,
      nodeColor: node.color,
      incoming:
        incomingIndex < 0
          ? null
          : { from: incomingIndex, to: nodeLane, color: node.color },
      through,
      outgoing,
      laneCount: Math.max(before.length, active.length, nodeLane + 1),
    };
  });
}

type GitReferenceBadge = {
  kind: GitCommitReference["kind"];
  label: string;
  title: string;
};

const referenceOrder: Record<GitCommitReference["kind"], number> = {
  head: 0,
  localBranch: 1,
  tag: 2,
  remoteBranch: 3,
};

/** HEAD folds into its branch; a remote branch folds into the local branch of the same name on this commit. */
export function gitReferenceBadges(
  references: readonly GitCommitReference[],
): GitReferenceBadge[] {
  const sorted = [...references].sort(
    (left, right) => referenceOrder[left.kind] - referenceOrder[right.kind],
  );
  const remoteBranchName = (name: string) => name.slice(name.indexOf("/") + 1);
  const remotes = sorted.filter(
    (reference) =>
      reference.kind === "remoteBranch" &&
      remoteBranchName(reference.name) !== "HEAD",
  );
  const folded = new Set<GitCommitReference>();
  const withRemotes = (branch: string, label: string) => {
    const tracking = remotes.filter(
      (remote) => remoteBranchName(remote.name) === branch,
    );
    for (const remote of tracking) folded.add(remote);
    return [label, ...tracking.map((remote) => remote.name)].join(", ");
  };
  const head = sorted.some((reference) => reference.kind === "head");
  const currentBranch = head
    ? sorted.find((reference) => reference.kind === "localBranch")
    : undefined;
  const badges: GitReferenceBadge[] = [];
  if (currentBranch) {
    const label = `HEAD -> ${currentBranch.name}`;
    badges.push({
      kind: "head",
      label,
      title: withRemotes(currentBranch.name, label),
    });
  } else if (head) badges.push({ kind: "head", label: "HEAD", title: "HEAD" });
  for (const reference of sorted) {
    if (reference.kind === "localBranch" && reference !== currentBranch)
      badges.push({
        kind: "localBranch",
        label: reference.name,
        title: withRemotes(reference.name, reference.name),
      });
    else if (reference.kind === "tag")
      badges.push({
        kind: "tag",
        label: `tag: ${reference.name}`,
        title: `tag: ${reference.name}`,
      });
  }
  for (const remote of remotes)
    if (!folded.has(remote))
      badges.push({
        kind: "remoteBranch",
        label: remote.name,
        title: remote.name,
      });
  return badges;
}

export type GitHistory = {
  roots: string[];
  commits: GitCommit[];
  hasMore: boolean;
};
export type GitCommitDetail = {
  oid: string;
  parent: string | null;
  files: GitFile[];
};
export type GitBranch = {
  name: string;
  oid: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
};
export type GitWorktree = { path: string; head: string; branch: string | null };
export type GitWorktreeRequest = {
  id: string;
  name: string;
  parentPath: string;
  folderName: string;
  branch: string;
  remote: boolean;
  createBranch: boolean;
  version: string;
};

/** A worktree on `name` checks out the local branch, else a remote one (origin first), else a new branch from `head`. */
export function worktreeBranchSource(
  branches: readonly GitBranch[],
  name: string,
  head: string,
): { branch: GitBranch; createBranch: boolean } {
  const local = branches.find(
    (branch) => !branch.remote && branch.name === name,
  );
  if (local) return { branch: local, createBranch: false };
  const remotes = branches.filter(
    (branch) =>
      branch.remote && branch.name.slice(branch.name.indexOf("/") + 1) === name,
  );
  const remote =
    remotes.find((branch) => branch.name === `origin/${name}`) ?? remotes[0];
  if (remote) return { branch: remote, createBranch: false };
  return {
    branch: { name, oid: head, remote: false, current: false, upstream: null },
    createBranch: true,
  };
}

export function comparableGitPath(path: string): string {
  const windows = isWindowsPath(path);
  const normalized = (windows ? path.replace(/\\/g, "/") : path).replace(
    /\/+$/,
    "",
  );
  return windows ? normalized.toLocaleLowerCase() : normalized;
}

/** Worktree projects are named `<project> · <branch>`; drop the suffix when the branch is shown beside it. */
export function projectNameWithoutBranch(
  name: string,
  branch: string | null | undefined,
): string {
  const suffix = branch ? ` · ${branch}` : "";
  return suffix && name.length > suffix.length && name.endsWith(suffix)
    ? name.slice(0, -suffix.length)
    : name;
}

const compareGitNames = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
}).compare;

/** The primary worktree and its branch come first; the rest sort by name. */
export function orderGitRefs(
  branches: readonly GitBranch[],
  worktrees: readonly GitWorktree[],
) {
  const [primaryWorktree, ...linkedWorktrees] = worktrees;
  const baseBranch = primaryWorktree?.branch ?? null;
  return {
    baseBranch,
    orderedWorktrees: primaryWorktree
      ? [
          primaryWorktree,
          ...linkedWorktrees.sort((a, b) =>
            compareGitNames(a.branch ?? a.path, b.branch ?? b.path),
          ),
        ]
      : [],
    local: branches
      .filter((branch) => !branch.remote)
      .sort(
        (a, b) =>
          Number(b.name === baseBranch) - Number(a.name === baseBranch) ||
          compareGitNames(a.name, b.name),
      ),
    remote: branches
      .filter((branch) => branch.remote)
      .sort((a, b) => compareGitNames(a.name, b.name)),
  };
}

export type GitRemote = {
  name: string;
  url: string;
  pushUrl?: string | null;
  ambiguous?: boolean;
};
export type GitMutationResult = {
  oid: string | null;
  message: string;
  warning: string | null;
};

export function gitErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Za-z][A-Za-z0-9]*$/.test(error.code)
    )
      // Malformed output has no actionable translation: its backend detail is the only diagnostic.
      return error.code === "malformed" &&
        "message" in error &&
        typeof error.message === "string"
        ? `[Git/malformed] ${error.message}`
        : `[Git/${error.code}]`;
    if ("message" in error) return String(error.message);
  }
  return String(error);
}
export function gitErrorCode(message: string): string | null {
  return /^\[Git\/([A-Za-z][A-Za-z0-9]*)\](?: |$)/.exec(message)?.[1] ?? null;
}
export function gitErrorUncertain(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "uncertain" in error &&
    error.uncertain === true
  );
}
