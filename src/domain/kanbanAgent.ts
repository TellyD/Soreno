import {
  agentPresets,
  agentProviderLabel,
  agentProviderOf,
  agentSessionActivity,
  agentSessionDisplayName,
  type AgentSession,
  type AgentSessionActivity,
  type AgentSessionKanbanIssue,
  type AgentSessionStatus,
} from "./agentSessions";
import { kanbanImageName, type KanbanSource } from "./kanban";

export type KanbanIssueAgentRequest = {
  issue: {
    source: KanbanSource;
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    branchName: string;
  };
  projectId: string;
  executable: string;
  presetName: string;
  worktree: boolean;
  /** False keeps the Kanban view on screen while the session starts in the rail. */
  open: boolean;
};

export type KanbanIssueAgentTarget = Omit<KanbanIssueAgentRequest, "issue">;

export type KanbanIssueAgentSession = {
  session: AgentSession;
  name: string;
  activity: AgentSessionActivity;
  /** Its tab was closed; the session is kept to be reopened from the issue. */
  closed: boolean;
  projectName: string;
};

export type KanbanIssueAgents = {
  live: ReadonlyMap<string, KanbanIssueAgentSession>;
  ended: ReadonlyMap<string, AgentSessionKanbanIssue>;
};

// Same name as the session's tab: OMP reports its title in the status, other CLIs in the terminal title.
function sessionName(
  session: AgentSession,
  status: AgentSessionStatus | undefined,
  terminalTitles: Readonly<Record<string, string>>,
) {
  return agentSessionDisplayName(
    session,
    status?.conversation?.name || terminalTitles[session.id],
  );
}

export function kanbanIssueAgents(
  links: readonly AgentSessionKanbanIssue[],
  sessions: readonly AgentSession[],
  statuses: readonly AgentSessionStatus[],
  closedSessionIds: ReadonlySet<string>,
  terminalTitles: Readonly<Record<string, string>>,
): KanbanIssueAgents {
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const statusesById = new Map(
    statuses.map((status) => [status.sessionId, status]),
  );
  const live = new Map<string, KanbanIssueAgentSession>();
  const ended = new Map<string, AgentSessionKanbanIssue>();
  for (const link of links) {
    if (link.sessionId === null) {
      ended.set(link.issueId, link);
      continue;
    }
    const session = sessionsById.get(link.sessionId);
    const status = session && statusesById.get(session.id);
    if (session)
      live.set(link.issueId, {
        session,
        name: sessionName(session, status, terminalTitles),
        activity: agentSessionActivity(status),
        closed: closedSessionIds.has(session.id),
        projectName: link.projectName,
      });
  }
  return { live, ended };
}

export type KanbanCommentTarget = {
  sessionId: string;
  name: string;
  executable: string;
  /** The issue's own linked session: the only one whose summary the backend posts on this issue. */
  linkedToIssue: boolean;
};

/**
 * Running agents that may receive an issue comment: the issue's own session alone while it
 * runs, otherwise the agents of the issue's project.
 */
export function kanbanCommentTargets(
  linked: KanbanIssueAgentSession | undefined,
  projectId: string | undefined,
  sessions: readonly AgentSession[],
  statuses: readonly AgentSessionStatus[],
  terminalTitles: Readonly<Record<string, string>>,
): KanbanCommentTarget[] {
  const statusesById = new Map(
    statuses.map((status) => [status.sessionId, status]),
  );
  const running = (session: AgentSession) =>
    session.kind !== "service" &&
    agentProviderOf(session.executable) !== null &&
    statusesById.get(session.id)?.state === "running";
  if (linked && running(linked.session))
    return [
      {
        sessionId: linked.session.id,
        name: linked.name,
        executable: linked.session.executable,
        linkedToIssue: true,
      },
    ];
  return sessions
    .filter(
      (session) =>
        session.projectId === projectId &&
        session.id !== linked?.session.id &&
        running(session),
    )
    .map((session) => ({
      sessionId: session.id,
      name: sessionName(session, statusesById.get(session.id), terminalTitles),
      executable: session.executable,
      linkedToIssue: false,
    }));
}

// Native Windows re-encodes launch arguments several times under a 32 767-char command line,
// next to the hooks and issue-request instruction (KANBAN_PROMPT_COST_LIMIT in conversations_tests.rs).
export const PROMPT_COST_LIMIT = 1000;
// Mirrors KANBAN_ISSUE_FILENAME in src-tauri/src/commands/agents.rs.
const ISSUE_FILENAME = "issue.md";
// A cut description reads as the whole issue, so a long one goes to the file only.
const TRUNCATION_MARKER = `[Description not in this message: read ${ISSUE_FILENAME} (attached) first.]`;
const ELLIPSIS = "…";
// The backend only posts a summary block that ends the agent's message (kanban_issue_sessions.rs).
const SUMMARY_INSTRUCTION =
  "When the issue is fully done, end your final message with <soreno-summary>what changed for the user, in 1-3 short lines; no file paths, symbols, test counts or commands; on a later turn, only the new changes</soreno-summary>; Soreno posts it on the issue and moves it to review.";
