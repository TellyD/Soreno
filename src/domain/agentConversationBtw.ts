import type { AgentConversationState } from "./agentConversation";
import { count, isObject, text } from "./agentConversationRecords";

/** One side question; OMP's statuses: running, complete, cancelled, error, interrupted. */
type AgentConversationBtwTurn = {
  question: string;
  answer: string;
  status: string;
  error: string | null;
};

/** A side-question topic: its first question, then its follow-ups. */
export type AgentConversationBtwTopic = {
  id: string;
  createdAt: number;
  turns: AgentConversationBtwTurn[];
};

export function btwTopic(value: unknown): AgentConversationBtwTopic | null {
  if (!isObject(value) || !text(value.id)) return null;
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  return {
    id: text(value.id),
    createdAt: count(value.createdAt) ?? 0,
    turns: [value, ...followUps.filter(isObject)].map((turn) => ({
      question: text(turn.question),
      answer: text(turn.answer),
      status: text(turn.status),
      error: text(turn.error) || null,
    })),
  };
}

export const agentConversationBtwRunning = (topic: AgentConversationBtwTopic) =>
  topic.turns[topic.turns.length - 1].status === "running";

/** Records `topic`; a running one is what the panel shows. */
export function withBtwTopic(
  state: AgentConversationState,
  topic: AgentConversationBtwTopic,
): AgentConversationState {
  return {
    ...state,
    btw: [topic, ...state.btw.filter(({ id }) => id !== topic.id)].sort(
      (left, right) => right.createdAt - left.createdAt,
    ),
    btwView: agentConversationBtwRunning(topic)
      ? { topic: topic.id }
      : state.btwView,
  };
}

export function withLatestBtwTurn(
  topic: AgentConversationBtwTopic,
  change: (turn: AgentConversationBtwTurn) => AgentConversationBtwTurn,
): AgentConversationBtwTopic {
  const turns = [...topic.turns];
  turns[turns.length - 1] = change(turns[turns.length - 1]);
  return { ...topic, turns };
}
