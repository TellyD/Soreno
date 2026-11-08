import { useEffect, useRef, useState } from "react";
import * as gitApi from "../../data/projectGitApi";
import type {
  AgentProject,
  AgentProjectWorktree,
} from "../../domain/agentSessions";
import { gitErrorMessage, type GitRepository } from "../../domain/projectGit";
import {
  worktreeDefaults,
  worktreeRepositoryBlocker,
  type WorktreeRequest,
} from "./GitWorktreeDialog";
import { useGitStrings } from "./gitStrings";
import { LocalizedOperationError } from "./operationError";

type QuickWorktreeDraft = {
  project: AgentProject;
  root: string;
  base: string;
  folderEdited: boolean;
  request: WorktreeRequest;
};

export function useQuickWorktree({
  hidden,
  isBlocked,
  disconnectedProjectIds,
  execute,
  onCreated,
}: {
  hidden: boolean;
  isBlocked: () => boolean;
  disconnectedProjectIds: readonly string[];
  execute: (work: () => Promise<void>) => Promise<boolean>;
  onCreated: (
    created: AgentProject,
    worktree: Omit<AgentProjectWorktree, "projectIds">,
    sourceProjectId: string,
  ) => Promise<void>;
}) {
  const gitStrings = useGitStrings();
  const [draft, setDraft] = useState<QuickWorktreeDraft | null>(null);
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    if (!hidden) return;
    readGeneration.current += 1;
    setLoadingProjectId(null);
    setDraft(null);
  }, [hidden]);

  async function open(project: AgentProject) {
    if (
      isBlocked() ||
      loadingProjectId ||
      disconnectedProjectIds.includes(project.id)
    )
      return;
    const generation = ++readGeneration.current;
    setLoadingProjectId(project.id);
    const result: { repository: GitRepository | null } = { repository: null };
    const succeeded = await execute(async () => {
      let repository;
      try {
        repository = await gitApi.readGitRepository(project.id);
      } catch (reason) {
        throw new Error(gitErrorMessage(reason));
      }
      result.repository = repository;
      const blocker = worktreeRepositoryBlocker(gitStrings, repository);
      if (blocker) throw new LocalizedOperationError(blocker);
    });
    if (generation !== readGeneration.current || hiddenRef.current) return;
    setLoadingProjectId(null);
    const repository = result.repository;
    if (!succeeded || !repository?.identity || !repository.head) return;
    setDraft({
      project,
      root: repository.identity.root,
      base: repository.branch ?? repository.head.slice(0, 8),
      folderEdited: false,
      request: {
        ...worktreeDefaults(project, repository.identity.root, {
          name: "",
          oid: repository.head,
          remote: false,
          current: false,
          upstream: null,
        }),
        createBranch: true,
        version: repository.version,
      },
    });
  }

  function changeBranch(name: string) {
    setDraft((current) => {
      if (!current) return current;
      const branch = { ...current.request.branch, name };
      const nextDefaults = worktreeDefaults(
        current.project,
        current.root,
        branch,
      );
      return {
        ...current,
        request: {
          ...current.request,
          name: nextDefaults.name,
          folderName: current.folderEdited
            ? current.request.folderName
            : nextDefaults.folderName,
          branch,
        },
      };
    });
  }

  function change(request: WorktreeRequest) {
    setDraft((current) =>
      current
        ? {
            ...current,
            folderEdited:
              current.folderEdited ||
              request.folderName !== current.request.folderName,
            request,
          }
        : current,
    );
  }

  async function create() {
    if (!draft || isBlocked()) return;
    const branch = draft.request.branch.name.trim();
    if (!branch) return;
    const result: { created: AgentProject | null } = { created: null };
    await execute(async () => {
      try {
        result.created = await gitApi.createGitWorktree(draft.project.id, {
          id: draft.request.id,
          name: draft.request.name,
          parentPath: draft.request.parentPath.trim(),
          folderName: draft.request.folderName.trim(),
          branch,
          remote: false,
          createBranch: true,
          version: draft.request.version,
        });
      } catch (reason) {
        throw new Error(gitErrorMessage(reason));
      }
    });
    const created = result.created;
    if (!created) return;
    setDraft(null);
    await onCreated(
      created,
      { path: created.path, head: draft.request.branch.oid, branch },
      draft.project.id,
    );
  }

  return {
    draft,
    loadingProjectId,
    open,
    changeBranch,
    change,
    close: () => setDraft(null),
    create,
  };
}
