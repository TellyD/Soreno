import { agentSessionActivity, type AgentSessionStatus } from "./agentSessions";
import { sameItems } from "./sameItems";

type AgentAttentionKind = "finished" | "awaiting";

/** What a session's mark asks of the user, the wait first. */
export type AgentSessionAttention = "awaiting" | "unread";

export type AgentAttentionEvent = {
  sessionId: string;
  kind: AgentAttentionKind;
};

export type AgentAttentionState = {
  /** Sessions whose turn has not been seen ending yet. */
  working: ReadonlySet<string>;
  /** Waiting for a reply, oldest first. */
  awaiting: readonly string[];
  /** Finished out of view and not shown since, oldest first. */
  unread: readonly string[];
};

export const emptyAgentAttention: AgentAttentionState = {
  working: new Set(),
  awaiting: [],
  unread: [],
};

/** Applies one status refresh; events are the turns that ended and the new waits. */
export function observeAgentAttention(
  state: AgentAttentionState,
  statuses: ReadonlyMap<string, AgentSessionStatus>,
  sessionIds: ReadonlySet<string>,
  displayed: ReadonlySet<string>,
): { state: AgentAttentionState; events: AgentAttentionEvent[] } {
  const working = new Set<string>();
  const observedWorking = new Set<string>();
  const awaitingNow = new Set<string>();
  const finished: string[] = [];
  for (const status of statuses.values()) {
    if (!sessionIds.has(status.sessionId)) continue;
    const activity = agentSessionActivity(status);
    if (activity === "working") observedWorking.add(status.sessionId);
    else if (activity === "awaiting") awaitingNow.add(status.sessionId);
  }
  for (const id of state.working) {
    if (!sessionIds.has(id)) continue;
    const status = statuses.get(id);
    const activity = status && agentSessionActivity(status);
    // Missing status or unknown activity is not finished: wait for a real one.
    if (!activity || activity === "running" || activity === "awaiting")
      working.add(id);
    else if (activity !== "working") finished.push(id);
  }
  // A wait belongs to the turn: answering it resumes work that ends later.
  for (const id of [...observedWorking, ...awaitingNow]) working.add(id);
  const awaiting = [
    ...state.awaiting.filter((id) => awaitingNow.has(id)),
    ...[...awaitingNow].filter((id) => !state.awaiting.includes(id)),
  ];
  const unread = [...new Set([...state.unread, ...finished])].filter(
    (id) =>
      sessionIds.has(id) &&
      !displayed.has(id) &&
      // A new run or a wait supersedes the previous unread mark.
      !observedWorking.has(id) &&
      !awaitingNow.has(id),
  );
  const events: AgentAttentionEvent[] = [
    ...finished.map((sessionId) => ({ sessionId, kind: "finished" as const })),
    ...awaiting
      .filter((id) => !state.awaiting.includes(id))
      .map((sessionId) => ({ sessionId, kind: "awaiting" as const })),
  ];
  return {
    state: {
      working,
      awaiting: sameItems(awaiting, state.awaiting) ? state.awaiting : awaiting,
      unread: sameItems(unread, state.unread) ? state.unread : unread,
    },
    events,
  };
}

type AgentNotificationContext = {
  /** Sessions whose terminal is on screen in the workspace. */
  displayed: ReadonlySet<string>;
  windowFocused: boolean;
};

/** Never for a session shown in a focused window. */
export function notifiableAgentEvents(
  events: readonly AgentAttentionEvent[],
  { displayed, windowFocused }: AgentNotificationContext,
): AgentAttentionEvent[] {
  return events.filter(
    ({ sessionId }) => !windowFocused || !displayed.has(sessionId),
  );
}

export type AgentNotificationSubject = {
  name: string;
  projectName: string | null;
  lastMessage: string | null;
};

export type AgentNotificationStrings = {
  awaiting: string;
  finished: string;
  several: (count: number) => string;
};

export type AgentNotification = {
  title: string;
  body: string;
  /** Selected when the notification is clicked. */
  sessionId: string;
};

/** One notification for a batch: waits first, then finished turns, once per session. */
export function agentNotification(
  events: readonly AgentAttentionEvent[],
  describe: (sessionId: string) => AgentNotificationSubject | undefined,
  strings: AgentNotificationStrings,
): AgentNotification | null {
  const kinds = new Map<string, AgentAttentionKind>();
  for (const { sessionId, kind } of events)
    if (kinds.get(sessionId) !== "awaiting") kinds.set(sessionId, kind);
  const entries = [...kinds]
    .sort(
      ([, left], [, right]) =>
        Number(right === "awaiting") - Number(left === "awaiting"),
    )
    .flatMap(([sessionId, kind]) => {
      const subject = describe(sessionId);
      return subject ? [{ sessionId, kind, subject }] : [];
    });
  const [first] = entries;
  if (!first) return null;
  if (entries.length === 1) {
    const { kind, subject } = first;
    const detail =
      kind === "awaiting"
        ? strings.awaiting
        : (subject.lastMessage ?? strings.finished);
    // An unnamed session falls back to its project's name: the title already says it.
    const projectName =
      subject.projectName === subject.name ? null : subject.projectName;
    return {
      title: subject.name,
      body: [projectName, detail].filter(Boolean).join(" · "),
      sessionId: first.sessionId,
    };
  }
  return {
    title: strings.several(entries.length),
    body: entries.map(({ subject }) => subject.name).join(", "),
    sessionId: first.sessionId,
  };
}

/** Waits come before unread turns; a session already on screen is skipped. */
export function nextAgentAttentionSession(
  state: Pick<AgentAttentionState, "awaiting" | "unread">,
  displayed: ReadonlySet<string>,
): string | null {
  return (
    [...state.awaiting, ...state.unread].find((id) => !displayed.has(id)) ??
    null
  );
}
