/** `/` completions: every OMP command at the start of a draft, its `/skill:` tokens in prose. */

import { isObject, text } from "./agentConversationRecords";

export type AgentConversationCommand = { name: string; description: string };
export type AgentConversationCommandToken = { start: number; query: string };

// OMP's other builtins duplicate Soreno's controls, move the session or need its terminal.
const CHAT_BUILTINS: Record<string, true> = {
  compact: true,
  context: true,
  usage: true,
  changelog: true,
};

// OMP lists only builtins it runs from a prompt; Soreno turns these into OMP's own requests or prompts.
const REQUEST_COMMANDS: AgentConversationCommand[] = [
  {
    name: "goal",
    description: "Set, show, pause, resume or drop the session goal",
  },
  {
    name: "btw",
    description: "Ask a side question, or browse this session's side questions",
  },
];

export function agentConversationCommands(
  value: unknown,
): AgentConversationCommand[] {
  const list = (Array.isArray(value) ? value : []).flatMap((command) =>
    isObject(command) &&
    text(command.name) &&
    (command.source !== "builtin" || CHAT_BUILTINS[text(command.name)] === true)
      ? [{ name: text(command.name), description: text(command.description) }]
      : [],
  );
  return [
    ...REQUEST_COMMANDS.filter(
      (request) => !list.some(({ name }) => name === request.name),
    ),
    ...list,
  ];
}

/** The command being typed before `caret`, or null if the caret is not in one. */
export function agentConversationCommandAt(
  text: string,
  caret: number,
): AgentConversationCommandToken | null {
  // shortcut: no `/` inside the token, so namespaced `skill:ns/name` stops completing at its `/`; allow one if such skills show up.
  // shortcut: a draft opening with blanks before `/` gets no completion though it is sent trimmed; handle if users hit it.
  const match = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1].length;
  // OMP ignores a skill token in prose once the draft starts with another command.
  if (start > 0 && text.trimStart().startsWith("/")) return null;
  return { start, query: match[2] };
}

export function agentConversationCommandMatches(
  commands: readonly AgentConversationCommand[],
  token: AgentConversationCommandToken,
) {
  const query = token.query.toLowerCase();
  return commands.filter(
    ({ name }) =>
      (token.start === 0 || name.startsWith("skill:")) &&
      name.toLowerCase().includes(query),
  );
}

/** Replaces the whole token with `prefix` and `name`, then one space. */
export function insertAgentConversationCommand(
  text: string,
  token: AgentConversationCommandToken,
  name: string,
  prefix = "/",
) {
  const before = `${text.slice(0, token.start)}${prefix}${name} `;
  const rest = text.slice(token.start + 1).replace(/^\S* ?/, "");
  return { text: before + rest, caret: before.length };
}

const chatCommandCatalogKey = "soreno.agents.chat-commands.v1";

/** The commands the last OMP chat listed: settings has no session to ask OMP. */
export function readChatCommandCatalog(): AgentConversationCommand[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(chatCommandCatalogKey) ?? "null",
    );
    return Array.isArray(value)
      ? value.filter(
          (command): command is AgentConversationCommand =>
            typeof command?.name === "string" &&
            command.name !== "" &&
            typeof command.description === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function recordChatCommandCatalog(
  commands: readonly AgentConversationCommand[],
) {
  try {
    localStorage.setItem(chatCommandCatalogKey, JSON.stringify(commands));
  } catch {
    /* The catalog only feeds settings: the chat must not depend on storage. */
  }
}

/** OMP's RPC takes `/goal` only as its own `goal` request; null for any other draft. */
export function agentConversationGoalRequest(message: string) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) return null;
  const args = match[1] ?? "";
  const [, sub, rest] = /^(\S*)\s*([\s\S]*)$/.exec(args)!;
  switch (sub) {
    case "":
    case "show":
      return { type: "goal", op: "get" };
    case "pause":
    case "resume":
    case "drop":
      return { type: "goal", op: sub };
    case "set":
      return { type: "goal", op: "create", objective: rest };
    // No RPC op changes the budget: OMP's refusal is shown rather than a goal named "budget".
    case "budget":
      return { type: "goal", op: sub };
    default:
      return { type: "goal", op: "create", objective: args };
  }
}

/** `/btw <question>` asks OMP a side question; `/btw` alone lists them. Null for any other draft. */
export function agentConversationBtwRequest(message: string) {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) return null;
  return match[1]
    ? { type: "btw", question: match[1] }
    : { type: "get_btw_history" };
}
