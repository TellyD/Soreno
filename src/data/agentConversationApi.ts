import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentConversationHistoryPage,
  AgentConversationRecord,
} from "../domain/agentConversation";

// Each subscription replaces the session's subscriber: the latest must reach the backend last.
const subscribing = new Map<string, Promise<unknown>>();

/** Streams the run's records; pending dialogs, the command list and a past exit arrive first. */
export async function subscribeAgentConversation(
  sessionId: string,
  onRecord: (record: AgentConversationRecord) => void,
): Promise<() => void> {
  let open = true;
  const channel = new Channel<string>();
  channel.onmessage = (line) => {
    if (!open) return;
    try {
      const record: unknown = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record))
        onRecord(record as AgentConversationRecord);
    } catch {
      // The backend only forwards JSON objects; anything else is not a record.
    }
  };
  const previous = subscribing.get(sessionId) ?? Promise.resolve();
  const subscription = previous
    .catch(() => {})
    .then(() =>
      invoke("agent_conversation_subscribe", { sessionId, onRecord: channel }),
    );
  subscribing.set(sessionId, subscription);
  try {
    await subscription;
  } finally {
    if (subscribing.get(sessionId) === subscription)
      subscribing.delete(sessionId);
  }
  return () => {
    open = false;
  };
}

export function sendAgentConversationCommand(
  sessionId: string,
  record: AgentConversationRecord,
): Promise<void> {
  return invoke("agent_conversation_send", { sessionId, record });
}

/** The project's earlier OMP conversations, newest first, `limit` files from `offset`. */
export function readAgentConversationHistory(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<AgentConversationHistoryPage> {
  return invoke("agent_conversation_history", { sessionId, offset, limit });
}

// shortcut: checked once per project per app run; recheck periodically if releases get missed.
const ompUpdates = new Map<string, Promise<string | null>>();

/** The newer OMP version the project's environment can install, or null. */
export function availableOmpUpdate(projectId: string): Promise<string | null> {
  const cached = ompUpdates.get(projectId);
  if (cached) return cached;
  const check = invoke<string | null>("agent_omp_update_available", {
    projectId,
  });
  ompUpdates.set(projectId, check);
  // A failed check (offline, say) runs again next time.
  check.catch(() => {
    if (ompUpdates.get(projectId) === check) ompUpdates.delete(projectId);
  });
  return check;
}

export async function updateOmp(projectId: string): Promise<void> {
  try {
    await invoke("agent_update_omp", { projectId });
  } finally {
    ompUpdates.delete(projectId);
  }
}
