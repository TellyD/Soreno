import {
  designProjectId,
  agentEnvironmentKey,
  orderAgentItems,
  agentProjectNameFromPath,
  pinnedAgentItemsFirst,
  type AgentProject,
  type AgentProjectGroupRecord,
  type AgentProjectWorktree,
  type AgentProjectWorktreeGroup,
  type AgentSession,
  type AgentSessionStatus,
  type AgentWorkspace,
} from "./agentSessions";
import type { AgentSessionAttention } from "./agentAttention";
import type { ProjectService } from "./projectServices";

export const worktreeName = (
  worktree: AgentProjectWorktree,
  branch = worktree.branch,
) => branch ?? agentProjectNameFromPath(worktree.path);

/** The agents space without Design boards' sessions and synthetic project; statuses stay for the Design view. */
export function agentsSpaceWorkspace(
  workspace: AgentWorkspace,
): AgentWorkspace {
  return {
    ...workspace,
    projects: workspace.projects.filter(({ id }) => id !== designProjectId),
    sessions: workspace.sessions.filter(
      (session) => !session.design && session.projectId !== designProjectId,
    ),
  };
}

/** Keeps only known projects; the repository falls back to the first surviving member. */
export function railWorktreeGroups(
  groups: readonly AgentProjectWorktreeGroup[],
  projects: readonly AgentProject[],
): AgentProjectWorktreeGroup[] {
  const known = new Set(projects.map((project) => project.id));
  return groups.flatMap((group) => {
    const projectIds = group.projectIds.filter((id) => known.has(id));
    if (projectIds.length === 0) return [];
    const repositoryProjectId = projectIds.includes(group.repositoryProjectId)
      ? group.repositoryProjectId
      : projectIds[0];
    return [{ ...group, projectIds, repositoryProjectId }];
  });
}

/** A worktree with agents also marks its repository, which represents it in the rail. */
export function projectIdsWithAgents(
  sessions: readonly AgentSession[],
  closedSessionIds: ReadonlySet<string>,
  worktreeGroups: readonly AgentProjectWorktreeGroup[],
): Set<string> {
  const ids = new Set(
    sessions.flatMap((session) =>
      session.kind === "service" || closedSessionIds.has(session.id)
        ? []
        : [session.projectId],
    ),
  );
  for (const group of worktreeGroups)
    if (group.projectIds.some((id) => ids.has(id)))
      ids.add(group.repositoryProjectId);
  return ids;
}

/** Tabs in project order, pinned first; split children live inside their parent's tab. */
export function visibleAgentSessions({
  projects,
  sessions,
  tabOrder,
  pinnedIds,
  hiddenIds,
  closedIds,
  terminalSplits,
}: {
  projects: readonly AgentProject[];
  sessions: readonly AgentSession[];
  tabOrder: Readonly<Record<string, string[]>>;
  pinnedIds: ReadonlySet<string>;
  hiddenIds: ReadonlySet<string>;
  closedIds: ReadonlySet<string>;
  terminalSplits: Readonly<Record<string, string>>;
}): AgentSession[] {
  const splitChildIds = new Set(Object.values(terminalSplits));
  return projects
    .flatMap((project) =>
      pinnedAgentItemsFirst(
        orderAgentItems(
          sessions.filter(
            (session) =>
              session.projectId === project.id && session.kind !== "service",
          ),
          Object.prototype.hasOwnProperty.call(tabOrder, project.id)
            ? tabOrder[project.id]
            : [],
        ),
        pinnedIds,
      ),
    )
    .filter(
      (session) =>
        !hiddenIds.has(session.id) &&
        !closedIds.has(session.id) &&
        !splitChildIds.has(session.id),
    );
}

/** Rail priority view: waits then unread turns, then the other live sessions; the rest stays in the tree. */
export function agentPrioritySections(
  sessions: readonly AgentSession[],
  attentionOf: (id: string) => AgentSessionAttention | null,
  isLive: (id: string) => boolean,
) {
  const awaiting: AgentSession[] = [];
  const unread: AgentSession[] = [];
  const live: AgentSession[] = [];
  for (const session of sessions) {
    const mark = attentionOf(session.id);
    if (mark === "awaiting") awaiting.push(session);
    else if (mark === "unread") unread.push(session);
    else if (isLive(session.id)) live.push(session);
  }
  return { toHandle: [...awaiting, ...unread], live };
}

/** Service sessions missing from the manifest stay listed but cannot be launched again. */
export function agentServiceCatalog(
  manifestServices: readonly ProjectService[],
  serviceSessions: readonly AgentSession[],
  fallbackCwd: string,
): { services: ProjectService[]; launchableServiceIds: Set<string> } {
  const byId = new Map(
    manifestServices.map((service) => [service.id, service]),
  );
  const launchableServiceIds = new Set(byId.keys());
  for (const session of serviceSessions) {
    const id = session.serviceId;
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: session.name,
      cwd: session.workingDirectory ?? fallbackCwd,
      executable: session.executable,
      args: session.args,
    });
  }
  return { services: [...byId.values()], launchableServiceIds };
}

/**
 * Services follow the selected project's manual group, in group order; a selected
 * worktree of a grouped repository joins the group right after its repository.
 */
