import {
  agentLaunchPresets,
  agentProviderOf,
  type AgentProvider,
  type AgentSession,
} from "./agentSessions";

/** A worktree merge left in progress on conflicts, in the Soreno projects of that worktree. */
export type GitMergeConflict = {
  projectIds: readonly string[];
  branch: string;
  base: string;
};

export function mergeConflictPrompt({
  branch,
  base,
}: Pick<GitMergeConflict, "branch" | "base">): string {
  // Ref names may contain `"`, which Windows PowerShell launchers reject: such names are described instead.
  const quotedBranch = branch.includes('"');
  const branchRef = quotedBranch
    ? "this worktree's branch (its `HEAD`)"
    : `\`${branch}\``;
  const baseRef = base.includes('"')
    ? "the branch recorded in `MERGE_HEAD`"
    : `\`${base}\``;
  const mergedBranch = quotedBranch ? branchRef : `branch ${branchRef}`;
  return [
    `Soreno could not merge ${mergedBranch} into ${baseRef}: merging ${baseRef} into this worktree stopped on conflicts, and that merge is still in progress here.`,
    `Resolve every conflicted file listed by \`git status\`, keeping the intent of both ${branchRef} and ${baseRef}, and leave no conflict marker. Run the checks relevant to the files you touched, stage the resolved files, then conclude the merge with \`git commit --no-edit\`.`,
    "Do not abort the merge, rebase, reset or push. If a conflict needs a decision you cannot infer from the code and history, stop and ask me.",
    `Once the merge is committed, tell me so I can merge ${branchRef} into ${baseRef} again from Soreno.`,
  ].join("\n\n");
}

// Picks the worktree's latest visible agent (it knows these changes best), launched by its preset name.
export function mergeConflictAgent(
  sessions: readonly AgentSession[],
  projectIds: readonly string[],
  hidden: readonly AgentProvider[],
): { name: string; executable: string } {
  const visible = agentLaunchPresets.filter(
    ({ executable }) => !hidden.includes(executable),
  );
  const presets = visible.length > 0 ? visible : agentLaunchPresets;
  let latest: { name: string; executable: string; createdAt: string } | null =
    null;
  for (const session of sessions) {
    if (!projectIds.includes(session.projectId)) continue;
    if (latest && session.createdAt <= latest.createdAt) continue;
    const provider = agentProviderOf(session.executable);
    const preset = presets.find(({ executable }) => executable === provider);
    if (preset)
      latest = {
        name: preset.name,
        executable: preset.executable,
        createdAt: session.createdAt,
      };
  }
  return latest
    ? { name: latest.name, executable: latest.executable }
    : { name: presets[0].name, executable: presets[0].executable };
}
