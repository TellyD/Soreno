import type { AgentProjectGroup } from "./AgentForms";

export type ServiceView = {
  open: boolean;
  projectId?: string;
  serviceId?: string;
};
type ServiceViews = Record<string, ServiceView>;
type Selection = { projectId: string | null; sessionId: string | null };

export const selectionKey = "soreno.agents.selection.v1";
export const terminalTitlesKey = "soreno.agents.terminal-titles.v1";
export const tabOrderKey = "soreno.agents.tab-order.v1";
export const pinnedTabsKey = "soreno.agents.pinned-tabs.v1";
export const terminalSplitsKey = "soreno.agents.terminal-splits.v1";
export const projectOrderKey = "soreno.agents.project-order.v1";
export const projectSectionOrderKey = "soreno.agents.project-section-order.v1";
export const projectGroupsKey = "soreno.agents.project-groups.v1";
export const collapsedProjectsKey = "soreno.agents.collapsed-projects.v1";
export const hideProjectsWithoutAgentsKey =
  "soreno.agents.hide-projects-without-agents.v1";
const priorityViewKey = "soreno.agents.priority-view.v1";
export const serviceViewsKey = "soreno.agents.service-views.v1";
export const servicesPanelHeightKey = "soreno.agents.services-panel-height.v1";
const kanbanSelectedKey = "soreno.agents.kanban.v1";
export const serviceTrustKey = "soreno.services.trust.v1";

const validStoredId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 256 &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(id);

export function readTabOrder(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(tabOrderKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 1024)
        .filter(([id, ids]) => validStoredId(id) && Array.isArray(ids))
        .map(([id, ids]) => [
          id,
          [...new Set((ids as unknown[]).slice(0, 1024).filter(validStoredId))],
        ]),
    );
  } catch {
    return {};
  }
}

export function readTerminalSplits(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(terminalSplitsKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const parents = new Set<string>();
    const children = new Set<string>();
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 1024)
        .flatMap(([parentId, childId]) => {
          if (
            !validStoredId(parentId) ||
            !validStoredId(childId) ||
            parentId === childId ||
            parents.has(childId) ||
            children.has(parentId) ||
            children.has(childId)
          )
            return [];
          parents.add(parentId);
          children.add(childId);
          return [[parentId, childId] as const];
        }),
    );
  } catch {
    return {};
  }
}

function readStoredIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(value)
      ? [...new Set(value.slice(0, 1024).filter(validStoredId))]
      : [];
  } catch {
    return [];
  }
}

export const readProjectOrder = () => readStoredIds(projectOrderKey);
export const readProjectSectionOrder = () =>
  readStoredIds(projectSectionOrderKey);

export function readLegacyProjectGroups(): AgentProjectGroup[] | null {
  try {
    const stored = localStorage.getItem(projectGroupsKey);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    const assigned = new Set<string>();
    return value.slice(0, 256).flatMap((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        !("name" in entry) ||
        !("projectIds" in entry) ||
        !validStoredId(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        entry.name.length > 100 ||
        !Array.isArray(entry.projectIds)
      )
        return [];
      ids.add(entry.id);
      const projectIds = [
        ...new Set(
          (entry.projectIds as unknown[]).slice(0, 1024).filter(validStoredId),
        ),
      ].filter((id) => {
        if (assigned.has(id)) return false;
        assigned.add(id);
        return true;
      });
      return [
        {
          id: entry.id,
          name: entry.name.trim(),
          projectIds,
          groupProjectId: null,
          collapsed: "collapsed" in entry && entry.collapsed === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

export const readCollapsedProjects = () =>
  new Set(readStoredIds(collapsedProjectsKey));

export const readPinnedTabs = () => new Set(readStoredIds(pinnedTabsKey));

function readStoredFlag(key: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "false") === true;
  } catch {
    return false;
  }
}

export function writeStoredJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage is optional: a denied permission must not block the workspace. */
  }
}

export const readHideProjectsWithoutAgents = () =>
  readStoredFlag(hideProjectsWithoutAgentsKey);

export const writeHideProjectsWithoutAgents = (value: boolean) =>
  writeStoredJson(hideProjectsWithoutAgentsKey, value);

export const readPriorityView = () => readStoredFlag(priorityViewKey);

export const writePriorityView = (value: boolean) =>
  writeStoredJson(priorityViewKey, value);

export const readKanbanSelected = () => readStoredFlag(kanbanSelectedKey);

export const writeKanbanSelected = (value: boolean) =>
  writeStoredJson(kanbanSelectedKey, value);

export function readServiceViews(): ServiceViews {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(serviceViewsKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 1024)
        .filter(
          ([scope, view]) =>
            validStoredId(scope) &&
            !!view &&
            typeof view === "object" &&
            !Array.isArray(view),
        )
        .map(([scope, view]) => {
          const stored = view as Partial<ServiceView>;
          return [
            scope,
            {
              open: stored.open === true,
              ...(validStoredId(stored.projectId)
                ? { projectId: stored.projectId }
                : {}),
              ...(validStoredId(stored.serviceId)
                ? { serviceId: stored.serviceId }
                : {}),
            },
          ];
        }),
    );
  } catch {
    return {};
  }
}

export function readServicesPanelHeight(): number | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(servicesPanelHeightKey) ?? "null",
    );
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readServiceTrust(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(serviceTrustKey) ?? "null",
    );
    return new Set(
      Array.isArray(value)
        ? value.slice(0, 1024).filter((entry) => typeof entry === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function readSelection(): Selection {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(selectionKey) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "projectId" in value &&
      "sessionId" in value
    ) {
      return {
        projectId: typeof value.projectId === "string" ? value.projectId : null,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      };
    }
  } catch {
    /* Selection persistence is optional. */
  }
  return { projectId: null, sessionId: null };
}

export function readTerminalTitles(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(terminalTitlesKey) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const titles: Record<string, string> = {};
    let count = 0;
    for (const [id, title] of Object.entries(value)) {
      if (count >= 1024) break;
      if (
        validStoredId(id) &&
        typeof title === "string" &&
        title.length <= 512
      ) {
        titles[id] = title;
        count++;
      }
    }
    return titles;
  } catch {
    return {};
  }
}
