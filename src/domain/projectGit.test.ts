import { expect, it } from "vitest";
import {
  buildGitGraphRows,
  gitReferenceBadges,
  canResolveGitFile,
  canRestoreGitFile,
  comparableGitPath,
  gitErrorCode,
  gitErrorMessage,
  gitRepositoryName,
  groupGitChanges,
  hasGitConflictMarkers,
  isGitSnapshotCurrent,
  orderGitRefs,
  projectNameWithoutBranch,
  worktreeBranchSource,
  type GitBranch,
  type GitChangeOrder,
  type GitCommit,
  type GitFile,
} from "./projectGit";

const commit = (oid: string, parents: string[] = []): GitCommit => ({
  oid,
  parents,
  references: [],
  author: "Ada",
  date: "2025-01-02T12:30:00Z",
  subject: oid,
});

it.each([
  ["https://example.com/team/repo.git", "repo"],
  ["git@example.com:team/repo.git", "repo"],
  [" ssh://example.com/repo/?ref=main ", "repo"],
])("derives a repository name from %s", (url, expected) => {
  expect(gitRepositoryName(url)).toBe(expected);
});

it("keeps structured Git errors language-neutral", () => {
  const message = gitErrorMessage({
    code: "dirty",
    message: "Le worktree doit être propre.",
  });

  expect(message).toBe("[Git/dirty]");
  expect(gitErrorCode(message)).toBe("dirty");
  expect(gitErrorMessage(new Error("offline"))).toBe("offline");
  const malformed = gitErrorMessage({
    code: "malformed",
    message: "Statut invalide.",
  });
  expect(gitErrorCode(malformed)).toBe("malformed");
  expect(malformed).toContain("Statut invalide.");
});

it("centralizes restore and resolve file eligibility", () => {
  const regular: GitFile = {
    path: "src/main.ts",
    oldPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    conflict: true,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };

  expect(canRestoreGitFile(regular)).toBe(true);
  expect(canResolveGitFile(regular)).toBe(true);
  expect(canRestoreGitFile({ ...regular, submodule: true })).toBe(false);
  expect(canResolveGitFile({ ...regular, mode: "160000" })).toBe(false);
  expect(canResolveGitFile({ ...regular, conflict: false })).toBe(false);
});

it("detects conflict markers and exact Git snapshots", () => {
  const snapshot = { projectId: "p1", scope: "local:/repo", version: "v1" };

  expect(hasGitConflictMarkers("before\n<<<<<<< ours\nafter\n")).toBe(true);
  expect(hasGitConflictMarkers("before ======= after")).toBe(false);
  expect(isGitSnapshotCurrent(snapshot, { ...snapshot })).toBe(true);
  expect(
    isGitSnapshotCurrent(snapshot, { ...snapshot, scope: "local:/other" }),
  ).toBe(false);
  expect(isGitSnapshotCurrent(snapshot, null)).toBe(false);
});

it("groups conflicts first, partial changes on both sides, untracked files among changes by path", () => {
  const file = (
    path: string,
    indexStatus: string,
    worktreeStatus: string,
    conflict = false,
  ): GitFile => ({
    path,
    oldPath: null,
    indexStatus,
    worktreeStatus,
    conflict,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  });
  const conflict = file("conflict.ts", "U", "U", true);
  const partial = file("partial.ts", "M", "M");
  const untracked = file("new.ts", "?", "?");
  const unstaged = file("later.ts", ".", "M");

  expect(groupGitChanges([partial, unstaged, conflict, untracked])).toEqual([
    { key: "conflicts", changes: [{ file: conflict, side: "unstaged" }] },
    {
      key: "unstaged",
      changes: [
        { file: unstaged, side: "unstaged" },
        { file: untracked, side: "unstaged" },
        { file: partial, side: "unstaged" },
      ],
    },
    { key: "staged", changes: [{ file: partial, side: "staged" }] },
  ]);
});

