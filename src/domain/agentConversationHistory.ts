/** ↑/↓ recall of sent messages in the composer, like a shell history. */

import type { AgentConversationState } from "./agentConversation";
import { splitAgentConversationPrompt } from "./agentConversationAttachments";
import { sorenoNotices } from "./agentSessions";

/** The recalled position and text, and the draft they replaced; null while not browsing. */
export type AgentConversationRecall = {
  index: number;
  text: string;
  stash: string;
} | null;

/** The texts the user sent, queued ones last, oldest first, without attached files or Soreno's messages. */
export function agentConversationHistory(
  state: Pick<AgentConversationState, "entries" | "queued">,
): string[] {
  const history: string[] = [];
  for (const prompt of [
    ...state.entries.flatMap((entry) =>
      entry.role === "user" ? [entry.text] : [],
    ),
    ...state.queued.map((message) => message.text),
  ]) {
    const text = splitAgentConversationPrompt(prompt).text.trim();
    if (text && !sorenoNotices(text) && text !== history[history.length - 1])
      history.push(text);
  }
  return history;
}

/**
 * The draft after `key`, or null to leave the key to the textarea. An edited recall is the
 * new draft: browsing restarts from it.
 */
export function recallAgentConversationMessage(
  history: readonly string[],
  recall: AgentConversationRecall,
  draft: string,
  key: "ArrowUp" | "ArrowDown",
): { recall: AgentConversationRecall; text: string } | null {
  const browsing = recall?.text === draft ? recall : null;
  const stash = browsing?.stash ?? draft;
  // The history shifts when a queued message is cancelled: find the recalled text again.
  const found =
    browsing &&
    (history[browsing.index] === browsing.text
      ? browsing.index
      : history.lastIndexOf(browsing.text));
  const at = found === null || found < 0 ? history.length : found;
  const index = key === "ArrowUp" ? at - 1 : browsing && at + 1;
  if (index === null || index < 0) return null;
  if (index >= history.length) return { recall: null, text: stash };
  return {
    recall: { index, text: history[index], stash },
    text: history[index],
  };
}
