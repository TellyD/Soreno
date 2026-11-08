import { ContextMenu } from "@base-ui/react/context-menu";
import {
  ArrowDown,
  ArrowUp,
  LayoutGrid,
  LoaderCircle,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  moveAgentItem,
  orderAgentItems,
  type AgentProject,
  type AgentProjectWorktreeGroup,
} from "../../domain/agentSessions";
import { useAgentTabReorder } from "../../hooks/useAgentTabReorder";
import { MenuItem } from "../ui/Menu";
import type { AgentProjectGroup } from "./AgentForms";
import { useAgentStrings } from "./agentStrings";

type ProjectRailSection = {
  id: string;
  group: AgentProjectGroup | null;
  projects: AgentProject[];
};

export type AgentProjectRenderProps = {
  project: AgentProject;
  manualGroup: AgentProjectGroup | undefined;
  worktreeGroup: AgentProjectWorktreeGroup | undefined;
  reorderActions: ReactNode;
};

export type AgentProjectGroupRenderProps = {
  group: AgentProjectGroup;
  count: number;
  actions: ReactNode;
};

type AgentProjectListProps = {
  projects: AgentProject[];
  groups: AgentProjectGroup[];
  worktreeGroups: AgentProjectWorktreeGroup[];
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  reorderDisabled: boolean;
  sectionOrder: string[];
  renderProject: (props: AgentProjectRenderProps) => ReactNode;
  renderGroup: (props: AgentProjectGroupRenderProps) => ReactNode;
  onOpenGroupOverview: (group: AgentProjectGroup) => void;
  onReorder: (projectIds: string[]) => void;
  onSectionOrderChange: (sectionIds: string[]) => void;
  onEditGroup: (group: AgentProjectGroup) => void;
  onCustomizeGroup: (group: AgentProjectGroup) => void;
  onDeleteGroup: (group: AgentProjectGroup) => void;
  onMoveProjectToGroup: (projectId: string, groupId: string | null) => void;
};

function dropPosition(
  before: boolean,
  after: boolean,
): "before" | "after" | undefined {
  if (before) return "before";
  if (after) return "after";
  return undefined;
}

