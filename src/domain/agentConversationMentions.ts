/** `@path` mentions: OMP reads the files they name, relative to the session's folder. */

import { agentProjectNameFromPath } from "./agentSessions";

/** OMP only reads a mention at the start or after one of these characters. */
const MENTION_BOUNDARY = /[\s([{<"'`]/;
/** OMP trims these from an unquoted mention, or splits on them: a path with them is quoted. */
const QUOTED_PATH = /[\s@]|^[`"'([{<]|[)\]}>.,;:!?"'`]$/;

export type AgentConversationMention = { start: number; query: string };

/** The mention being typed before `caret`, or null if the caret is not in one. */
export function agentConversationMentionAt(
  text: string,
  caret: number,
): AgentConversationMention | null {
  const match = /@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return match.index === 0 || MENTION_BOUNDARY.test(text[match.index - 1])
    ? { start: match.index, query: match[1] }
    : null;
}

/** The token OMP reads back as `path`, or null if no quoting can represent it. */
export function agentConversationMentionToken(path: string): string | null {
  if (!QUOTED_PATH.test(path)) return `@${path}`;
  if (!path.includes('"')) return `@"${path}"`;
  return path.includes("'") ? null : `@'${path}'`;
}

/** Replaces the whole mention token with `path`, then a space unless a delimiter follows. */
export function insertAgentConversationMention(
  text: string,
  mention: AgentConversationMention,
  path: string,
): { text: string; caret: number } | null {
  const token = agentConversationMentionToken(path);
  if (token === null) return null;
  const before = text.slice(0, mention.start);
  // Unquoted: stop before the trailing delimiters OMP trims, so `(@sr)` keeps its `)`.
  const rest = text
    .slice(mention.start + 1)
    .replace(
      /^(?:"[^"]*"|'[^']*'|[^\s@]*?(?=[)\]}>.,;:!?"'`]*(?:[\s@]|$)))/,
      "",
    );
  if (/^\S/.test(rest)) {
    return {
      text: `${before}${token}${rest}`,
      caret: before.length + token.length,
    };
  }
  return {
    text: `${before}${token} ${rest.replace(/^ /, "")}`,
    caret: before.length + token.length + 1,
  };
}

/** A project `@` searches, its paths prefixed by `folder` (empty outside a group overview). */
export type AgentConversationMentionRoot = {
  projectId: string;
  folder: string;
};

/** Group members under the folder name Soreno links them by in the overview folder: the first of a name wins. */
export function groupMentionRoots(
  members: readonly { id: string; path: string }[],
): AgentConversationMentionRoot[] {
  const seen = new Set<string>();
  return members.flatMap(({ id, path }) => {
    const folder = agentProjectNameFromPath(path);
    // Case-insensitive like the backend: Windows and macOS folders are.
    const key = folder.toLowerCase();
    if (folder === "" || folder === "." || folder === ".." || seen.has(key))
      return [];
    seen.add(key);
    return [{ projectId: id, folder }];
  });
}

/** Takes one item from each list in turn, so no project crowds out the others. */
export function interleaveMentionPaths<T>(
  lists: readonly (readonly T[])[],
  limit: number,
): T[] {
  const paths: T[] = [];
  for (let index = 0; paths.length < limit; index++) {
    const row = lists.filter((list) => index < list.length);
    if (row.length === 0) break;
    for (const list of row) paths.push(list[index]);
  }
  return paths.slice(0, limit);
}
