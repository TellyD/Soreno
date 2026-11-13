import { assetFileName } from "./assetUrl";
import { compareDate } from "./dateTime";

export type KanbanSource = "local" | "linear";

export type KanbanTeam = { id: string; key: string; name: string };

export type KanbanWorkflowState = {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
};

export type KanbanLabel = { id: string; name: string; color: string };

/** A Soreno project (`agent_projects`); for a Linear issue, the one linked to its Linear project. */
export type KanbanProjectRef = { id: string; name: string };

type KanbanLinearProjectRef = {
  id: string;
  name: string;
  color: string;
};

export type KanbanUserRef = { id: string; name: string; avatarUrl?: string };

type KanbanPullRequest = { number: number; url: string };

export type KanbanIssue = {
  source: KanbanSource;
  id: string;
  identifier: string;
  title: string;
  priority: number;
  stateId: string;
  createdAt: string;
  updatedAt: string;
  project: KanbanProjectRef | null;
  labels: KanbanLabel[];
  pullRequests: KanbanPullRequest[];
  // Linear only.
  url?: string;
  assignee?: KanbanUserRef | null;
  linearProject?: KanbanLinearProjectRef | null;
};

export type KanbanBoard = {
  source: KanbanSource;
  team: KanbanTeam;
  states: KanbanWorkflowState[];
  labels: KanbanLabel[];
  issues: KanbanIssue[];
};

/** A connected Linear workspace; the name is empty for a key saved before workspaces existed. */
export type LinearWorkspace = { id: string; name: string };

export function linearWorkspaceName(name: string): string {
  return name || "Linear";
}

/** One Linear team's board; `teams` lists every team of every connected workspace. */
export type LinearKanbanBoard = KanbanBoard & {
  teams: (KanbanTeam & { workspace: string })[];
  // More issues than the board loads; the oldest updated are left out.
  truncated: boolean;
  // Soreno projects linked to a Linear project of this board's workspace.
  linkedProjectIds: string[];
  // Who the team's issues can be assigned to.
  members: KanbanUserRef[];
};

/** A Linear project a Soreno project can be linked to. */
export type LinearProjectSummary = {
  id: string;
  name: string;
  teams: string[];
  workspace: string;
};

export type KanbanIssueFields = {
  title: string;
  stateId: string;
  priority: number;
  project: KanbanProjectRef | null;
  labels: KanbanLabel[];
  // Linear only.
  assignee?: KanbanUserRef | null;
};

export type KanbanIssueUpdate = KanbanIssueFields & {
  id: string;
  updatedAt: string;
  // Linear only.
  linearProject?: KanbanLinearProjectRef | null;
};

export type KanbanIssuePatch = Partial<KanbanIssueFields>;

export type KanbanIssueDescriptionUpdate = {
  id: string;
  description: string | null;
  updatedAt: string;
};

export type KanbanIssueInput = {
  stateId?: string;
  priority?: number;
  title?: string;
  projectId?: string | null;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
  assigneeId?: string | null;
};

export type KanbanIssueCreateInput = {
  teamId: string;
  title: string;
  description?: string;
  stateId?: string;
  priority?: number;
  projectId?: string;
  labelIds?: string[];
  parentId?: string;
};

export type KanbanComment = {
  id: string;
  body: string;
  createdAt: string;
  // Linear only.
  user?: KanbanUserRef | null;
};

export type KanbanIssueCompletion = {
  comment: KanbanComment;
  /** Null when the summary comment was updated in place. */
  update: KanbanIssueUpdate | null;
};

export type KanbanIssueSelection = {
  id: string;
  identifier: string;
  source: KanbanSource;
};

/** Outcome of an issue an agent session asked Soreno to create, or to edit when `updated`; exactly one of `issue`/`error` is set. */
export type KanbanIssueRequestEvent = {
  sessionId: string;
  sessionName: string;
  title: string;
  updated: boolean;
  issue: KanbanIssueSelection | null;
  error: string | null;
};