export function AgentProjectList({
  projects,
  groups,
  worktreeGroups,
  hasLoaded,
  loading,
  refreshing,
  reorderDisabled,
  sectionOrder,
  renderProject,
  renderGroup,
  onOpenGroupOverview,
  onReorder,
  onSectionOrderChange,
  onEditGroup,
  onCustomizeGroup,
  onDeleteGroup,
  onMoveProjectToGroup,
}: AgentProjectListProps) {
  const s = useAgentStrings();
  const worktreeGroupByProjectId = new Map(
    worktreeGroups.flatMap((group) =>
      group.projectIds.map((id) => [id, group] as const),
    ),
  );
  const railProjects = projects.filter((project) => {
    const group = worktreeGroupByProjectId.get(project.id);
    return !group || group.repositoryProjectId === project.id;
  });
  const manualGroupByProjectId = new Map(
    groups.flatMap((group) =>
      group.projectIds.map((id) => [id, group] as const),
    ),
  );
  const groupedRailProjects = groups.map((group) => ({
    group,
    projects: railProjects.filter((project) =>
      group.projectIds.includes(project.id),
    ),
  }));
  const ungroupedRailProjects = railProjects.filter(
    (project) => !manualGroupByProjectId.has(project.id),
  );
  const derivedRailSections: ProjectRailSection[] = [];
  const addedGroupIds = new Set<string>();
  for (const project of railProjects) {
    const group = manualGroupByProjectId.get(project.id);
    if (!group) {
      derivedRailSections.push({
        id: `project:${project.id}`,
        group: null,
        projects: [project],
      });
    } else if (!addedGroupIds.has(group.id)) {
      addedGroupIds.add(group.id);
      derivedRailSections.push({
        id: `group:${group.id}`,
        group,
        projects:
          groupedRailProjects.find((item) => item.group.id === group.id)
            ?.projects ?? [],
      });
    }
  }
  for (const group of groups) {
    if (!addedGroupIds.has(group.id))
      derivedRailSections.push({
        id: `group:${group.id}`,
        group,
        projects: [],
      });
  }
  const railSections = orderAgentItems(derivedRailSections, sectionOrder);
  const projectDragIds = railSections.flatMap((section) => {
    const projectIds = section.projects.map((project) => project.id);
    if (!section.group) return projectIds;
    return section.group.collapsed ? [section.id] : [section.id, ...projectIds];
  });
  const projectReorder = useAgentTabReorder({
    axis: "vertical",
    ids: projectDragIds,
    projectId: undefined,
    disabled: reorderDisabled,
    onReorder: reorderProject,
  });
  const projectSectionReorder = useAgentTabReorder({
    axis: "vertical",
    ids: railSections.map((section) => section.id),
    projectId: undefined,
    disabled: reorderDisabled,
    onReorder: reorderProjectSection,
  });
  const projectDropAfterId = projectReorder.dropAtEnd
    ? projectDragIds
        .filter((id) => id !== projectReorder.draggingId)
        .slice(-1)[0]
    : null;
  const projectSectionDropAfterId = projectSectionReorder.dropAtEnd
    ? railSections
        .filter((section) => section.id !== projectSectionReorder.draggingId)
        .slice(-1)[0]?.id
    : null;

  function reorderProjectSection(id: string, index: number) {
    if (reorderDisabled) return;
    const next = moveAgentItem(railSections, id, index);
    if (next === railSections) return;
    onSectionOrderChange(next.map((section) => section.id));
    onReorder(
      next.flatMap((section) => section.projects.map((project) => project.id)),
    );
  }

  function reorderProject(id: string, index: number) {
    if (reorderDisabled) return;
    const nextItems = moveAgentItem(
      projectDragIds.map((itemId) => ({ id: itemId })),
      id,
      index,
    );
    if (
      nextItems.every(
        (item, itemIndex) => item.id === projectDragIds[itemIndex],
      )
    )
      return;
    const nextIds = nextItems.map((item) => item.id);
    const movedIndex = nextIds.indexOf(id);
    const followingGroupId = manualGroupByProjectId.get(
      nextIds[movedIndex + 1],
    )?.id;
    const precedingGroupId = manualGroupByProjectId.get(
      nextIds[movedIndex - 1],
    )?.id;
    const currentGroupId = manualGroupByProjectId.get(id)?.id ?? null;
    const targetGroupId =
      followingGroupId ??
      (precedingGroupId === currentGroupId ? currentGroupId : null);
    let nextGroups = groups;
    if (targetGroupId !== currentGroupId) {
      nextGroups = groups
        .map((group) => {
          const projectIds = group.projectIds.filter((value) => value !== id);
          if (group.id === targetGroupId) projectIds.push(id);
          return { ...group, projectIds };
        })
        .filter((group) => group.projectIds.length > 0);
      onMoveProjectToGroup(id, targetGroupId);
    }
    onSectionOrderChange([
      ...new Set(
        nextIds.flatMap((itemId) => {
          if (itemId.startsWith("group:")) return [itemId];
          return nextGroups.some((group) => group.projectIds.includes(itemId))
            ? []
            : [`project:${itemId}`];
        }),
      ),
    ]);
    onReorder(
      nextIds.flatMap((itemId) => {
        const section = railSections.find((item) => item.id === itemId);
        if (!section) return [itemId];
        if (!section.group?.collapsed) return [];
        const group = nextGroups.find((item) => item.id === section.group?.id);
        return group
          ? section.projects
              .filter((project) => group.projectIds.includes(project.id))
              .map((project) => project.id)
          : [];
      }),
    );
  }

  function reorderProjectInSection(id: string, offset: -1 | 1) {
    const group = manualGroupByProjectId.get(id);
    const section = group
      ? groupedRailProjects.find((item) => item.group.id === group.id)?.projects
      : ungroupedRailProjects;
    if (!section) return;
    const index = section.findIndex((project) => project.id === id);
    const target = section[index + offset];
    if (!target) return;
    reorderProject(id, projectDragIds.indexOf(target.id));
  }

  function projectGroupHeader(group: AgentProjectGroup, sectionId: string) {
    const count = groupedRailProjects.find((item) => item.group.id === group.id)
      ?.projects.length;
    const sectionIndex = railSections.findIndex(
      (section) => section.id === sectionId,
    );
    return (
      <div
        ref={(element) => {
          if (element) projectReorder.itemRefs.current.set(sectionId, element);
          else projectReorder.itemRefs.current.delete(sectionId);
        }}
        className="agent-project-group"
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(
              ".agent-project-select, .agent-project-group-toggle",
            )
          )
            projectSectionReorder.startDrag(sectionId, event);
        }}
      >
        {renderGroup({
          group,
          count: count ?? 0,
          actions: (
            <>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem leading={<LayoutGrid />} />}
                onClick={() => onOpenGroupOverview(group)}
              >
                {s.openGroupOverview}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem leading={<Pencil />} />}
                onClick={() => onEditGroup(group)}
              >
                {s.editGroup}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem leading={<Palette />} />}
                onClick={() => onCustomizeGroup(group)}
              >
                {s.customizeProject}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                disabled={sectionIndex === 0}
                render={<MenuItem leading={<ArrowUp />} />}
                onClick={() =>
                  reorderProjectSection(sectionId, sectionIndex - 1)
                }
              >
                {s.moveGroupUp}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                disabled={sectionIndex === railSections.length - 1}
                render={<MenuItem leading={<ArrowDown />} />}
                onClick={() =>
                  reorderProjectSection(sectionId, sectionIndex + 1)
                }
              >
                {s.moveGroupDown}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem danger leading={<Trash2 />} />}
                onClick={() => onDeleteGroup(group)}
              >
                {s.deleteGroup}
              </ContextMenu.Item>
            </>
          ),
        })}
      </div>
    );
  }

  return (
    <nav
      ref={(element) => {
        projectReorder.containerRef.current = element;
        projectSectionReorder.containerRef.current = element;
      }}
      className={`agent-project-list${loading ? " is-loading" : ""}${projectReorder.isReordering || projectSectionReorder.isReordering ? " is-reordering" : ""}`}
      data-reorderable={
        (!reorderDisabled && projectDragIds.length > 1) || undefined
      }
      aria-busy={loading || refreshing || undefined}
      aria-label={s.projects}
    >
      {loading ? (
        <LoaderCircle
          size={28}
          className="app-loading-spinner"
          role="status"
          aria-label={s.loading}
        />
      ) : null}
      {!loading && hasLoaded
        ? railSections.map((section) => (
            <div
              ref={(element) => {
                if (element)
                  projectSectionReorder.itemRefs.current.set(
                    section.id,
                    element,
                  );
                else projectSectionReorder.itemRefs.current.delete(section.id);
              }}
              className={`agent-project-section${projectSectionReorder.draggingId === section.id ? " is-dragging" : ""}`}
              data-drop={dropPosition(
                projectSectionReorder.dropBeforeId === section.id,
                projectSectionDropAfterId === section.id,
              )}
              data-project-drop={dropPosition(
                !!section.group && projectReorder.dropBeforeId === section.id,
                !!section.group && projectDropAfterId === section.id,
              )}
              key={section.id}
            >
              {section.group
                ? projectGroupHeader(section.group, section.id)
                : null}
              {section.projects.map((project) => {
                const manualGroup = manualGroupByProjectId.get(project.id);
                if (manualGroup?.collapsed) return null;
                const projectSection = manualGroup
                  ? (groupedRailProjects.find(
                      (item) => item.group.id === manualGroup.id,
                    )?.projects ?? [])
                  : ungroupedRailProjects;
                const sectionIndex = projectSection.findIndex(
                  (item) => item.id === project.id,
                );
                const worktreeGroup = worktreeGroupByProjectId.get(project.id);
                return (
                  <div
                    ref={(element) => {
                      if (element)
                        projectReorder.itemRefs.current.set(
                          project.id,
                          element,
                        );
                      else projectReorder.itemRefs.current.delete(project.id);
                    }}
                    className={`agent-project${manualGroup ? " in-project-group" : ""}${worktreeGroup ? " has-worktrees" : ""}${projectReorder.draggingId === project.id ? " is-dragging" : ""}`}
                    data-project-id={project.id}
                    data-drop={dropPosition(
                      projectReorder.dropBeforeId === project.id,
                      projectDropAfterId === project.id,
                    )}
                    key={project.id}
                    onPointerDown={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest(".agent-project-select")
                      )
                        projectReorder.startDrag(project.id, event);
                    }}
                  >
                    {renderProject({
                      project,
                      manualGroup,
                      worktreeGroup,
                      reorderActions: (
                        <>
                          <ContextMenu.Item
                            nativeButton
                            disabled={sectionIndex === 0}
                            render={<MenuItem leading={<ArrowUp />} />}
                            onClick={() =>
                              reorderProjectInSection(project.id, -1)
                            }
                          >
                            {s.moveProjectUp}
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            nativeButton
                            disabled={
                              sectionIndex === projectSection.length - 1
                            }
                            render={<MenuItem leading={<ArrowDown />} />}
                            onClick={() =>
                              reorderProjectInSection(project.id, 1)
                            }
                          >
                            {s.moveProjectDown}
                          </ContextMenu.Item>
                        </>
                      ),
                    })}
                  </div>
                );
              })}
            </div>
          ))
        : null}
    </nav>
  );
}
