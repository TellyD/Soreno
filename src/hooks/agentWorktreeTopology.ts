import type {
  AgentProjectWorktreeGroup,
  AgentWorkspace,
} from "../domain/agentSessions";

type WorktreeGrouping = {
  scope: string | null;
  groups: AgentProjectWorktreeGroup[];
  refreshing?: boolean;
};
const worktreeCacheKey = "soreno.agents.worktree-groups.v1";
const branchCacheKey = "soreno.agents.branches.v1";
type CachedBranch = { target: string; branch: string | null };
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
export const workspaceProjectScope = (workspace: AgentWorkspace) =>
  JSON.stringify({
    projects: workspace.projects.map(({ id, path, environment }) => [
      id,
      path,
      environment,
    ]),
    disconnectedProjectIds: workspace.disconnectedProjectIds ?? [],
  });
function scopeProjects(scope: string) {
  try {
    const value: unknown = JSON.parse(scope);
    return value && typeof value === "object" && "projects" in value
      ? JSON.stringify(value.projects)
      : null;
  } catch {
    return null;
  }
}
export const projectTarget = ({
  path,
  environment,
}: AgentWorkspace["projects"][number]) => JSON.stringify([path, environment]);
export function preserveGroupingWhileRefreshing(
  grouping: WorktreeGrouping,
  previous: AgentWorkspace,
  next: AgentWorkspace,
) {
  const previousScope = workspaceProjectScope(previous);
  const nextScope = workspaceProjectScope(next);
  if (grouping.scope !== previousScope) {
    // The launch cache stays valid when only SSH connection states changed.
    return grouping.refreshing &&
      grouping.scope &&
      grouping.scope !== nextScope &&
      scopeProjects(grouping.scope) === scopeProjects(nextScope)
      ? { ...grouping, scope: nextScope }
      : grouping;
  }
  if (nextScope === previousScope) return grouping;
  const previousById = new Map(
    previous.projects.map((project) => [project.id, project]),
  );
  const nextIds = new Set(next.projects.map((project) => project.id));
  const unchangedIds = new Set(
    next.projects.flatMap((project) => {
      const prior = previousById.get(project.id);
      return prior && projectTarget(prior) === projectTarget(project)
        ? [project.id]
        : [];
    }),
  );
  const groups = grouping.groups.flatMap((group) => {
    const projectIds = group.projectIds.filter(
      (id) =>
        unchangedIds.has(id) || (!previousById.has(id) && nextIds.has(id)),
    );
    if (projectIds.length === 0) return [];
    const projectIdSet = new Set(projectIds);
    return [
      {
        ...group,
        repositoryProjectId: projectIds.includes(group.repositoryProjectId)
          ? group.repositoryProjectId
          : projectIds[0],
        projectIds,
        worktrees: group.worktrees.flatMap((worktree) => {
          const worktreeProjectIds = worktree.projectIds.filter((id) =>
            projectIdSet.has(id),
          );
          return worktree.projectIds.length > 0 &&
            worktreeProjectIds.length === 0
            ? []
            : [{ ...worktree, projectIds: worktreeProjectIds }];
        }),
      },
    ];
  });
  return { scope: nextScope, groups, refreshing: true };
}
export function readWorktreeCache(): WorktreeGrouping {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(worktreeCacheKey) ?? "null",
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("scope" in value) ||
      !("groups" in value) ||
      typeof value.scope !== "string" ||
      !Array.isArray(value.groups)
    )
      throw new Error();
    const valid = value.groups.every(
      (group): group is AgentProjectWorktreeGroup =>
        !!group &&
        typeof group === "object" &&
        "repositoryProjectId" in group &&
        typeof group.repositoryProjectId === "string" &&
        "projectIds" in group &&
        stringArray(group.projectIds) &&
        "worktrees" in group &&
        Array.isArray(group.worktrees) &&
        group.worktrees.every(
          (worktree: unknown) =>
            !!worktree &&
            typeof worktree === "object" &&
            "path" in worktree &&
            typeof worktree.path === "string" &&
            "head" in worktree &&
            typeof worktree.head === "string" &&
            "branch" in worktree &&
            (worktree.branch === null || typeof worktree.branch === "string") &&
            "projectIds" in worktree &&
            stringArray(worktree.projectIds),
        ),
    );
    return valid
      ? { scope: value.scope, groups: value.groups }
      : { scope: null, groups: [] };
  } catch {
    return { scope: null, groups: [] };
  }
}
export function writeWorktreeCache(
  scope: string,
  groups: AgentProjectWorktreeGroup[],
) {
  try {
    localStorage.setItem(worktreeCacheKey, JSON.stringify({ scope, groups }));
  } catch {
    /* Cache availability must not block project navigation. */
  }
}
export function readBranchCache(): Record<string, CachedBranch> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(branchCacheKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, CachedBranch] => {
        const cached: unknown = entry[1];
        return (
          !!cached &&
          typeof cached === "object" &&
          "target" in cached &&
          typeof cached.target === "string" &&
          "branch" in cached &&
          (cached.branch === null || typeof cached.branch === "string")
        );
      }),
    );
  } catch {
    return {};
  }
}
export function writeBranchCache(
  projects: AgentWorkspace["projects"],
  branches: Record<string, string | null>,
  previous: Record<string, CachedBranch> = {},
) {
  try {
    localStorage.setItem(
      branchCacheKey,
      JSON.stringify({
        ...previous,
        ...Object.fromEntries(
          projects.flatMap((project) => {
            const branch = branches[project.id];
            return branch === undefined
              ? []
              : [[project.id, { target: projectTarget(project), branch }]];
          }),
        ),
      }),
    );
  } catch {
    /* Cache availability must not block project navigation. */
  }
}
export function worktreeAliasIds(
  groups: AgentProjectWorktreeGroup[],
  projectId: string,
): readonly string[] {
  return (
    groups
      .flatMap((group) => group.worktrees)
      .find((worktree) => worktree.projectIds.includes(projectId))
      ?.projectIds ?? [projectId]
  );
}
/** Missing projects whose worktree a still-reachable repository no longer lists were removed elsewhere. */
export function orphanedWorktreeProjectIds(
  known: AgentProjectWorktreeGroup[],
  snapshot: AgentProjectWorktreeGroup[],
  missingProjectIds: readonly string[],
) {
  const missing = new Set(missingProjectIds);
  const listed = new Set(
    snapshot.flatMap((group) => group.worktrees.map(({ path }) => path)),
  );
  return missingProjectIds.filter((id) =>
    known.some((group) => {
      const path = group.worktrees.find((worktree) =>
        worktree.projectIds.includes(id),
      )?.path;
      // Unreachable storage hides the whole repository: only a fresh listing proves removal.
      return (
        path !== undefined &&
        !listed.has(path) &&
        snapshot.some((fresh) =>
          fresh.projectIds.some(
            (other) => !missing.has(other) && group.projectIds.includes(other),
          ),
        )
      );
    }),
  );
}
/** The backend cannot probe disconnected projects, so their last known groups stay. */
export function keepDisconnectedWorktreeGroups(
  known: AgentProjectWorktreeGroup[],
  snapshot: AgentProjectWorktreeGroup[],
  disconnectedProjectIds: readonly string[],
) {
  const disconnected = new Set(disconnectedProjectIds);
  const probed = new Set(snapshot.flatMap((group) => group.projectIds));
  return [
    ...known.filter(
      (group) =>
        group.projectIds.length > 0 &&
        group.projectIds.every((id) => disconnected.has(id) && !probed.has(id)),
    ),
    ...snapshot,
  ];
}
export function mergePartialWorktreeGroups(
  current: AgentProjectWorktreeGroup[],
  updates: AgentProjectWorktreeGroup[],
  projects: AgentWorkspace["projects"],
) {
  const remaining = [...current];
  const environments = new Map(
    projects.map((project) => [project.id, project.environment]),
  );
  const sameEnvironment = (leftId: string, rightId: string) => {
    const left = environments.get(leftId);
    const right = environments.get(rightId);
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === "local") return true;
    if (left.kind === "wsl")
      return (
        !!left.distribution &&
        !!right.distribution &&
        left.distribution.toLowerCase() === right.distribution.toLowerCase()
      );
    return !!left.ssh && JSON.stringify(left.ssh) === JSON.stringify(right.ssh);
  };
  const groups = updates.map((update) => {
    const paths = new Set(update.worktrees.map((worktree) => worktree.path));
    const matches = remaining.filter(
      (group) =>
        update.projectIds.some((id) => group.projectIds.includes(id)) ||
        (sameEnvironment(
          update.repositoryProjectId,
          group.repositoryProjectId,
        ) &&
          group.worktrees.some((worktree) => paths.has(worktree.path))),
    );
    matches.forEach((group) => remaining.splice(remaining.indexOf(group), 1));
    return {
      ...update,
      projectIds: [
        ...new Set([
          ...update.projectIds,
          ...matches.flatMap((group) => group.projectIds),
        ]),
      ],
      worktrees: update.worktrees.map((worktree) => ({
        ...worktree,
        projectIds: [
          ...new Set([
            ...worktree.projectIds,
            ...matches.flatMap((group) =>
              group.worktrees
                .filter((candidate) => candidate.path === worktree.path)
                .flatMap((candidate) => candidate.projectIds),
            ),
          ]),
        ],
      })),
    };
  });
  return [...remaining, ...groups];
}