export type KanbanSubIssue = {
  id: string;
  identifier: string;
  title: string;
  state: { id: string; name: string; type: string; color: string };
};

export type KanbanIssueDetail = {
  source: KanbanSource;
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  branchName: string;
  priority: number;
  stateId: string;
  createdAt: string;
  updatedAt: string;
  project: KanbanProjectRef | null;
  labels: KanbanLabel[];
  children: KanbanSubIssue[];
  // Oldest first.
  comments: KanbanComment[];
  pullRequests: KanbanPullRequest[];
  // Linear only.
  url?: string;
  teamId?: string;
  assignee?: KanbanUserRef | null;
  linearProject?: KanbanLinearProjectRef | null;
};

const KANBAN_IMAGE_URL =
  /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/([^?#]+)$/;
const KANBAN_IMAGE_PATH =
  /(?:^|\/)kanban-images\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/;

/** File name of a Kanban image from its `convertFileSrc` URL, or null for any other URL. */
export function kanbanImageName(url: string): string | null {
  return assetFileName(url, KANBAN_IMAGE_URL, KANBAN_IMAGE_PATH);
}

// Same shapes as `LOCAL_IMAGE_URL` in src-tauri/src/linear/images.rs.
const LOCAL_IMAGE_URLS =
  /<((?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/[^\s<>]+)>|(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/[^\s()<>"'[\]]+/g;
const LINEAR_UPLOAD_URLS =
  /<(https:\/\/uploads\.linear\.app\/[^\s<>]+)>|https:\/\/uploads\.linear\.app\/[^\s()<>"'[\]]+/g;

function urlsOf(text: string, pattern: RegExp): Set<string> {
  return new Set(
    [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]),
  );
}

/** [Linear upload, local image] pairs for the Kanban images Linear replaced, in order, from `previous` to `next`; null if they do not match. */
export function replacedKanbanImages(
  previous: string,
  next: string,
): [string, string][] | null {
  const kept = urlsOf(next, LOCAL_IMAGE_URLS);
  const known = urlsOf(previous, LINEAR_UPLOAD_URLS);
  // The backend uploads each file once, so one upload per file name.
  const local = new Map<string, string>();
  for (const url of urlsOf(previous, LOCAL_IMAGE_URLS)) {
    const name = kanbanImageName(url);
    if (name && !kept.has(url) && !local.has(name)) local.set(name, url);
  }
  const uploads = [...urlsOf(next, LINEAR_UPLOAD_URLS)].filter(
    (url) => !known.has(url),
  );
  if (uploads.length !== local.size) return null;
  const sources = [...local.values()];
  return uploads.map((url, index) => [url, sources[index]]);
}

/** Code of a `[Kanban/<code>] …` backend error, which the interface translates. */
export function kanbanErrorCode(message: string): string | null {
  return /^\[Kanban\/([A-Za-z][A-Za-z0-9]*)\] /.exec(message)?.[1] ?? null;
}

export const kanbanBoardTabs = ["active", "backlog", "all"] as const;

export type KanbanBoardTab = (typeof kanbanBoardTabs)[number];

export const kanbanPriorities = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
] as const;

export type KanbanPriorityName = (typeof kanbanPriorities)[number];

const activeStateTypes: Record<string, true> = {
  unstarted: true,
  started: true,
};

export function visibleStates(
  states: readonly KanbanWorkflowState[],
  tab: KanbanBoardTab,
): KanbanWorkflowState[] {
  if (tab === "all") return [...states];
  if (tab === "backlog") {
    return states.filter((state) => state.type === "backlog");
  }
  return states.filter((state) => activeStateTypes[state.type]);
}

export type KanbanColumn =
  "backlog" | "todo" | "inProgress" | "inReview" | "done" | "canceled";

export type KanbanSourceFilter = "all" | "local" | "linear";

export const kanbanSourceFilters: readonly KanbanSourceFilter[] = [
  "all",
  "local",
  "linear",
];

/** Column of a local or Linear state, by type; a started state named "review"/"revue" is In Review. */
export function kanbanColumn(
  state: Pick<KanbanWorkflowState, "type" | "name">,
): KanbanColumn {
  switch (state.type) {
    case "backlog":
      return "backlog";
    case "started":
      return /review|revue/i.test(state.name) ? "inReview" : "inProgress";
    case "completed":
      return "done";
    case "canceled":
      return "canceled";
    default:
      return "todo";
  }
}

export function linearColumnState(
  column: KanbanColumn,
  linearStates: readonly KanbanWorkflowState[],
): KanbanWorkflowState | null {
  return linearStates.reduce<KanbanWorkflowState | null>(
    (first, state) =>
      kanbanColumn(state) === column &&
      (!first || state.position < first.position)
        ? state
        : first,
    null,
  );
}

/** Local state id (= column) where the issue's card is shown. */
export function issueColumnStateId(
  issue: KanbanIssue,
  localStates: readonly KanbanWorkflowState[],
  linearStates: readonly KanbanWorkflowState[],
): string | undefined {
  if (issue.source === "local") return issue.stateId;
  const state = linearStates.find(({ id }) => id === issue.stateId);
  if (!state) return undefined;
  const column = kanbanColumn(state);
  return localStates.find((local) => kanbanColumn(local) === column)?.id;
}

/** State id to send when the card is dropped on the local column `targetStateId`; null = refused or unchanged. */
export function droppedIssueStateId(
  issue: KanbanIssue,
  targetStateId: string,
  localStates: readonly KanbanWorkflowState[],
  linearStates: readonly KanbanWorkflowState[],
): string | null {
  if (issueColumnStateId(issue, localStates, linearStates) === targetStateId) {
    return null;
  }
  if (issue.source === "local") return targetStateId;
  const target = localStates.find(({ id }) => id === targetStateId);
  return target
    ? (linearColumnState(kanbanColumn(target), linearStates)?.id ?? null)
    : null;
}

export const kanbanSortFields = ["updated", "created", "priority"] as const;

export type KanbanSortField = (typeof kanbanSortFields)[number];

/** Not ascending: newest first, or most urgent first. */
export type KanbanSort = { field: KanbanSortField; ascending: boolean };

function compareIssues(
  left: KanbanIssue,
  right: KanbanIssue,
  { field, ascending }: KanbanSort,
): number {
  // Priority 0 means none: last in both directions.
  if (field === "priority" && (left.priority === 0) !== (right.priority === 0))
    return left.priority === 0 ? 1 : -1;
  const order =
    field === "created"
      ? compareDate(right.createdAt, left.createdAt)
      : (field === "priority" ? left.priority - right.priority : 0) ||
        compareDate(right.updatedAt, left.updatedAt);
  return ascending ? -order : order;
}

export function groupIssuesByState(
  issues: readonly KanbanIssue[],
  localStates: readonly KanbanWorkflowState[],
  linearStates: readonly KanbanWorkflowState[] = [],
  sort: KanbanSort = { field: "updated", ascending: false },
): Map<string, KanbanIssue[]> {
  const groups = new Map<string, KanbanIssue[]>(
    localStates.map((state) => [state.id, []]),
  );

  for (const issue of issues) {
    const stateId = issueColumnStateId(issue, localStates, linearStates);
    if (stateId !== undefined) groups.get(stateId)?.push(issue);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => compareIssues(left, right, sort));
  }

  return groups;
}

export function filterIssuesBySource(
  issues: readonly KanbanIssue[],
  filter: KanbanSourceFilter,
): readonly KanbanIssue[] {
  return filter === "all"
    ? issues
    : issues.filter(({ source }) => source === filter);
}

/** Decision 3: local→local; linear→linear when available; all→remembered when available, else local. */
export function defaultCreateSource(
  filter: KanbanSourceFilter,
  remembered: KanbanSource | null,
  linearAvailable: boolean,
): KanbanSource {
  if (!linearAvailable || filter === "local") return "local";
  if (filter === "linear") return "linear";
  return remembered ?? "local";
}

export function kanbanPriorityName(priority: number): KanbanPriorityName {
  return kanbanPriorities[priority] ?? "none";
}

export function applyIssueUpdate<B extends KanbanBoard>(
  board: B,
  update: KanbanIssueUpdate,
): B {
  return {
    ...board,
    issues: board.issues.map((issue) =>
      issue.id === update.id ? { ...issue, ...update } : issue,
    ),
  };
}

export function kanbanIssueInput(
  patch: KanbanIssuePatch,
  confirmed: KanbanIssueFields,
): KanbanIssueInput {
  const input: KanbanIssueInput = {};
  if (patch.title !== undefined && patch.title !== confirmed.title) {
    input.title = patch.title;
  }
  if (patch.stateId !== undefined && patch.stateId !== confirmed.stateId) {
    input.stateId = patch.stateId;
  }
  if (patch.priority !== undefined && patch.priority !== confirmed.priority) {
    input.priority = patch.priority;
  }
  if (
    patch.project !== undefined &&
    patch.project?.id !== confirmed.project?.id
  ) {
    input.projectId = patch.project?.id ?? null;
  }
  if (
    patch.assignee !== undefined &&
    patch.assignee?.id !== confirmed.assignee?.id
  ) {
    input.assigneeId = patch.assignee?.id ?? null;
  }
  if (patch.labels !== undefined) {
    const current = new Set(confirmed.labels.map(({ id }) => id));
    const requested = new Set(patch.labels.map(({ id }) => id));
    const added = [...requested].filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !requested.has(id));
    if (added.length > 0) input.addedLabelIds = added;
    if (removed.length > 0) input.removedLabelIds = removed;
  }
  return input;
}

/** Ids of the Linear labels named like a local label, ignoring case. */
export function transferLabelIds(
  localLabels: readonly KanbanLabel[],
  linearLabels: readonly KanbanLabel[],
): string[] {
  const names = new Set(localLabels.map(({ name }) => name.toLowerCase()));
  return [
    ...new Set(
      linearLabels
        .filter(({ name }) => names.has(name.toLowerCase()))
        .map(({ id }) => id),
    ),
  ];
}

/** Description of a transferred issue: its comments, oldest first, appended after a `---` separator. */
export function transferDescription(
  description: string | null,
  comments: readonly KanbanComment[],
  heading: string,
  formatDate: (value: string) => string,
): string {
  if (comments.length === 0) return description ?? "";
  const sorted = [...comments].sort((left, right) =>
    compareDate(left.createdAt, right.createdAt),
  );
  return [
    ...(description ? [description] : []),
    "---",
    heading,
    ...sorted.map(
      ({ body, createdAt }) => `**${formatDate(createdAt)}**\n\n${body}`,
    ),
  ].join("\n\n");
}

// Project ids are UUIDs, so these filter values cannot collide with a project id.
export const allKanbanProjectsFilter = "all";
export const noKanbanProjectFilter = "none";

export type KanbanIssueProjects = {
  projects: KanbanProjectRef[];
  hasIssueWithoutProject: boolean;
};

// Issues carry the project name from their last load; known projects hold the current one.
export function kanbanIssueProjects(
  issues: readonly KanbanIssue[],
  known: ReadonlyMap<string, KanbanProjectRef>,
): KanbanIssueProjects {
  const projects = new Map<string, KanbanProjectRef>();
  let hasIssueWithoutProject = false;
  for (const { project } of issues) {
    if (project) projects.set(project.id, known.get(project.id) ?? project);
    else hasIssueWithoutProject = true;
  }
  return {
    hasIssueWithoutProject,
    projects: [...projects.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    ),
  };
}

export function filterIssuesByProject(
  issues: readonly KanbanIssue[],
  filter: string,
): readonly KanbanIssue[] {
  if (filter === allKanbanProjectsFilter) return issues;
  return issues.filter(({ project }) =>
    filter === noKanbanProjectFilter ? !project : project?.id === filter,
  );
}
