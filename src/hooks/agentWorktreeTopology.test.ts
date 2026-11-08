import { expect, it } from "vitest";
import type { AgentProjectWorktreeGroup } from "../domain/agentSessions";
import { mergePartialWorktreeGroups } from "./agentWorktreeTopology";

const primary = {
  id: "primary",
  name: "Primary",
  path: "/projects/primary",
  environment: { kind: "local" as const, distribution: null },
};
const alias = {
  ...primary,
  id: "alias",
  name: "Alias",
  path: "/projects/linked",
};
const fullGroup: AgentProjectWorktreeGroup = {
  repositoryProjectId: primary.id,
  projectIds: [primary.id, alias.id],
  worktrees: [
    {
      path: primary.path,
      head: "a".repeat(40),
      branch: "main",
      projectIds: [primary.id],
    },
    {
      path: alias.path,
      head: "b".repeat(40),
      branch: "linked",
      projectIds: [alias.id],
    },
    {
      path: "/projects/removed",
      head: "c".repeat(40),
      branch: "removed",
      projectIds: [],
    },
  ],
};
const partialGroup: AgentProjectWorktreeGroup = {
  ...fullGroup,
  projectIds: [primary.id],
  worktrees: [
    fullGroup.worktrees[0],
    { ...fullGroup.worktrees[1], projectIds: [] },
  ],
};

it("keeps worktree project associations only for paths present in a partial snapshot", () => {
  expect(
    mergePartialWorktreeGroups([fullGroup], [partialGroup], [primary, alias]),
  ).toEqual([
    {
      ...partialGroup,
      projectIds: [primary.id, alias.id],
      worktrees: [
        fullGroup.worktrees[0],
        { ...fullGroup.worktrees[1], projectIds: [alias.id] },
      ],
    },
  ]);
});

it("does not merge groups sharing a path from a different environment", () => {
  const remote = {
    ...alias,
    id: "remote",
    environment: { kind: "wsl" as const, distribution: "Ubuntu" },
  };
  const remoteGroup: AgentProjectWorktreeGroup = {
    repositoryProjectId: remote.id,
    projectIds: [remote.id],
    worktrees: [{ ...fullGroup.worktrees[0], projectIds: [remote.id] }],
  };
  const update = { ...partialGroup, projectIds: [] };
  expect(
    mergePartialWorktreeGroups([remoteGroup], [update], [primary, remote]),
  ).toEqual([remoteGroup, update]);
});
