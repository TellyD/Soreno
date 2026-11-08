import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteAgentProject,
  listAgentBranches,
  listAgentStatuses,
  listAgentWorktrees,
  loadAgentWorkspace,
  saveAgentSession,
  startAgentSession,
  stopAgentSession,
  updateAgentProjectAppearance,
  updateAgentProjectGroupAppearance,
} from "../data/agentSessionsApi";
import {
  agentSessionActivity,
  type AgentProjectAppearance,
  type AgentProjectWorktree,
  type AgentProjectWorktreeGroup,
  type AgentSession,
  type AgentSessionStatus,
  type AgentWorkspace,
} from "../domain/agentSessions";
import { asError, errorMessage } from "../domain/errors";
import {
  projectServiceKey,
  type ProjectService,
} from "../domain/projectServices";
import {
  keepDisconnectedWorktreeGroups,
  mergePartialWorktreeGroups,
  orphanedWorktreeProjectIds,
  preserveGroupingWhileRefreshing,
  projectTarget,
  readBranchCache,
  readWorktreeCache,
  workspaceProjectScope,
  worktreeAliasIds,
  writeBranchCache,
  writeWorktreeCache,
} from "./agentWorktreeTopology";

const emptyWorkspace: AgentWorkspace = {
  projects: [],
  sessions: [],
  statuses: [],
};
const emptyWorktreeGroups: AgentProjectWorktreeGroup[] = [];
const topologyPollDelay = 5000;
type AppearanceTarget = "projects" | "groups";
const incompleteTopologyRetryDelay = 500;
/** Keeps the failing service identifiable so the UI can describe it in the active locale. */
export class AgentServiceError extends Error {
  constructor(
    readonly failure: "start" | "stopTimeout",
    readonly serviceLabel: string,
    cause?: unknown,
  ) {
    super(cause === undefined ? failure : errorMessage(cause));
  }
}
const values = <T>(value: T | readonly T[]): readonly T[] =>
  Array.isArray(value) ? value : [value as T];
