import * as gitApi from "../../data/projectGitApi";
import type {
  AgentProject,
  AgentProjectWorktree,
  AgentProjectWorktreeGroup,
} from "../../domain/agentSessions";
import { issueWorktreeCandidates } from "../../domain/agentWorkspaceView";
import { gitErrorMessage, worktreeBranchSource } from "../../domain/projectGit";
import {
  worktreeDefaults,
  worktreeRepositoryBlocker,
} from "./GitWorktreeDialog";
import type { GitStrings } from "./gitStrings";
import { LocalizedOperationError } from "./operationError";

/** A project already on the issue's branch, otherwise a new worktree of `source` for it. */
export async function issueWorktreeProject({
  projects,
  source,
  branch,
  group,
  branches,
  gitStrings,
  onCreated,
}: {
  projects: readonly AgentProject[];
  source: AgentProject;
  branch: string;
  group: AgentProjectWorktreeGroup | undefined;
  branches: Readonly<Record<string, string | null>>;
  gitStrings: GitStrings;
  onCreated: (
    repositoryProjectId: string,
    projectId: string,
    worktree: Omit<AgentProjectWorktree, "projectIds">,
  ) => void;
}) {
  // Cached branches can be stale, so every candidate is confirmed, all at once; likely matches win.
  const reads = issueWorktreeCandidates(
    projects,
    source,
    group,
    branches,
    branch,
  ).map((candidate) => {
    const read = gitApi.readGitRepository(candidate.id);
    return {
      candidate,
      read,
      confirmed: read.then(
        (repository) => repository.branch === branch,
        () => false,
      ),
    };
  });
  for (const { candidate, confirmed } of reads) {
    if (await confirmed) return candidate;
  }
  let repository;
  let refs;
  try {
    [repository, refs] = await Promise.all([
      reads.find(({ candidate }) => candidate.id === source.id)?.read ??
        gitApi.readGitRepository(source.id),
      gitApi.readGitBranches(source.id),
    ]);
  } catch (reason) {
    throw new Error(gitErrorMessage(reason));
  }
  const blocker = worktreeRepositoryBlocker(gitStrings, repository);
  const root = repository.identity?.root;
  if (blocker || !root || !repository.head)
    throw new LocalizedOperationError(blocker ?? gitStrings.missing);
  const origin = worktreeBranchSource(refs, branch, repository.head);
  const defaults = worktreeDefaults(source, root, origin.branch);
  let created;
  try {
    created = await gitApi.createGitWorktree(source.id, {
      id: defaults.id,
      name: defaults.name,
      parentPath: defaults.parentPath,
      folderName: defaults.folderName,
      branch: origin.branch.name,
      remote: origin.branch.remote,
      createBranch: origin.createBranch,
      version: repository.version,
    });
  } catch (reason) {
    throw new Error(gitErrorMessage(reason));
  }
  onCreated(group?.repositoryProjectId ?? source.id, created.id, {
    path: created.path,
    head: origin.branch.oid,
    branch,
  });
  return created;
}