export function servicesScope(
  selected: AgentProject | undefined,
  groups: readonly AgentProjectGroupRecord[],
  worktreeGroups: readonly AgentProjectWorktreeGroup[],
  projects: readonly AgentProject[],
): { key: string; projects: AgentProject[] } | null {
  if (!selected) return null;
  const repositoryId =
    worktreeGroups.find((group) => group.projectIds.includes(selected.id))
      ?.repositoryProjectId ?? selected.id;
  const group = groups.find(
    (item) =>
      item.groupProjectId === selected.id ||
      item.projectIds.includes(repositoryId),
  );
  const insertWorktree =
    group &&
    group.groupProjectId !== selected.id &&
    !group.projectIds.includes(selected.id);
  const members = group
    ? group.projectIds.flatMap((id) => {
        const member = projects.filter((project) => project.id === id);
        return insertWorktree && id === repositoryId
          ? [...member, selected]
          : member;
      })
    : [selected];
  return {
    key: group ? `group:${group.id}` : selected.id,
    projects: members.filter((project) => project.environment.kind === "ssh"),
  };
}

export type SshConnectionState =
  "offline" | "dormant" | "starting" | "unknown" | "active" | "error" | "idle";

export function sshConnectionState({
  disconnected,
  dormant,
  sessions,
  statusOf,
  startingSessionId,
  failedSessionId,
  statusesUnreadable,
}: {
  disconnected: boolean;
  /** Not reached since launch; a starting session still shows as starting. */
  dormant: boolean;
  sessions: readonly AgentSession[];
  statusOf: (id: string) => AgentSessionStatus | undefined;
  startingSessionId: string | null;
  /** Session whose launch failed with a still displayed error. */
  failedSessionId: string | null;
  statusesUnreadable: boolean;
}): { state: SshConnectionState; activeCount: number } {
  const statuses = sessions.map((session) => statusOf(session.id));
  const activeCount = statuses.filter(
    (status) => status?.state === "running",
  ).length;
  const state: SshConnectionState = disconnected
    ? "offline"
    : sessions.some((session) => session.id === startingSessionId)
      ? "starting"
      : dormant
        ? "dormant"
        : statusesUnreadable || statuses.some((status) => !status)
          ? "unknown"
          : activeCount > 0
            ? "active"
            : sessions.some((session) => session.id === failedSessionId) ||
                statuses.some(
                  (status) =>
                    status?.state === "exited" &&
                    status.exitCode !== null &&
                    status.exitCode !== 0,
                )
              ? "error"
              : "idle";
  return { state, activeCount };
}

export function uniqueAgentSessionName(
  sessions: readonly AgentSession[],
  projectId: string,
  baseName: string,
): string {
  const names = new Set(
    sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.name),
  );
  let name = baseName;
  for (let number = 2; names.has(name); number++)
    name = `${baseName} ${number}`;
  return name;
}

/** Prefers projects already associated with the worktree, then any project on its path. */
export function findWorktreeProject(
  projects: readonly AgentProject[],
  group: AgentProjectWorktreeGroup | undefined,
  worktreePath: string,
  environmentKey: string,
): AgentProject | undefined {
  const matches = (project: AgentProject | undefined) =>
    !!project && agentEnvironmentKey(project.environment) === environmentKey;
  const associatedIds =
    group?.worktrees.find((worktree) => worktree.path === worktreePath)
      ?.projectIds ?? [];
  return (
    associatedIds
      .map((id) => projects.find((project) => project.id === id))
      .find((project): project is AgentProject => matches(project)) ??
    projects.find(
      (project) => project.path === worktreePath && matches(project),
    )
  );
}

/** Repositories and group overviews an issue or Design agent can start in: never a worktree or a missing project. */
export function agentLaunchProjects(
  listedProjects: readonly AgentProject[],
  missingProjectIds: readonly string[],
  groupByProjectId: ReadonlyMap<string, AgentProjectWorktreeGroup>,
  groupOverviewProjects: readonly AgentProject[],
): AgentProject[] {
  return [
    ...listedProjects.filter(
      (project) =>
        !missingProjectIds.includes(project.id) &&
        (groupByProjectId.get(project.id)?.repositoryProjectId ??
          project.id) === project.id,
    ),
    ...groupOverviewProjects,
  ];
}

/** Repository projects of the same machine, those likely on `branch` first. */
export function issueWorktreeCandidates(
  projects: readonly AgentProject[],
  source: AgentProject,
  group: AgentProjectWorktreeGroup | undefined,
  branches: Readonly<Record<string, string | null | undefined>>,
  branch: string,
): AgentProject[] {
  const repositoryProjectIds = group?.projectIds ?? [source.id];
  const environment = agentEnvironmentKey(source.environment);
  const likely: AgentProject[] = [];
  const unlikely: AgentProject[] = [];
  for (const project of projects) {
    if (
      !repositoryProjectIds.includes(project.id) ||
      agentEnvironmentKey(project.environment) !== environment
    )
      continue;
    const onBranch =
      branches[project.id] !== undefined
        ? branches[project.id] === branch
        : !!group?.worktrees.some(
            (worktree) =>
              worktree.branch === branch &&
              worktree.projectIds.includes(project.id),
          );
    (onBranch ? likely : unlikely).push(project);
  }
  return [...likely, ...unlikely];
}
