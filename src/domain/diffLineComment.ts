import type { ForgeKind } from "./forge";
import type { GitSide } from "./projectGit";

export type DiffLineForgeRequest = {
  kind?: ForgeKind | null;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  base: string;
  head: string;
};

/** Whole lines selected in one side of a diff; line numbers are 1-based in that side's document. */
export type DiffLineSelection = {
  path: string;
  side?: GitSide;
  forgeRequest?: DiffLineForgeRequest;
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

function forgeRequestLabel({ kind, number }: DiffLineForgeRequest) {
  if (kind === "github") return `PR #${number}`;
  if (kind === "gitlab") return `MR !${number}`;
  return `request #${number}`;
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
  const forge = selection.forgeRequest;
  const requestLabel = forge ? forgeRequestLabel(forge) : null;
  const version = forge
    ? selection.version === "after"
      ? "head version"
      : "base version"
    : selection.version === "after"
      ? "current version"
      : "previous version";
  const changes = requestLabel
    ? requestLabel
    : selection.untracked
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
  const command = forge
    ? `${git} diff ${shellArgument(forge.base)} ${shellArgument(forge.head)} -- ${path}`
    : selection.side === "staged"
      ? `${git} diff --staged -- ${path}`
      : `${git} diff -- ${path}`;
  const see = selection.untracked
    ? `The file is new and untracked, so \`git diff\` shows nothing: read ${selection.path}${selection.gitRoot ? ` (relative to ${selection.gitRoot})` : ""} directly.`
    : `See the change with \`${command}\`.`;
  const contextLines = [
    ...(repository
      ? [`Repository: ${repository.name} at ${repository.path}`]
      : []),
    ...(forge
      ? [
          `${requestLabel}: ${forge.title.trim()} (${forge.sourceBranch} -> ${forge.targetBranch})`,
        ]
      : []),
  ];
  const instruction = forge
    ? `Act on this comment${repository ? ` in ${repository.name}` : ""} (branch ${forge.sourceBranch}); if you disagree, explain why. ${see}`
    : `Act on this comment in ${repository ? "that repository's" : "the"} working tree; if you disagree, explain why. ${see}`;
  return [
    `Soreno comment on ${selection.path} ${lines}${repository ? ` in ${repository.name}` : ""}${requestLabel ? ` (${requestLabel})` : ""}: ${remark.split("\n")[0]}`,
    "",
    remark,
    "",
    ...(contextLines.length ? [...contextLines, ""] : []),
    `Selected code (${version}, ${changes}):`,
    fence,
    excerpt,
    fence,
    "",
    instruction,
  ].join("\n");
}
