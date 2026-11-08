import { Menu } from "@base-ui/react/menu";
import {
  AlertTriangle,
  ChevronDown,
  Folder,
  GitBranch,
  LoaderCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as forgeApi from "../../data/forgeApi";
import * as api from "../../data/projectGitApi";
import {
  createGitReadCache,
  gitReadScope,
  readPersistedGitRepository,
  writePersistedGitRepository,
} from "../../data/gitReadCache";
import type { AgentProject } from "../../domain/agentSessions";
import type { GitMergeConflict } from "../../domain/mergeConflictAgent";
import type { ForgeKind } from "../../domain/forge";
import {
  projectFileGitStatus,
  type ProjectFileGitChange,
} from "../../domain/projectFiles";
import {
  gitErrorCode,
  projectNameWithoutBranch,
  type GitWorktree,
} from "../../domain/projectGit";
import {
  useGitChangesMutations,
  type GitCommitWarning,
} from "../../hooks/useGitChangesMutations";
import { useProjectGit } from "../../hooks/useProjectGit";
import {
  dismissNotification,
  notifyError,
  notifyWarning,
  useNotification,
} from "../../notifications";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { MenuItem, MenuSurface } from "../ui/Menu";
import type { AgentTransitionGuard } from "./AgentWorkspace";
import { GitBranchesView } from "./GitBranchesView";
import { GitForgeView } from "./GitForgeView";
import { GitChangesConfirmations } from "./GitChangesConfirmations";
import {
  GitPanelHeaderActions,
  useGitFilesRatioPreference,
  useGitFileTreePreference,
  useGitFilesVisiblePreference,
} from "./GitChangesWorkspace";
import { GitChangesView } from "./GitChangesView";
import { LoadingState } from "../ui/LoadingState";
import { GitHistoryView } from "./GitHistoryView";
import { GitRemoteActions } from "./GitRemoteActions";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import {
  ProjectExplorer,
  type ProjectExplorerGuard,
  type ProjectFileOpenRequest,
} from "./ProjectExplorer";
import type { GitFileMenu } from "./ProjectPathMenu";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings, type GitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";

const panelViewStorageKey = "soreno:project-panel-view";
const panelViews = [
  "explorer",
  "changes",
  "history",
  "branches",
  "requests",
] as const;
type ProjectPanelView = (typeof panelViews)[number];
const defaultFilesRatio = 28;
const minFilesRatio = 15;
const maxFilesRatio = 80;

function readPanelView(): ProjectPanelView {
  try {
    const value = localStorage.getItem(panelViewStorageKey);
    return value === "explorer" ||
      value === "history" ||
      value === "branches" ||
      value === "requests"
      ? value
      : "changes";
  } catch {
    return "changes";
  }
}

function panelViewLabel(
  s: GitStrings,
  view: ProjectPanelView,
  forgeKind: ForgeKind | null,
) {
  return view === "explorer"
    ? s.explorer
    : view === "changes"
      ? s.changesView
      : view === "requests"
        ? s.forgeRequests(forgeKind)
        : s[view];
}

type InitConfirmation = { projectId: string; scope: string; version: string };

export type GitPanelProps = {
  project?: AgentProject;
  projects?: AgentProject[];
  disconnected?: boolean;
  projectsLoading?: boolean;
  projectsError?: string | null;
  branchRevision?: number;
  visible: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onClose: () => void;
  onMutation?: (projectId?: string, branch?: string | null) => void;
  onBranchRead?: (projectId: string, branch: string, startedAt: number) => void;
  onOpenProjectById?: (projectId: string) => void;
  onOpenExternalWorktree?: (worktree: GitWorktree) => void | Promise<void>;
  onWorktreeCreated?: (
    project: AgentProject,
    worktree: GitWorktree,
  ) => void | Promise<void>;
  onWorktreeRemoved?: (worktree: GitWorktree) => void;
  worktreeRunningSessions?: (worktree: GitWorktree) => number;
  worktreeProjectIds?: (worktree: GitWorktree) => string[];
  onStopWorktreeSessions?: (worktree: GitWorktree) => Promise<void>;
  onPrepareWorktreeRemoval?: (
    worktree: GitWorktree,
  ) => Promise<() => Promise<void>>;
  onResolveMergeConflict?: (conflict: GitMergeConflict) => void;
  onRetryProjects?: () => void;
  openFileRequest?: ProjectFileOpenRequest | null;
  onOpenFileRequestHandled?: (id: number) => void;
  /** Opens a project-relative file in Files, through `openFileRequest`. */
  onOpenFile?: (path: string) => void;
  registerProjectNavigationGuard?: (guard: AgentTransitionGuard) => () => void;
  registerTransitionGuard?: (guard: AgentTransitionGuard) => () => void;
  /** Running agents of the project that can receive diff line comments. */
  commentTargets?: readonly GitDiffCommentTarget[];
  /** Running agent of the active terminal pane; receives paths typed from Files. */
  activeAgentTarget?: GitDiffCommentTarget | null;
  /** A path was typed into this running agent from Files: show its terminal. */
  onAgentInput?: (sessionId: string) => void;
  /** Opens a terminal signing the forge CLI in. */
  onForgeLogin?: (kind: ForgeKind) => void;
  /** Bumped when a forge sign-in succeeded: the requests tab reads again. */
  forgeLoginRevision?: number;
};

export function GitPanel({
  project,
  projects = [],
  disconnected = false,
  projectsLoading = false,
  projectsError = null,
  branchRevision,
  visible,
  expanded = false,
  onExpandedChange,
  onClose,
  onMutation,
  onBranchRead,
  onOpenProjectById,
  onOpenExternalWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
  worktreeRunningSessions,
  worktreeProjectIds,
  onStopWorktreeSessions,
  onPrepareWorktreeRemoval,
  onResolveMergeConflict,
  onRetryProjects,
  openFileRequest,
  onOpenFileRequestHandled,
  onOpenFile,
  registerProjectNavigationGuard,
  registerTransitionGuard,
  commentTargets,
  activeAgentTarget,
  onAgentInput,
  onForgeLogin,
  forgeLoginRevision,
}: GitPanelProps) {
  const s = useGitStrings();
  const agentStrings = useAgentStrings();
  const [initialPanelView] = useState(readPanelView);
  const [explorerActive, setExplorerActive] = useState(
    initialPanelView === "explorer",
  );
  const [transitionLocked, setTransitionLocked] = useState(false);
  const transitionLockRef = useRef(false);
  const [readCache] = useState(createGitReadCache);
  const [mergeConflicts, setMergeConflicts] = useState<
    Record<string, GitMergeConflict | null>
  >({});
  const readScope = project ? gitReadScope(project) : undefined;
  const gitReachable =
    visible && !disconnected && !projectsLoading && !projectsError;
  const gitActive = gitReachable && !explorerActive;
  const persistedRepository = useMemo(
    () =>
      project?.environment.kind === "ssh" && readScope
        ? readPersistedGitRepository(project.id, readScope)
        : undefined,
    [project?.environment.kind, project?.id, readScope],
  );
  const git = useProjectGit(
    project?.id,
    gitActive,
    onMutation,
    readCache,
    readScope,
    project?.environment.kind,
    persistedRepository,
    disconnected,
  );
  const viewGit = gitActive ? git : { ...git, isBusy: () => true };
  useEffect(() => {
    if (
      project?.environment.kind === "ssh" &&
      readScope &&
      git.repo &&
      git.hasFreshStatus
    ) {
      writePersistedGitRepository(project.id, readScope, git.repo);
    }
  }, [
    git.hasFreshStatus,
    git.repo,
    project?.environment.kind,
    project?.id,
    readScope,
  ]);
  const { branchRead } = git;
  useEffect(() => {
    if (branchRead)
      onBranchRead?.(
        branchRead.projectId,
        branchRead.branch,
        branchRead.startedAt,
      );
  }, [branchRead, onBranchRead]);
  const [visitedViews, setVisitedViews] = useState<Set<string>>(
    () => new Set(),
  );
  const [initConfirmation, setInitConfirmation] =
    useState<InitConfirmation | null>(null);
  const [requestedHistory, setRequestedHistory] = useState<{
    oid: string;
    scope: string;
  } | null>(null);
  const [historyPath, setHistoryPath] = useState<{
    path: string;
    scope: string;
  } | null>(null);
  const [historyFilterFocus, setHistoryFilterFocus] = useState<object | null>(
    null,
  );
  const [forgeRemote, setForgeRemote] = useState<{
    scope: string;
    kind: ForgeKind;
  } | null>(null);
  const [pathPrefix, setPathPrefix] = useState<{
    scope: string;
    root: string;
    value: string | null;
  } | null>(null);
  const readScopeRef = useRef(readScope);
  readScopeRef.current = readScope;
  const selectPanelViewRef = useRef<(view: ProjectPanelView) => void>(() => {});
  const showCommitWarning = useCallback(
    (warning: GitCommitWarning | null) => {
      if (!warning) {
        if (readScopeRef.current !== undefined)
          dismissNotification(`git-commit-warning:${readScopeRef.current}`);
        return;
      }
      const { historyOid, scope } = warning;
      notifyWarning(s.operationCompletedWithWarning, {
        key: `git-commit-warning:${scope}`,
        action: historyOid
          ? {
              label: `${s.sha} ${historyOid.slice(0, 12)}`,
              onAction: () => {
                if (readScopeRef.current !== scope) return;
                setHistoryPath(null);
                setRequestedHistory({ oid: historyOid, scope });
                selectPanelViewRef.current("history");
              },
            }
          : undefined,
      });
    },
    [s.operationCompletedWithWarning, s.sha],
  );
  const changesMutations = useGitChangesMutations({
    active: gitActive,
    blockedTitles: {
      conflicts: s.conflictsBlockCommit,
      detached: s.detached,
      operation: s.operationBlocksMutation,
    },
    git,
    onCommitWarning: showCommitWarning,
    projectId: project?.id,
    scope: readScope,
  });
  const [filesVisible, setFilesVisible] = useGitFilesVisiblePreference();
  const [filesRatio, setFilesRatio] = useGitFilesRatioPreference(
    defaultFilesRatio,
    minFilesRatio,
    maxFilesRatio,
  );
  const [publishHost, setPublishHost] = useState<HTMLDivElement | null>(null);
  const [remoteActionRunning, setRemoteActionRunning] = useState(false);
  const [tree, toggleFileLayout] = useGitFileTreePreference();
  const fileListId = useId();
  const gitRef = useRef(git);
  const explorerGuardRef = useRef<ProjectExplorerGuard | null>(null);
  const restoredPanelView = useRef(false);
  gitRef.current = git;
  const operationPendingRef = useRef(s.operationPending);
  operationPendingRef.current = s.operationPending;
  const registerExplorerGuard = useCallback((guard: ProjectExplorerGuard) => {
    explorerGuardRef.current = guard;
    return () => {
      if (explorerGuardRef.current === guard) explorerGuardRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (restoredPanelView.current || !project) return;
    restoredPanelView.current = true;
    if (initialPanelView !== "explorer" && git.draft.view !== initialPanelView)
      git.updateDraft({ view: initialPanelView });
  }, [git.draft.view, git.updateDraft, initialPanelView, project]);

  useEffect(() => {
    if (
      openFileRequest &&
      project &&
      openFileRequest.projectId === project.id &&
      !transitionLockRef.current
    ) {
      setExplorerActive(true);
    }
  }, [openFileRequest?.id, project?.id]);

  useEffect(() => {
    const view: ProjectPanelView = explorerActive ? "explorer" : git.draft.view;
    try {
      localStorage.setItem(panelViewStorageKey, view);
    } catch {
      /* Optional preference. */
    }
  }, [explorerActive, git.draft.view]);

  const filesShown = visible && explorerActive && !!project;
  const filesShownRef = useRef(filesShown);
  useEffect(() => {
    const wasShown = filesShownRef.current;
    filesShownRef.current = filesShown;
    // The inactive Git hook reads once per scope and again after reconnecting; only re-showing Files
    // over an already-read status needs a forced read for fresh badges.
    if (!filesShown || wasShown || disconnected) return;
    if (gitRef.current.hasFreshStatus) void gitRef.current.refresh();
  }, [disconnected, filesShown]);

  useEffect(() => {
    if (git.draft.view === "changes") return;
    setVisitedViews((current) =>
      current.has(git.draft.view)
        ? current
        : new Set(current).add(git.draft.view),
    );
  }, [git.draft.view]);

  useEffect(
    () =>
      registerProjectNavigationGuard?.({
        hasPendingWork: () =>
          explorerGuardRef.current?.hasPendingWork() ?? false,
        cancel: () => explorerGuardRef.current?.cancel(),
        prepare: () =>
          explorerGuardRef.current?.prepare() ?? Promise.resolve(true),
      }),
    [registerProjectNavigationGuard],
  );

  useEffect(
    () =>
      registerTransitionGuard?.({
        hasPendingWork: () =>
          gitRef.current.hasPendingMutation() ||
          (explorerGuardRef.current?.hasPendingWork() ?? false),
        cancel: () => {
          transitionLockRef.current = false;
          setTransitionLocked(false);
          gitRef.current.cancelClose();
          explorerGuardRef.current?.cancel();
        },
        prepare: async () => {
          if (!gitRef.current.prepareClose()) {
            notifyError(operationPendingRef.current);
            return false;
          }
          transitionLockRef.current = true;
          setTransitionLocked(true);
          const explorer = explorerGuardRef.current;
          explorer?.lock();
          if (explorer && !(await explorer.prepare())) {
            transitionLockRef.current = false;
            setTransitionLocked(false);
            explorer.cancel();
            gitRef.current.cancelClose();
            return false;
          }
          explorer?.discard();
          return true;
        },
      }),
    [registerTransitionGuard],
  );

  const root = git.repo?.identity?.root;
  const gitRepositoryReady = git.repo?.availability === "ready";
  const branchLabel =
    gitReachable && gitRepositoryReady
      ? (git.repo?.branch ?? git.repo?.head?.slice(0, 8) ?? "—")
      : null;
  useEffect(() => {
    if (
      !project ||
      readScope === undefined ||
      !root ||
      !gitRepositoryReady ||
      disconnected
    )
      return;
    let current = true;
    api
      .readGitPathPrefix(project.id)
      .then((value) => {
        if (current) setPathPrefix({ scope: readScope, root, value });
      })
      .catch(() => {
        /* Files only lose Git badges until the next explicit refresh retries. */
      });
    return () => {
      current = false;
    };
  }, [
    disconnected,
    gitRepositoryReady,
    git.revision,
    project?.id,
    readScope,
    root,
  ]);
  useEffect(() => {
    if (
      !project ||
      readScope === undefined ||
      !gitRepositoryReady ||
      disconnected
    )
      return;
    let current = true;
    forgeApi.readForgeRemote(project.id).then(
      (remote) => {
        if (current) setForgeRemote({ scope: readScope, kind: remote.kind });
      },
      () => {
        /* The tab keeps its default label; the view reports the failure. */
      },
    );
    return () => {
      current = false;
    };
  }, [disconnected, gitRepositoryReady, project?.id, readScope]);
  const forgeKind =
    forgeRemote && forgeRemote.scope === readScope ? forgeRemote.kind : null;
  const gitPrefix =
    pathPrefix &&
    gitRepositoryReady &&
    pathPrefix.scope === readScope &&
    pathPrefix.root === root
      ? pathPrefix.value
      : null;
  const gitFiles = git.repo?.files;
  const explorerGitStatus = useMemo(
    () =>
      gitPrefix === null || !gitFiles
        ? null
        : projectFileGitStatus(gitFiles, gitPrefix),
    [gitFiles, gitPrefix],
  );
  const activeHistoryPath =
    historyPath && historyPath.scope === readScope ? historyPath.path : null;
  const { incompatibleOperation } = changesMutations;
  const gitError = git.error;
  const gitErrorScope = readScope ?? project?.id;
  const resolvableConflict =
    gitError?.source === "mutation" &&
    gitErrorCode(gitError.message) === "mergeConflict" &&
    gitErrorScope !== undefined
      ? (mergeConflicts[gitErrorScope] ?? null)
      : null;
  useNotification(
    gitActive && gitError && gitErrorScope !== undefined
      ? {
          key: `git:${gitErrorScope}`,
          message: formatOperationError(agentStrings, {
            message: gitError.message,
            context:
              gitError.source === "read" ? s.repositoryReadError : undefined,
            warning: gitError.uncertain ? s.uncertain : undefined,
          }),
          action:
            gitError.source === "read"
              ? { label: s.retry, onAction: () => void git.refresh() }
              : resolvableConflict && onResolveMergeConflict
                ? {
                    label: agentStrings.resolveConflictsWithAgent,
                    onAction: () => {
                      git.dismissError();
                      onResolveMergeConflict(resolvableConflict);
                    },
                  }
                : { label: s.dismiss, onAction: git.dismissError },
          onDismiss: git.dismissError,
        }
      : null,
  );

  async function confirmInit() {
    const confirmation = initConfirmation;
    if (
      !gitActive ||
      !confirmation ||
      readScope === undefined ||
      readScope !== confirmation.scope ||
      project?.id !== confirmation.projectId ||
      git.repo?.version !== confirmation.version ||
      git.repo.availability !== "notRepository" ||
      git.isBusy()
    )
      return;
    setInitConfirmation(null);
    await git.mutate(() =>
      api.initGitRepository(confirmation.projectId, confirmation.version),
    );
  }

  const activePanelView: ProjectPanelView = explorerActive
    ? "explorer"
    : git.draft.view;

  async function selectPanelView(view: ProjectPanelView) {
    if (transitionLockRef.current || view === activePanelView) return false;
    if (explorerActive) {
      const guard = explorerGuardRef.current;
      if (guard && !(await guard.prepare())) return false;
      guard?.discard();
    }
    setExplorerActive(view === "explorer");
    if (view !== "explorer") git.updateDraft({ view });
    return true;
  }
  selectPanelViewRef.current = (view) => void selectPanelView(view);

  async function showFileChanges(change: ProjectFileGitChange) {
    if (await selectPanelView("changes"))
      git.updateDraft({
        selection: { path: change.gitPath, side: change.side },
      });
  }

  async function showFileHistory(path: string): Promise<boolean> {
    if (
      readScope === undefined ||
      (activePanelView === "history"
        ? transitionLockRef.current
        : !(await selectPanelView("history")))
    )
      return false;
    setRequestedHistory(null);
    setHistoryPath({ path, scope: readScope });
    setHistoryFilterFocus({});
    return true;
  }

  const fileMenu: GitFileMenu | undefined = project
    ? {
        project,
        prefix: gitPrefix,
        agentTarget: activeAgentTarget ?? null,
        onAgentInput,
        onShowHistory: showFileHistory,
        // shortcut: History rows don't know if the file still exists and the action ignores the transition lock; a missing file just fails to load in Files. Gate it if users hit either.
        onOpenFile,
      }
    : undefined;

  async function closePanel() {
    const guard = explorerGuardRef.current;
    if (guard && !(await guard.prepare())) return;
    guard?.discard();
    onClose();
  }

  let content: ReactNode;
  if (!git.desktop) content = <EmptyState description={s.desktop} fill />;
  else if (projectsLoading)
    content = (
      <div
        className="git-panel-centered-status"
        role="status"
        aria-label={s.loadingProjects}
      >
        <LoaderCircle
          size={14}
          className="app-loading-spinner"
          aria-hidden="true"
        />
      </div>
    );
  else if (projectsError) content = <EmptyState fill />;
  else if (!project)
    content = <EmptyState description={s.noProject} fill icon={<Folder />} />;
  else if (git.loading && !git.repo)
    content = (
      <LoadingState className="git-panel-centered-status">
        {s.loading}
      </LoadingState>
    );
  else if (!git.repo)
    content = git.autoRefreshPaused ? (
      <EmptyState
        actions={
          <Button
            disabled={git.loading || git.busy}
            onClick={() => void git.refresh()}
          >
            {s.refreshStatus}
          </Button>
        }
        description={s.autoRefreshPaused}
        fill
        icon={<AlertTriangle />}
      />
    ) : (
      <EmptyState description={s.missing} fill />
    );
  else if (git.repo.availability === "notRepository")
    content = (
      <EmptyState
        actions={
          <Button
            variant="primary"
            startIcon={<GitBranch />}
            disabled={git.busy || !!git.error?.uncertain}
            onClick={() => {
              if (readScope !== undefined)
                setInitConfirmation({
                  projectId: project.id,
                  scope: readScope,
                  version: git.repo!.version,
                });
            }}
          >
            {s.initRepository}
          </Button>
        }
        description={s.initDescription}
        fill
        headingLevel={3}
        icon={<GitBranch />}
        title={s.notRepository}
      />
    );
  else if (git.repo.availability === "bare")
    content = <EmptyState description={s.bare} fill />;
  else
    content = (
      <div className="git-panel-content" aria-busy={git.revalidating}>
        {git.autoRefreshPaused ? (
          <div className="git-panel-notice" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{s.autoRefreshPaused}</span>
            <Button
              size="small"
              disabled={git.loading || git.busy}
              onClick={() => void git.refresh()}
            >
              {s.refreshStatus}
            </Button>
          </div>
        ) : git.repo.limited ? (
          <div className="git-panel-notice" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            {s.limited}
          </div>
        ) : null}
        {incompatibleOperation ? (
          <div className="git-panel-notice" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{s.operationInstructions}</span>
          </div>
        ) : null}
        <GitRemoteActions
          active={gitActive}
          git={viewGit}
          projectId={project.id}
          toolbarContainer={publishHost}
          onRunningChange={setRemoteActionRunning}
          readCache={readCache}
          readScope={readScope}
        />
        {visitedViews.has("history") || git.draft.view === "history" ? (
          <div
            hidden={git.draft.view !== "history"}
            style={{
              display: git.draft.view === "history" ? "contents" : "none",
            }}
          >
            <GitHistoryView
              active={gitActive && git.draft.view === "history"}
              head={git.repo.head}
              projectId={project.id}
              requestedOid={
                requestedHistory &&
                readScope !== undefined &&
                requestedHistory.scope === readScope
                  ? requestedHistory.oid
                  : null
              }
              requestToken={
                requestedHistory &&
                readScope !== undefined &&
                requestedHistory.scope === readScope
                  ? requestedHistory
                  : undefined
              }
              revision={git.revision}
              readCache={readCache}
              readScope={readScope}
              path={activeHistoryPath}
              gitPath={
                activeHistoryPath !== null && gitPrefix !== null
                  ? `${gitPrefix}${activeHistoryPath}`
                  : null
              }
              onClearPath={() => {
                setHistoryPath(null);
                setRequestedHistory(null);
              }}
              filterFocusRequest={historyFilterFocus}
              onFilterFocusHandled={() => setHistoryFilterFocus(null)}
              fileMenu={fileMenu}
            />
          </div>
        ) : null}
        {visitedViews.has("branches") || git.draft.view === "branches" ? (
          <div
            hidden={git.draft.view !== "branches"}
            style={{
              display: git.draft.view === "branches" ? "contents" : "none",
            }}
          >
            <GitBranchesView
              active={gitActive && git.draft.view === "branches"}
              git={viewGit}
              project={project}
              projects={projects}
              readCache={readCache}
              readScope={readScope}
              branchRevision={branchRevision}
              onOpenProject={onOpenProjectById}
              onOpenExternalWorktree={onOpenExternalWorktree}
              onWorktreeCreated={onWorktreeCreated}
              onWorktreeRemoved={(worktree) => {
                onWorktreeRemoved?.(worktree);
                onMutation?.();
                onRetryProjects?.();
              }}
              worktreeRunningSessions={worktreeRunningSessions}
              worktreeProjectIds={worktreeProjectIds}
              onStopWorktreeSessions={onStopWorktreeSessions}
              onPrepareWorktreeRemoval={onPrepareWorktreeRemoval}
              onMergeConflict={(scope, conflict) =>
                setMergeConflicts((current) => ({
                  ...current,
                  [scope]: conflict,
                }))
              }
            />
          </div>
        ) : null}
        {visitedViews.has("requests") || git.draft.view === "requests" ? (
          <div
            hidden={git.draft.view !== "requests"}
            style={{
              display: git.draft.view === "requests" ? "contents" : "none",
            }}
          >
            <GitForgeView
              active={gitActive && git.draft.view === "requests"}
              git={viewGit}
              project={project}
              readScope={readScope}
              loginRevision={forgeLoginRevision}
              onRemote={(remote) => {
                if (readScope !== undefined)
                  setForgeRemote({ scope: readScope, kind: remote.kind });
              }}
              onLogin={onForgeLogin}
              onWorktreeCreated={onWorktreeCreated}
            />
          </div>
        ) : null}
        <GitChangesView
          active={gitActive}
          git={git}
          projectId={project.id}
          filePane={{
            defaultRatio: defaultFilesRatio,
            listId: fileListId,
            maxRatio: maxFilesRatio,
            minRatio: minFilesRatio,
            ratio: filesRatio,
            tree,
            visible: filesVisible,
            onRatioChange: setFilesRatio,
            onToggleTree: toggleFileLayout,
          }}
          actions={changesMutations.actions}
          commit={changesMutations.commit}
          onHistory={() => void selectPanelView("history")}
          onPublishHostChange={setPublishHost}
          commentTargets={commentTargets}
          fileMenu={fileMenu}
        />
      </div>
    );

  if (git.desktop && project && !projectsLoading && !projectsError) {
    const retainedGitContent = content;
    const inactiveContent = disconnected ? (
      <EmptyState description={s.projectDisconnected} fill role="status" />
    ) : explorerActive ? (
      <ProjectExplorer
        key={`explorer:${readScope ?? project.id}`}
        agentTarget={activeAgentTarget}
        gitStatus={explorerGitStatus}
        historyAvailable={gitRepositoryReady}
        openFileRequest={openFileRequest}
        project={project}
        registerGuard={registerExplorerGuard}
        onAgentInput={onAgentInput}
        onFilesChanged={() => void git.refresh()}
        onOpenFileRequestHandled={onOpenFileRequestHandled}
        onShowChanges={(change) => void showFileChanges(change)}
        onShowHistory={(path) => void showFileHistory(path)}
      />
    ) : null;
    content = (
      <>
        {inactiveContent}
        <div
          key={`git:${readScope ?? project.id}`}
          hidden={!gitActive}
          style={{ display: gitActive ? "contents" : "none" }}
        >
          {retainedGitContent}
        </div>
      </>
    );
  }

  const activeInitConfirmation =
    initConfirmation &&
    readScope !== undefined &&
    initConfirmation.scope === readScope
      ? initConfirmation
      : null;
  const initChanged =
    !!activeInitConfirmation &&
    (project?.id !== activeInitConfirmation.projectId ||
      git.repo?.version !== activeInitConfirmation.version ||
      git.repo?.availability !== "notRepository");
  useNotification(
    gitActive && initChanged
      ? {
          key: "git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );
  return (
    <>
      <section
        className="agent-git-panel"
        data-expanded={expanded || undefined}
        hidden={!visible}
        aria-label={s.projectTools}
      >
        <header className="agent-git-panel-header">
          <div className="git-panel-heading">
            <Menu.Root modal={false}>
              <h2>
                <Menu.Trigger
                  render={
                    <button
                      className="git-panel-view-trigger"
                      type="button"
                      aria-label={s.projectView}
                    >
                      {panelViewLabel(s, activePanelView, forgeKind)}
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  }
                />
              </h2>
              <Menu.Portal>
                <Menu.Positioner
                  className="agent-menu-positioner"
                  sideOffset={4}
                  align="start"
                  collisionPadding={8}
                >
                  <Menu.Popup
                    render={<MenuSurface className="git-panel-view-menu" />}
                  >
                    {panelViews.map((view) => (
                      <Menu.Item
                        key={view}
                        disabled={transitionLocked}
                        nativeButton
                        render={
                          <MenuItem
                            selected={activePanelView === view}
                            aria-current={
                              activePanelView === view ? "page" : undefined
                            }
                          />
                        }
                        onClick={() => void selectPanelView(view)}
                      >
                        {panelViewLabel(s, view, forgeKind)}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <nav className="git-panel-view-tabs" aria-label={s.projectView}>
              {panelViews.map((view) => (
                <button
                  className="git-panel-view-tab"
                  key={view}
                  type="button"
                  disabled={transitionLocked}
                  aria-current={activePanelView === view ? "page" : undefined}
                  onClick={() => void selectPanelView(view)}
                >
                  {panelViewLabel(s, view, forgeKind)}
                </button>
              ))}
            </nav>
            {project ? (
              <p title={root ?? project.path}>
                {branchLabel
                  ? projectNameWithoutBranch(project.name, git.repo?.branch)
                  : project.name}
              </p>
            ) : null}
            {branchLabel ? (
              <span
                className="git-branch-label"
                title={git.repo?.upstream ?? undefined}
              >
                <GitBranch size={13} aria-hidden="true" />
                <span>{branchLabel}</span>
              </span>
            ) : null}
            {gitReachable && (git.repo?.ahead || git.repo?.behind) ? (
              <span
                className="git-tracking-status"
                title={s.trackingStatus(git.repo.ahead, git.repo.behind)}
              >
                ↑{git.repo.ahead} ↓{git.repo.behind}
              </span>
            ) : null}
          </div>
          <GitPanelHeaderActions
            busy={
              gitActive &&
              git.busy &&
              // The quick commit and sync buttons already spin next to their action.
              !(
                (remoteActionRunning || changesMutations.commit.quickPending) &&
                activePanelView === "changes" &&
                filesVisible
              )
            }
            filesVisible={filesVisible}
            listId={fileListId}
            showFilesToggle={
              gitActive &&
              git.repo?.availability === "ready" &&
              activePanelView === "changes"
            }
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onToggleFiles={() => setFilesVisible(!filesVisible)}
            onClose={() => void closePanel()}
          />
        </header>
        {content}
      </section>
      {gitActive && activeInitConfirmation
        ? createPortal(
            <ConfirmationDialog
              title={s.initTitle}
              confirmVariant="primary"
              description={s.initDescription}
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.initRepository}
              cancelDisabled={git.busy}
              confirmDisabled={git.busy || initChanged}
              onCancel={() => {
                if (!git.busy) setInitConfirmation(null);
              }}
              onConfirm={() => void confirmInit()}
            />,
            document.body,
          )
        : null}
      <GitChangesConfirmations
        active={gitActive}
        state={changesMutations.confirmations}
      />
    </>
  );
}
