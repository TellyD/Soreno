import type { KanbanSource } from "./kanban";

export type SshConnection = {
  host: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  hostKey: string | null;
};

export type SshHostKey = {
  key: string;
  fingerprint: string;
};

export type SshBrowseResult = {
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
};

export type SshPortForward = {
  remotePort: number;
  localPort: number;
};

export type SshPortForwardStart = {
  forwards: SshPortForward[];
  ignoredPorts: string[];
};

export type SshMobileDevice = {
  id: string;
  label: string;
  pairedAt: number;
  lastSeenAt: number | null;
};

/** Mobile access is paused until its security review is settled: only an installed service shows, to be disabled. */
export const MOBILE_ACCESS_PAUSED = true;

export type SshMobileStatus = {
  platform: string;
  supported: boolean;
  installed: boolean;
  upToDate: boolean;
  active: boolean;
  /** An older Tailscale installation, to convert with an update. */
  legacy: boolean;
  connected: boolean;
  stateFresh: boolean;
  host: string | null;
  server: string | null;
  /** `null` when the server could not read its authorizations; empty without a current binary. */
  devices: SshMobileDevice[] | null;
  /** Ids of the pairing secrets still waiting for a phone; `null` like `devices`. */
  pairings: string[] | null;
  /** Ids of the pairing secrets a phone spent, kept until they would have expired; `null` like `devices`. */
  pairingsUsed: string[] | null;
};

export type SshMobilePairing = {
  id: string;
  /** Carries the pairing secret: never displayed nor copied. */
  url: string;
  qrSvg: string;
  /** On this desktop's clock. */
  expiresAt: number;
};

export type AgentEnvironment = {
  kind: "local" | "wsl" | "ssh";
  distribution: string | null;
  ssh?: SshConnection | null;
};

// ASCII-only case folding, like the backend `eq_ignore_ascii_case`.
function wslDistributionKey(distribution: string | null): string | null {
  return (
    distribution?.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) ?? null
  );
}

export function agentEnvironmentKey(environment: AgentEnvironment): string {
  const ssh = environment.ssh;
  return JSON.stringify([
    environment.kind,
    environment.kind === "wsl"
      ? wslDistributionKey(environment.distribution)
      : null,
    environment.kind === "ssh"
      ? [
          ssh?.host ?? null,
          ssh?.user ?? null,
          ssh?.port ?? null,
          ssh?.identityFile ?? null,
          ssh?.hostKey ?? null,
        ]
      : null,
  ]);
}

export function agentProjectTargetKey(
  environment: AgentEnvironment,
  path: string,
): string {
  return JSON.stringify([
    agentEnvironmentKey(environment),
    path.replace(/\/+$/, ""),
  ]);
}

// Mirrors the backend `same_agent_environment` group rule.
export function sameAgentMachine(
  left: AgentEnvironment,
  right: AgentEnvironment,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "wsl") {
    const leftName = wslDistributionKey(left.distribution);
    return (
      leftName != null && leftName === wslDistributionKey(right.distribution)
    );
  }
  if (left.kind === "ssh") {
    return (
      left.ssh != null &&
      right.ssh != null &&
      left.ssh.host === right.ssh.host &&
      left.ssh.user === right.ssh.user &&
      left.ssh.port === right.ssh.port
    );
  }
  return true;
}

export type AgentProjectDirectory = {
  path: string;
  suggestedName: string | null;
  environment: AgentEnvironment;
};

export function agentProjectNameFromPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}

export function isAbsoluteProjectPath(
  environment: AgentEnvironment,
  path: string,
): boolean {
  return environment.kind === "local"
    ? /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
    : path.startsWith("/");
}

