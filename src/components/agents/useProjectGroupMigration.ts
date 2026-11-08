import { useEffect, useRef, useState } from "react";
import * as api from "../../data/agentSessionsApi";
import {
  groupCollapseKey,
  type AgentProject,
  type AgentProjectWorktreeGroup,
  type AgentWorkspace,
} from "../../domain/agentSessions";
import { notifyWarning } from "../../notifications";
import type { AgentProjectGroup } from "./AgentForms";
import { useAgentStrings } from "./agentStrings";
import {
  projectGroupsKey,
  readLegacyProjectGroups,
} from "./agentWorkspaceStorage";

/** Keeps saved groups on their rail representatives and imports the legacy local groups once. */
export function useProjectGroupMigration({
  desktop,
  hasLoaded,
  loading,
  busy,
  loadError,
  worktreesLoaded,
  worktreesComplete,
  worktrees,
  workspace,
  railProjects,
  projectGroups,
  groupByProjectId,
  execute,
  setCollapsed,
}: {
  desktop: boolean;
  hasLoaded: boolean;
  loading: boolean;
  busy: boolean;
  loadError: string | null;
  worktreesLoaded: boolean;
  worktreesComplete: boolean;
  worktrees: AgentProjectWorktreeGroup[];
  workspace: AgentWorkspace;
  railProjects: AgentProject[];
  projectGroups: AgentProjectGroup[];
  groupByProjectId: ReadonlyMap<string, AgentProjectWorktreeGroup>;
  execute: (work: () => Promise<void>) => Promise<boolean>;
  setCollapsed: (update: (current: Set<string>) => Set<string>) => void;
}) {
  const s = useAgentStrings();
  const [legacyProjectGroups, setLegacyProjectGroups] = useState(
    readLegacyProjectGroups,
  );
  const groupMigrationStarted = useRef(false);
  const groupReconciliation = useRef<string | null>(null);
  const previousWorktrees = useRef(worktrees);

  useEffect(() => {
    if (
      !desktop ||
      !hasLoaded ||
      loading ||
      busy ||
      loadError ||
      legacyProjectGroups !== null ||
      (!worktreesLoaded && worktrees.length === 0)
    )
      return;
    const railIds = new Set(railProjects.map((project) => project.id));
    const fallbackWorktrees = previousWorktrees.current;
    previousWorktrees.current = worktrees;
    const assigned = new Set<string>();
    const changed = projectGroups.flatMap((group) => {
      const projectIds = group.projectIds.flatMap((id) => {
        const worktreeGroup =
          groupByProjectId.get(id) ??
          worktrees.find(
            (item) =>
              item.repositoryProjectId === id || item.projectIds.includes(id),
          ) ??
          fallbackWorktrees.find(
            (item) =>
              item.repositoryProjectId === id || item.projectIds.includes(id),
          );
        const representative = railIds.has(id)
          ? id
          : [
              worktreeGroup?.repositoryProjectId,
              ...(worktreeGroup?.projectIds ?? []),
            ].find(
              (candidate) =>
                candidate &&
                railIds.has(candidate) &&
                (worktreesComplete || groupByProjectId.has(candidate)),
            );
        if (
          !representative ||
          !railIds.has(representative) ||
          assigned.has(representative)
        )
          return worktreesComplete ? [] : [id];
        assigned.add(representative);
        return [representative];
      });
      return JSON.stringify(projectIds) === JSON.stringify(group.projectIds)
        ? []
        : [{ id: group.id, name: group.name, projectIds }];
    });
    const attempt = JSON.stringify(changed);
    // A rejected save reloads the same workspace: never retry it in a loop.
    if (changed.length === 0 || groupReconciliation.current === attempt) return;
    groupReconciliation.current = attempt;
    void execute(async () => {
      for (const group of changed) await api.saveAgentProjectGroup(group);
    }).then((succeeded) => {
      if (succeeded) groupReconciliation.current = null;
    });
  }, [
    desktop,
    hasLoaded,
    loading,
    busy,
    loadError,
    legacyProjectGroups,
    worktreesLoaded,
    worktreesComplete,
    workspace.projects,
    workspace.groups,
    worktrees,
  ]);

  useEffect(() => {
    if (
      !desktop ||
      !hasLoaded ||
      !worktreesLoaded ||
      busy ||
      loadError ||
      legacyProjectGroups === null ||
      groupMigrationStarted.current
    )
      return;
    const forgetLegacyGroups = () => {
      try {
        localStorage.removeItem(projectGroupsKey);
      } catch {
        /* Storage is optional; the import is idempotent. */
      }
      setLegacyProjectGroups(null);
    };
    if (legacyProjectGroups.length === 0) {
      forgetLegacyGroups();
      return;
    }
    groupMigrationStarted.current = true;
    const result = {
      ran: false,
      ungroupedProjectIds: [] as string[],
      groupIds: [] as string[],
    };
    void execute(async () => {
      result.ran = true;
      const imported = await api.importAgentProjectGroups(
        legacyProjectGroups.map(({ id, name, projectIds }) => ({
          id,
          name,
          projectIds,
        })),
      );
      result.ungroupedProjectIds = imported.ungroupedProjectIds;
      result.groupIds = imported.groupIds;
    }).then((succeeded) => {
      if (!succeeded) {
        // Not started because another operation was running: retry once it ends.
        if (!result.ran) groupMigrationStarted.current = false;
        return;
      }
      setCollapsed((current) => {
        const next = new Set(current);
        legacyProjectGroups.forEach((group, index) => {
          const groupId = result.groupIds[index];
          if (group.collapsed && groupId) next.add(groupCollapseKey(groupId));
        });
        return next;
      });
      forgetLegacyGroups();
      if (result.ungroupedProjectIds.length > 0)
        notifyWarning(
          s.groupMigrationUngrouped(
            result.ungroupedProjectIds
              .map(
                (id) =>
                  workspace.projects.find((project) => project.id === id)
                    ?.name ?? id,
              )
              .join(", "),
          ),
        );
    });
  }, [
    desktop,
    hasLoaded,
    worktreesLoaded,
    busy,
    loadError,
    legacyProjectGroups,
  ]);
}
