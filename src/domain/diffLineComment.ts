import type { GitSide } from "./projectGit";

/** Whole lines selected in one side of a diff; line numbers are 1-based in that side's document. */
export type DiffLineSelection = {
  path: string;
  side: GitSide;
  version: "before" | "after";
  fromLine: number;
  toLine: number;
  text: string;
  /** Git root the shown `path` is relative to; the agent's cwd may differ. */
  gitRoot?: string;
  /** Untracked files have no `git diff`: the agent must read them. */
  untracked?: boolean;
  /** Set when the agent may run elsewhere (group agents); only labels the message. */
  repository?: { name: string; path: string };
};

const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** POSIX single-quoted literal, left bare when it has no shell-significant characters. */
export function shellArgument(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

const EXCERPT_LINE_LIMIT = 200;

export function diffLineRangeLabel({ fromLine, toLine }: DiffLineSelection) {
  return fromLine === toLine ? `L${fromLine}` : `L${fromLine}–${toLine}`;
}

/** Agent-facing text, English like the other agent prompts; the first line leads the session history. */
export function diffLineCommentRequest(
  selection: DiffLineSelection,
  comment: string,
): string {
  const remark = comment.trim();
  const lines =
    selection.fromLine === selection.toLine
      ? `line ${selection.fromLine}`
      : `lines ${selection.fromLine}-${selection.toLine}`;
  const version =
    selection.version === "after" ? "current version" : "previous version";
  const changes = selection.untracked
    ? "untracked file"
    : selection.side === "staged"
      ? "staged changes"
      : "unstaged changes";
  const excerptLines = selection.text.split("\n");
  const excerpt =
    excerptLines.length > EXCERPT_LINE_LIMIT
      ? `${excerptLines.slice(0, EXCERPT_LINE_LIMIT).join("\n")}\n… (${excerptLines.length - EXCERPT_LINE_LIMIT} more lines)`
      : selection.text;
  const longestTicks = Math.max(
    0,
    ...(excerpt.match(/`+/g) ?? []).map((ticks) => ticks.length),
  );
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  const repository = selection.repository;
  const git = selection.gitRoot
    ? `git -C ${shellArgument(selection.gitRoot)}`
    : "git";
  const path = shellArgument(selection.path);
  const command =
    selection.side === "staged"
      ? `${git} diff --staged -- ${path}`
      : `${git} diff -- ${path}`;
  const see = selection.untracked
    ? `The file is new and untracked, so \`git diff\` shows nothing: read ${selection.path}${selection.gitRoot ? ` (relative to ${selection.gitRoot})` : ""} directly.`
    : `See the change with \`${command}\`.`;
  return [
    `Soreno comment on ${selection.path} ${lines}${repository ? ` in ${repository.name}` : ""}: ${remark.split("\n")[0]}`,
    "",
    remark,
    "",
    ...(repository
      ? [`Repository: ${repository.name} at ${repository.path}`, ""]
      : []),
    `Selected code (${version}, ${changes}):`,
    fence,
    excerpt,
    fence,
    "",
    `Act on this comment in ${repository ? "that repository's" : "the"} working tree; if you disagree, explain why. ${see}`,
  ].join("\n");
}