export type AgentProject = {
  id: string;
  name: string;
  path: string;
  environment: AgentEnvironment;
  iconDataUrl?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type AgentProjectAppearance = Pick<
  AgentProject,
  "color" | "icon" | "iconDataUrl"
>;

export function sshProjectScope(
  project: AgentProject | null | undefined,
): string | null {
  return project?.environment.kind === "ssh"
    ? JSON.stringify([
        project.id,
        project.path,
        project.environment.ssh?.host ?? null,
        project.environment.ssh?.user ?? null,
        project.environment.ssh?.port ?? null,
      ])
    : null;
}

/** Synthetic project of Design boards without a project; like the design sessions, absent from the agents space. */
export const designProjectId = "design";

export type AgentSession = {
  id: string;
  projectId: string;
  name: string;
  /** Manual name; takes precedence over names reported by the CLI. */
  customName?: string | null;
  kind?: "terminal" | "service" | "conversation";
  serviceId?: string | null;
  workingDirectory?: string | null;
  /** Empty launches the environment's default interactive shell. */
  executable: string;
  args: string[];
  createdAt: string;
  /** Kept when its tab closes, to be reopened from the favorites menu. */
  favorite?: boolean;
  /** Hidden agent of a Design board: never listed in the agents space. */
  design?: boolean;
};

export type AgentSessionStatus = {
  sessionId: string;
  state: "idle" | "running" | "exited";
  exitCode: number | null;
  /** The launcher did not find the session executable in the project environment. */
  missingExecutable?: boolean;
  /** Claude Code or Codex too old to report its activity (OSC 7501). */
  outdatedCli?: boolean;
  /** Live agent activity, when reported by the CLI bridge. */
  working?: boolean | null;
  /** The agent waits for a reply: permission prompt or question. */
  awaiting?: boolean;
  /** Start of the final message of the last finished turn. */
  lastMessage?: string;
  conversation?: {
    provider: AgentProvider;
    sessionId: string;
    sessionFile: string | null;
    name: string | null;
  } | null;
  resume?: "new" | "linked" | "select" | "approval" | "unsupported";
  conversationError?: string | null;
  /** Summary the agent ended its turn with, not yet posted to its Kanban issue. */
  issueSummary?: { id: string; text: string };
};

export type AgentSessionMessage = {
  id: string;
  sessionId: string;
  body: string;
  status: "queued" | "delivered" | "failed";
  /** Why a failed message was not delivered, or why a queued one is held back. */
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

const SORENO_PREFIX = "Soreno(?::| comment on )";
const SORENO_NOTICE = new RegExp(`^${SORENO_PREFIX}`);
// Batches are joined like MESSAGE_SEPARATOR in agent_sessions/messages.rs; the lookahead keeps a description's own rule in its message.
// shortcut: a quoted excerpt holding a blank line, ---, a blank line then a Soreno: line splits as a new notice; skip fenced code if such diffs get commented.
const SORENO_BATCH_SEPARATOR = new RegExp(
  `\\n\\n---\\n\\n(?=${SORENO_PREFIX})`,
);

/** The Soreno messages a delivered batch holds, each as its first line and the rest; null for a prompt the user wrote. */
export function sorenoNotices(text: string) {
  if (!SORENO_NOTICE.test(text)) return null;
  return text.split(SORENO_BATCH_SEPARATOR).map((message) => {
    const end = message.indexOf("\n");
    return end < 0
      ? { summary: message.trim(), details: "" }
      : { summary: message.slice(0, end), details: message.slice(end).trim() };
  });
}

export type AgentSessionActivity =
  "working" | "awaiting" | "waiting" | "running" | "stopped";

export function agentSessionActivity(
  status: AgentSessionStatus | undefined,
): AgentSessionActivity {
  if (status?.state !== "running") return "stopped";
  if (status.awaiting === true) return "awaiting";
  if (status.working === true) return "working";
  return status.working === false ? "waiting" : "running";
}

export type AgentProjectGroupRecord = AgentProjectAppearance & {
  id: string;
  name: string;
  projectIds: string[];
  groupProjectId: string | null;
};

export const groupCollapseKey = (groupId: string) => `group:${groupId}`;

export type AgentSessionEndReason =
  "session" | "project" | "worktree" | "merged";

// One record per issue; sessionId is null once the session is gone, then the record describes how it ended.
export type AgentSessionKanbanIssue = {
  source: KanbanSource;
  issueId: string;
  issueIdentifier: string;
  /** Empty for a Linear link made before titles were kept. */
  issueTitle: string;
  sessionId: string | null;
  sessionName: string;
  executable: string;
  projectName: string;
  startedAt: string;
  endedAt: string | null;
  endReason: AgentSessionEndReason | null;
  mergedInto: string | null;
};

export type AgentProjectLinearLink = {
  projectId: string;
  linearProjectId: string;
};

/** A coding agent working from a Design board; a session follows at most one board. */
export type AgentSessionDesignBoard = {
  boardId: string;
  sessionId: string;
  linkedAt: string;
};

/** Like the backend, keeps closed only sessions a favorite, a listed issue or an automation still holds. */
export function closedAgentSessionIds(
  closedIds: readonly string[],
  sessions: readonly AgentSession[],
  links: readonly AgentSessionKanbanIssue[],
  automationSessionIds: readonly string[],
): Set<string> {
  const kept = new Set([
    ...sessions.flatMap((session) => (session.favorite ? [session.id] : [])),
    ...links.flatMap((link) => (link.sessionId ? [link.sessionId] : [])),
    ...automationSessionIds,
  ]);
  return new Set(closedIds.filter((id) => kept.has(id)));
}

export type AgentWorkspace = {
  projects: AgentProject[];
  sessions: AgentSession[];
  statuses: AgentSessionStatus[];
  /** Projects without automatic SSH access, dormant ones included. */
  disconnectedProjectIds?: string[];
  /** SSH projects not reached since launch: starting a session connects them. */
  dormantProjectIds?: string[];
  groups?: AgentProjectGroupRecord[];
  kanbanIssueSessions?: AgentSessionKanbanIssue[];
  designBoardSessions?: AgentSessionDesignBoard[];
  linearProjectLinks?: AgentProjectLinearLink[];
  /** Sessions kept without a tab until reopened. */
  closedSessionIds?: string[];
  /** Sessions an automation runs in; closing their tab keeps them. */
  automationSessionIds?: string[];
};

/** An explicitly disconnected project refuses launches; a dormant one connects on launch. */
export function sessionLaunchBlocked(
  workspace: Pick<
    AgentWorkspace,
    "disconnectedProjectIds" | "dormantProjectIds"
  >,
  projectId: string,
): boolean {
  return (
    (workspace.disconnectedProjectIds ?? []).includes(projectId) &&
    !(workspace.dormantProjectIds ?? []).includes(projectId)
  );
}

export type AgentProjectBranch = {
  projectId: string;
  branch: string | null;
};

export type AgentServiceDirectory = {
  serviceId: string;
  cwd: string;
};

export type AgentServiceBranch = {
  serviceId: string;
  branch: string | null;
};

export type AgentProjectWorktree = {
  path: string;
  head: string;
  branch: string | null;
  projectIds: string[];
};

export type AgentProjectWorktreeGroup = {
  repositoryProjectId: string;
  projectIds: string[];
  worktrees: AgentProjectWorktree[];
};

export type AgentProjectWorktreeSnapshot = {
  groups: AgentProjectWorktreeGroup[];
  complete: boolean;
  // Probed projects whose folder no longer exists.
  missingProjectIds: string[];
};

export type AgentEnvironments = {
  localLabel: string;
  distributions: string[];
  wslError: string | null;
};

export const AGENT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
export class AgentAttachmentTooLargeError extends Error {}

export type AgentGridConfig = {
  // Device pixels, for CSI 14/16/18 t replies.
  cellWidth: number;
  cellHeight: number;
  // 0–15 ANSI, 16 foreground, 17 background, 18 cursor.
  palette: string[];
};

export type AgentGridScroll =
  | { kind: "delta"; lines: number }
  | { kind: "pageUp" }
  | { kind: "pageDown" }
  | { kind: "bottom" }
  // Lines up from the bottom; the backend clamps it to the history.
  | { kind: "offset"; offset: number };

// Viewport rows and cells; `right` when the pointer is on the cell's right half.
export type AgentGridSelect =
  | {
      kind: "start";
      row: number;
      col: number;
      right: boolean;
      mode: "simple" | "word" | "line";
    }
  // A row outside the screen scrolls toward it by its distance first.
  | { kind: "extend"; row: number; col: number; right: boolean }
  | { kind: "all" }
  | { kind: "clear" };

// Inclusive cells in viewport rows; rows outside the screen are scrolled out of view.
export type AgentGridSelection = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type AgentGridSpan = {
  t: string;
  c: number;
  fg: number;
  bg: number;
  f: number;
  l?: string;
  // One glyph over `c` cells (wide, combining, astral): never split per UTF-16 unit.
  g?: true;
};

export type AgentGridCursorShape = "block" | "underline" | "beam" | "hidden";

export type AgentGridFrame = {
  cols: number;
  rows: number;
  full: boolean;
  // Rows the content moved up (negative: down) before `lines` apply; vacated rows are blank.
  shift: number;
  // [row, spans, wrapped]: wrapped when the row's text continues on the next row.
  lines: [number, AgentGridSpan[], boolean][];
  cursor: { row: number; col: number; shape: AgentGridCursorShape };
  displayOffset: number;
  historySize: number;
  selection: AgentGridSelection | null;
  // Select requests the engine applied so far (wraps at 2^32).
  selectCount: number;
  modes: number;
  title: string | null;
  clipboard: string | null;
  state: AgentSessionStatus["state"];
  parsedBytes: number;
  parseMicros: number;
};

/** OMP driven over its RPC protocol in a conversation view: a launcher identity, not a CLI. */
export const ompConversationExecutable = "omp-conversation";

export const agentPresets = [
  { name: "Pi", executable: "pi" },
  { name: "OMP", executable: "omp" },
  { name: "Codex", executable: "codex" },
  { name: "Claude Code", executable: "claude" },
  { name: "Chat (OMP)", executable: ompConversationExecutable },
  { name: "Terminal", executable: "" },
] as const;

export type AgentProvider = Exclude<
  (typeof agentPresets)[number]["executable"],
  ""
>;

export type AgentLaunchPreset = Extract<
  (typeof agentPresets)[number],
  { executable: AgentProvider }
>;

export const agentLaunchPresets = agentPresets.filter(
  (preset): preset is AgentLaunchPreset => preset.executable !== "",
);

export const agentInstallGuides: Record<AgentProvider, string> = {
  pi: "https://pi.dev",
  omp: "https://omp.sh/docs/quickstart",
  [ompConversationExecutable]: "https://omp.sh/docs/quickstart",
  codex: "https://developers.openai.com/codex/cli",
  claude: "https://code.claude.com/docs/en/setup",
};

export function isAgentProvider(value: unknown): value is AgentProvider {
  return agentLaunchPresets.some(({ executable }) => executable === value);
}

export function defaultAgentArgs(
  byProvider: Partial<Record<AgentProvider, string[]>>,
  executable: string,
): string[] {
  return (isAgentProvider(executable) && byProvider[executable]) || [];
}

export function visibleAgentPresets(hidden: readonly AgentProvider[]) {
  return agentPresets.filter(
    ({ executable }) =>
      executable === "" || !hidden.some((provider) => provider === executable),
  );
}

// An issue agent needs an executable, so hiding every agent cannot empty this list.
export function visibleIssueAgentPresets(hidden: readonly AgentProvider[]) {
  const visible = agentLaunchPresets.filter(
    ({ executable }) => !hidden.includes(executable),
  );
  return visible.length > 0 ? visible : agentLaunchPresets;
}

export function orderAgentItems<T extends { id: string }>(
  items: T[],
  ids: readonly string[] = [],
): T[] {
  const remaining = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];
  for (const id of ids) {
    const item = remaining.get(id);
    if (item) {
      ordered.push(item);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

/** The insertion index is measured after removing the moved item. */
export function moveAgentItem<T extends { id: string }>(
  items: T[],
  id: string,
  index: number,
): T[] {
  const from = items.findIndex((item) => item.id === id);
  const to = Math.max(
    0,
    Math.min(Number.isNaN(index) ? 0 : Math.trunc(index), items.length - 1),
  );
  if (from < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function pinnedAgentItemsFirst<T extends { id: string }>(
  items: T[],
  pinnedIds: ReadonlySet<string>,
): T[] {
  return [
    ...items.filter((item) => pinnedIds.has(item.id)),
    ...items.filter((item) => !pinnedIds.has(item.id)),
  ];
}

export function projectSectionIds(
  projects: AgentProject[],
  groups: AgentProjectGroupRecord[],
) {
  const groupByProjectId = new Map(
    groups.flatMap((group) =>
      group.projectIds.map((id) => [id, group.id] as const),
    ),
  );
  const addedGroupIds = new Set<string>();
  return [
    ...projects.flatMap((project) => {
      const groupId = groupByProjectId.get(project.id);
      if (!groupId) return [`project:${project.id}`];
      if (addedGroupIds.has(groupId)) return [];
      addedGroupIds.add(groupId);
      return [`group:${groupId}`];
    }),
    ...groups.flatMap((group) =>
      addedGroupIds.has(group.id) ? [] : [`group:${group.id}`],
    ),
  ];
}

export function reconcileProjectSectionOrder(
  current: string[],
  derived: string[],
) {
  const derivedIds = new Set(derived);
  const included = new Set<string>();
  const next = current.filter((id) => {
    if (!derivedIds.has(id) || included.has(id)) return false;
    included.add(id);
    return true;
  });
  for (let index = 0; index < derived.length; index++) {
    const id = derived[index];
    if (included.has(id)) continue;
    const precedingIndex = next.indexOf(derived[index - 1]);
    const followingId = derived
      .slice(index + 1)
      .find((candidate) => included.has(candidate));
    const followingIndex = followingId ? next.indexOf(followingId) : -1;
    next.splice(
      precedingIndex >= 0
        ? precedingIndex + 1
        : followingIndex >= 0
          ? followingIndex
          : next.length,
      0,
      id,
    );
    included.add(id);
  }
  return next;
}

// Launchers may be absolute paths or Windows wrappers (claude.cmd, omp.ps1…).
function agentExecutableName(executable: string): string {
  const name = executable.split(/[\\/]/).pop() ?? executable;
  return name.replace(/\.(exe|ps1|cmd|bat)$/i, "");
}

function agentPresetOf(executable: string) {
  const name = agentExecutableName(executable).toLowerCase();
  return agentPresets.find((preset) => preset.executable === name) ?? null;
}

export function agentProviderOf(executable: string): AgentProvider | null {
  return agentPresetOf(executable)?.executable || null;
}

export function agentProviderLabel(executable: string): string {
  return agentPresetOf(executable)?.name ?? agentExecutableName(executable);
}

export function agentImagePasteSequence(
  executable: string,
  environment: AgentEnvironment,
  platform: string,
): string {
  return agentProviderOf(executable) === "pi" &&
    (environment.kind === "wsl" ||
      (environment.kind === "local" && /^win/i.test(platform)))
    ? "\x1bv"
    : "\x16";
}

export function agentSessionDisplayName(
  session: Pick<AgentSession, "name" | "customName" | "executable">,
  automaticName?: string | null,
  issue?: Pick<AgentSessionKanbanIssue, "issueIdentifier" | "issueTitle">,
): string {
  if (session.customName) return session.customName;
  const issueName =
    issue &&
    [issue.issueIdentifier, issue.issueTitle].filter(Boolean).join(" · ");
  const provider = agentProviderOf(session.executable);
  // OMP retitles as the work moves and a Pi name is set on purpose; Claude and Codex titles guess from the first messages.
  return (
    (provider === "pi" ||
    provider === "omp" ||
    provider === ompConversationExecutable
      ? automaticName || issueName
      : issueName || automaticName) || session.name
  );
}

export function agentSessionTitle(
  title: string,
  executable: string,
  projectPath: string,
): string | null {
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!clean) return "";
  const provider = agentProviderOf(executable);
  if (provider === "pi") {
    const prefix = /^(?:\S+\s+)?(?:π|pi) - /i;
    // Ignore shell/launcher titles; only the CLI's own format identifies a session.
    if (!prefix.test(clean)) return null;
    const name = clean.replace(prefix, "");
    const folder = agentProjectNameFromPath(projectPath);
    if (name === folder) return "";
    const suffix = ` - ${folder}`;
    return (
      name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() : name
    ).slice(0, 512);
  }
  if (provider === "omp") {
    if (clean === "π") return "";
    const match = /^π(?:\s*:\s*|\s+[>!:\u2800-\u28ff](?:\s+|$))(.*)$/u.exec(
      clean,
    );
    return match ? match[1].trim().slice(0, 512) : null;
  }
  let name =
    provider === "claude" ? clean.replace(/^[✳◐◑](?:\s+|$)/u, "") : clean;
  if (provider === "codex") name = withoutCodexProjectSuffix(name, projectPath);
  if (
    /^(?:[a-z]:[\\/]|\\\\|\/|(?:wsl|cmd|powershell|pwsh)(?:\.exe)?(?:\s|$))/i.test(
      name,
    )
  )
    return null;
  return name.slice(0, 512);
}

const CODEX_TITLE_PROJECT_MAX = 24;

function graphemes(value: string): string[] {
  // Older macOS WebKit lacks Intl.Segmenter: fall back to code points.
  if (typeof Intl.Segmenter !== "function") return Array.from(value);
  return Array.from(
    new Intl.Segmenter().segment(value),
    (part) => part.segment,
  );
}

function withoutCodexProjectSuffix(name: string, projectPath: string): string {
  const project = agentProjectNameFromPath(projectPath);
  if (!project) return name;
  if (name.endsWith(` | ${project}`))
    return name.slice(0, -` | ${project}`.length).trim();
  // Codex cuts project names past 24 graphemes to their first 21 followed by "...".
  const parts = graphemes(project);
  if (parts.length <= CODEX_TITLE_PROJECT_MAX) return name;
  const label = `${parts.slice(0, CODEX_TITLE_PROJECT_MAX - 3).join("")}...`;
  if (name.endsWith(` | ${label}`))
    return name.slice(0, -` | ${label}`.length).trim();
  return name;
}

export function agentEnvironmentLabel(
  environment: AgentEnvironment,
  localLabel = "Local",
): string {
  if (environment.kind === "wsl") return "WSL";
  if (environment.kind === "ssh") {
    const connection = environment.ssh;
    const host = connection?.host ?? "";
    const address = connection?.port
      ? `${host.includes(":") ? `[${host}]` : host}:${connection.port}`
      : host;
    return `SSH · ${connection?.user ? `${connection.user}@` : ""}${address}`;
  }
  return localLabel;
}