const SUMMARY_TAIL = `\n\n${SUMMARY_INSTRUCTION}`;
const SUMMARY_OPEN = "<soreno-summary>";
const SUMMARY_CLOSE = "</soreno-summary>";

/** Shows the summary block the backend posts as plain prose; other mentions of the tag stay as written. */
// shortcut: the raw tag shows while the block streams, until its closing tag arrives.
// shortcut: checked per text block, while the backend reads the reply's joined text; a text block ending with a summary but followed by another loses its tags on screen only. Check at message level if that shows up.
export function withoutIssueSummaryTags(text: string) {
  const body = text.trimEnd();
  if (!body.endsWith(SUMMARY_CLOSE)) return text;
  const start = body.lastIndexOf(SUMMARY_OPEN);
  if (start < 0) return text;
  const summary = body.slice(
    start + SUMMARY_OPEN.length,
    -SUMMARY_CLOSE.length,
  );
  return summary.trim() ? `${body.slice(0, start)}\n\n${summary.trim()}` : text;
}

// Mirrors MAX_PROMPT_IMAGES in src-tauri/src/kanban/images.rs.
const KANBAN_PROMPT_IMAGE_LIMIT = 6;
// Room for "\n\nAttached files in <directory>: image-1.png, …, issue.md", appended by the backend at launch.
export const ATTACHMENT_NOTE_COST = 450;
const ATTACHMENT_NAME_COST = 16;
// `![alt](url)` or `![alt](<url>)` with a local asset URL; the alt text may hold escaped brackets.
const ASSET_IMAGE_PATTERN =
  /(!\[(?:\\.|[^\\\]])*\]\()(<(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/[^\s<>]+>|(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/[^\s()<>]+)(?=[\s)])/g;
// Same shape with a Linear upload URL, which needs the Linear key to be read.
const LINEAR_IMAGE_PATTERN =
  /(!\[(?:\\.|[^\\\]])*\]\()(<https:\/\/uploads\.linear\.app\/[^\s<>]+>|https:\/\/uploads\.linear\.app\/[^\s()<>]+)(?=[\s)])/g;

export type KanbanIssueLaunch = {
  prompt: string;
  // The N-th Kanban image is attached as `image-N.<ext>`, the name the prompt uses for it.
  imageNames: string[];
  // Downloaded by the backend as the images following `imageNames`.
  imageUrls: string[];
  // Original Markdown target of `image-N` at index N-1, restored when the agent edits the issue.
  imageTargets: string[];
  // Untruncated issue, attached as `issue.md` when the prompt cuts its description.
  issueFile: string | null;
};