const serviceSession = (
  workspace: AgentWorkspace,
  projectId: string,
  service: ProjectService,
): AgentSession => {
  const existing = workspace.sessions.find(
    (session) =>
      session.projectId === projectId &&
      session.kind === "service" &&
      session.serviceId === service.id,
  );
  return {
    id: existing?.id ?? crypto.randomUUID(),
    projectId,
    name: service.label,
    kind: "service",
    serviceId: service.id,
    workingDirectory: service.cwd,
    executable: service.executable,
    args: service.args,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
};

export function useAgentSessions(
  pollProjectTopology = true,
  retainedProjectId?: { readonly current: string | null },
) {
  const [desktop] = useState(isTauri);
  const [workspace, setWorkspace] = useState<AgentWorkspace>(emptyWorkspace);
  const [hasLoaded, setHasLoaded] = useState(!desktop);
  const [loading, setLoading] = useState(desktop);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pendingServiceKeys, setPendingServiceKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const [branchError, setBranchError] = useState<string | null>(null);
  const [worktreeGrouping, setWorktreeGrouping] = useState(() => {
    const cached = readWorktreeCache();
    return cached.scope ? { ...cached, refreshing: true } : cached;
  });
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [missingProjectIds, setMissingProjectIds] = useState<readonly string[]>(
    [],
  );
  const [completeWorktreeScope, setCompleteWorktreeScope] = useState<
    string | null
  >(null);
  const [branchRevision, setBranchRevision] = useState(0);
  const branchPollGeneration = useRef(0);
  const branchReadInFlight = useRef(false);
  const branchRereadPending = useRef(false);
  // When the read behind each project's shown branch started; older observations lose.
  const branchAppliedAt = useRef<Record<string, number>>({});
  const wakeTopologyPoll = useRef<(() => void) | undefined>(undefined);
  const worktreePollGeneration = useRef(0);
  const workspaceRef = useRef(emptyWorkspace);
  // Latest queued branch map; reads must not wait for React to render it.
  const branchesRef = useRef(branches);
  const updateBranches = useCallback(
    (
      update: (
        current: Record<string, string | null>,
      ) => Record<string, string | null>,
    ) => {
      const next = update(branchesRef.current);
      if (next === branchesRef.current) return;
      branchesRef.current = next;
      setBranches(next);
    },
    [],
  );
  const publishBranch = useCallback(
    (projectId: string, branch: string | null, startedAt: number) => {
      const projectIds = worktreeAliasIds(worktreeGrouping.groups, projectId);
      for (const id of projectIds) branchAppliedAt.current[id] = startedAt;
      updateBranches((current) => {
        if (projectIds.every((id) => current[id] === branch)) return current;
        return Object.fromEntries([
          ...Object.entries(current),
          ...projectIds.map((id) => [id, branch] as const),
        ]);
      });
      // A confirmed branch must survive a restart before the next poll lands.
      writeBranchCache(
        workspaceRef.current.projects,
        Object.fromEntries(projectIds.map((id) => [id, branch] as const)),
        readBranchCache(),
      );
    },
    [updateBranches, worktreeGrouping.groups],
  );
  const refreshBranches = useCallback(
    (projectId?: string, branch?: string | null) => {
      branchPollGeneration.current += 1;
      if (projectId && branch !== undefined)
        publishBranch(projectId, branch, Date.now());
      setBranchRevision((value) => value + 1);
    },
    [publishBranch],
  );
  const publishBranchRef = useRef(publishBranch);
  publishBranchRef.current = publishBranch;
  const worktreeGroupingRef = useRef(worktreeGrouping);
  worktreeGroupingRef.current = worktreeGrouping;
  // Git panels read HEAD sooner than the topology poll; publish what they saw.
  const observeBranch = useCallback(
    (projectId: string, branch: string, startedAt: number) => {
      // Aliases share one HEAD, so the freshest stamp among them decides.
      const projectIds = worktreeAliasIds(
        worktreeGroupingRef.current.groups,
        projectId,
      );
      const appliedAt = Math.max(
        ...projectIds.map((id) => branchAppliedAt.current[id] ?? -Infinity),
      );
      if (startedAt < appliedAt) return;
      if (projectIds.every((id) => branchesRef.current[id] === branch)) {
        // Already shown: only record that this newer read confirmed it.
        for (const id of projectIds) branchAppliedAt.current[id] = startedAt;
        return;
      }
      branchPollGeneration.current += 1;
      publishBranchRef.current(projectId, branch, startedAt);
      setBranchRevision((value) => value + 1);
    },
    [],
  );
  const rememberWorktreeProject = useCallback(
    (
      repositoryProjectId: string,
      projectId: string,
      worktree: Omit<AgentProjectWorktree, "projectIds">,
    ) => {
      worktreePollGeneration.current += 1;
      setWorktreeGrouping((current) => ({
        ...current,
        groups: current.groups.map((group) => {
          if (
            group.repositoryProjectId !== repositoryProjectId &&
            !group.projectIds.includes(repositoryProjectId)
          )
            return group;
          const existing = group.worktrees.find(
            (candidate) => candidate.path === worktree.path,
          );
          return {
            ...group,
            projectIds: group.projectIds.includes(projectId)
              ? group.projectIds
              : [...group.projectIds, projectId],
            worktrees: existing
              ? group.worktrees.map((candidate) =>
                  candidate !== existing ||
                  candidate.projectIds.includes(projectId)
                    ? candidate
                    : {
                        ...candidate,
                        projectIds: [...candidate.projectIds, projectId],
                      },
                )
              : [...group.worktrees, { ...worktree, projectIds: [projectId] }],
          };
        }),
      }));
    },
    [],
  );
  const forgetWorktree = useCallback(
    (repositoryProjectId: string, path: string) => {
      worktreePollGeneration.current += 1;
      setWorktreeGrouping((current) => ({
        ...current,
        groups: current.groups.map((group) =>
          group.repositoryProjectId === repositoryProjectId
            ? {
                ...group,
                worktrees: group.worktrees.filter(
                  (worktree) => worktree.path !== path,
                ),
              }
            : group,
        ),
      }));
    },
    [],
  );
  const inFlight = useRef(false);
  // A refresh requested while busy runs once afterwards, so the in-flight snapshot can't stay installed.
  const retryQueued = useRef(false);
  const mutationRevision = useRef(0);
  // Confirmed orphans survive failed deletions and the post-deletion scope change.
  // shortcut: candidates live in memory only; a retained or refused orphan is forgotten on restart, persist them if users report leftovers.
  const orphanCandidates = useRef(new Set<string>());
  const mounted = useRef(false);
  // A reload started before an appearance update was confirmed may return the older appearance.
  const appearanceRevision = useRef(0);
  const confirmedAppearance = useRef(
    new Map<string, { appearance: AgentProjectAppearance; revision: number }>(),
  );

  const saveServiceSession = useCallback(async (session: AgentSession) => {
    await saveAgentSession(session);
    const current = workspaceRef.current;
    workspaceRef.current = {
      ...current,
      sessions: [
        ...current.sessions.filter((item) => item.id !== session.id),
        session,
      ],
    };
  }, []);

  const reload = useCallback(async () => {
    if (!desktop) return;
    try {
      const startRevision = appearanceRevision.current;
      const loaded = await loadAgentWorkspace();
      if (mounted.current) {
        for (const [id, confirmed] of confirmedAppearance.current)
          if (confirmed.revision <= startRevision)
            confirmedAppearance.current.delete(id);
        const withConfirmed = <T extends { id: string }>(
          target: AppearanceTarget,
          item: T,
        ): T => {
          const confirmed = confirmedAppearance.current.get(
            `${target}:${item.id}`,
          );
          return confirmed ? { ...item, ...confirmed.appearance } : item;
        };
        const next =
          confirmedAppearance.current.size === 0
            ? loaded
            : {
                ...loaded,
                projects: loaded.projects.map((project) =>
                  withConfirmed("projects", project),
                ),
                groups: loaded.groups?.map((group) =>
                  withConfirmed("groups", group),
                ),
              };
        const previous = workspaceRef.current;
        workspaceRef.current = next;
        if (workspaceProjectScope(previous) !== workspaceProjectScope(next))
          setCompleteWorktreeScope(null);
        setWorktreeGrouping((current) =>
          preserveGroupingWhileRefreshing(current, previous, next),
        );
        const unchangedIds = new Set(
          next.projects.flatMap((project) => {
            const prior = previous.projects.find(
              (item) => item.id === project.id,
            );
            return prior && projectTarget(prior) === projectTarget(project)
              ? [project.id]
              : [];
          }),
        );
        setMissingProjectIds((current) => {
          const kept = current.filter((id) => unchangedIds.has(id));
          return kept.length === current.length ? current : kept;
        });
        const cachedBranches = readBranchCache();
        updateBranches((current) => {
          const branches = Object.fromEntries(
            next.projects.flatMap((project) => {
              if (unchangedIds.has(project.id) && project.id in current)
                return [[project.id, current[project.id]] as const];
              // Last known branch avoids a startup spinner until the first slow Git probe returns.
              const cached = cachedBranches[project.id];
              return cached?.target === projectTarget(project)
                ? [[project.id, cached.branch] as const]
                : [];
            }),
          );
          return JSON.stringify(branches) === JSON.stringify(current)
            ? current
            : branches;
        });
        setWorkspace(next);
        setHasLoaded(true);
        setLoadError(null);
      }
    } catch (reason) {
      if (mounted.current) setLoadError(errorMessage(reason));
      throw reason;
    }
  }, [desktop, updateBranches]);

  const updateStatuses = useCallback((statuses: AgentSessionStatus[]) => {
    setWorkspace((current) =>
      JSON.stringify(current.statuses) === JSON.stringify(statuses)
        ? current
        : { ...current, statuses },
    );
  }, []);

  // The queued follow-up is a plain reload so it keeps a failed mutation's error.
  const refreshQueued = useCallback(async () => {
    while (retryQueued.current && mounted.current && !inFlight.current) {
      retryQueued.current = false;
      inFlight.current = true;
      try {
        await reload();
      } catch {
        /* reload owns the workspace error. */
      } finally {
        inFlight.current = false;
      }
    }
  }, [reload]);

  const retry = useCallback(async (): Promise<boolean> => {
    if (!desktop) return false;
    if (inFlight.current) {
      retryQueued.current = true;
      return false;
    }
    inFlight.current = true;
    setLoading(true);
    setLoadError(null);
    setError(null);
    try {
      await reload();
      return true;
    } catch {
      /* reload owns the workspace error. */
      return false;
    } finally {
      inFlight.current = false;
      await refreshQueued();
      if (mounted.current) setLoading(false);
    }
  }, [desktop, reload, refreshQueued]);

  // Appearance only: no global busy state, so the workspace does not flash on each pick.
  // Picks are merged per project or group and sent as deltas by a single serialized drain, so the latest pick persists last.
  const pendingAppearance = useRef(
    new Map<
      string,
      {
        target: AppearanceTarget;
        id: string;
        change: AgentProjectAppearance;
        settle: ((saved: boolean) => void)[];
      }
    >(),
  );
  const appearanceDraining = useRef(false);
  const appearanceIdle = useRef<(() => void)[]>([]);
  const saveAppearance = useCallback(
    (target: AppearanceTarget, id: string, change: AgentProjectAppearance) => {
      if (!desktop) return Promise.resolve(false);
      const key = `${target}:${id}`;
      const saved = new Promise<boolean>((resolve) => {
        const batch = pendingAppearance.current.get(key);
        if (batch) {
          batch.change = { ...batch.change, ...change };
          batch.settle.push(resolve);
        } else
          pendingAppearance.current.set(key, {
            target,
            id,
            change: { ...change },
            settle: [resolve],
          });
      });
      if (appearanceDraining.current) return saved;
      appearanceDraining.current = true;
      void (async () => {
        if (mounted.current) setError(null);
        try {
          // Entries re-added for a target while its batch is in flight are visited again.
          for (const [key, batch] of pendingAppearance.current) {
            pendingAppearance.current.delete(key);
            let succeeded = false;
            try {
              const { icon, color, iconDataUrl } = await (
                batch.target === "projects"
                  ? updateAgentProjectAppearance
                  : updateAgentProjectGroupAppearance
              )(batch.id, batch.change);
              const appearance = { icon, color, iconDataUrl };
              appearanceRevision.current += 1;
              confirmedAppearance.current.set(key, {
                appearance,
                revision: appearanceRevision.current,
              });
              // Only appearance: other fields may come from a newer full save.
              const patch = <T extends { id: string }>(items: T[]) =>
                items.map((item) =>
                  item.id === batch.id ? { ...item, ...appearance } : item,
                );
              const replace = (current: AgentWorkspace) =>
                batch.target === "projects"
                  ? { ...current, projects: patch(current.projects) }
                  : {
                      ...current,
                      groups: current.groups && patch(current.groups),
                    };
              workspaceRef.current = replace(workspaceRef.current);
              if (mounted.current) setWorkspace(replace);
              succeeded = true;
            } catch (reason) {
              if (mounted.current) setError(asError(reason));
            }
            for (const settle of batch.settle) settle(succeeded);
          }
        } finally {
          appearanceDraining.current = false;
          for (const resolve of appearanceIdle.current.splice(0)) resolve();
        }
      })();
      return saved;
    },
    [desktop],
  );
  const saveProjectAppearance = useCallback(
    (projectId: string, change: AgentProjectAppearance) =>
      saveAppearance("projects", projectId, change),
    [saveAppearance],
  );
  const saveGroupAppearance = useCallback(
    (groupId: string, change: AgentProjectAppearance) =>
      saveAppearance("groups", groupId, change),
    [saveAppearance],
  );
  // Resolves with the hook's own snapshot: React may not have rendered the last saved appearance yet.
  const waitForProjectAppearance = useCallback(async () => {
    while (appearanceDraining.current)
      await new Promise<void>((resolve) =>
        appearanceIdle.current.push(resolve),
      );
    return workspaceRef.current;
  }, []);
  const hasPendingProjectAppearance = useCallback(
    () => appearanceDraining.current,
    [],
  );

  useEffect(() => {
    mounted.current = true;
    void retry();
    return () => {
      mounted.current = false;
    };
  }, [retry]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const revision = mutationRevision.current;
      try {
        const statuses = await listAgentStatuses();
        if (
          !cancelled &&
          !inFlight.current &&
          revision === mutationRevision.current
        ) {
          updateStatuses(statuses);
          setStatusError(null);
        }
      } catch (reason) {
        if (!cancelled) setStatusError(errorMessage(reason));
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 1000);
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [desktop, updateStatuses]);

  const workingKey = workspace.statuses
    .filter((status) => agentSessionActivity(status) === "working")
    .map((status) => status.sessionId)
    .join("\n");
  const previousWorkingKey = useRef(workingKey);
  useEffect(() => {
    const stillWorking = new Set(workingKey.split("\n"));
    const ended = previousWorkingKey.current
      .split("\n")
      .some((id) => id && !stillWorking.has(id));
    previousWorkingKey.current = workingKey;
    // An agent turn may have switched branches without any Git panel open.
    if (ended) wakeTopologyPoll.current?.();
  }, [workingKey]);

  const projectScope = workspaceProjectScope(workspace);
  const hasCurrentWorktrees =
    hasLoaded && worktreeGrouping.scope === projectScope;
  const worktrees = hasCurrentWorktrees
    ? worktreeGrouping.groups
    : emptyWorktreeGroups;
  const worktreesLoaded =
    !desktop ||
    !!loadError ||
    (hasLoaded &&
      (workspace.projects.length === 0 ||
        (hasCurrentWorktrees && !worktreeGrouping.refreshing)));
  const worktreesComplete =
    !desktop ||
    (hasLoaded &&
      (workspace.projects.length === 0 ||
        completeWorktreeScope === projectScope));

  useEffect(() => {
    if (!pollProjectTopology || !desktop || !hasLoaded) return;
    if (workspace.projects.length === 0) {
      setWorktreeGrouping({ scope: projectScope, groups: [] });
      setWorktreeError(null);
      writeWorktreeCache(projectScope, []);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    let wakePending = false;
    let hasMatchingGrouping =
      worktreeGrouping.scope === projectScope && !worktreeGrouping.refreshing;
    let hasSettledGrouping = hasMatchingGrouping;
    const scopeIsCurrent = () =>
      !cancelled &&
      workspaceProjectScope(workspaceRef.current) === projectScope;
    // Removed elsewhere (another Soreno instance, `git worktree remove`): drop the stale rows.
    // shortcut: deletion does not recheck the path; a worktree re-registered at the same path within one poll would lose its project, add a conditional backend delete if that happens.
    // shortcut: manual project group membership is not handed over to sibling worktrees, unlike in-app removal; reuse handOverGroupMembership if users group worktrees.
    async function removeOrphanedProjects(projectIds: string[]) {
      if (inFlight.current) return;
      inFlight.current = true;
      mutationRevision.current += 1;
      let removed = false;
      try {
        for (const projectId of projectIds) {
          try {
            await deleteAgentProject(projectId);
            orphanCandidates.current.delete(projectId);
            removed = true;
          } catch {
            /* Busy Git, a running session or an automation: retried on the next complete poll. */
          }
        }
        if (removed) await reload();
      } catch {
        /* reload owns the workspace error. */
      } finally {
        inFlight.current = false;
        await refreshQueued();
      }
    }
    function readBranches(rereadIfBusy: boolean) {
      if (branchReadInFlight.current) {
        // The running read may predate the change that woke this poll.
        if (rereadIfBusy) branchRereadPending.current = true;
        return;
      }
      branchReadInFlight.current = true;
      const startedAt = Date.now();
      const revision = mutationRevision.current;
      const generation = branchPollGeneration.current;
      const responseIsCurrent = () =>
        scopeIsCurrent() &&
        !inFlight.current &&
        revision === mutationRevision.current &&
        generation === branchPollGeneration.current;
      void listAgentBranches()
        .then((entries) => {
          if (!responseIsCurrent()) return;
          // Projects confirmed by a newer read keep their value and stamp; dormant
          // projects keep their last known branch until their server is reached.
          const dormantIds = new Set(
            workspaceRef.current.dormantProjectIds ?? [],
          );
          const keptIds = new Set([
            ...Object.keys(branchAppliedAt.current).filter(
              (id) => branchAppliedAt.current[id] > startedAt,
            ),
            // Unknown dormant branches take the backend null, else the rail spins forever.
            ...[...dormantIds].filter(
              (id) => branchesRef.current[id] !== undefined,
            ),
          ]);
          const taken = Object.fromEntries(
            entries
              .filter(({ projectId }) => !keptIds.has(projectId))
              .map(({ projectId, branch }) => [projectId, branch]),
          );
          for (const projectId of Object.keys(taken))
            branchAppliedAt.current[projectId] = startedAt;
          updateBranches((current) => {
            const next = { ...taken };
            for (const id of keptIds) if (id in current) next[id] = current[id];
            const keys = Object.keys(next);
            return keys.length === Object.keys(current).length &&
              keys.every((id) => id in current && current[id] === next[id])
              ? current
              : next;
          });
          const cached = readBranchCache();
          writeBranchCache(
            workspaceRef.current.projects,
            Object.fromEntries(
              Object.entries(taken).filter(([id]) => !dormantIds.has(id)),
            ),
            Object.fromEntries(
              Object.entries(cached).filter(
                ([id]) => keptIds.has(id) || dormantIds.has(id),
              ),
            ),
          );
          setBranchError(null);
        })
        .catch((reason) => {
          // Keep the last known branches, but never disguise an IPC failure as missing Git data.
          if (responseIsCurrent()) setBranchError(errorMessage(reason));
        })
        .finally(() => {
          branchReadInFlight.current = false;
          const reread = branchRereadPending.current;
          branchRereadPending.current = false;
          if (cancelled) {
            if (mounted.current) setBranchRevision((value) => value + 1);
          } else if (reread) readBranches(false);
        });
    }
    async function poll(woken = false) {
      polling = true;
      const revision = mutationRevision.current;
      const generation = worktreePollGeneration.current;
      const responseIsCurrent = () =>
        scopeIsCurrent() &&
        !inFlight.current &&
        revision === mutationRevision.current &&
        generation === worktreePollGeneration.current;
      let retryIncompleteTopology = false;
      readBranches(woken);
      try {
        const snapshot = await listAgentWorktrees();
        if (!responseIsCurrent()) return;
        setWorktreeError(null);
        setMissingProjectIds((current) =>
          JSON.stringify(current) === JSON.stringify(snapshot.missingProjectIds)
            ? current
            : snapshot.missingProjectIds,
        );
        const known = worktreeGroupingRef.current;
        const knownGroups = known.scope === projectScope ? known.groups : [];
        const candidates = orphanCandidates.current;
        // Partial snapshots still prove removal; their merge would forget the old path.
        for (const id of orphanedWorktreeProjectIds(
          knownGroups,
          snapshot.groups,
          snapshot.missingProjectIds,
        ))
          candidates.add(id);
        if (snapshot.complete) {
          const missing = new Set(snapshot.missingProjectIds);
          const projectIds = new Set(
            workspaceRef.current.projects.map(({ id }) => id),
          );
          for (const id of candidates)
            if (!missing.has(id) || !projectIds.has(id)) candidates.delete(id);
          // Deleting the open project would drop its unsaved editor buffer without confirmation.
          const orphanIds = [...candidates].filter(
            (id) => id !== retainedProjectId?.current,
          );
          const groups = keepDisconnectedWorktreeGroups(
            knownGroups,
            snapshot.groups,
            workspaceRef.current.disconnectedProjectIds ?? [],
          );
          setWorktreeGrouping((current) =>
            current.scope === projectScope &&
            !current.refreshing &&
            JSON.stringify(current.groups) === JSON.stringify(groups)
              ? current
              : { scope: projectScope, groups },
          );
          setCompleteWorktreeScope(projectScope);
          hasMatchingGrouping = true;
          hasSettledGrouping = true;
          writeWorktreeCache(projectScope, groups);
          if (orphanIds.length > 0) await removeOrphanedProjects(orphanIds);
        } else {
          retryIncompleteTopology = !hasSettledGrouping;
          const hasRefreshingFallback =
            worktreeGrouping.scope === projectScope &&
            worktreeGrouping.refreshing &&
            worktreeGrouping.groups.length > 0;
          setWorktreeGrouping((current) => {
            let groups = current.scope === projectScope ? current.groups : [];
            if (!hasMatchingGrouping && !hasRefreshingFallback) {
              groups = snapshot.groups;
            } else if (snapshot.groups.length > 0) {
              groups = mergePartialWorktreeGroups(
                groups,
                snapshot.groups,
                workspace.projects,
              );
            }
            return current.scope === projectScope &&
              current.refreshing === undefined &&
              JSON.stringify(current.groups) === JSON.stringify(groups)
              ? current
              : { scope: projectScope, groups };
          });
          hasMatchingGrouping = true;
          hasSettledGrouping = true;
        }
      } catch (reason) {
        if (!responseIsCurrent()) return;
        setWorktreeGrouping((current) =>
          current.scope === projectScope
            ? { scope: projectScope, groups: current.groups }
            : { scope: projectScope, groups: [] },
        );
        hasSettledGrouping = true;
        setWorktreeError(errorMessage(reason));
      } finally {
        polling = false;
        if (scopeIsCurrent()) {
          const woke = wakePending;
          wakePending = false;
          timer = setTimeout(
            () => void poll(woke),
            woke
              ? 0
              : retryIncompleteTopology
                ? incompleteTopologyRetryDelay
                : topologyPollDelay,
          );
        }
      }
    }
    // Coalesces wakes: one in-flight read leaves exactly one immediate follow-up.
    const wake = () => {
      if (polling) {
        wakePending = true;
        return;
      }
      clearTimeout(timer);
      void poll(true);
    };
    wakeTopologyPoll.current = wake;
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (wakeTopologyPoll.current === wake)
        wakeTopologyPoll.current = undefined;
    };
  }, [
    pollProjectTopology,
    desktop,
    hasLoaded,
    projectScope,
    workspace.projects.length,
    branchRevision,
    updateBranches,
    reload,
    refreshQueued,
    retainedProjectId,
  ]);

  const execute = useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      if (inFlight.current || !desktop) return false;
      inFlight.current = true;
      mutationRevision.current += 1;
      setBusy(true);
      setError(null);
      let succeeded = true;
      try {
        await work();
      } catch (reason) {
        succeeded = false;
        if (mounted.current) setError(asError(reason));
      }
      // A launcher may have been saved even if starting its process failed.
      try {
        await reload();
      } catch (reason) {
        succeeded = false;
        if (mounted.current) setError(asError(reason));
      } finally {
        inFlight.current = false;
        // Callers open or launch right after, which a still-held lock would refuse.
        await refreshQueued();
        if (mounted.current) setBusy(false);
      }
      return succeeded;
    },
    [desktop, reload, refreshQueued],
  );

  const runServiceOperation = useCallback(
    async (
      projectId: string,
      serviceIds: readonly string[],
      work: () => Promise<void>,
    ) => {
      const keys = serviceIds.map((id) => projectServiceKey(projectId, id));
      setPendingServiceKeys((current) => new Set([...current, ...keys]));
      try {
        return await execute(work);
      } finally {
        if (mounted.current)
          setPendingServiceKeys((current) => {
            const next = new Set(current);
            keys.forEach((key) => next.delete(key));
            return next;
          });
      }
    },
    [execute],
  );

  const synchronizeServiceSessions = useCallback(
    async (
      projectId: string,
      services: ProjectService | readonly ProjectService[],
    ) => {
      const requested = values(services);
      if (requested.length === 0) return true;
      return runServiceOperation(
        projectId,
        requested.map((service) => service.id),
        async () => {
          const snapshot = workspaceRef.current;
          for (const service of requested)
            await saveServiceSession(
              serviceSession(snapshot, projectId, service),
            );
        },
      );
    },
    [runServiceOperation, saveServiceSession],
  );

  const startServices = useCallback(
    async (
      projectId: string,
      services: ProjectService | readonly ProjectService[],
    ) => {
      const requested = values(services);
      if (requested.length === 0) return true;
      return runServiceOperation(
        projectId,
        requested.map((service) => service.id),
        async () => {
          const snapshot = workspaceRef.current;
          const sessions = requested.map((service) =>
            serviceSession(snapshot, projectId, service),
          );
          const statuses = await listAgentStatuses();
          updateStatuses(statuses);
          const runningIds = new Set(
            statuses
              .filter((status) => status.state === "running")
              .map((status) => status.sessionId),
          );
          const launches = sessions.filter(
            (session) => !runningIds.has(session.id),
          );
          for (const session of launches) await saveServiceSession(session);
          for (const session of launches) {
            try {
              await startAgentSession(session.id);
            } catch (reason) {
              throw new AgentServiceError("start", session.name, reason);
            }
          }
        },
      );
    },
    [runServiceOperation, saveServiceSession, updateStatuses],
  );

  const stopServices = useCallback(
    async (projectId: string, serviceIds: string | readonly string[]) => {
      const requestedIds = new Set(values(serviceIds));
      const sessions = workspaceRef.current.sessions.filter(
        (session) =>
          session.projectId === projectId &&
          session.kind === "service" &&
          !!session.serviceId &&
          requestedIds.has(session.serviceId),
      );
      if (sessions.length === 0) return true;
      return runServiceOperation(
        projectId,
        sessions.map((session) => session.serviceId!),
        async () => {
          const statuses = await listAgentStatuses();
          updateStatuses(statuses);
          const runningIds = new Set(
            statuses
              .filter((status) => status.state === "running")
              .map((status) => status.sessionId),
          );
          for (const session of sessions)
            if (runningIds.has(session.id)) await stopAgentSession(session.id);
        },
      );
    },
    [runServiceOperation, updateStatuses],
  );

  const restartService = useCallback(
    async (projectId: string, service: ProjectService) => {
      return runServiceOperation(projectId, [service.id], async () => {
        const snapshot = workspaceRef.current;
        const session = serviceSession(snapshot, projectId, service);
        let statuses = await listAgentStatuses();
        updateStatuses(statuses);
        const wasRunning = statuses.some(
          (status) =>
            status.sessionId === session.id && status.state === "running",
        );
        if (wasRunning) {
          await stopAgentSession(session.id);
          const deadline = Date.now() + 5000;
          do {
            statuses = await listAgentStatuses();
            updateStatuses(statuses);
            if (
              !statuses.some(
                (status) =>
                  status.sessionId === session.id && status.state === "running",
              )
            )
              break;
            if (Date.now() >= deadline)
              throw new AgentServiceError("stopTimeout", service.label);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (true);
        }
        await saveServiceSession(session);
        try {
          await startAgentSession(session.id);
        } catch (reason) {
          throw new AgentServiceError("start", service.label, reason);
        }
      });
    },
    [runServiceOperation, saveServiceSession, updateStatuses],
  );

  const isBusy = useCallback(() => inFlight.current, []);
  return {
    desktop,
    workspace,
    branches,
    branchError,
    branchRevision,
    worktrees,
    worktreeError,
    missingProjectIds,
    worktreesLoaded,
    worktreesComplete,
    hasLoaded,
    loading,
    loadError,
    busy,
    isBusy,
    error,
    pendingServiceKeys,
    statusError,
    setError,
    retry,
    execute,
    saveProjectAppearance,
    saveGroupAppearance,
    waitForProjectAppearance,
    hasPendingProjectAppearance,
    updateStatuses,
    synchronizeServiceSessions,
    startServices,
    stopServices,
    restartService,
    refreshBranches,
    observeBranch,
    rememberWorktreeProject,
    forgetWorktree,
  };
}
