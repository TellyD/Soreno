import { invoke } from "@tauri-apps/api/core";
import type { AgentProject } from "../domain/agentSessions";
import type {
  GitBranch,
  GitCloneRequest,
  GitCommitDetail,
  GitComparison,
  GitHistory,
  GitMutationResult,
  GitRemote,
  GitRepository,
  GitSide,
  GitWorktree,
  GitWorktreeRequest,
} from "../domain/projectGit";

export const initGitRepository = (projectId: string, version: string) =>
  invoke<GitMutationResult>("project_git_init", { projectId, version });
export const cloneGitRepository = (request: GitCloneRequest) =>
  invoke<AgentProject>("project_git_clone", { request });
export const readGitRepository = (projectId: string) =>
  invoke<GitRepository>("project_git_repository", { projectId });
export const readGitComparison = (
  projectId: string,
  path: string,
  side: GitSide,
  version?: string,
) =>
  invoke<GitComparison>("project_git_comparison", {
    projectId,
    path,
    side,
    version,
  });
export const stageGitFiles = (
  projectId: string,
  paths: string[],
  version: string,
) =>
  invoke<GitMutationResult>("project_git_stage", { projectId, paths, version });
export const unstageGitFiles = (
  projectId: string,
  paths: string[],
  version: string,
) =>
  invoke<GitMutationResult>("project_git_unstage", {
    projectId,
    paths,
    version,
  });
export const generateGitCommitMessage = (projectId: string, version: string) =>
  invoke<string>("project_git_generate_commit_message", { projectId, version });
export const commitGitChanges = (
  projectId: string,
  message: string,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_commit", {
    projectId,
    message,
    version,
  });
export const quickCommitGitChanges = (
  projectId: string,
  paths: string[],
  version: string,
) =>
  invoke<GitMutationResult>("project_git_quick_commit", {
    projectId,
    paths,
    version,
  });
export const setGitIdentity = (
  projectId: string,
  name: string,
  email: string,
  global: boolean,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_set_identity", {
    projectId,
    name,
    email,
    global,
    version,
  });
export const restoreGitFiles = (
  projectId: string,
  paths: string[],
  version: string,
) =>
  invoke<GitMutationResult>("project_git_restore", {
    projectId,
    paths,
    version,
  });
export const readGitHistory = (
  projectId: string,
  roots: string[] | null,
  offset: number,
  path: string | null = null,
) =>
  invoke<GitHistory>("project_git_history", { projectId, roots, offset, path });
export const readGitPathPrefix = (projectId: string) =>
  invoke<string | null>("project_git_path_prefix", { projectId });
export const readGitCommitDetail = (projectId: string, oid: string) =>
  invoke<GitCommitDetail>("project_git_commit_detail", { projectId, oid });
export const readGitCommitComparison = (
  projectId: string,
  oid: string,
  path: string,
) =>
  invoke<GitComparison>("project_git_commit_comparison", {
    projectId,
    oid,
    path,
  });
export const readGitBranches = (projectId: string) =>
  invoke<GitBranch[]>("project_git_branches", { projectId });
export const createGitBranch = (
  projectId: string,
  name: string,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_create_branch", {
    projectId,
    name,
    version,
  });
export const removeGitBranch = (
  projectId: string,
  name: string,
  expectedOid: string,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_remove_branch", {
    projectId,
    name,
    expectedOid,
    version,
  });
export const readGitWorktrees = (projectId: string) =>
  invoke<GitWorktree[]>("project_git_worktrees", { projectId });
export const createGitWorktree = (
  projectId: string,
  request: GitWorktreeRequest,
) =>
  invoke<AgentProject>("project_git_create_worktree", { projectId, request });
export const removeGitWorktree = (projectId: string, worktree: GitWorktree) =>
  invoke<GitMutationResult>("project_git_remove_worktree", {
    projectId,
    path: worktree.path,
    expectedHead: worktree.head,
    expectedBranch: worktree.branch,
  });
export const mergeGitWorktree = (
  projectId: string,
  worktree: GitWorktree & { branch: string },
  base: string,
) =>
  invoke<GitMutationResult>("project_git_merge_worktree", {
    projectId,
    path: worktree.path,
    expectedHead: worktree.head,
    expectedBranch: worktree.branch,
    expectedBase: base,
  });
export const switchGitBranch = (
  projectId: string,
  name: string,
  remote: boolean,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_switch_branch", {
    projectId,
    name,
    remote,
    version,
  });
export const resolveGitFiles = (
  projectId: string,
  paths: string[],
  version: string,
  allowMarkers: boolean,
) =>
  invoke<GitMutationResult>("project_git_resolve", {
    projectId,
    paths,
    version,
    allowMarkers,
  });
export const readGitRemotes = (projectId: string) =>
  invoke<GitRemote[]>("project_git_remotes", { projectId });
export const fetchGitRemote = (
  projectId: string,
  remote: string,
  expectedUrl: string,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_fetch", {
    projectId,
    remote,
    expectedUrl,
    version,
  });
export const pullGitRemote = (
  projectId: string,
  remote: string,
  expectedUrl: string,
  version: string,
  rebase: boolean,
) =>
  invoke<GitMutationResult>("project_git_pull", {
    projectId,
    remote,
    expectedUrl,
    version,
    rebase,
  });
export const pushGitRemote = (
  projectId: string,
  remote: string,
  branch: string,
  expectedUrl: string,
  version: string,
) =>
  invoke<GitMutationResult>("project_git_push", {
    projectId,
    remote,
    branch,
    expectedUrl,
    version,
  });