// UTF-8 bytes, weighted by the JSON escaping and CRT quoting of the Windows launch payload.
function charCost(char: string): number {
  if (char === '"' || char === "\\") return 3;
  if (char === "\n" || char === "\r" || char === "\t") return 2;
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

export function launchCost(text: string): number {
  let cost = 0;
  for (const char of text) cost += charCost(char);
  return cost;
}

function truncateToCost(text: string, limit: number): string {
  let cost = 0;
  let end = 0;
  // Iterating code points never splits a surrogate pair.
  for (const char of text) {
    cost += charCost(char);
    if (cost > limit) break;
    end += char.length;
  }
  return text.slice(0, end);
}

// Neither asset nor Linear upload URLs resolve for the agent, so it gets a copy of each image instead.
function withImagePlaceholders(description: string) {
  const names: string[] = [];
  const urls: string[] = [];
  // First target seen for each name in `names`.
  const localTargets: string[] = [];
  // `offset` numbers the Linear images after every Kanban one, as the backend attaches them.
  const placeholder = (
    list: string[],
    value: string,
    offset: number,
    match: string,
    opening: string,
    target: string = value,
  ) => {
    let index = list.indexOf(value);
    if (index < 0) {
      if (names.length + urls.length === KANBAN_PROMPT_IMAGE_LIMIT)
        return match;
      index = list.push(value) - 1;
      if (list === names) localTargets.push(target);
    }
    return `${opening}image-${offset + index + 1}`;
  };
  const text = description
    .replace(ASSET_IMAGE_PATTERN, (match, opening: string, target: string) => {
      const unwrapped = target.startsWith("<") ? target.slice(1, -1) : target;
      const name = kanbanImageName(unwrapped);
      return name
        ? placeholder(names, name, 0, match, opening, unwrapped)
        : match;
    })
    .replace(LINEAR_IMAGE_PATTERN, (match, opening: string, target: string) =>
      placeholder(
        urls,
        target.startsWith("<") ? target.slice(1, -1) : target,
        names.length,
        match,
        opening,
      ),
    );
  return { text, names, urls, targets: [...localTargets, ...urls] };
}

export function fitTitle(title: string, room: number) {
  if (launchCost(title) <= room) return title;
  return `${truncateToCost(title, room - launchCost(ELLIPSIS)).trimEnd()}${ELLIPSIS}`;
}

export function kanbanIssueLaunch(
  issue: Pick<
    KanbanIssueAgentRequest["issue"],
    "identifier" | "title" | "description"
  >,
): KanbanIssueLaunch {
  const prefix = `Issue ${issue.identifier}: `;
  const title = issue.title.trim();
  const room = PROMPT_COST_LIMIT - launchCost(SUMMARY_TAIL);
  const {
    text: description,
    names,
    urls,
    targets,
  } = withImagePlaceholders(issue.description?.trim() ?? "");
  const images = names.length + urls.length;
  const full = `${prefix}${title}${description ? `\n\n${description}` : ""}`;
  const imagesCost = images
    ? ATTACHMENT_NOTE_COST + images * ATTACHMENT_NAME_COST
    : 0;
  if (launchCost(full) <= room - imagesCost)
    return {
      prompt: `${full}${SUMMARY_TAIL}`,
      imageNames: names,
      imageUrls: urls,
      imageTargets: targets,
      issueFile: null,
    };
  // The attached issue references every image placeholder, so all images go along.
  const limit =
    room - ATTACHMENT_NOTE_COST - (images + 1) * ATTACHMENT_NAME_COST;
  const marker = `\n\n${TRUNCATION_MARKER}`;
  // shortcut: an identifier of ~100 chars leaves no room for the ellipsis and overruns the budget, risking a refused Windows launch; drop the title like design.ts if such identifiers appear.
  const fitted = fitTitle(title, limit - launchCost(prefix + marker));
  return {
    prompt: `${prefix}${fitted}${marker}${SUMMARY_TAIL}`,
    imageNames: names,
    imageUrls: urls,
    imageTargets: targets,
    issueFile: `${full}\n`,
  };
}

/**
 * Agent-facing text, English like the launch prompt; the first line leads a session's message list.
 * The summary instruction only goes to the issue's own session: the backend posts a summary on the
 * receiving session's linked issue, so another agent would report on the wrong issue.
 */
export function kanbanCommentRequest(
  issue: { identifier: string; title: string },
  comment: { body: string },
  linkedToIssue: boolean,
): string {
  const body = comment.body.trim();
  return [
    `Soreno: comment on ${issue.identifier}: ${body.split("\n")[0]}`,
    "",
    `Issue ${issue.identifier}: ${issue.title}`,
    "",
    "Comment:",
    body,
    "",
    "Act on this comment for the issue you are working on; if you disagree or need more information, say so in your reply.",
    ...(linkedToIssue ? [SUMMARY_INSTRUCTION] : []),
  ].join("\n");
}

/**
 * Agent-facing text sent when a running session is linked to an issue afterwards, usually to track
 * the work under way: it gets the issue as context and the summary instruction its report depends on.
 */
export function kanbanIssueAssignment(issue: {
  identifier: string;
  title: string;
  description: string | null;
}): string {
  // shortcut: description images stay as local URLs the agent cannot read; attach them like the launch does if agents need them.
  // shortcut: a description near the 64 KiB message limit makes the send fail (reported, link kept); attach it as a file if such issues get linked.
  const description = issue.description?.trim();
  return [
    `Soreno: this session is now linked to issue ${issue.identifier}: ${issue.title}`,
    ...(description ? ["", description] : []),
    "",
    "Keep doing what you are doing: this issue is context for your current work, so do not start working on it unless the user asks.",
    SUMMARY_INSTRUCTION,
  ].join("\n");
}

/** Agent-facing text sent once a session is unlinked from its issue: its summaries would go nowhere. */
export function kanbanIssueRelease(identifier: string): string {
  return [
    `Soreno: this session is no longer linked to issue ${identifier}.`,
    "",
    "Stop ending your messages with a soreno-summary block for it; keep working as the user asks.",
  ].join("\n");
}

const AGENT_SIGNATURE_SUFFIX = " via Soreno";
// Comments have no author, so the posting agent is named in the body itself.
const AGENT_SIGNATURE_PATTERN = /\n\s*— ([^\n]+) via Soreno\s*$/;

export function signAgentSummary(summary: string, executable: string): string {
  return `${summary.trimEnd()}\n\n— ${agentProviderLabel(executable)}${AGENT_SIGNATURE_SUFFIX}`;
}

export type KanbanAgentComment = {
  name: string;
  executable: string;
  /** The body without its signature. */
  body: string;
};

export function kanbanAgentComment(body: string): KanbanAgentComment | null {
  const match = AGENT_SIGNATURE_PATTERN.exec(body);
  if (!match) return null;
  const name = match[1].trim();
  return {
    name,
    executable:
      agentPresets.find((preset) => preset.name === name)?.executable ?? name,
    body: body.slice(0, match.index).trimEnd(),
  };
}
