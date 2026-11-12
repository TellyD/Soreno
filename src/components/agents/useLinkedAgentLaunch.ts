import type { RefObject } from "react";
import * as api from "../../data/agentSessionsApi";
import * as designApi from "../../data/designApi";
import {
  defaultAgentArgs,
  ompConversationExecutable,
  sessionLaunchBlocked,
  type AgentProject,
  type AgentProjectWorktree,
  type AgentProjectWorktreeGroup,
  type AgentSession,
  type AgentWorkspace,
} from "../../domain/agentSessions";
import { railWorktreeGroups } from "../../domain/agentWorkspaceView";
import {
  designAgentSessionName,
  designBranchName,
  designLaunchPrompt,
  type DesignAgentRequest,
} from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { useAppSettings } from "../../settings";
import { kanbanErrorCode } from "../../domain/kanban";
import {
  kanbanIssueLaunch,
  type KanbanIssueAgentRequest,
} from "../../domain/kanbanAgent";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { issueWorktreeProject } from "./issueWorktreeProject";
import {
  formatOperationError,
  LocalizedOperationError,
} from "./operationError";
import type {
  AgentLaunch,
  StartAgentSession,
} from "./useAgentSessionLifecycle";

/** Creates, links and starts the agent a Kanban issue or a Design board hands work to. */
export function useLinkedAgentLaunch({
  closing,
  current,
  missingProjectIds,
  orderedProjects,
  groupByProjectId,
  branches,
  execute,
  start,
  selectSession,
  rememberWorktreeProject,
  refreshBranches,
}: {
  closing: RefObject<boolean>;
  current: RefObject<{ workspace: AgentWorkspace }>;
  missingProjectIds: readonly string[];
  orderedProjects: readonly AgentProject[];
  groupByProjectId: ReadonlyMap<string, AgentProjectWorktreeGroup>;
  branches: Readonly<Record<string, string | null>>;
  execute: (work: () => Promise<void>) => Promise<boolean>;
  start: StartAgentSession;
  selectSession: (session: AgentSession) => Promise<boolean>;
  rememberWorktreeProject: (
    repositoryProjectId: string,
    projectId: string,
    worktree: Omit<AgentProjectWorktree, "projectIds">,
  ) => void;
  refreshBranches: () => void;
}) {
  const s = useAgentStrings();
  const gitStrings = useGitStrings();
  const { settings } = useAppSettings();

  // Rejects with localized text, or a coded Kanban error the board translates: the board shows
  // it instead of the workspace notification.
  async function runIssueAgentStep(work: () => Promise<void>) {
    const outcome: { done: boolean; failure: unknown } = {
      done: false,
      failure: null,
    };
    const reloaded = await execute(async () => {
      try {
        await work();
        outcome.done = true;
      } catch (reason) {
        outcome.failure = reason;
      }
    });
    if (outcome.done && reloaded) return;
    if (outcome.done) throw new LocalizedOperationError(s.workspaceLoadError);
    const { failure } = outcome;
    if (failure !== null && kanbanErrorCode(errorMessage(failure)))
      throw failure;
    throw new LocalizedOperationError(
      failure === null
        ? s.issueAgentBusy
        : failure instanceof LocalizedOperationError
          ? failure.message
          : formatOperationError(s, { message: errorMessage(failure) }),
    );
  }

  async function startLinkedAgent({
    projectId,
    executable,
    name,
    worktree,
    branchName,
    open,
    link,
    launch,
  }: {
    projectId: string;
    executable: string;
    name: string;
    worktree: boolean;
    branchName: string;
    open: boolean;
    link: (sessionId: string) => Promise<void>;
    launch: AgentLaunch;
  }) {
    if (closing.current) throw new LocalizedOperationError(s.issueAgentBusy);
    const { projects } = current.current.workspace;
    const source = projects.find((project) => project.id === projectId);
    if (!source || missingProjectIds.includes(projectId))
      throw new LocalizedOperationError(s.issueAgentProjectUnavailable);
    if (sessionLaunchBlocked(current.current.workspace, projectId))
      throw new LocalizedOperationError(s.issueAgentProjectDisconnected);
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId,
      name,
      executable,
      args: defaultAgentArgs(settings.agentPresetArgs, executable),
      ...(executable === ompConversationExecutable && {
        kind: "conversation" as const,
      }),
      createdAt: new Date().toISOString(),
    };
    await runIssueAgentStep(async () => {
      // A group overview folder is not a Git repository: run in it directly.
      if (
        worktree &&
        !(current.current.workspace.groups ?? []).some(
          (group) => group.groupProjectId === projectId,
        )
      ) {
        // The worktree needs Git on the server before the session can wake it.
        let group;
        if (
          (current.current.workspace.dormantProjectIds ?? []).includes(
            projectId,
          )
        ) {
          await api.setAgentProjectConnected(projectId, true);
          // Topology discovery skipped the dormant project: read it now that it is awake.
          const { groups } = await api.listAgentWorktrees();
          group = railWorktreeGroups(groups, orderedProjects).find((item) =>
            item.projectIds.includes(source.id),
          );
        }
        session.projectId = (
          await issueWorktreeProject({
            projects: current.current.workspace.projects,
            source,
            branch: branchName,
            group: group ?? groupByProjectId.get(source.id),
            branches,
            gitStrings,
            onCreated: (repositoryProjectId, projectId, worktree) => {
              rememberWorktreeProject(repositoryProjectId, projectId, worktree);
              refreshBranches();
            },
          })
        ).id;
      }
      await api.saveAgentSession(session);
      await link(session.id);
    });
    await runIssueAgentStep(async () => {
      await start(session.id, undefined, launch);
    });
    if (open) await selectSession(session);
  }

  async function startIssueAgent({
    issue,
    ...target
  }: KanbanIssueAgentRequest) {
    await startLinkedAgent({
      ...target,
      name: `${issue.identifier} · ${target.presetName}`,
      branchName: issue.branchName,
      link: (sessionId) =>
        api.linkAgentSessionKanbanIssue(sessionId, {
          source: issue.source,
          id: issue.id,
          identifier: issue.identifier,
        }),
      launch: kanbanIssueLaunch(issue),
    });
  }

  async function startDesignAgent({
    board,
    frames,
    instructions,
    ...target
  }: DesignAgentRequest) {
    const asked = instructions.trim() || null;
    await startLinkedAgent({
      ...target,
      name: designAgentSessionName(board.name, target.presetName),
      branchName: designBranchName(board.name),
      link: (sessionId) => designApi.linkDesignSession(sessionId, board.id),
      launch: {
        prompt: designLaunchPrompt(board.name, asked !== null),
        imageNames: [],
        imageUrls: [],
        imageTargets: [],
        issueFile: null,
        designFrames: {
          boardId: board.id,
          frameIds: frames.map((frame) => frame.id),
          instructions: asked,
        },
      },
    });
  }

  return { startIssueAgent, startDesignAgent };
}
