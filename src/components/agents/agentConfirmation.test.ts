import { expect, it } from "vitest";
import type { AgentProject, AgentSession } from "../../domain/agentSessions";
import { confirmationDialogText, type Confirmation } from "./agentConfirmation";
import { agentStringsForLocale } from "./agentStrings";

const s = agentStringsForLocale("en-US");
const project: AgentProject = {
  id: "p",
  name: "Project",
  path: "/p",
  environment: { kind: "ssh", distribution: null },
};
const session: AgentSession = {
  id: "s",
  projectId: "p",
  name: "Codex",
  executable: "codex",
  args: [],
  createdAt: "",
};
const worktree = (merge?: { branch: string; base: string }): Confirmation => ({
  kind: "worktree",
  repositoryProjectId: "p",
  worktree: { path: "/wt", head: "h", branch: "fix", projectIds: ["wt"] },
  projects: [project],
  merge,
});
const text = (
  confirmation: Confirmation,
  options: Partial<Parameters<typeof confirmationDialogText>[2]> = {},
) =>
  confirmationDialogText(s, confirmation, {
    runningWorktreeSessions: 0,
    disconnectIncomplete: false,
    remoteStopFailed: false,
    ...options,
  });

it("warns that running worktree sessions stop before the merge", () => {
  expect(
    text(worktree({ branch: "fix", base: "main" }), {
      runningWorktreeSessions: 2,
    }),
  ).toEqual({
    title: s.mergeWorktree("main"),
    description: `${s.mergeWorktreeDescription("fix", "main")} ${s.worktreeSessionsWillStop(2)}`,
    confirmLabel: s.stopSessionsAndMerge,
  });
  expect(text(worktree(), { runningWorktreeSessions: 1 }).confirmLabel).toBe(
    s.stopSessionsAndDelete,
  );
});

it("confirms idle worktree and group deletions with their own label", () => {
  expect(text(worktree()).confirmLabel).toBe(s.removeWorktree);
  expect(
    text({
      kind: "group",
      group: {
        id: "g",
        name: "Team",
        projectIds: [],
        groupProjectId: null,
        collapsed: false,
      },
    }),
  ).toMatchObject({
    title: s.deleteGroupTitle("Team"),
    confirmLabel: s.deleteGroup,
  });
});

it("turns an incomplete disconnect into a dismissible report", () => {
  expect(
    text({ kind: "disconnect", project }, { disconnectIncomplete: true }),
  ).toEqual({
    title: s.disconnectIncompleteTitle,
    description: s.disconnectIncompleteDescription,
    confirmLabel: s.dismiss,
  });
});

it("offers to delete without the server after a failed remote stop", () => {
  expect(
    text({ kind: "session", session }, { remoteStopFailed: true }),
  ).toEqual({
    title: s.removeSession,
    description: s.sshRemoteStopFailed,
    confirmLabel: s.disconnectAndDelete,
  });
});
