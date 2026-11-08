import type {
  AgentProject,
  AgentProjectWorktree,
  AgentSession,
} from "../../domain/agentSessions";
import type { AgentProjectGroup } from "./AgentForms";
import type { AgentStrings } from "./agentStrings";

export type Confirmation = (
  | { kind: "stop" | "restart"; session: AgentSession }
  | { kind: "session"; session: AgentSession }
  | { kind: "project"; project: AgentProject }
  | {
      kind: "worktree";
      repositoryProjectId: string;
      worktree: AgentProjectWorktree;
      projects: AgentProject[];
      merge?: { branch: string; base: string };
    }
  | { kind: "disconnect"; project: AgentProject }
  | { kind: "group"; group: AgentProjectGroup; deleteProjects?: boolean }
) & { fromMenu?: boolean };
export type Deletion =
  | Extract<Confirmation, { kind: "session" | "project" | "group" }>
  | { kind: "close"; session: AgentSession };

export function groupDeletionProjectIds({
  group,
  deleteProjects,
}: Extract<Confirmation, { kind: "group" }>): string[] {
  return [
    ...(group.groupProjectId ? [group.groupProjectId] : []),
    ...(deleteProjects ? group.projectIds : []),
  ];
}

export function confirmationDialogText(
  s: AgentStrings,
  confirmation: Confirmation,
  {
    runningWorktreeSessions,
    disconnectIncomplete,
    remoteStopFailed,
  }: {
    runningWorktreeSessions: number;
    /** The disconnect failed: the dialog only reports it. */
    disconnectIncomplete: boolean;
    /** The deletion failed to stop remote sessions: confirming skips the server. */
    remoteStopFailed: boolean;
  },
): { title: string; description: string; confirmLabel: string } {
  if (disconnectIncomplete)
    return {
      title: s.disconnectIncompleteTitle,
      description: s.disconnectIncompleteDescription,
      confirmLabel: s.dismiss,
    };
  let title: string;
  let description: string;
  switch (confirmation.kind) {
    case "disconnect":
      title = s.disconnect;
      description = s.disconnectDescription;
      break;
    case "project":
      title = s.removeProject;
      description = s.deleteProjectDescription;
      break;
    case "group":
      title = s.deleteGroupTitle(confirmation.group.name);
      description = confirmation.deleteProjects
        ? s.deleteGroupWithProjectsDescription
        : s.deleteGroupDescription;
      break;
    case "worktree":
      title = confirmation.merge
        ? s.mergeWorktree(confirmation.merge.base)
        : s.removeWorktree;
      description = confirmation.merge
        ? s.mergeWorktreeDescription(
            confirmation.merge.branch,
            confirmation.merge.base,
          )
        : s.deleteWorktreeDescription(confirmation.worktree.branch);
      break;
    case "session":
      title = s.removeSession;
      description = s.deleteSessionDescription;
      break;
    case "restart":
      title = s.restart;
      description = s.restartDescription;
      break;
    case "stop":
      title = s.stop;
      description = s.stopDescription;
      break;
  }
  let confirmLabel = confirmation.kind === "group" ? s.deleteGroup : title;
  if (confirmation.kind === "worktree" && runningWorktreeSessions > 0) {
    description = `${description} ${s.worktreeSessionsWillStop(runningWorktreeSessions)}`;
    confirmLabel = confirmation.merge
      ? s.stopSessionsAndMerge
      : s.stopSessionsAndDelete;
  }
  if (remoteStopFailed) {
    description = s.sshRemoteStopFailed;
    confirmLabel = s.disconnectAndDelete;
  }
  return { title, description, confirmLabel };
}
