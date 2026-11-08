import { describe, expect, it } from "vitest";
import {
  agentNotification,
  emptyAgentAttention,
  nextAgentAttentionSession,
  notifiableAgentEvents,
  observeAgentAttention,
  type AgentAttentionEvent,
  type AgentAttentionState,
} from "./agentAttention";
import type { AgentSessionStatus } from "./agentSessions";

type Activity = "working" | "idle" | "awaiting" | "unknown" | "exited";

function statuses(activities: Record<string, Activity>) {
  return new Map<string, AgentSessionStatus>(
    Object.entries(activities).map(([sessionId, activity]) => [
      sessionId,
      {
        sessionId,
        state: activity === "exited" ? "exited" : "running",
        exitCode: null,
        working:
          activity === "unknown"
            ? null
            : activity !== "idle" && activity !== "exited",
        awaiting: activity === "awaiting",
      },
    ]),
  );
}

function observer(sessionIds = ["a", "b", "c"]) {
  let state: AgentAttentionState = emptyAgentAttention;
  return {
    get state() {
      return state;
    },
    observe(activities: Record<string, Activity>, displayed: string[] = []) {
      const result = observeAgentAttention(
        state,
        statuses(activities),
        new Set(sessionIds),
        new Set(displayed),
      );
      state = result.state;
      return result.events;
    },
  };
}

describe("observeAgentAttention", () => {
  it("reports a finished turn once and keeps it unread only out of view", () => {
    const sessions = observer();
    expect(sessions.observe({ a: "working", b: "working" })).toEqual([]);
    expect(sessions.observe({ a: "idle", b: "idle" }, ["b"])).toEqual([
      { sessionId: "a", kind: "finished" },
      { sessionId: "b", kind: "finished" },
    ]);
    expect(sessions.state.unread).toEqual(["a"]);
    expect(sessions.observe({ a: "idle", b: "idle" })).toEqual([]);

    sessions.observe({ a: "idle" }, ["a"]);
    expect(sessions.state.unread).toEqual([]);
  });

  it("waits for a known activity before ending a turn", () => {
    const sessions = observer();
    sessions.observe({ a: "working" });
    expect(sessions.observe({ a: "unknown" })).toEqual([]);
    expect(sessions.observe({})).toEqual([]);
    expect(sessions.observe({ a: "exited" })).toEqual([
      { sessionId: "a", kind: "finished" },
    ]);
  });

  it("reports a wait once, then the end of the turn it belongs to", () => {
    const sessions = observer();
    sessions.observe({ a: "idle" });
    expect(sessions.observe({ a: "awaiting" })).toEqual([
      { sessionId: "a", kind: "awaiting" },
    ]);
    expect(sessions.observe({ a: "awaiting" })).toEqual([]);
    expect(sessions.state.awaiting).toEqual(["a"]);

    expect(sessions.observe({ a: "working" })).toEqual([]);
    expect(sessions.state.awaiting).toEqual([]);
    expect(sessions.observe({ a: "idle" })).toEqual([
      { sessionId: "a", kind: "finished" },
    ]);
  });

  it("lets a new run or a wait supersede an unread mark", () => {
    const sessions = observer();
    sessions.observe({ a: "working", b: "working" });
    sessions.observe({ a: "idle", b: "idle" });
    expect(sessions.state.unread).toEqual(["a", "b"]);
    sessions.observe({ a: "working", b: "awaiting" });
    expect(sessions.state.unread).toEqual([]);
    expect(sessions.state.awaiting).toEqual(["b"]);
  });

  it("forgets deleted sessions", () => {
    const sessions = observer(["a"]);
    sessions.observe({ a: "working", b: "working" });
    expect(sessions.observe({ a: "idle", b: "idle" })).toEqual([
      { sessionId: "a", kind: "finished" },
    ]);
    expect(sessions.observe({ b: "awaiting" })).toEqual([]);
  });
});

describe("notifiableAgentEvents", () => {
  const events: AgentAttentionEvent[] = [
    { sessionId: "shown", kind: "finished" },
    { sessionId: "hidden", kind: "awaiting" },
  ];
  const notified = (windowFocused: boolean) =>
    notifiableAgentEvents(events, {
      displayed: new Set(["shown"]),
      windowFocused,
    }).map(({ sessionId }) => sessionId);

  it("never notifies for a session shown in a focused window", () => {
    expect(notified(true)).toEqual(["hidden"]);
  });

  it("notifies every session while the window is in the background", () => {
    expect(notified(false)).toEqual(["shown", "hidden"]);
  });
});

describe("agentNotification", () => {
  const strings = {
    awaiting: "Attend votre réponse",
    finished: "Tour terminé",
    several: (count: number) => `${count} sessions`,
  };
  const subjects: Record<
    string,
    { name: string; projectName: string | null; lastMessage: string | null }
  > = {
    a: { name: "Tests", projectName: "Web", lastMessage: "Tout passe." },
    b: { name: "Docs", projectName: "Web", lastMessage: null },
    c: { name: "Infra", projectName: null, lastMessage: null },
    d: { name: "Web", projectName: "Web", lastMessage: "Prêt." },
  };
  const notification = (events: AgentAttentionEvent[]) =>
    agentNotification(events, (id) => subjects[id], strings);

  it("names the session, its project and the start of its last message", () => {
    expect(notification([{ sessionId: "a", kind: "finished" }])).toEqual({
      title: "Tests",
      body: "Web · Tout passe.",
      sessionId: "a",
    });
    expect(notification([{ sessionId: "b", kind: "finished" }])?.body).toBe(
      "Web · Tour terminé",
    );
    expect(notification([{ sessionId: "c", kind: "awaiting" }])?.body).toBe(
      "Attend votre réponse",
    );
    expect(notification([{ sessionId: "d", kind: "finished" }])?.body).toBe(
      "Prêt.",
    );
  });

  it("groups simultaneous sessions and opens the first wait", () => {
    expect(
      notification([
        { sessionId: "a", kind: "finished" },
        { sessionId: "b", kind: "finished" },
        { sessionId: "c", kind: "awaiting" },
        { sessionId: "a", kind: "awaiting" },
        { sessionId: "gone", kind: "finished" },
      ]),
    ).toEqual({
      title: "3 sessions",
      body: "Tests, Infra, Docs",
      sessionId: "a",
    });
  });

  it("is skipped when no session is left to describe", () => {
    expect(notification([{ sessionId: "gone", kind: "finished" }])).toBeNull();
  });
});

describe("nextAgentAttentionSession", () => {
  it("prefers waits over unread turns and skips sessions on screen", () => {
    const state = { awaiting: ["a", "b"], unread: ["c"] };
    expect(nextAgentAttentionSession(state, new Set())).toBe("a");
    expect(nextAgentAttentionSession(state, new Set(["a"]))).toBe("b");
    expect(nextAgentAttentionSession(state, new Set(["a", "b"]))).toBe("c");
    expect(
      nextAgentAttentionSession(
        { awaiting: ["a"], unread: [] },
        new Set(["a"]),
      ),
    ).toBeNull();
  });
});
