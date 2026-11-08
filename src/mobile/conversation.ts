import type { MobileStrings } from "./mobileStrings";

export type ConversationProvider = "pi" | "omp" | "claude" | "codex";

export type ToolAction =
  | "read"
  | "edit"
  | "write"
  | "run"
  | "search"
  | "web"
  | "agent"
  | "ask"
  | "other";

export type ToolCall = {
  kind: "tool";
  id: string;
  name: string;
  action: ToolAction;
  subject: string | null;
};

export type ToolResult = {
  kind: "toolResult";
  id: string;
  error: boolean;
  text: string | null;
  truncated?: boolean;
};

export type ConversationItem =
  | {
      kind: "user";
      id: string;
      text: string;
      images: number;
      truncated?: boolean;
    }
  | { kind: "assistant"; id: string; text: string; truncated?: boolean }
  | ToolCall
  | ToolResult;

export type ToolEntry = ToolCall & { result: ToolResult | null };

export type ConversationEntry =
  Exclude<ConversationItem, ToolCall | ToolResult> | ToolEntry;

export type ConversationReset = {
  provider: ConversationProvider | null;
  available: boolean;
  truncated: boolean;
  /** The server saves images sent from the phone; an older one does not say it. */
  images?: boolean;
  /** The agent's history was deleted while it runs; omitted otherwise. */
  deleted?: boolean;
  /** A Chat (OMP) session, which reads RPC JSON lines; omitted by an older server. */
  rpc?: boolean;
};

export type Conversation = ConversationReset & {
  entries: ConversationEntry[];
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function resetConversation(reset: ConversationReset): Conversation {
  return {
    provider: reset.provider,
    available: reset.available,
    truncated: reset.truncated,
    images: reset.images,
    deleted: reset.deleted,
    rpc: reset.rpc,
    entries: [],
  };
}

/** Appends a batch; a result joins its call by `id`, even when the call came in an earlier batch. */
export function appendItems(
  conversation: Conversation,
  items: ConversationItem[],
): Conversation {
  if (!items.length) return conversation;
  const entries = conversation.entries.slice();
  for (const item of items) {
    if (item.kind === "tool") {
      entries.push({ ...item, result: null });
      continue;
    }
    if (item.kind !== "toolResult") {
      entries.push(item);
      continue;
    }
    // A result whose call predates the first batch has nothing to attach to.
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.kind !== "tool" || entry.id !== item.id) continue;
      entries[index] = { ...entry, result: item };
      break;
    }
  }
  return { ...conversation, entries };
}

/** Calls the agent ran last without a result yet: it waits for an answer. A question never
 * answers itself, so it waits even while the agent reports work; another call (a permission)
 * only once the agent stopped. Same rule as `Pending::awaiting` on the server. */
export function awaitingReply(
  entries: ConversationEntry[],
  working: boolean | null,
) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind !== "tool") return false;
    if (!entry.result && (entry.action === "ask" || working !== true))
      return true;
  }
  return false;
}

/** A message as typed then confirmed. Terminal: a protected paste, so an ESC in the text cannot act
 * as a key, then Enter. Chat (`rpc`): the JSON line OMP's RPC mode reads; `followUp` queues it
 * behind a turn in progress. */
export function conversationMessage(text: string, rpc: boolean) {
  // shortcut: dtach interleaves the 8-byte packets of clients writing at the same instant (desktop, another phone), so both RPC lines are dropped as unparsable; serialize writers if lost messages get reported.
  if (rpc)
    return `${JSON.stringify({ type: "prompt", message: text, streamingBehavior: "followUp" })}\n`;
  return `${PASTE_START}${text.split("\x1b").join("")}${PASTE_END}\r`;
}

/** Unknown actions from a newer server read as "used <name>". */
export function toolLabel(tool: ToolCall, strings: MobileStrings) {
  const actions: Partial<Record<string, string>> = strings.toolActions;
  return actions[tool.action] ?? strings.toolOther(tool.name);
}
