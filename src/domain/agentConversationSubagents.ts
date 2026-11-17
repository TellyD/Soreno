import type {
  AgentConversationState,
  AgentConversationSubagent,
} from "./agentConversation";
import { count, isObject, text } from "./agentConversationRecords";

const SUBAGENT_STATUS: Record<string, AgentConversationSubagent["status"]> = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  aborted: "aborted",
  cancelled: "aborted",
};

/** Merges what a lifecycle, progress or registry entry tells about one subagent. */
export function withSubagent(
  state: AgentConversationState,
  entry: unknown,
): AgentConversationState {
  if (!isObject(entry) || !text(entry.id)) return state;
  const id = text(entry.id);
  const known = state.subagents.find((agent) => agent.id === id);
  const status = text(entry.status);
  const agent: AgentConversationSubagent = {
    id,
    agent: text(entry.agent) || known?.agent || null,
    index: count(entry.index) ?? known?.index ?? state.subagents.length,
    description: text(entry.description) || known?.description || null,
    status: status
      ? Object.prototype.hasOwnProperty.call(SUBAGENT_STATUS, status)
        ? SUBAGENT_STATUS[status]
        : "running"
      : (known?.status ?? "running"),
    activity: text(entry.lastIntent) || known?.activity || null,
    toolCount: count(entry.toolCount) ?? known?.toolCount ?? 0,
    tokens: count(entry.tokens) ?? known?.tokens ?? 0,
    durationMs: count(entry.durationMs) ?? known?.durationMs ?? null,
    parentToolCallId:
      text(entry.parentToolCallId) || known?.parentToolCallId || null,
  };
  return {
    ...state,
    subagents: [
      ...state.subagents.filter((other) => other.id !== id),
      agent,
    ].sort((left, right) => left.index - right.index),
  };
}
