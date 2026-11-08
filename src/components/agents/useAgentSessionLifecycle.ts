import type { Dispatch, RefObject, SetStateAction } from "react";
import * as api from "../../data/agentSessionsApi";
import {
  sessionLaunchBlocked,
  type AgentSession,
  type AgentSessionStatus,
  type AgentWorkspace,
} from "../../domain/agentSessions";
import type { DesignLaunchFrames } from "../../domain/design";
import type { KanbanIssueLaunch } from "../../domain/kanbanAgent";
import { useAgentStrings } from "./agentStrings";
import { LocalizedOperationError } from "./operationError";

/** A launch prompt with its attachments: issue images or Design frames. */
export type AgentLaunch = KanbanIssueLaunch & {
  designFrames?: DesignLaunchFrames | null;
};
export type StartAgentSession = (
  id: string,
  known?: AgentSessionStatus,
  launch?: AgentLaunch | null,
) => Promise<AgentSessionStatus | undefined>;

/** Starts agent processes, publishes their running status at once and waits for their exit. */
export function useAgentSessionLifecycle({
  current,
  closing,
  isBusy,
  execute,
  fullWorkspace,
  terminalSplits,
  updateStatuses,
  bumpRevision,
  setStartingSessionId,
  setFocusRequest,
  setLaunchFailed,
}: {
  current: RefObject<{
    workspace: AgentWorkspace;
    fullWorkspace: AgentWorkspace;
  }>;
  closing: RefObject<boolean>;
  isBusy: () => boolean;
  execute: (work: () => Promise<void>) => Promise<boolean>;
  fullWorkspace: AgentWorkspace;
  terminalSplits: Record<string, string>;
  updateStatuses: (statuses: AgentSessionStatus[]) => void;
  bumpRevision: (id: string) => void;
  setStartingSessionId: (id: string | null) => void;
  setFocusRequest: Dispatch<SetStateAction<number>>;
  setLaunchFailed: (id: string | null) => void;
}) {
  const s = useAgentStrings();

  async function start(
    id: string,
    known = current.current.workspace.statuses.find(
      (status) => status.sessionId === id,
    ),
    launch: AgentLaunch | null = null,
  ) {
    const session = current.current.fullWorkspace.sessions.find(
      (item) => item.id === id,
    );
    if (
      session &&
      sessionLaunchBlocked(current.current.workspace, session.projectId)
    )
      return;
    await (launch
      ? api.startAgentSession(
          id,
          undefined,
          undefined,
          launch.prompt,
          launch.imageNames,
          launch.issueFile,
          launch.imageUrls,
          launch.imageTargets,
          ...(launch.designFrames ? [launch.designFrames] : []),
        )
      : api.startAgentSession(id));
    const runningStatus: AgentSessionStatus = {
      ...known,
      sessionId: id,
      state: "running",
      exitCode: null,
      missingExecutable: false,
      working: null,
    };
    updateStatuses([
      ...current.current.workspace.statuses.filter(
        (status) => status.sessionId !== id,
      ),
      runningStatus,
    ]);
    bumpRevision(id);
    return runningStatus;
  }

  async function launch(session: AgentSession, focusOnSuccess = true) {
    if (
      closing.current ||
      isBusy() ||
      sessionLaunchBlocked(current.current.workspace, session.projectId)
    )
      return;
    let failedSessionId = session.id;
    setStartingSessionId(session.id);
    try {
      if (
        await execute(async () => {
          let statuses = await api.listAgentStatuses();
          updateStatuses(statuses);
          for (const id of [session.id, terminalSplits[session.id]].filter(
            (id): id is string => !!id,
          )) {
            const status = statuses.find((status) => status.sessionId === id);
            if (status?.state === "running") continue;
            try {
              const runningStatus = await start(id, status);
              if (!runningStatus) continue;
              statuses = [
                ...statuses.filter((status) => status.sessionId !== id),
                runningStatus,
              ];
              updateStatuses(statuses);
            } catch (reason) {
              updateStatuses(statuses);
              failedSessionId = id;
              throw reason;
            }
          }
        })
      ) {
        if (focusOnSuccess) setFocusRequest((value) => value + 1);
      } else setLaunchFailed(failedSessionId);
    } finally {
      setStartingSessionId(null);
    }
  }

  async function waitForExit(id: string) {
    const deadline = Date.now() + 5000;
    while (true) {
      const statuses = await api.listAgentStatuses();
      updateStatuses(statuses);
      const status = statuses.find((item) => item.sessionId === id);
      if (status?.state !== "running") return status;
      if (Date.now() >= deadline)
        throw new LocalizedOperationError(s.stopTimeout);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function stopProjectSessions(projectIds: string[]) {
    const statuses = await api.listAgentStatuses();
    updateStatuses(statuses);
    // Hidden Design sessions hold the folder too: removal must stop them as well.
    const running = fullWorkspace.sessions.filter(
      (session) =>
        projectIds.includes(session.projectId) &&
        statuses.some(
          (status) =>
            status.sessionId === session.id && status.state === "running",
        ),
    );
    await Promise.all(
      running.map((session) => api.stopAgentSession(session.id)),
    );
    await Promise.all(running.map((session) => waitForExit(session.id)));
  }

  return { start, launch, waitForExit, stopProjectSessions };
}
