import { useEffect, useState, type RefObject } from "react";
import * as api from "../../data/agentSessionsApi";
import {
  defaultAgentArgs,
  ompConversationExecutable,
  sessionLaunchBlocked,
  type AgentSession,
  type AgentSessionStatus,
  type AgentWorkspace,
} from "../../domain/agentSessions";
import { uniqueAgentSessionName } from "../../domain/agentWorkspaceView";
import { asError } from "../../domain/errors";
import { forgeLoginSession, type ForgeKind } from "../../domain/forge";
import {
  mergeConflictAgent,
  mergeConflictPrompt,
  type GitMergeConflict,
} from "../../domain/mergeConflictAgent";
import { useAppSettings } from "../../settings";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { LocalizedOperationError } from "./operationError";
import type { StartAgentSession } from "./useAgentSessionLifecycle";

/** Agents started for Git: one resolving a merge conflict, one signing in to a forge. */
export function useRecoveryAgentLaunch({
  closing,
  current,
  busy,
  loading,
  isBusy,
  execute,
  start,
  selectSession,
  statusById,
  setFailedMerge,
  gitPanelExpanded,
  onGitPanelExpandedChange,
}: {
  closing: RefObject<boolean>;
  current: RefObject<{ workspace: AgentWorkspace }>;
  busy: boolean;
  loading: boolean;
  isBusy: () => boolean;
  execute: (work: () => Promise<void>) => Promise<boolean>;
  start: StartAgentSession;
  selectSession: (session: AgentSession) => Promise<boolean>;
  statusById: ReadonlyMap<string, AgentSessionStatus>;
  setFailedMerge: (
    failed: { error: Error; conflict: GitMergeConflict } | null,
  ) => void;
  gitPanelExpanded: boolean;
  onGitPanelExpandedChange?: (expanded: boolean) => void;
}) {
  const s = useAgentStrings();
  const gitStrings = useGitStrings();
  const { settings } = useAppSettings();
  const [queuedMergeConflicts, setQueuedMergeConflicts] = useState<
    GitMergeConflict[]
  >([]);
  const [forgeLoginSessionIds, setForgeLoginSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [forgeLoginRevision, setForgeLoginRevision] = useState(0);

  useEffect(() => {
    // Failed logins stay tracked: restarting the same session may still succeed.
    const done = [...forgeLoginSessionIds].filter((id) => {
      const status = statusById.get(id);
      return !status || (status.state === "exited" && status.exitCode === 0);
    });
    if (!done.length) return;
    setForgeLoginSessionIds((ids) => {
      const next = new Set(ids);
      for (const id of done) next.delete(id);
      return next;
    });
    if (done.some((id) => statusById.get(id)))
      setForgeLoginRevision((value) => value + 1);
  }, [forgeLoginSessionIds, statusById]);

  // Conflicts requested during a workspace operation start in order once it ends.
  useEffect(() => {
    if (queuedMergeConflicts.length === 0 || busy || loading || isBusy())
      return;
    const [next, ...rest] = queuedMergeConflicts;
    setQueuedMergeConflicts(rest);
    void resolveMergeConflict(next);
  }, [queuedMergeConflicts, busy, loading, isBusy]);

  async function resolveMergeConflict(conflict: GitMergeConflict) {
    if (closing.current) return;
    if (isBusy()) {
      setQueuedMergeConflicts((queued) => [...queued, conflict]);
      return;
    }
    const { workspace: latest } = current.current;
    const project = latest.projects.find((project) =>
      conflict.projectIds.includes(project.id),
    );
    if (!project) return;
    const agent = mergeConflictAgent(
      latest.sessions,
      conflict.projectIds,
      settings.hiddenAgentPresets,
    );
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId: project.id,
      name: uniqueAgentSessionName(
        latest.sessions,
        project.id,
        s.mergeConflictSessionName(agent.name),
      ),
      executable: agent.executable,
      args: defaultAgentArgs(settings.agentPresetArgs, agent.executable),
      ...(agent.executable === ompConversationExecutable && {
        kind: "conversation" as const,
      }),
      createdAt: new Date().toISOString(),
    };
    const started = await execute(async () => {
      if (sessionLaunchBlocked(current.current.workspace, project.id))
        throw new LocalizedOperationError(s.issueAgentProjectDisconnected);
      await api.saveAgentSession(session);
      try {
        await start(session.id, undefined, {
          prompt: mergeConflictPrompt(conflict),
          imageNames: [],
          imageUrls: [],
          imageTargets: [],
          issueFile: null,
        });
      } catch (reason) {
        // Its prompt is never persisted: reopening it would start a bare agent.
        await api.deleteAgentSession(session.id).catch(() => {});
        const failure = asError(reason);
        setFailedMerge({ error: failure, conflict });
        throw failure;
      }
    });
    if (started) await selectSession(session);
  }

  async function startForgeLogin(projectId: string, kind: ForgeKind) {
    if (closing.current) return;
    const { workspace: latest } = current.current;
    if (!latest.projects.some((project) => project.id === projectId)) return;
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId,
      name: uniqueAgentSessionName(
        latest.sessions,
        projectId,
        gitStrings.forgeLoginSessionName(kind),
      ),
      ...forgeLoginSession(kind),
      createdAt: new Date().toISOString(),
    };
    const started = await execute(async () => {
      if (sessionLaunchBlocked(current.current.workspace, projectId))
        throw new LocalizedOperationError(s.issueAgentProjectDisconnected);
      await api.saveAgentSession(session);
      try {
        await start(session.id);
      } catch (reason) {
        await api.deleteAgentSession(session.id).catch(() => {});
        throw reason;
      }
    });
    if (!started) return;
    setForgeLoginSessionIds((ids) => new Set(ids).add(session.id));
    if ((await selectSession(session)) && gitPanelExpanded)
      onGitPanelExpandedChange?.(false);
  }

  return { resolveMergeConflict, startForgeLogin, forgeLoginRevision };
}