it("orders each group by changed lines, keeping uncounted files last and ties in path order", () => {
  const file = (
    path: string,
    added: number | null,
    deleted: number | null,
  ): GitFile => ({
    path,
    oldPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added,
    deleted,
  });
  const files = [
    file("binary.png", null, null),
    file("large.ts", 40, 2),
    file("removed.ts", null, 3),
    file("small-a.ts", 1, 0),
    file("small-b.ts", 0, 1),
  ];
  const paths = (order: GitChangeOrder) =>
    groupGitChanges(files, order)[1].changes.map(({ file }) => file.path);

  expect(paths("path")).toEqual(files.map(({ path }) => path));
  expect(paths("mostChanged")).toEqual([
    "large.ts",
    "removed.ts",
    "small-a.ts",
    "small-b.ts",
    "binary.png",
  ]);
  expect(paths("leastChanged")).toEqual([
    "small-a.ts",
    "small-b.ts",
    "removed.ts",
    "large.ts",
    "binary.png",
  ]);
});

it("lays out linear history on one stable lane", () => {
  const rows = buildGitGraphRows([
    commit("new", ["middle"]),
    commit("middle", ["root"]),
    commit("root"),
  ]);

  expect(rows.map(({ nodeLane, laneCount }) => [nodeLane, laneCount])).toEqual([
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
  expect(rows[0].incoming).toBeNull();
  expect(rows[1].incoming).toEqual({ from: 0, to: 0, color: 0 });
  expect(rows[2].outgoing).toEqual([]);
});

it("opens, preserves and rejoins lanes across a merge", () => {
  const rows = buildGitGraphRows([
    commit("merge", ["main", "side"]),
    commit("side", ["root"]),
    commit("main", ["root"]),
    commit("root"),
  ]);

  expect(rows[0].outgoing).toEqual([
    { from: 0, to: 0, color: 0 },
    { from: 0, to: 1, color: 1 },
  ]);
  expect(rows[1]).toMatchObject({ nodeLane: 1, nodeColor: 1, laneCount: 2 });
  expect(rows[1].through).toEqual([{ from: 0, to: 0, color: 0 }]);
  expect(rows[2].through).toEqual([{ from: 1, to: 0, color: 1 }]);
  expect(rows[2].outgoing).toEqual([{ from: 0, to: 0, color: 1 }]);
  expect(rows[3]).toMatchObject({ nodeLane: 0, nodeColor: 1, laneCount: 1 });
});

it("puts sibling tips on separate lanes until their shared parent", () => {
  const rows = buildGitGraphRows([
    commit("A", ["C"]),
    commit("B", ["C"]),
    commit("C"),
  ]);

  expect(rows.map(({ nodeLane }) => nodeLane)).toEqual([0, 1, 0]);
  expect(rows[1].through).toEqual([{ from: 0, to: 0, color: 0 }]);
  expect(rows[1].outgoing).toEqual([{ from: 1, to: 0, color: 0 }]);
});

it("keeps existing rows stable when older commits are appended", () => {
  const firstPage = [
    commit("merge", ["main", "side"]),
    commit("side", ["root"]),
  ];
  const before = buildGitGraphRows(firstPage);
  const after = buildGitGraphRows([
    ...firstPage,
    commit("main", ["root"]),
    commit("root"),
  ]);

  expect(after.slice(0, firstPage.length)).toEqual(before);
});

it.each([
  {
    name: "folds HEAD and its same-commit remote, drops origin/HEAD",
    references: [
      { name: "origin/HEAD", kind: "remoteBranch" },
      { name: "origin/main", kind: "remoteBranch" },
      { name: "v1.0", kind: "tag" },
      { name: "main", kind: "localBranch" },
      { name: "HEAD", kind: "head" },
    ],
    expected: [
      ["HEAD -> main", "HEAD -> main, origin/main"],
      ["tag: v1.0", "tag: v1.0"],
    ],
  },
  {
    name: "keeps remotes of other branches apart",
    references: [
      { name: "origin/main", kind: "remoteBranch" },
      { name: "upstream/feature/x", kind: "remoteBranch" },
      { name: "feature/x", kind: "localBranch" },
    ],
    expected: [
      ["feature/x", "feature/x, upstream/feature/x"],
      ["origin/main", "origin/main"],
    ],
  },
  {
    name: "shows a detached HEAD on its own",
    references: [
      { name: "origin/main", kind: "remoteBranch" },
      { name: "HEAD", kind: "head" },
    ],
    expected: [
      ["HEAD", "HEAD"],
      ["origin/main", "origin/main"],
    ],
  },
] as const)("$name", ({ references, expected }) => {
  expect(
    gitReferenceBadges(references).map(({ label, title }) => [label, title]),
  ).toEqual(expected);
});

const ref = (name: string, remote: boolean): GitBranch => ({
  name,
  oid: `${name}-oid`,
  remote,
  current: false,
  upstream: null,
});

it("checks out the local branch of a worktree before any remote one", () => {
  const local = ref("tel-1", false);
  expect(
    worktreeBranchSource(
      [ref("origin/tel-1", true), local],
      "tel-1",
      "head-oid",
    ),
  ).toEqual({ branch: local, createBranch: false });
});

it("tracks a remote-only branch, preferring origin", () => {
  const origin = ref("origin/feature/tel-1", true);
  expect(
    worktreeBranchSource(
      [ref("upstream/feature/tel-1", true), origin, ref("origin/tel-1", true)],
      "feature/tel-1",
      "head-oid",
    ),
  ).toEqual({ branch: origin, createBranch: false });
  const fork = ref("fork/tel-2", true);
  expect(worktreeBranchSource([fork], "tel-2", "head-oid").branch).toBe(fork);
});

it("creates an absent branch from the current HEAD", () => {
  expect(
    worktreeBranchSource([ref("main", false)], "tel-3", "head-oid"),
  ).toEqual({
    branch: {
      name: "tel-3",
      oid: "head-oid",
      remote: false,
      current: false,
      upstream: null,
    },
    createBranch: true,
  });
});
it("compares Windows and UNC paths case-insensitively, POSIX paths verbatim", () => {
  expect(comparableGitPath("C:\\Repo\\Feature\\")).toBe("c:/repo/feature");
  expect(comparableGitPath("\\\\wsl$\\Ubuntu\\Repo")).toBe(
    "//wsl$/ubuntu/repo",
  );
  expect(comparableGitPath("/home/User/Repo//")).toBe("/home/User/Repo");
  expect(comparableGitPath("/home/User/Repo\\x")).toBe("/home/User/Repo\\x");
});
it("orders the primary worktree and its branch first, then by natural name", () => {
  const branch = (name: string, remote = false): GitBranch => ({
    name,
    oid: name,
    remote,
    current: false,
    upstream: null,
  });
  const branches = [
    branch("zeta"),
    branch("origin/b", true),
    branch("Alpha-10"),
    branch("main"),
    branch("origin/a", true),
    branch("alpha-9"),
  ];
  const worktrees = [
    { path: "/repo", head: "1", branch: "main" },
    { path: "/repo-10", head: "2", branch: "feat-10" },
    { path: "/repo-2", head: "3", branch: "feat-2" },
  ];
  const ordered = orderGitRefs(branches, worktrees);

  expect(ordered.baseBranch).toBe("main");
  expect(ordered.orderedWorktrees.map((worktree) => worktree.branch)).toEqual([
    "main",
    "feat-2",
    "feat-10",
  ]);
  expect(ordered.local.map((value) => value.name)).toEqual([
    "main",
    "alpha-9",
    "Alpha-10",
    "zeta",
  ]);
  expect(ordered.remote.map((value) => value.name)).toEqual([
    "origin/a",
    "origin/b",
  ]);
  expect(worktrees.map((worktree) => worktree.branch)).toEqual([
    "main",
    "feat-10",
    "feat-2",
  ]);
  expect(branches[0].name).toBe("zeta");
  expect(orderGitRefs(branches, [])).toMatchObject({
    baseBranch: null,
    orderedWorktrees: [],
  });
});

it("drops only an exact trailing branch suffix from a project name", () => {
  expect(projectNameWithoutBranch("Soreno · team/topic", "team/topic")).toBe(
    "Soreno",
  );
  expect(projectNameWithoutBranch("Soreno · team/topic", "topic")).toBe(
    "Soreno · team/topic",
  );
  expect(projectNameWithoutBranch("Soreno · old", "new")).toBe("Soreno · old");
  expect(projectNameWithoutBranch(" · main", "main")).toBe(" · main");
  expect(projectNameWithoutBranch("Soreno", null)).toBe("Soreno");
});
