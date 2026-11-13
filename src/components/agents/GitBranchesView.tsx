import {
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitMerge,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/projectGitApi";
import {
  gitReadKeys,
  readMutableGit,
  type GitReadCache,
} from "../../data/gitReadCache";
import {
  agentEnvironmentKey,
  type AgentProject,
} from "../../domain/agentSessions";
import type { GitMergeConflict } from "../../domain/mergeConflictAgent";
import {
  comparableGitPath,
  gitErrorCode,
  gitErrorMessage,
  orderGitRefs,
  type GitBranch as GitBranchValue,
  type GitWorktree,
} from "../../domain/projectGit";
import type { useProjectGit } from "../../hooks/useProjectGit";
import {
  dismissNotification,
  notifyError,
  notifyWarning,
  useNotification,
} from "../../notifications";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import {
  GitBranchDeleteDialog,
  type GitBranchDeleteRequest,
} from "./GitBranchDeleteDialog";
import {
  GitWorktreeDialog,
  worktreeDefaults,
  type WorktreeRequest,
} from "./GitWorktreeDialog";
import { LoadingState } from "../ui/LoadingState";
import { useGitStrings } from "./gitStrings";
import "./GitArchiveViews.css";

type GitState = ReturnType<typeof useProjectGit>;
type SwitchRequest = {
  name: string;
  projectId: string;
  remote: boolean;
  version: string;
};
type GitRefs = {
  scope: string;
  branches: GitBranchValue[];
  worktrees: GitWorktree[];
};
type GitBranchesViewProps = {
  active: boolean;
  git: GitState;
  project: AgentProject;
  projects?: AgentProject[];
  readCache?: GitReadCache;
  readScope?: string;
  branchRevision?: number;
  onOpenProject?: (projectId: string) => void;
  onOpenExternalWorktree?: (worktree: GitWorktree) => void | Promise<void>;
  onWorktreeCreated?: (
    project: AgentProject,
    worktree: GitWorktree,
  ) => void | Promise<void>;
  onWorktreeRemoved?: (worktree: GitWorktree) => void;
  worktreeRunningSessions?: (worktree: GitWorktree) => number;
  worktreeProjectIds?: (worktree: GitWorktree) => string[];
  onStopWorktreeSessions?: (worktree: GitWorktree) => Promise<void>;
  // Runs just before a worktree removal; the returned restore undoes it on failure.
  onPrepareWorktreeRemoval?: (
    worktree: GitWorktree,
  ) => Promise<() => Promise<void>>;
  // Every merge stopped on conflicts; null when no Soreno project owns the worktree.
  onMergeConflict?: (scope: string, conflict: GitMergeConflict | null) => void;
};

export function GitBranchesView({
  active,
  git,
  project,
  projects = [],
  readCache,
  readScope,
  branchRevision,
  onOpenProject,
  onOpenExternalWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
  worktreeRunningSessions,
  worktreeProjectIds,
  onStopWorktreeSessions,
  onPrepareWorktreeRemoval,
  onMergeConflict,
}: GitBranchesViewProps) {
  const s = useGitStrings();
  const projectId = project.id;
  const scope = readScope ?? projectId;
  const generation = useRef(0);
  const currentScope = useRef(scope);
  const refreshedBranchRevision = useRef(branchRevision);
  const input = useRef<HTMLInputElement>(null);
  const deleteReturnFocus = useRef<HTMLElement>(null);
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [name, setName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [pending, setPending] = useState<SwitchRequest | null>(null);
  const [worktreeRequest, setWorktreeRequest] =
    useState<WorktreeRequest | null>(null);
  const [deleteRequest, setDeleteRequest] =
    useState<GitBranchDeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [focusBranchInputWhenIdle, setFocusBranchInputWhenIdle] =
    useState(false);
  const cachedBranches = readCache?.peek<GitBranchValue[]>(
    scope,
    gitReadKeys.branches,
  );
  const cachedWorktrees = readCache?.peek<GitWorktree[]>(
    scope,
    gitReadKeys.worktrees,
  );
  const values = refs?.scope === scope ? refs.branches : (cachedBranches ?? []);
  const worktreeValues =
    refs?.scope === scope ? refs.worktrees : (cachedWorktrees ?? []);
  const hasLoaded =
    refs?.scope === scope ||
    (cachedBranches !== undefined && cachedWorktrees !== undefined);

  const refresh = useCallback(
    async (force = false) => {
      if (!active) return;
      const request = ++generation.current;
      setLoading(true);
      setReadFailed(false);
      try {
        const [branches, worktrees] = await Promise.all([
          readMutableGit(
            readCache,
            scope,
            gitReadKeys.branches,
            () => api.readGitBranches(projectId),
            force,
          ),
          readMutableGit(
            readCache,
            scope,
            gitReadKeys.worktrees,
            () => api.readGitWorktrees(projectId),
            force,
          ),
        ]);
        if (request === generation.current)
          setRefs({ scope, branches, worktrees });
      } catch {
        if (request === generation.current) setReadFailed(true);
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [active, projectId, readCache, scope],
  );

  useEffect(() => {
    currentScope.current = scope;
  }, [scope]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, git.revision]);
  useEffect(() => {
    if (!active || refreshedBranchRevision.current === branchRevision) return;
    refreshedBranchRevision.current = branchRevision;
    void refresh(true);
  }, [active, branchRevision, refresh]);
  useEffect(() => {
    if (!active && !git.busy) {
      setPending(null);
      setWorktreeRequest(null);
      setDeleteRequest(null);
    }
  }, [active, git.busy]);
  useEffect(() => {
    if (!focusBranchInputWhenIdle || git.busy) return;
    setFocusBranchInputWhenIdle(false);
    const focused = document.activeElement;
    if (
      active &&
      (!focused || focused === document.body || !focused.isConnected)
    )
      input.current?.focus();
  }, [active, focusBranchInputWhenIdle, git.busy]);

  const createBlocked =
    git.busy ||
    !!git.error ||
    !!git.repo?.limited ||
    !!git.repo?.operation ||
    !name.trim();
  const switchBlocked =
    git.busy || !!git.error || !!git.repo?.limited || !!git.repo?.operation;
  const worktreeBlocked =
    git.busy ||
    !!git.error?.uncertain ||
    !!git.repo?.limited ||
    !!git.repo?.operation ||
    !git.repo?.head;
  const newWorktreeBlocked = worktreeBlocked || !!git.error || !name.trim();
  const deleteBlocked =
    git.busy ||
    git.error?.source === "read" ||
    !!git.error?.uncertain ||
    !!git.repo?.limited ||
    !!git.repo?.operation ||
    !git.repo?.version;

  async function create() {
    const version = git.repo?.version;
    if (!version || createBlocked || git.isBusy()) return;
    setCreatingBranch(true);
    try {
      const result = await git.mutate(() =>
        api.createGitBranch(projectId, name.trim(), version),
      );
      if (result !== undefined) setName("");
    } finally {
      setCreatingBranch(false);
    }
  }

  function requestSwitch(branch: GitBranchValue) {
    if (!git.repo || branch.current || switchBlocked) return;
    setPending({
      name: branch.name,
      projectId,
      remote: branch.remote,
      version: git.repo.version,
    });
  }

  async function confirmSwitch() {
    const request = pending;
    if (
      !request ||
      request.projectId !== projectId ||
      request.version !== git.repo?.version ||
      switchBlocked ||
      git.isBusy()
    )
      return;
    setFocusBranchInputWhenIdle(true);
    setPending(null);
    await git.mutate(() =>
      api.switchGitBranch(
        projectId,
        request.name,
        request.remote,
        request.version,
      ),
    );
  }

  function requestWorktree(branch: GitBranchValue) {
    const root = git.repo?.identity?.root;
    if (!root || worktreeBlocked) return;
    setWorktreeRequest({
      ...worktreeDefaults(project, root, branch),
      version: git.repo!.version,
    });
  }

  function requestNewBranchWorktree() {
    const root = git.repo?.identity?.root;
    const branchName = name.trim();
    if (!root || !branchName || newWorktreeBlocked) return;
    const branch = {
      name: branchName,
      oid: git.repo!.head!,
      remote: false,
      current: false,
      upstream: null,
    };
    setWorktreeRequest({
      ...worktreeDefaults(project, root, branch),
      createBranch: true,
      version: git.repo!.version,
    });
  }

  async function createWorktree() {
    const request = worktreeRequest;
    if (
      !request ||
      request.projectId !== projectId ||
      request.version !== git.repo?.version ||
      worktreeBlocked ||
      git.isBusy() ||
      creatingWorktree
    )
      return;
    setCreatingWorktree(true);
    try {
      const created = await git.mutate(() =>
        api.createGitWorktree(projectId, {
          id: request.id,
          name: request.name,
          parentPath: request.parentPath.trim(),
          folderName: request.folderName.trim(),
          branch: request.branch.name,
          remote: request.branch.remote,
          createBranch: request.createBranch,
          version: request.version,
        }),
      );
      if (created) {
        if (request.createBranch) setName("");
        setWorktreeRequest(null);
        await onWorktreeCreated?.(created, {
          path: created.path,
          head: request.branch.oid,
          branch: request.branch.remote
            ? request.branch.name.slice(request.branch.name.indexOf("/") + 1)
            : request.branch.name,
        });
      }
    } finally {
      setCreatingWorktree(false);
    }
  }

  async function confirmDelete() {
    const request = deleteRequest;
    if (!request || deleteChanged || deleteBlocked || git.isBusy() || deleting)
      return;
    setDeleting(true);
    dismissNotification(`git-branches-warning:${request.scope}`);
    try {
      if (request.kind !== "branch" && deleteRunningSessions > 0) {
        try {
          await onStopWorktreeSessions?.(request.worktree);
        } catch {
          notifyError(s.stopSessionsError);
          return;
        }
      }
      await git.mutate(async () => {
        const restore =
          request.kind === "branch"
            ? undefined
            : await onPrepareWorktreeRemoval?.(request.worktree);
        let result;
        try {
          result = await (request.kind === "branch"
            ? api.removeGitBranch(
                projectId,
                request.branch.name,
                request.branch.oid,
                request.version,
              )
            : request.kind === "merge"
              ? api.mergeGitWorktree(projectId, request.worktree, request.base)
              : api.removeGitWorktree(projectId, request.worktree));
        } catch (reason) {
          await restore?.();
          if (
            request.kind === "merge" &&
            gitErrorCode(gitErrorMessage(reason)) === "mergeConflict"
          ) {
            const projectIds = worktreeProjectIds?.(request.worktree) ?? [];
            onMergeConflict?.(
              request.scope,
              projectIds.length
                ? {
                    projectIds,
                    branch: request.worktree.branch,
                    base: request.base,
                  }
                : null,
            );
            setDeleteRequest(null);
          }
          throw reason;
        }
        // Reflect the confirmed removal now; the full Git refresh that follows is slow.
        setFocusBranchInputWhenIdle(true);
        const removedBranch =
          request.kind === "branch"
            ? request.branch.name
            : result.warning
              ? null
              : request.worktree.branch;
        if (currentScope.current === request.scope) {
          generation.current++;
          setLoading(false);
          setRefs((current) => {
            const base =
              current?.scope === request.scope
                ? current
                : {
                    scope: request.scope,
                    branches: values,
                    worktrees: worktreeValues,
                  };
            return {
              scope: request.scope,
              branches: base.branches.filter(
                (branch) => branch.remote || branch.name !== removedBranch,
              ),
              worktrees:
                request.kind === "branch"
                  ? base.worktrees
                  : base.worktrees.filter(
                      (worktree) => worktree.path !== request.worktree.path,
                    ),
            };
          });
        }
        setDeleteRequest(null);
        if (result.warning)
          notifyWarning(
            result.warning.trim() || s.operationCompletedWithWarning,
            {
              key: `git-branches-warning:${request.scope}`,
            },
          );
        if (request.kind !== "branch") onWorktreeRemoved?.(request.worktree);
        return result;
      });
    } finally {
      setDeleting(false);
    }
  }

  const pendingChanged =
    !!pending &&
    (pending.projectId !== projectId || pending.version !== git.repo?.version);
  const worktreeChanged =
    !!worktreeRequest &&
    (worktreeRequest.projectId !== projectId ||
      worktreeRequest.version !== git.repo?.version);
  const deleteChanged =
    !!deleteRequest &&
    (deleteRequest.projectId !== projectId ||
      deleteRequest.scope !== scope ||
      (deleteRequest.kind === "branch" &&
        deleteRequest.version !== git.repo?.version));
  const deleteRunningSessions =
    deleteRequest && deleteRequest.kind !== "branch"
      ? (worktreeRunningSessions?.(deleteRequest.worktree) ?? 0)
      : 0;
  const { baseBranch, orderedWorktrees, local, remote } = orderGitRefs(
    values,
    worktreeValues,
  );
  const rootPath = git.repo?.identity?.root;
  const currentPath = rootPath ? comparableGitPath(rootPath) : null;
  const sourceEnvironment = agentEnvironmentKey(project.environment);
  const projectByPath = new Map(
    projects
      .filter(
        (value) => agentEnvironmentKey(value.environment) === sourceEnvironment,
      )
      .map((value) => [comparableGitPath(value.path), value]),
  );
  const localBranchFor = (branch: GitBranchValue) =>
    branch.remote
      ? local.find(
          (candidate) =>
            candidate.name ===
              branch.name.slice(branch.name.indexOf("/") + 1) &&
            candidate.upstream === branch.name,
        )
      : branch;
  const blockTitle = (branch: GitBranchValue) =>
    branch.current
      ? s.currentBranch
      : git.repo?.operation
        ? s.operationBlocksMutation
        : git.repo?.limited
          ? s.limited
          : git.error
            ? s.gitErrorBlocksAction
            : git.busy
              ? s.loading
              : undefined;

  useNotification(
    active && readFailed
      ? {
          key: `git-branches:${scope}`,
          message: s.branchesReadError,
          action: { label: s.retry, onAction: () => void refresh(true) },
        }
      : null,
  );
  useNotification(
    active &&
      ((!!pending && pendingChanged) || (!!deleteRequest && deleteChanged))
      ? {
          key: "git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );

  return (
    <div className="git-branches-view">
      <div className="git-view-toolbar">
        <strong>{s.branches}</strong>
        <IconButton
          size="small"
          aria-label={s.refreshBranches}
          title={s.refreshBranches}
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          <RefreshCw className={loading ? "app-loading-spinner" : undefined} />
        </IconButton>
      </div>
      {!git.repo?.branch && git.repo?.head ? (
        <div className="git-panel-notice">
          <GitBranch size={14} aria-hidden="true" />
          <span>{s.detachedCreate}</span>
          <Button size="small" onClick={() => input.current?.focus()}>
            {s.createBranch}
          </Button>
        </div>
      ) : null}
      <form
        className="git-branch-create"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="git-branch-create-controls">
          <Input
            ref={input}
            id="git-branch-name"
            aria-label={s.newBranch}
            value={name}
            placeholder={s.branchPlaceholder}
            disabled={git.busy}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            aria-busy={creatingBranch || undefined}
            type="submit"
            variant="primary"
            disabled={createBlocked}
            startIcon={
              creatingBranch ? (
                <LoaderCircle className="app-loading-spinner" />
              ) : undefined
            }
          >
            {s.createBranch}
          </Button>
          <Button
            type="button"
            disabled={newWorktreeBlocked}
            onClick={requestNewBranchWorktree}
          >
            {s.createWorktree}
          </Button>
        </div>
      </form>
      {loading && !hasLoaded ? (
        <LoadingState className="git-panel-centered-status">
          {s.branchesLoading}
        </LoadingState>
      ) : (
        <div className="git-branch-groups">
          <section className="git-branch-section git-worktree-section">
            <header className="git-branch-section-heading">
              <span className="git-branch-section-title">
                <FolderGit2 size={13} aria-hidden="true" />
                <h3>{s.worktrees}</h3>
              </span>
              <span className="git-branch-count">{worktreeValues.length}</span>
            </header>
            {worktreeValues.length ? (
              <ul>
                {orderedWorktrees.map((worktree, index) => {
                  const path = comparableGitPath(worktree.path);
                  const current = path === currentPath;
                  const primary = index === 0;
                  const target = projectByPath.get(path);
                  const canOpen =
                    !current &&
                    (target ? !!onOpenProject : !!onOpenExternalWorktree);
                  return (
                    <li
                      className="git-branch-row git-worktree-row"
                      key={worktree.path}
                    >
                      <button
                        type="button"
                        className={`git-branch-main${current ? " is-current" : ""}`}
                        disabled={!canOpen}
                        aria-current={current ? "true" : undefined}
                        aria-label={`${canOpen ? s.openWorktree : s.worktrees} · ${worktree.branch ?? worktree.head.slice(0, 8)}`}
                        title={
                          current
                            ? s.currentWorktree
                            : canOpen
                              ? s.openWorktree
                              : worktree.path
                        }
                        onClick={() => {
                          if (target) onOpenProject?.(target.id);
                          else void onOpenExternalWorktree?.(worktree);
                        }}
                      >
                        <span className="git-branch-icon">
                          <FolderGit2 size={14} aria-hidden="true" />
                        </span>
                        <span className="git-branch-copy">
                          <strong>
                            {worktree.branch ?? worktree.head.slice(0, 8)}
                          </strong>
                          <small>{worktree.path}</small>
                        </span>
                        {current ? (
                          <span className="git-branch-status">
                            {s.currentWorktree}
                          </span>
                        ) : target ? (
                          <span className="git-branch-status">
                            {target.name}
                          </span>
                        ) : null}
                      </button>
                      {!current && !primary ? (
                        <span className="git-branch-actions">
                          {worktree.branch &&
                          baseBranch &&
                          worktree.branch !== baseBranch ? (
                            <IconButton
                              size="small"
                              aria-label={`${s.mergeWorktree(baseBranch)} · ${worktree.branch}`}
                              title={s.mergeWorktree(baseBranch)}
                              disabled={deleteBlocked}
                              onClick={(event) => {
                                deleteReturnFocus.current = event.currentTarget;
                                setDeleteRequest({
                                  kind: "merge",
                                  projectId,
                                  scope,
                                  worktree: {
                                    ...worktree,
                                    branch: worktree.branch!,
                                  },
                                  base: baseBranch,
                                });
                              }}
                            >
                              <GitMerge />
                            </IconButton>
                          ) : null}
                          <IconButton
                            size="small"
                            tone="danger"
                            aria-label={`${s.deleteWorktree} · ${worktree.branch ?? worktree.head.slice(0, 8)}`}
                            title={s.deleteWorktree}
                            disabled={deleteBlocked}
                            onClick={(event) => {
                              deleteReturnFocus.current = event.currentTarget;
                              setDeleteRequest({
                                kind: "worktree",
                                projectId,
                                scope,
                                worktree,
                              });
                            }}
                          >
                            <Trash2 />
                          </IconButton>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                className="git-branch-empty"
                description={s.noWorktrees}
                size="compact"
              />
            )}
          </section>
          <div className="git-branch-columns">
            <header className="git-branch-family-heading">
              <span className="git-branch-section-title">
                <GitBranch size={13} aria-hidden="true" />
                <strong>{s.branches}</strong>
              </span>
              <span className="git-branch-count">
                {local.length + remote.length}
              </span>
            </header>
            {[
              { title: s.localBranches, values: local },
              { title: s.remoteBranches, values: remote },
            ].map((group) => (
              <section
                className="git-branch-section git-branch-subsection"
                key={group.title}
              >
                <header className="git-branch-section-heading">
                  <h3>{group.title}</h3>
                  <span className="git-branch-count">
                    {group.values.length}
                  </span>
                </header>
                {group.values.length ? (
                  <ul>
                    {group.values.map((branch) => {
                      const worktreeBranch = localBranchFor(branch);
                      const occupied = worktreeValues.find(
                        (worktree) => worktree.branch === worktreeBranch?.name,
                      );
                      const occupiedPath = occupied
                        ? comparableGitPath(occupied.path)
                        : null;
                      const occupiedHere = occupiedPath === currentPath;
                      const target = occupiedPath
                        ? projectByPath.get(occupiedPath)
                        : undefined;
                      const canOpen =
                        !!occupied &&
                        !occupiedHere &&
                        (target ? !!onOpenProject : !!onOpenExternalWorktree);
                      const mainDisabled =
                        branch.current ||
                        occupiedHere ||
                        (!!occupied && !canOpen) ||
                        (!occupied && switchBlocked);
                      const action =
                        branch.current || occupiedHere
                          ? s.switchBranch
                          : occupied
                            ? s.openWorktree
                            : s.switchBranch;
                      const title =
                        occupiedHere || branch.current
                          ? s.currentBranch
                          : occupied
                            ? canOpen
                              ? s.openWorktree
                              : occupied.path
                            : blockTitle(branch);
                      const status =
                        branch.current || occupiedHere
                          ? s.currentBranch
                          : occupied
                            ? (target?.name ?? s.worktreeOpen)
                            : null;
                      return (
                        <li
                          className="git-branch-row"
                          key={`${branch.remote}:${branch.name}`}
                        >
                          <button
                            type="button"
                            className={`git-branch-main${branch.current || occupiedHere ? " is-current" : ""}`}
                            disabled={mainDisabled}
                            aria-current={
                              branch.current || occupiedHere
                                ? "true"
                                : undefined
                            }
                            aria-label={`${action} · ${branch.name}`}
                            title={title}
                            onClick={() => {
                              if (canOpen && occupied) {
                                if (target) onOpenProject?.(target.id);
                                else void onOpenExternalWorktree?.(occupied);
                              } else requestSwitch(branch);
                            }}
                          >
                            <span className="git-branch-icon">
                              <GitBranch size={14} aria-hidden="true" />
                            </span>
                            <span className="git-branch-copy">
                              <strong>{branch.name}</strong>
                              {branch.upstream ? (
                                <small>
                                  {s.upstream}: {branch.upstream}
                                </small>
                              ) : occupied ? (
                                <small>{occupied.path}</small>
                              ) : null}
                            </span>
                            {status ? (
                              <span className="git-branch-status">
                                {status}
                              </span>
                            ) : null}
                          </button>
                          {!occupied && !branch.current ? (
                            <span className="git-branch-actions">
                              <IconButton
                                className="git-worktree-create"
                                size="small"
                                aria-label={`${s.createWorktree} · ${branch.name}`}
                                title={s.createWorktree}
                                disabled={worktreeBlocked}
                                onClick={() =>
                                  requestWorktree(worktreeBranch ?? branch)
                                }
                              >
                                <FolderPlus />
                              </IconButton>
                              {!branch.remote ? (
                                <IconButton
                                  size="small"
                                  tone="danger"
                                  aria-label={`${s.deleteBranch} · ${branch.name}`}
                                  title={s.deleteBranch}
                                  disabled={deleteBlocked}
                                  onClick={(event) => {
                                    if (!git.repo?.version) return;
                                    deleteReturnFocus.current =
                                      event.currentTarget;
                                    setDeleteRequest({
                                      kind: "branch",
                                      projectId,
                                      scope,
                                      version: git.repo.version,
                                      branch,
                                    });
                                  }}
                                >
                                  <Trash2 />
                                </IconButton>
                              ) : null}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState
                    className="git-branch-empty"
                    description={s.noBranches}
                    size="compact"
                  />
                )}
              </section>
            ))}
          </div>
        </div>
      )}
      {pending && active
        ? createPortal(
            <ConfirmationDialog
              title={s.switchTitle}
              confirmVariant="primary"
              description={
                <span className="git-commit-confirmation">
                  <span>{s.switchDescription}</span>
                  <span>
                    <strong>{s.destination}:</strong>{" "}
                    {pending.remote
                      ? pending.name.slice(pending.name.indexOf("/") + 1)
                      : pending.name}
                  </span>
                  {pending.remote ? (
                    <span>
                      <strong>{s.remoteSource}:</strong> {pending.name}
                    </span>
                  ) : null}
                </span>
              }
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.switchBranch}
              cancelDisabled={git.busy}
              confirmDisabled={switchBlocked || pendingChanged}
              onCancel={() => {
                if (!git.busy) setPending(null);
              }}
              onConfirm={() => void confirmSwitch()}
            />,
            document.body,
          )
        : null}
      {deleteRequest && active
        ? createPortal(
            <GitBranchDeleteDialog
              request={deleteRequest}
              runningSessions={deleteRunningSessions}
              returnFocusRef={deleteReturnFocus}
              pending={deleting || git.busy}
              disabled={deleteBlocked || deleteChanged}
              onCancel={() => {
                if (deleting || git.busy) return;
                setDeleteRequest(null);
              }}
              onConfirm={() => void confirmDelete()}
            />,
            document.body,
          )
        : null}
      {worktreeRequest && active
        ? createPortal(
            <GitWorktreeDialog
              request={worktreeRequest}
              busy={git.busy || creatingWorktree}
              blocked={worktreeBlocked}
              changed={worktreeChanged}
              onChange={setWorktreeRequest}
              onCancel={() => {
                if (!git.busy && !creatingWorktree) setWorktreeRequest(null);
              }}
              onCreate={() => void createWorktree()}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
