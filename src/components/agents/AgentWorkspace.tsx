import { Folder, GitBranch, LoaderCircle, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/agentSessionsApi";
import { listenCloseTab } from "../../data/appMenuApi";
import * as gitApi from "../../data/projectGitApi";
import {
  agentEnvironmentKey,
  agentEnvironmentLabel,
  agentImagePasteSequence,
  agentPresets,
  agentProjectTargetKey,
  agentProviderOf,
  agentSessionActivity,
  agentSessionDisplayName,
  agentSessionTitle,
  closedAgentSessionIds,
  defaultAgentArgs,
  groupCollapseKey,
  moveAgentItem,
  ompConversationExecutable,
  orderAgentItems,
  pinnedAgentItemsFirst,
  projectSectionIds,
  reconcileProjectSectionOrder,
  sameAgentMachine,
  sessionLaunchBlocked,
  type AgentProject,
  type AgentProjectWorktree,
  type AgentSession,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import { groupMentionRoots } from "../../domain/agentConversationMentions";
import {
  nextAgentAttentionSession,
  type AgentSessionAttention,
} from "../../domain/agentAttention";
import {
  agentLaunchProjects,
  agentsSpaceWorkspace,
  findWorktreeProject,
  projectIdsWithAgents,
  railWorktreeGroups,
  sshConnectionState,
  uniqueAgentSessionName,
  visibleAgentSessions,
  worktreeName,
} from "../../domain/agentWorkspaceView";
import { pruneRecentProjectFiles } from "../../domain/recentProjectFiles";
import type { KanbanIssueSelection } from "../../domain/kanban";
import type { GitMergeConflict } from "../../domain/mergeConflictAgent";
import {
  gitErrorCode,
  gitErrorMessage,
  type GitCloneRequest,
} from "../../domain/projectGit";
import { projectServiceKey } from "../../domain/projectServices";
import {
  AgentServiceError,
  useAgentSessions,
} from "../../hooks/useAgentSessions";
import { useAgentAttention } from "../../hooks/useAgentAttention";
import { useAgentTabReorder } from "../../hooks/useAgentTabReorder";
import { usePersistedValue } from "../../hooks/usePersistedValue";
import { KanbanControllerProvider } from "../../hooks/useKanbanController";
import { useRemoteSessionLabels } from "../../hooks/useRemoteSessionLabels";
import { notifyWarning, useNotification } from "../../notifications";
import { useAppSettings } from "../../settings";
import { AutomationsBoard } from "../automations/AutomationsBoard";
import { KanbanBoard } from "../kanban/KanbanBoard";
import { KanbanIssuePanel } from "../kanban/KanbanIssuePanel";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import {
  AgentProjectForm,
  AgentProjectGroupForm,
  AgentSessionForm,
  type AgentProjectGroup,
} from "./AgentForms";
import { GitCloneForm, type GitCloneRecovery } from "./GitCloneForm";
import { AgentProjectRail } from "./AgentProjectRail";
import { AgentSessionTabs } from "./AgentSessionTabs";
import { AgentServiceTrustDialog } from "./AgentServiceTrustDialog";
import { AgentConversation } from "./AgentConversation";
import { AgentTerminal } from "./AgentTerminal";
import { MissingAgentNotice } from "./MissingAgentNotice";
import { GitPanel } from "./GitPanel";
import { GitWorktreeDialog } from "./GitWorktreeDialog";
import { ProjectGroupPanel } from "./ProjectGroupPanel";
import { ProjectServicesDock } from "./ProjectServicesDock";
import { ProjectServicesPanel } from "./ProjectServicesPanel";
import { QuickOpenDialog } from "./QuickOpenDialog";
import {
  ProjectSearchDialog,
  type ProjectSearchState,
} from "./ProjectSearchDialog";
import type { ProjectFileOpenRequest } from "./ProjectExplorer";
import type { ProjectSearchRoot } from "../../domain/projectFiles";
import {
  AgentSshStatusControl,
  type SshTransition,
} from "./AgentSshStatusControl";
import { NewSessionMenu } from "./AgentWorkspaceMenus";
import {
  confirmationDialogText,
  groupDeletionProjectIds,
  type Confirmation,
  type Deletion,
} from "./agentConfirmation";
import { useAgentStrings } from "./agentStrings";
import {
  formatOperationError,
  isSshRemoteStopFailure,
  LocalizedOperationError,
} from "./operationError";
import { useGitStrings } from "./gitStrings";
import { useQuickWorktree } from "./useQuickWorktree";
import { useAgentSessionLifecycle } from "./useAgentSessionLifecycle";
import { useProjectGroupMigration } from "./useProjectGroupMigration";
import { useLinkedAgentLaunch } from "./useLinkedAgentLaunch";
import { useRecoveryAgentLaunch } from "./useRecoveryAgentLaunch";
import { useWorkspaceServices } from "./useWorkspaceServices";
import { useToolsPanelMode } from "./useToolsPanelMode";
import {
  collapsedProjectsKey,
  projectOrderKey,
  pinnedTabsKey,
  projectSectionOrderKey,
  readCollapsedProjects,
  readHideProjectsWithoutAgents,
  readKanbanSelected,
  readPinnedTabs,
  readProjectOrder,
  readProjectSectionOrder,
  readSelection,
  readTabOrder,
  readTerminalSplits,
  readTerminalTitles,
  selectionKey,
  tabOrderKey,
  terminalSplitsKey,
  terminalTitlesKey,
  writeHideProjectsWithoutAgents,
  writeKanbanSelected,
  writeStoredJson,
} from "./agentWorkspaceStorage";
import { DesignSessionPanel } from "../design/DesignSessionPanel";
import { DesignWorkspace } from "../design/DesignWorkspace";
import "./AgentWorkspace.css";
import "./GitPanel.css";
import "./GitControls.css";
import "./AgentTerminalWorkspace.css";
import "./AgentForms.css";

const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

export type AgentTransitionGuard = {
  prepare: () => Promise<boolean>;
  hasPendingWork: () => boolean;
  /** Release the launch lock if another close guard cancels or native close fails. */
  cancel?: () => void;
};
/** A board shown over the sessions: the Kanban, the automations or the Design whiteboard. */
export type AgentBoard = "kanban" | "automations" | "design";
export type AgentBoardRequest = {
  board: AgentBoard | null;
  id: number;
  issue?: KanbanIssueSelection;
};
/** Session of a clicked notification, selected once the workspace has loaded. */
export type AgentSessionRequest = { sessionId: string; id: number };
type AgentWorkspaceProps = {
  gitPanelContainer?: HTMLElement | null;
  gitPanelExpanded?: boolean;
  gitPanelVisible?: boolean;
  hidden: boolean;
  boardRequest?: AgentBoardRequest;
  onGitPanelExpandedChange?: (expanded: boolean) => void;
  onGitPanelVisibleChange?: (visible: boolean) => void;
  onBoardChange?: (board: AgentBoard | null) => void;
  // Whether the Kanban board has an issue open in the right panel.
  onBoardIssuePanelChange?: (open: boolean) => void;
  // That panel hidden by the panel shortcut, its issue staying open.
  boardIssuePanelHidden?: boolean;
  onBoardIssuePanelHiddenChange?: (hidden: boolean) => void;
  onProjectToolsAvailableChange?: (available: boolean) => void;
  /** Brings the workspace on screen on `board`, for a notification or a shortcut. */
  onShowWorkspace?: (board: AgentBoard | null) => void;
  sidebarContainer?: HTMLElement | null;
  statusBarContainer?: HTMLElement | null;
  sessionRequest?: AgentSessionRequest;
  /** Register only for application close, not for vault changes. */
  registerTransitionGuard?: (guard: AgentTransitionGuard) => () => void;
};
type Form = (
  | { kind: "project"; project?: AgentProject }
  | { kind: "clone" }
  | { kind: "group"; group?: AgentProjectGroup }
  | { kind: "session"; session: AgentSession }
) & { fromMenu?: boolean };

export function AgentWorkspace({
  gitPanelContainer,
  gitPanelExpanded = false,
  gitPanelVisible = true,
  hidden,
  boardRequest,
  onGitPanelExpandedChange,
  onGitPanelVisibleChange,
  onBoardChange,
  onBoardIssuePanelChange,
  boardIssuePanelHidden = false,
  onBoardIssuePanelHiddenChange,
  onProjectToolsAvailableChange,
  onShowWorkspace,
  sessionRequest,
  sidebarContainer,
  statusBarContainer,
  registerTransitionGuard,
}: AgentWorkspaceProps) {
  const s = useAgentStrings();
  const { settings } = useAppSettings();
  const gitStrings = useGitStrings();
  const selectedProjectIdRef = useRef<string | null>(null);
  const {
    desktop,
    workspace: fullWorkspace,
    branches,
    branchError,
    branchRevision,
    worktrees,
    worktreeError,
    missingProjectIds,
    worktreesLoaded,
    worktreesComplete,
    hasLoaded,
    loading,
    loadError,
    busy,
    isBusy,
    error,
    pendingServiceKeys,
    statusError,
    setError,
    retry,
    execute: executeWorkspace,
    saveProjectAppearance,
    saveGroupAppearance,
    waitForProjectAppearance,
    hasPendingProjectAppearance,
    updateStatuses,
    startServices,
    stopServices,
    restartService,
    refreshBranches,
    observeBranch,
    rememberWorktreeProject,
    forgetWorktree,
  } = useAgentSessions(!hidden, selectedProjectIdRef);
  const workspace = useMemo(
    () => agentsSpaceWorkspace(fullWorkspace),
    [fullWorkspace],
  );
  const [selection, setSelection] = useState(readSelection);
  const [board, setBoard] = useState<AgentBoard | null>(() =>
    readKanbanSelected() ? "kanban" : null,
  );
  const kanbanSelected = board === "kanban";
  const boardSelected = board !== null;
  // Keeps the board's move queue alive across toggles without fetching Kanban before first use.
  const [kanbanOpened, setKanbanOpened] = useState(kanbanSelected);
  const [automationsOpened, setAutomationsOpened] = useState(false);
  const [designOpened, setDesignOpened] = useState(false);
  const [designSessionRequest, setDesignSessionRequest] =
    useState<AgentSessionRequest>();
  const [designSessionId, setDesignSessionId] = useState<string | null>(null);
  const [kanbanIssueRequest, setKanbanIssueRequest] = useState<{
    issue: KanbanIssueSelection;
  }>();
  // The board posts pending issue summaries, so it mounts for them even while never shown.
  if (
    !kanbanOpened &&
    workspace.statuses.some(({ issueSummary }) => issueSummary)
  )
    setKanbanOpened(true);
  const [projectOrder, setProjectOrder] = useState(readProjectOrder);
  const [projectSectionOrder, setProjectSectionOrder] = useState(
    readProjectSectionOrder,
  );
  const [tabOrder, setTabOrder] = useState(readTabOrder);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(readPinnedTabs);
  const [terminalSplits, setTerminalSplits] = useState(readTerminalSplits);
  const lastSessionByProject = useRef<Record<string, string>>(
    selection.projectId && selection.sessionId
      ? { [selection.projectId]: selection.sessionId }
      : {},
  );
  const [collapsed, setCollapsed] = useState(readCollapsedProjects);
  const [hideProjectsWithoutAgents, setHideProjectsWithoutAgents] = useState(
    readHideProjectsWithoutAgents,
  );
  const updateHideProjectsWithoutAgents = (value: boolean) => {
    setHideProjectsWithoutAgents(value);
    writeHideProjectsWithoutAgents(value);
  };
  const returnFocusRef = useRef<HTMLElement>(null);
  const addProjectRef = useRef<HTMLButtonElement>(null);
  const addSessionRef = useRef<HTMLButtonElement>(null);
  const sshControlRef = useRef<HTMLButtonElement>(null);
  const terminalStackRef = useRef<HTMLDivElement>(null);
  const sessionTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [form, setForm] = useState<Form | null>(null);
  const [cloneRecovery, setCloneRecovery] = useState<GitCloneRecovery | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState<{
    selectionQuery: string | null;
  } | null>(null);
  const [lastProjectSearch, setLastProjectSearch] =
    useState<ProjectSearchState>({
      query: "",
      options: { caseSensitive: false, wholeWord: false, regex: false },
    });
  const [openFileRequest, setOpenFileRequest] =
    useState<ProjectFileOpenRequest | null>(null);
  const openFileRequestId = useRef(0);
  const [closeChecking, setCloseChecking] = useState(false);
  const closing = useRef(false);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [terminalTitles, setTerminalTitles] =
    useState<Record<string, string>>(readTerminalTitles);
  const [focusRequest, setFocusRequest] = useState(0);
  // One-shot: child effects consume it before this reset, so reopening keeps focus on the agent.
  const [serviceFocusRequest, setServiceFocusRequest] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (serviceFocusRequest !== null) setServiceFocusRequest(null);
  }, [serviceFocusRequest]);
  const [navigationFocusRequest, setNavigationFocusRequest] = useState(0);
  const consumedNavigationFocusRequest = useRef(0);
  const [launchFailed, setLaunchFailed] = useState<string | null>(null);
  const [failedConnectProjectId, setFailedConnectProjectId] = useState<
    string | null
  >(null);
  const [failedDeletion, setFailedDeletion] = useState<Deletion | null>(null);
  const [failedMerge, setFailedMerge] = useState<{
    error: Error;
    conflict: GitMergeConflict;
  } | null>(null);
  const [sshTransition, setSshTransition] = useState<SshTransition | null>(
    null,
  );
  const sshTransitionRef = useRef<SshTransition | null>(null);
  const [sshForwardBusy, setSshForwardBusy] = useState(false);
  const sshForwardBusyRef = useRef(false);
  const handleSshForwardBusyChange = useCallback((value: boolean) => {
    sshForwardBusyRef.current = value;
    setSshForwardBusy(value);
  }, []);
  const [startingSessionId, setStartingSessionId] = useState<string | null>(
    null,
  );
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Masks a deleted issue's link until a reload drops it: the reload can be skipped or stale.
  const [deletedIssueIds, setDeletedIssueIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);
  const [mountedSessions, setMountedSessions] = useState<Set<string>>(
    () => new Set(),
  );
  const projectNavigationGuards = useRef(new Set<AgentTransitionGuard>());
  const registerProjectNavigationGuard = useCallback(
    (guard: AgentTransitionGuard) => {
      projectNavigationGuards.current.add(guard);
      return () => {
        projectNavigationGuards.current.delete(guard);
      };
    },
    [],
  );
  const current = useRef({ workspace, fullWorkspace, loading });
  current.current = { workspace, fullWorkspace, loading };
  async function execute(work: () => Promise<void>) {
    setFailedConnectProjectId(null);
    setLaunchFailed(null);
    setFailedDeletion(null);
    return executeWorkspace(work);
  }
  const { start, launch, waitForExit, stopProjectSessions } =
    useAgentSessionLifecycle({
      current,
      closing,
      isBusy,
      execute,
      fullWorkspace,
      terminalSplits,
      updateStatuses,
      bumpRevision,
      setStartingSessionId,
      setFocusRequest,
      setLaunchFailed,
    });
  const updateTerminalTitle = useCallback((id: string, title: string) => {
    const { sessions, projects } = current.current.workspace;
    const session = sessions.find((session) => session.id === id);
    if (!session) return;
    const name = agentSessionTitle(
      title,
      session.executable,
      projects.find((project) => project.id === session.projectId)?.path ?? "",
    );
    if (name !== null)
      setTerminalTitles((current) =>
        current[id] === name ? current : { ...current, [id]: name },
      );
  }, []);
  const navigationDisabled =
    loading ||
    closeChecking ||
    sshTransition !== null ||
    sshForwardBusy ||
    (busy && closingSessionId === null);
  const projectsLoading = !hidden && !hasLoaded && loading;
  const projectsRefreshing = hasLoaded && (loading || !worktreesLoaded);
  const projectToolsAvailable = !hasLoaded || workspace.projects.length > 0;
  const groupProjectIds = new Set(
    (workspace.groups ?? []).flatMap((group) =>
      group.groupProjectId ? [group.groupProjectId] : [],
    ),
  );
  const projectGroups: AgentProjectGroup[] = (workspace.groups ?? []).map(
    (group) => ({
      ...group,
      collapsed: collapsed.has(groupCollapseKey(group.id)),
    }),
  );
  const orderedProjects = orderAgentItems(workspace.projects, projectOrder);
  const listedProjects = orderedProjects.filter(
    (project) => !groupProjectIds.has(project.id),
  );
  // shortcut: a group appears once its overview folder exists; prepare it on pick if unopened groups are missed.
  const groupOverviewProjects = (workspace.groups ?? []).flatMap((group) => {
    const project = workspace.projects.find(
      (item) => item.id === group.groupProjectId,
    );
    return project && !missingProjectIds.includes(project.id)
      ? [
          {
            ...project,
            color: group.color,
            icon: group.icon,
            iconDataUrl: group.iconDataUrl,
          },
        ]
      : [];
  });
  const worktreeGroups = railWorktreeGroups(worktrees, orderedProjects);
  const groupByProjectId = new Map(
    worktreeGroups.flatMap((group) =>
      group.projectIds.map((id) => [id, group] as const),
    ),
  );
  const { startIssueAgent, startDesignAgent } = useLinkedAgentLaunch({
    closing,
    current,
    missingProjectIds,
    orderedProjects,
    groupByProjectId,
    branches,
    execute,
    start,
    selectSession,
    rememberWorktreeProject,
    refreshBranches,
  });
  const kanbanIssueSessions = useMemo(
    () =>
      (workspace.kanbanIssueSessions ?? []).filter(
        (link) => !deletedIssueIds.has(link.issueId),
      ),
    [workspace.kanbanIssueSessions, deletedIssueIds],
  );
  const closedSessionIds = useMemo(
    () =>
      closedAgentSessionIds(
        workspace.closedSessionIds ?? [],
        workspace.sessions,
        kanbanIssueSessions,
        workspace.automationSessionIds ?? [],
      ),
    [
      workspace.closedSessionIds,
      workspace.sessions,
      kanbanIssueSessions,
      workspace.automationSessionIds,
    ],
  );
  const projectsWithAgents = projectIdsWithAgents(
    workspace.sessions,
    closedSessionIds,
    worktreeGroups,
  );
  const filteredProjects = hideProjectsWithoutAgents
    ? listedProjects.filter((project) => projectsWithAgents.has(project.id))
    : listedProjects;
  const filteredProjectIds = new Set(
    filteredProjects.map((project) => project.id),
  );
  const filteredProjectGroups = hideProjectsWithoutAgents
    ? projectGroups.filter(
        (group) =>
          (!!group.groupProjectId &&
            projectsWithAgents.has(group.groupProjectId)) ||
          group.projectIds.some((id) => filteredProjectIds.has(id)),
      )
    : projectGroups;
  const railProjects = listedProjects.filter((project) => {
    const group = groupByProjectId.get(project.id);
    return !group || group.repositoryProjectId === project.id;
  });
  const derivedProjectSectionIds = projectSectionIds(
    railProjects,
    projectGroups,
  );
  const reconciledProjectSectionOrder = reconcileProjectSectionOrder(
    projectSectionOrder,
    derivedProjectSectionIds,
  );
  const derivedProjectSectionOrderKey = JSON.stringify(
    derivedProjectSectionIds,
  );
  const hiddenProjectCount = railProjects.filter(
    (project) => !filteredProjectIds.has(project.id),
  ).length;
  const splitParentByChild = new Map(
    Object.entries(terminalSplits).map(([parentId, childId]) => [
      childId,
      parentId,
    ]),
  );
  const selectedSplitParentId = selection.sessionId
    ? splitParentByChild.get(selection.sessionId)
    : undefined;
  const visibleSessions = visibleAgentSessions({
    projects: orderedProjects,
    sessions: workspace.sessions,
    tabOrder,
    pinnedIds: pinnedSessionIds,
    hiddenIds: hiddenSessionIds,
    closedIds: closedSessionIds,
    terminalSplits,
  });
  const selectedSession = visibleSessions.find(
    (session) => session.id === (selectedSplitParentId ?? selection.sessionId),
  );
  const selectedProject =
    orderedProjects.find(
      (project) =>
        project.id === (selectedSession?.projectId ?? selection.projectId),
    ) ?? railProjects[0];
  selectedProjectIdRef.current = selectedProject?.id ?? null;
  const selectedProjectGroup = selectedProject
    ? projectGroups.find((group) => group.groupProjectId === selectedProject.id)
    : undefined;
  const selectedProjectDisconnected =
    !!selectedProject &&
    (workspace.disconnectedProjectIds ?? []).includes(selectedProject.id);
  const selectedProjectDormant =
    !!selectedProject &&
    (workspace.dormantProjectIds ?? []).includes(selectedProject.id);
  // The overview folder only holds links to its members: search the members themselves.
  const searchRoots: ProjectSearchRoot[] = selectedProjectGroup
    ? orderedProjects
        .filter(
          (project) =>
            selectedProjectGroup.projectIds.includes(project.id) &&
            !(workspace.disconnectedProjectIds ?? []).includes(project.id),
        )
        .map((project) => ({ projectId: project.id, label: project.name }))
    : selectedProject
      ? [{ projectId: selectedProject.id, label: "" }]
      : [];
  const selectedProjectLaunchBlocked =
    selectedProjectDisconnected && !selectedProjectDormant;
  const railSelectedProjectId = boardSelected ? undefined : selectedProject?.id;

  useEffect(() => {
    if (
      hidden ||
      boardSelected ||
      !selectedProject ||
      selectedProjectDisconnected
    ) {
      setQuickOpen(false);
      setProjectSearch(null);
      return;
    }

    function handleShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        (!event.ctrlKey && !event.metaKey) ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setQuickOpen(true);
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const selection = window.getSelection()?.toString() ?? "";
        setProjectSearch({
          selectionQuery:
            selection && selection.length <= 200 && !/[\r\n]/.test(selection)
              ? selection
              : null,
        });
      }
    }

    document.addEventListener("keydown", handleShortcut, true);
    return () => document.removeEventListener("keydown", handleShortcut, true);
  }, [hidden, boardSelected, selectedProject?.id, selectedProjectDisconnected]);

  const services = useWorkspaceServices({
    selectedProject,
    workspace,
    worktreeGroups,
    orderedProjects,
    closedSessionIds,
    hidden,
    boardSelected,
    isBusy,
    startServices,
    restartService,
    bumpRevision,
    setFailedConnectProjectId,
    setLaunchFailed,
    setFocusRequest,
  });
  const disabled =
    busy ||
    loading ||
    closeChecking ||
    services.trustPending ||
    sshTransition !== null ||
    sshForwardBusy;
  const selectedProjectAllSessions = selectedProject
    ? workspace.sessions.filter(
        (session) =>
          session.projectId === selectedProject.id &&
          !closedSessionIds.has(session.id),
      )
    : [];
  const favoriteSessions = selectedProject
    ? workspace.sessions.filter(
        (session) =>
          session.favorite && session.projectId === selectedProject.id,
      )
    : [];
  const selectedStatus = workspace.statuses.find(
    (status) => status.sessionId === selectedSession?.id,
  );
  const selectedProjectSessions = selectedProject
    ? visibleSessions.filter(
        (session) => session.projectId === selectedProject.id,
      )
    : [];
  const pinnedTabCount = selectedProjectSessions.filter((session) =>
    pinnedSessionIds.has(session.id),
  ).length;
  const splitSessionId = selectedSession
    ? (terminalSplits[selectedSession.id] ?? null)
    : null;
  const splitChildren = new Map(
    selectedProjectSessions.flatMap((tab) => {
      const child = workspace.sessions.find(
        (session) =>
          session.id === terminalSplits[tab.id] &&
          session.kind !== "service" &&
          session.projectId === tab.projectId &&
          !hiddenSessionIds.has(session.id) &&
          !closedSessionIds.has(session.id),
      );
      return child ? [[tab.id, child] as const] : [];
    }),
  );
  const splitSession = selectedSession
    ? splitChildren.get(selectedSession.id)
    : undefined;
  const failedLaunchSession = launchFailed
    ? fullWorkspace.sessions.find((session) => session.id === launchFailed)
    : undefined;
  const quickWorktree = useQuickWorktree({
    hidden,
    isBlocked: () => closing.current || isBusy(),
    disconnectedProjectIds: workspace.disconnectedProjectIds ?? [],
    execute,
    onCreated: (created, worktree, sourceProjectId) =>
      openWorktree(
        created,
        worktree,
        groupByProjectId.get(sourceProjectId)?.repositoryProjectId ??
          sourceProjectId,
      ),
  });
  const projectReorderDisabled =
    disabled || hidden || !!form || !!confirmation || !!quickWorktree.draft;
  const tabReorder = useAgentTabReorder({
    ids: selectedProjectSessions.map((session) => session.id),
    projectId: selectedProject?.id,
    disabled: disabled || hidden || !!form || !!confirmation,
    onReorder: reorderSession,
    canSplit: canSplitSession,
    onSplit: moveSessionIntoSplit,
    dropIndexBounds: (id) =>
      pinnedSessionIds.has(id)
        ? [0, pinnedTabCount - 1]
        : [pinnedTabCount, selectedProjectSessions.length - 1],
    splitTargetRef: terminalStackRef,
  });
  const statusById = useMemo(() => {
    const byId = new Map<string, AgentSessionStatus>();
    // Keeps the first status per session, as the former linear search did.
    for (const status of workspace.statuses)
      if (!byId.has(status.sessionId)) byId.set(status.sessionId, status);
    return byId;
  }, [workspace.statuses]);
  const statusOf = (id: string) => statusById.get(id);
  function missingAgentNotice(session: AgentSession) {
    if (!statusOf(session.id)?.missingExecutable) return undefined;
    return (
      <MissingAgentNotice
        session={session}
        environment={
          workspace.projects.find((project) => project.id === session.projectId)
            ?.environment
        }
        disabled={disabled}
        onRetry={() => void performAction({ kind: "restart", session })}
      />
    );
  }
  const terminalSessionIds = new Set([
    selectedSession?.id,
    splitSession?.id,
    ...workspace.sessions
      .filter(
        (session) =>
          session.kind !== "service" &&
          (mountedSessions.has(session.id) ||
            statusOf(session.id)?.state === "running"),
      )
      .map((session) => session.id),
  ]);
  const mountedTerminalSessions = workspace.sessions.filter(
    (session) =>
      session.kind !== "service" && terminalSessionIds.has(session.id),
  );
  const terminalSessions =
    selectedSession && splitSession
      ? [
          selectedSession,
          splitSession,
          ...mountedTerminalSessions.filter(
            (session) =>
              session.id !== selectedSession.id &&
              session.id !== splitSession.id,
          ),
        ]
      : mountedTerminalSessions;
  const isWorking = (id: string) =>
    agentSessionActivity(statusOf(id)) === "working";
  // An expanded Git panel covers the terminals while leaving them mounted.
  const displayedSessionKey = hidden
    ? ""
    : board === "design"
      ? (designSessionId ?? "")
      : boardSelected || (gitPanelVisible && gitPanelExpanded)
        ? ""
        : [selectedSession?.id, splitSession?.id].filter(Boolean).join("\n");
  const displayedSessionIds = new Set(
    displayedSessionKey.split("\n").filter(Boolean),
  );
  const sessionName = (session: AgentSession) =>
    agentSessionDisplayName(
      session,
      statusOf(session.id)?.conversation?.name || terminalTitles[session.id],
    );
  // Design sessions notify too, without marks: their tabs live in the Design board only.
  const attentionSessions = useMemo(
    () =>
      fullWorkspace.sessions.filter(
        (session) =>
          !closedSessionIds.has(session.id) &&
          !hiddenSessionIds.has(session.id),
      ),
    [closedSessionIds, hiddenSessionIds, fullWorkspace.sessions],
  );
  const attentionSession = (sessionId: string) =>
    attentionSessions.find((session) => session.id === sessionId);
  function showAttentionSession(sessionId: string) {
    const session = attentionSession(sessionId);
    if (!session) return;
    if (session.design) {
      setDesignSessionRequest((request) => ({
        sessionId,
        id: (request?.id ?? 0) + 1,
      }));
      // The shown workspace requests the board itself: selecting here too would run the guards twice.
      if (onShowWorkspace) onShowWorkspace("design");
      else void selectBoard("design");
      return;
    }
    onShowWorkspace?.(null);
    void selectSession(session).then((selected) => {
      if (selected && gitPanelExpanded) onGitPanelExpandedChange?.(false);
    });
  }
  const attention = useAgentAttention({
    desktop,
    sessions: attentionSessions,
    statuses: statusById,
    displayed: displayedSessionIds,
    describe: (sessionId) => {
      const session = attentionSession(sessionId);
      return session
        ? {
            name: sessionName(session),
            projectName:
              workspace.projects.find(
                (project) => project.id === session.projectId,
              )?.name ?? null,
            lastMessage: statusOf(sessionId)?.lastMessage ?? null,
          }
        : undefined;
    },
    strings: {
      awaiting: s.notificationAwaiting,
      finished: s.notificationFinished,
      several: s.notificationSeveral,
      failed: s.notificationFailed,
    },
  });
  const showNextAttentionSession = useRef(() => {});
  showNextAttentionSession.current = () => {
    const sessionId = nextAgentAttentionSession(attention, displayedSessionIds);
    if (sessionId) showAttentionSession(sessionId);
  };
  const showAdjacentSession = useRef<(step: 1 | -1) => boolean>(() => false);
  showAdjacentSession.current = (step) => {
    if (hidden || boardSelected) return false;
    const tabs = selectedProjectSessions;
    const index = tabs.findIndex((tab) => tab.id === selectedSession?.id);
    const next =
      tabs[index < 0 ? 0 : (index + step + tabs.length) % tabs.length];
    // Select without launching: cycling must not start every inactive agent it passes.
    if (next && next.id !== selectedSession?.id && !navigationDisabled)
      void selectSession(next);
    return true;
  };
  const handledSessionRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!sessionRequest || !hasLoaded) return;
    if (handledSessionRequest.current === sessionRequest.id) return;
    handledSessionRequest.current = sessionRequest.id;
    showAttentionSession(sessionRequest.sessionId);
  }, [sessionRequest, hasLoaded]);
  useEffect(() => {
    function handleSessionShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (event.key === "Tab" && event.ctrlKey && !event.metaKey) {
        if (!showAdjacentSession.current(event.shiftKey ? -1 : 1)) return;
      } else if (
        event.shiftKey &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "u"
      ) {
        showNextAttentionSession.current();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }
    document.addEventListener("keydown", handleSessionShortcut, true);
    return () =>
      document.removeEventListener("keydown", handleSessionShortcut, true);
  }, []);
  const paneAttention = (id: string): AgentSessionAttention | null =>
    agentSessionActivity(statusOf(id)) === "awaiting"
      ? "awaiting"
      : attention.unread.includes(id) && !isWorking(id)
        ? "unread"
        : null;
  const tabAttention = (id: string): AgentSessionAttention | null => {
    const marks = [id, terminalSplits[id]].map((sessionId) =>
      sessionId ? paneAttention(sessionId) : null,
    );
    return marks.includes("awaiting")
      ? "awaiting"
      : marks.includes("unread")
        ? "unread"
        : null;
  };
  const sessionStatusLabel = (
    id: string,
    mark: AgentSessionAttention | null,
  ) => {
    if (startingSessionId === id) return s.starting;
    if (isWorking(id)) return s.working;
    if (mark) return s[mark];
    const status = statusOf(id);
    return status?.state === "running"
      ? s.running
      : status?.state === "exited"
        ? s.stopped
        : s.ready;
  };
  const statusLabel = (id: string) => sessionStatusLabel(id, tabAttention(id));
  const paneStatusLabel = (id: string) =>
    sessionStatusLabel(id, paneAttention(id));
  const activePaneId =
    splitSession && selection.sessionId === splitSession.id
      ? splitSession.id
      : selectedSession?.id;
  const activePaneSession =
    activePaneId === splitSession?.id ? splitSession : selectedSession;
  const closeActiveTab = useRef<() => boolean>(() => false);
  closeActiveTab.current = () => {
    if (
      hidden ||
      boardSelected ||
      !activePaneSession ||
      // The secondary pane of a pinned tab is protected too, but only the parent id is pinned.
      (selectedSession && pinnedSessionIds.has(selectedSession.id)) ||
      document.querySelector('[aria-modal="true"]')
    )
      return false;
    // Unmounting a focused input fires no blur, and the issue title saves on blur.
    // shortcut: untested, as it needs the real issue panel under AgentWorkspace; cover it once the panel has a light harness.
    if (gitPanelContainer?.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
    void performAction({ kind: "close", session: activePaneSession });
    return true;
  };
  useEffect(() => {
    if (isMacOS) {
      const unlisten = listenCloseTab(() => closeActiveTab.current()).catch(
        () => undefined,
      );
      return () => void unlisten.then((stop) => stop?.());
    }
    // Capture phase, before the terminal; plain Ctrl+W stays the shell's delete-word.
    function handleCloseShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        event.metaKey ||
        !event.ctrlKey ||
        !event.shiftKey ||
        event.key.toLowerCase() !== "w" ||
        !closeActiveTab.current()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    }
    document.addEventListener("keydown", handleCloseShortcut, true);
    return () =>
      document.removeEventListener("keydown", handleCloseShortcut, true);
  }, []);
  const activeIssueLink = activePaneId
    ? kanbanIssueSessions.find((link) => link.sessionId === activePaneId)
    : undefined;
  // Agent sessions can show their issue, or link one; services and plain terminals cannot.
  const issuePanelSession =
    activePaneSession &&
    (activeIssueLink ||
      (activePaneSession.kind !== "service" &&
        agentProviderOf(activePaneSession.executable) !== null))
      ? activePaneSession
      : undefined;
  const {
    issueShown,
    designShown,
    activeDesignLink,
    issuePanelButtonRef,
    designPanelButtonRef,
    gitPanelButtonRef,
    toggleIssuePanel,
    closeIssuePanel,
    showGitInsteadOfIssue,
    toggleDesignPanel,
    closeDesignPanel,
    showGitInsteadOfDesign,
    focusGitPanelButton,
  } = useToolsPanelMode({
    issuePanelSession,
    activePaneId,
    designBoardSessions: fullWorkspace.designBoardSessions ?? [],
    hidden,
    boardSelected,
    projectToolsAvailable,
    gitPanelContainer,
    gitPanelVisible,
    gitPanelExpanded,
    onGitPanelVisibleChange,
    onGitPanelExpandedChange,
    onIssueOpen: () => setKanbanOpened(true),
  });
  function openDesignBoard(boardSessionId: string) {
    setDesignSessionRequest((request) => ({
      sessionId: boardSessionId,
      id: (request?.id ?? 0) + 1,
    }));
    void selectBoard("design");
  }
  // Runs after the new selection renders, so it closes the issue of the session actually shown.
  // shortcut: leaving and returning to the project while the file read is still pending closes a reopened issue again; remember the applied request id if it bites.
  useEffect(() => {
    if (openFileRequest && openFileRequest.projectId === selectedProject?.id) {
      showGitInsteadOfIssue();
      showGitInsteadOfDesign();
    }
  }, [openFileRequest?.id, selectedProject?.id]);
  function openIssueInKanban(issue: KanbanIssueSelection) {
    void selectBoard("kanban").then((selected) => {
      if (selected) setKanbanIssueRequest({ issue });
    });
  }
  const activatePaneRef = useRef<(id: string) => void>(() => {});
  activatePaneRef.current = (id) => {
    if (
      !selectedSession ||
      id === selection.sessionId ||
      (id !== selectedSession.id && id !== splitSession?.id)
    )
      return;
    lastSessionByProject.current[selectedSession.projectId] = id;
    setSelection({ projectId: selectedSession.projectId, sessionId: id });
  };
  const activatePane = useCallback(
    (id: string) => activatePaneRef.current(id),
    [],
  );
  const unreachableProjectIds = new Set([
    ...(workspace.disconnectedProjectIds ?? []),
    ...(workspace.dormantProjectIds ?? []),
  ]);
  const remoteSessionLabels = new Map<string, string>();
  for (const session of desktop ? workspace.sessions : []) {
    const project = workspace.projects.find(
      (project) => project.id === session.projectId,
    );
    if (
      project?.environment.kind === "ssh" &&
      !unreachableProjectIds.has(project.id) &&
      statusOf(session.id)?.state === "running"
    )
      remoteSessionLabels.set(
        session.id,
        `${project.name} · ${sessionName(session)}`,
      );
  }
  useRemoteSessionLabels(remoteSessionLabels);
  const runningAgentTargets = workspace.sessions
    .filter(
      (session) =>
        session.kind !== "service" &&
        agentProviderOf(session.executable) !== null &&
        statusOf(session.id)?.state === "running",
    )
    .sort(
      (left, right) =>
        Number(right.id === selectedSession?.id) -
        Number(left.id === selectedSession?.id),
    )
    .map((session) => ({
      sessionId: session.id,
      projectId: session.projectId,
      name: sessionName(session),
      executable: session.executable,
    }));
  const commentTargets = runningAgentTargets.filter(
    (target) => target.projectId === selectedProject?.id,
  );
  // Paths are typed into a terminal; a conversation session has none.
  const activeAgentTarget = boardSelected
    ? null
    : (commentTargets.find(
        (target) =>
          target.sessionId === activePaneId &&
          target.executable !== ompConversationExecutable,
      ) ?? null);
  let selectedResumeMessage: string | null = null;
  if (
    selectedStatus?.state !== "running" &&
    selectedSession?.id !== startingSessionId
  ) {
    switch (selectedStatus?.resume) {
      case "linked":
        selectedResumeMessage = s.resumeLinked;
        break;
      case "select":
        selectedResumeMessage = s.resumeSelect;
        break;
      case "approval":
        selectedResumeMessage = s.resumeApproval;
        break;
      case "unsupported":
        selectedResumeMessage = selectedSession?.executable
          ? s.resumeUnsupported
          : null;
        break;
    }
  }
  const sshAddress =
    selectedProject?.environment.kind === "ssh" &&
    selectedProject.environment.ssh?.host
      ? agentEnvironmentLabel(selectedProject.environment)
      : null;
  const { state: sshState, activeCount: sshActiveCount } = sshConnectionState({
    disconnected: selectedProjectLaunchBlocked,
    dormant: selectedProjectDormant,
    sessions: selectedProjectAllSessions,
    statusOf,
    startingSessionId,
    failedSessionId: error ? launchFailed : null,
    statusesUnreadable: !!(loadError || statusError),
  });
  const workspaceErrorMessage = error
    ? error instanceof AgentServiceError
      ? error.failure === "start"
        ? s.serviceStartError(error.serviceLabel)
        : s.serviceStopTimeout(error.serviceLabel)
      : error instanceof LocalizedOperationError
        ? error.message
        : formatOperationError(s, { message: error.message })
    : loadError
      ? s.workspaceLoadError
      : statusError
        ? s.statusReadError
        : null;
  const remoteStopDeletion =
    error && failedDeletion && isSshRemoteStopFailure(error.message)
      ? failedDeletion
      : null;
  useNotification(
    !hidden && workspaceErrorMessage
      ? {
          key: "agent-workspace:error",
          message: workspaceErrorMessage,
          action:
            failedMerge && failedMerge.error === error && !busy
              ? {
                  label: s.resolveConflictsWithAgent,
                  onAction: () =>
                    void resolveMergeConflict(failedMerge.conflict),
                }
              : {
                  label: remoteStopDeletion ? s.disconnectAndDelete : s.retry,
                  onAction: () => {
                    if (disabled) return;
                    if (remoteStopDeletion)
                      void deleteWithoutServer(remoteStopDeletion);
                    else if (error && failedConnectProjectId)
                      void connectProject(failedConnectProjectId);
                    else if (error && failedLaunchSession)
                      void launch(
                        failedLaunchSession,
                        failedLaunchSession.id !== splitSessionId,
                      );
                    else void retry();
                  },
                },
        }
      : null,
  );
  useNotification(
    !hidden && branchError
      ? { key: "agent-workspace:branches", message: s.branchReadError }
      : null,
  );
  useNotification(
    !hidden && worktreeError
      ? { key: "agent-workspace:worktrees", message: s.worktreeReadError }
      : null,
  );
  useNotification(
    !hidden && services.key && services.error
      ? {
          key: `project-services:${services.key}`,
          message: s.servicesManifestError,
          action: {
            label: s.retry,
            onAction: () => {
              if (!disabled) services.retry();
            },
          },
        }
      : null,
  );
  useNotification(
    !hidden && selectedSession && selectedStatus?.conversationError
      ? {
          key: `agent-conversation:${selectedSession.id}`,
          message: s.conversationLinkError,
        }
      : null,
  );
  useNotification(
    !hidden && activePaneSession && statusOf(activePaneSession.id)?.outdatedCli
      ? {
          key: `agent-outdated-cli:${activePaneSession.id}`,
          message: s.outdatedCli,
        }
      : null,
  );

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || loadError) return;
    setProjectOrder((previous) => {
      const next = orderAgentItems(workspace.projects, previous).map(
        (project) => project.id,
      );
      return JSON.stringify(next) === JSON.stringify(previous)
        ? previous
        : next;
    });
  }, [desktop, workspace.projects, hasLoaded, loading, loadError]);

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || loadError) return;
    setTabOrder((previous) => {
      const next = Object.fromEntries(
        workspace.projects
          .filter((project) =>
            Object.prototype.hasOwnProperty.call(previous, project.id),
          )
          .map((project) => [
            project.id,
            orderAgentItems(
              workspace.sessions.filter(
                (session) =>
                  session.projectId === project.id &&
                  session.kind !== "service",
              ),
              previous[project.id],
            ).map((session) => session.id),
          ]),
      );
      return JSON.stringify(next) === JSON.stringify(previous)
        ? previous
        : next;
    });
  }, [
    desktop,
    workspace.projects,
    workspace.sessions,
    hasLoaded,
    loading,
    loadError,
  ]);

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || loadError) return;
    pruneRecentProjectFiles(workspace.projects.map(({ id }) => id));
  }, [desktop, workspace.projects, hasLoaded, loading, loadError]);

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || loadError) return;
    setPinnedSessionIds((previous) => {
      const sessionIds = new Set(workspace.sessions.map(({ id }) => id));
      const next = new Set([...previous].filter((id) => sessionIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [desktop, workspace.sessions, hasLoaded, loading, loadError]);

  usePersistedValue(projectOrderKey, projectOrder);

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || busy || loadError) return;
    setProjectSectionOrder((current) => {
      const next = reconcileProjectSectionOrder(
        current,
        derivedProjectSectionIds,
      );
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [
    desktop,
    hasLoaded,
    loading,
    busy,
    loadError,
    derivedProjectSectionOrderKey,
  ]);

  usePersistedValue(projectSectionOrderKey, projectSectionOrder);

  useProjectGroupMigration({
    desktop,
    hasLoaded,
    loading,
    busy,
    loadError,
    worktreesLoaded,
    worktreesComplete,
    worktrees,
    workspace,
    railProjects,
    projectGroups,
    groupByProjectId,
    execute,
    setCollapsed,
  });

  usePersistedValue(tabOrderKey, tabOrder);

  usePersistedValue(pinnedTabsKey, pinnedSessionIds, (value) => [...value]);

  usePersistedValue(terminalSplitsKey, terminalSplits);

  useEffect(() => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      for (const group of worktrees) {
        if (group.projectIds.some((id) => previous.has(id)))
          group.projectIds.forEach((id) => next.add(id));
      }
      return next.size === previous.size ? previous : next;
    });
  }, [worktrees]);

  usePersistedValue(collapsedProjectsKey, collapsed, (value) => [...value]);

  function preserveDisplayedProjectSelection() {
    if (!selectedProject || selection.projectId === selectedProject.id) return;
    setSelection({
      projectId: selectedProject.id,
      sessionId: selectedSession?.id ?? null,
    });
  }

  function reorderSession(id: string, index: number) {
    if (disabled || hidden || form || confirmation) return;
    const next = pinnedAgentItemsFirst(
      moveAgentItem(selectedProjectSessions, id, index),
      pinnedSessionIds,
    );
    if (
      !selectedProject ||
      next.every((session, i) => session === selectedProjectSessions[i])
    )
      return;
    setTabOrder((previous) => ({
      ...previous,
      [selectedProject.id]: next.map((session) => session.id),
    }));
  }

  function toggleSessionPin(session: AgentSession) {
    if (disabled || hidden || form || confirmation || !selectedProject) return;
    const next = new Set(pinnedSessionIds);
    if (!next.delete(session.id)) next.add(session.id);
    setPinnedSessionIds(next);
    setTabOrder((previous) => ({
      ...previous,
      [selectedProject.id]: pinnedAgentItemsFirst(
        orderAgentItems(
          workspace.sessions.filter(
            (item) =>
              item.projectId === selectedProject.id && item.kind !== "service",
          ),
          previous[selectedProject.id] ?? [],
        ),
        next,
      ).map(({ id }) => id),
    }));
  }

  function toggleSessionFavorite(session: AgentSession) {
    if (disabled || hidden || form || confirmation) return;
    setSavingFavorite(true);
    void saveSession({ ...session, favorite: !session.favorite })
      .then((saved) => {
        if (!saved || !session.favorite) return;
        // A closed session no favorite or issue keeps anymore returns to the tabs.
        setHiddenSessionIds((current) => {
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      })
      .finally(() => setSavingFavorite(false));
  }

  function canSplitSession(id: string, side: "left" | "right") {
    const session = selectedProjectSessions.find((item) => item.id === id);
    return Boolean(
      session &&
      selectedSession &&
      !pinnedSessionIds.has(
        side === "left" ? selectedSession.id : session.id,
      ) &&
      session.id !== selectedSession.id &&
      session.projectId === selectedSession.projectId &&
      !terminalSplits[session.id] &&
      !terminalSplits[selectedSession.id] &&
      !disabled &&
      !hidden &&
      !form &&
      !confirmation,
    );
  }

  function moveSessionIntoSplit(id: string, side: "left" | "right") {
    if (!canSplitSession(id, side) || !selectedSession) return;
    const currentId = selectedSession.id;
    const source = selectedProjectSessions.find((session) => session.id === id);
    if (!source) return;
    const parentId = side === "left" ? source.id : currentId;
    const childId = side === "left" ? currentId : source.id;
    setTerminalSplits((current) => ({
      ...Object.fromEntries(
        Object.entries(current).filter(
          ([existingParentId, existingChildId]) =>
            ![source.id, currentId].includes(existingParentId) &&
            ![source.id, currentId].includes(existingChildId),
        ),
      ),
      [parentId]: childId,
    }));
    lastSessionByProject.current[source.projectId] = source.id;
    setSelection({ projectId: source.projectId, sessionId: source.id });
  }

  useEffect(() => {
    if (tabReorder.isReordering) return;
    const target = selection.sessionId
      ? sessionTabRefs.current.get(selection.sessionId)
      : addSessionRef.current;
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [
    selection.sessionId,
    selectedProject?.id,
    selectedProjectSessions.length,
  ]);

  useEffect(() => {
    if (
      !navigationFocusRequest ||
      consumedNavigationFocusRequest.current === navigationFocusRequest
    )
      return;
    const frame = requestAnimationFrame(() => {
      consumedNavigationFocusRequest.current = navigationFocusRequest;
      const target = selection.sessionId
        ? sessionTabRefs.current.get(selection.sessionId)
        : addSessionRef.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationFocusRequest, selection.sessionId]);

  useEffect(() => {
    setHiddenSessionIds((previous) => {
      const next = new Set(
        [...previous].filter((id) =>
          workspace.sessions.some((session) => session.id === id),
        ),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [workspace.sessions]);

  useEffect(() => {
    if (!desktop || !hasLoaded || loading || loadError) return;
    const sessions = new Map(
      workspace.sessions.map((session) => [session.id, session]),
    );
    const isValidSplit = ([parentId, childId]: [string, string]) => {
      const parent = sessions.get(parentId);
      const child = sessions.get(childId);
      return (
        !!parent &&
        !!child &&
        parent.kind !== "service" &&
        child.kind !== "service" &&
        parent.projectId === child.projectId
      );
    };
    setTerminalSplits((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(isValidSplit),
      );
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    // A selected child whose pair is dropped falls back to its surviving parent tab.
    const orphanedParent = Object.entries(terminalSplits).find(
      (pair) => pair[1] === selection.sessionId && !isValidSplit(pair),
    )?.[0];
    const parent = orphanedParent ? sessions.get(orphanedParent) : undefined;
    if (!parent) return;
    lastSessionByProject.current[parent.projectId] = parent.id;
    setSelection((current) =>
      current.sessionId === selection.sessionId
        ? { ...current, sessionId: parent.id }
        : current,
    );
  }, [
    desktop,
    hasLoaded,
    loading,
    loadError,
    workspace.sessions,
    terminalSplits,
    selection.sessionId,
  ]);

  useEffect(() => {
    setMountedSessions((previous) => {
      const runningIds = new Set(
        workspace.statuses
          .filter((status) => status.state === "running")
          .map((status) => status.sessionId),
      );
      const next = new Set(
        workspace.sessions
          .filter(
            (session) =>
              session.kind !== "service" &&
              !closedSessionIds.has(session.id) &&
              (previous.has(session.id) ||
                session.id === selectedSession?.id ||
                session.id === splitSessionId ||
                runningIds.has(session.id)),
          )
          .map((session) => session.id),
      );
      return next.size === previous.size &&
        [...next].every((id) => previous.has(id))
        ? previous
        : next;
    });
  }, [
    workspace.sessions,
    closedSessionIds,
    workspace.statuses,
    selectedSession?.id,
    splitSessionId,
  ]);

  useEffect(() => {
    writeStoredJson(selectionKey, selection);
  }, [selection]);

  useEffect(() => {
    writeKanbanSelected(kanbanSelected);
    onBoardChange?.(board);
  }, [board, kanbanSelected, onBoardChange]);

  useEffect(() => {
    onProjectToolsAvailableChange?.(projectToolsAvailable);
  }, [projectToolsAvailable, onProjectToolsAvailableChange]);

  // Only a new request object navigates; re-renders must not replay it.
  useEffect(() => {
    if (!boardRequest) return;
    if (boardRequest.board)
      void selectBoard(boardRequest.board).then((selected) => {
        const { issue } = boardRequest;
        if (selected && issue) setKanbanIssueRequest({ issue });
      });
    else if (!closing.current) setBoard(null);
  }, [boardRequest]);

  const { resolveMergeConflict, startForgeLogin, forgeLoginRevision } =
    useRecoveryAgentLaunch({
      closing,
      current,
      busy,
      loading,
      isBusy,
      execute,
      start,
      selectSession,
      statusById,
      setFailedMerge,
      gitPanelExpanded,
      onGitPanelExpandedChange,
    });

  useEffect(() => {
    writeStoredJson(terminalTitlesKey, terminalTitles);
  }, [terminalTitles]);

  useEffect(() => {
    if (!registerTransitionGuard || !desktop) return;
    const unregister = registerTransitionGuard({
      hasPendingWork: () =>
        sshForwardBusyRef.current || isBusy() || hasPendingProjectAppearance(),
      cancel: () => finishClose(false),
      prepare: async () => {
        await waitForProjectAppearance();
        if (sshForwardBusyRef.current || isBusy() || current.current.loading)
          return false;
        finishClose(true);
        return true;
      },
    });
    return () => {
      unregister();
      closing.current = false;
    };
  }, [
    desktop,
    hasPendingProjectAppearance,
    isBusy,
    registerTransitionGuard,
    waitForProjectAppearance,
  ]);

  function finishClose(value: boolean) {
    closing.current = value;
    setCloseChecking(value);
  }
  async function prepareProjectNavigation(
    nextProjectId: string | null,
    force = false,
  ) {
    if (!force && nextProjectId === selectedProject?.id) return true;
    for (const guard of projectNavigationGuards.current) {
      if (!(await guard.prepare())) return false;
    }
    return true;
  }
  async function selectSession(
    session: AgentSession,
    launchInactive = false,
    navigationPrepared = false,
  ) {
    if (
      sshTransitionRef.current ||
      (launchInactive && (closing.current || isBusy()))
    )
      return false;
    if (
      !navigationPrepared &&
      !(await prepareProjectNavigation(session.projectId))
    )
      return false;
    if (sshTransitionRef.current || (isBusy() && closingSessionId === null))
      return false;
    const projectIds = groupByProjectId.get(session.projectId)?.projectIds ?? [
      session.projectId,
    ];
    setCollapsed((previous) => {
      if (!projectIds.some((id) => previous.has(id))) return previous;
      const next = new Set(previous);
      projectIds.forEach((id) => next.delete(id));
      return next;
    });
    lastSessionByProject.current[session.projectId] = session.id;
    setBoard(null);
    setSelection({ projectId: session.projectId, sessionId: session.id });
    setFocusRequest((value) => value + 1);
    const tabSession =
      workspace.sessions.find(
        (item) => item.id === splitParentByChild.get(session.id),
      ) ?? session;
    const splitChildId = terminalSplits[tabSession.id];
    if (
      launchInactive &&
      !sessionLaunchBlocked(workspace, session.projectId) &&
      (statusOf(tabSession.id)?.state !== "running" ||
        (!!splitChildId && statusOf(splitChildId)?.state !== "running"))
    )
      void launch(tabSession);
    return true;
  }
  async function selectProject(project: AgentProject) {
    if (
      closing.current ||
      sshTransitionRef.current ||
      (isBusy() && closingSessionId === null)
    )
      return false;
    if (!(await prepareProjectNavigation(project.id))) return false;
    if (sshTransitionRef.current || (isBusy() && closingSessionId === null))
      return false;
    const sessions = visibleSessions.filter(
      (session) => session.projectId === project.id,
    );
    const lastId =
      selectedSession?.projectId === project.id
        ? selection.sessionId
        : lastSessionByProject.current[project.id];
    const lastTab = lastId
      ? sessions.find(
          (session) =>
            session.id === (splitParentByChild.get(lastId) ?? lastId),
        )
      : undefined;
    const session =
      (lastTab && lastTab.id !== lastId
        ? workspace.sessions.find((item) => item.id === lastId)
        : lastTab) ??
      sessions.find((session) => statusOf(session.id)?.state === "running") ??
      sessions[0];
    if (session) await selectSession(session, false, true);
    else showProject(project.id);
    return true;
  }
  function showProject(projectId: string) {
    setBoard(null);
    setSelection({ projectId, sessionId: null });
  }
  async function openFoundFile(request: Omit<ProjectFileOpenRequest, "id">) {
    const member =
      request.projectId !== selectedProject?.id &&
      orderedProjects.find((project) => project.id === request.projectId);
    if (member && !(await selectProject(member))) return;
    onGitPanelVisibleChange?.(true);
    setOpenFileRequest({ id: ++openFileRequestId.current, ...request });
  }
  async function selectBoard(next: AgentBoard) {
    if (closing.current) return false;
    if (board === next) return true;
    if (!(await prepareProjectNavigation(null))) return false;
    setBoard(next);
    if (next === "kanban") setKanbanOpened(true);
    else if (next === "automations") setAutomationsOpened(true);
    else setDesignOpened(true);
    return true;
  }
  function closeTerminalSplit(parentId: string) {
    const childId = terminalSplits[parentId];
    setTerminalSplits((current) => {
      const next = { ...current };
      delete next[parentId];
      return next;
    });
    if (selection.projectId && selection.sessionId === childId) {
      lastSessionByProject.current[selection.projectId] = parentId;
      setSelection({ projectId: selection.projectId, sessionId: parentId });
    }
    if (parentId === selectedSession?.id) setFocusRequest((value) => value + 1);
  }
  function openForm(next: Form) {
    setError(null);
    setForm(next);
  }
  function ask(next: Confirmation) {
    setError(null);
    setConfirmation(next);
  }
  function bumpRevision(id: string) {
    setRevisions((values) => ({ ...values, [id]: (values[id] ?? 0) + 1 }));
  }
  function reserveSshTransition(projectId: string, connected: boolean) {
    if (closing.current || isBusy() || sshTransitionRef.current) return null;
    const transition = { projectId, connected };
    sshTransitionRef.current = transition;
    setSshTransition(transition);
    return transition;
  }
  function releaseSshTransition(transition: SshTransition) {
    if (sshTransitionRef.current !== transition) return;
    sshTransitionRef.current = null;
    setSshTransition((current) => (current === transition ? null : current));
  }
  async function connectProject(projectId: string) {
    const transition = reserveSshTransition(projectId, true);
    if (!transition) return;
    try {
      if (!(await execute(() => api.setAgentProjectConnected(projectId, true))))
        setFailedConnectProjectId(projectId);
    } finally {
      releaseSshTransition(transition);
    }
  }
  async function saveProject(
    project: AgentProject,
    linearProjectId: string | null,
  ) {
    if (closing.current) return;
    const existingProject =
      form?.kind === "project" && !form.project
        ? current.current.workspace.projects.find(
            (item) =>
              agentProjectTargetKey(item.environment, item.path) ===
              agentProjectTargetKey(project.environment, project.path),
          )
        : undefined;
    // The form reuses its generated id, so a match on that id is this form's own earlier save.
    if (existingProject && existingProject.id !== project.id) {
      if (await selectProject(existingProject)) setForm(null);
      return;
    }
    const changesCurrentTarget =
      form?.kind === "project" &&
      form.project !== undefined &&
      form.project.id === selectedProject?.id &&
      (form.project.path !== project.path ||
        agentEnvironmentKey(form.project.environment) !==
          agentEnvironmentKey(project.environment));
    if (
      changesCurrentTarget &&
      !(await prepareProjectNavigation(project.id, true))
    )
      return;
    // The form no longer edits appearance, so keep the latest saved one once queued picks have landed.
    const saveWithLatestAppearance = async () => {
      const latest = (await waitForProjectAppearance()).projects.find(
        (item) => item.id === project.id,
      );
      await api.saveAgentProject(
        latest
          ? {
              ...project,
              icon: latest.icon,
              color: latest.color,
              iconDataUrl: latest.iconDataUrl,
            }
          : project,
      );
    };
    const currentLinearProjectId =
      current.current.workspace.linearProjectLinks?.find(
        (link) => link.projectId === project.id,
      )?.linearProjectId ?? null;
    if (
      await execute(async () => {
        await saveWithLatestAppearance();
        if (linearProjectId !== currentLinearProjectId)
          await api.setAgentProjectLinearLink(project.id, linearProjectId);
      })
    ) {
      if (
        form?.kind === "project" &&
        !form.project &&
        (await prepareProjectNavigation(project.id))
      )
        showProject(project.id);
      setForm(null);
    }
  }
  async function saveProjects(
    projects: AgentProject[],
    groupName: string | null,
    groupId: string,
  ) {
    if (closing.current || projects.length === 0) return;
    const savedProjects = current.current.workspace.projects;
    const selectedProjects = projects
      .map(
        (project) =>
          savedProjects.find(
            (item) =>
              agentProjectTargetKey(item.environment, item.path) ===
              agentProjectTargetKey(project.environment, project.path),
          ) ?? project,
      )
      .filter(
        (project, index, items) =>
          items.findIndex((item) => item.id === project.id) === index,
      );
    const existingIds = new Set(savedProjects.map((project) => project.id));
    if (
      await execute(async () => {
        for (const project of selectedProjects)
          if (!existingIds.has(project.id)) await api.saveAgentProject(project);
        if (groupName)
          await api.saveAgentProjectGroup({
            id: groupId,
            name: groupName,
            projectIds: selectedProjects.map((project) => project.id),
          });
      })
    ) {
      const firstProject = selectedProjects[0];
      if (await prepareProjectNavigation(firstProject.id))
        showProject(firstProject.id);
      setForm(null);
    }
  }
  function restoreProjectRailFocus({
    groupId,
    projectId,
  }: {
    groupId?: string;
    projectId?: string;
  }) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const groupTarget = groupId
          ? [
              ...document.querySelectorAll<HTMLButtonElement>(
                ".agent-project-group-toggle",
              ),
            ].find((item) => item.dataset.groupId === groupId)
          : null;
        const projectTarget = projectId
          ? [...document.querySelectorAll<HTMLElement>(".agent-project")]
              .find((item) => item.dataset.projectId === projectId)
              ?.querySelector<HTMLButtonElement>(".agent-project-select")
          : null;
        (groupTarget ?? projectTarget ?? addProjectRef.current)?.focus();
      }),
    );
  }
  async function saveProjectGroup(group: AgentProjectGroup) {
    const { id, name, projectIds } = group;
    if (
      await execute(() => api.saveAgentProjectGroup({ id, name, projectIds }))
    ) {
      setForm(null);
      restoreProjectRailFocus({ groupId: group.id });
    }
  }
  // Deleting projects drops their membership: their worktrees keep the group.
  // The returned restore never rejects; call it when the deletion fails.
  async function handOverGroupMembership(projectIds: string[]) {
    const removed = new Set(projectIds);
    const grouped = new Set(projectGroups.flatMap((item) => item.projectIds));
    const saved: AgentProjectGroup[] = [];
    const restore = async () => {
      for (const group of saved) {
        try {
          await api.saveAgentProjectGroup({
            id: group.id,
            name: group.name,
            projectIds: group.projectIds,
          });
        } catch {
          /* The deletion error matters more; the next reload shows the state. */
        }
      }
    };
    for (const group of projectGroups) {
      if (!group.projectIds.some((id) => removed.has(id))) continue;
      const next: string[] = [];
      for (const id of group.projectIds) {
        const candidates = removed.has(id)
          ? (groupByProjectId.get(id)?.projectIds ?? []).filter(
              (candidate) => !grouped.has(candidate),
            )
          : [id];
        for (const candidate of candidates) {
          if (removed.has(candidate) || next.includes(candidate)) continue;
          next.push(candidate);
          grouped.add(candidate);
        }
      }
      // Without successors, the backend cascade already drops the members.
      if (next.every((id) => group.projectIds.includes(id))) continue;
      try {
        await api.saveAgentProjectGroup({
          id: group.id,
          name: group.name,
          projectIds: next,
        });
      } catch (reason) {
        await restore();
        throw reason;
      }
      saved.push(group);
    }
    return restore;
  }
  async function updateProjectGroup(projectId: string, groupId: string | null) {
    const group = projectGroups.find((item) =>
      groupId === null
        ? item.projectIds.includes(projectId)
        : item.id === groupId,
    );
    if (!group) return false;
    const projectIds = group.projectIds.filter((id) => id !== projectId);
    if (groupId !== null) projectIds.push(projectId);
    return execute(async () => {
      const project = workspace.projects.find((item) => item.id === projectId);
      const anchor = workspace.projects.find(
        (item) =>
          item.id === group.groupProjectId ||
          (item.id !== projectId && group.projectIds.includes(item.id)),
      );
      if (
        groupId !== null &&
        project &&
        anchor &&
        !sameAgentMachine(project.environment, anchor.environment)
      ) {
        const [projectMachine, groupMachine] = [project, anchor].map(
          ({ environment }) =>
            environment.kind === "wsl" && environment.distribution
              ? `WSL · ${environment.distribution}`
              : agentEnvironmentLabel(environment, s.local),
        );
        throw new LocalizedOperationError(
          s.moveToGroupOtherMachine(
            project.name,
            projectMachine,
            group.name,
            groupMachine,
          ),
        );
      }
      await api.saveAgentProjectGroup({
        id: group.id,
        name: group.name,
        projectIds,
      });
    });
  }
  async function moveProjectToGroup(projectId: string, groupId: string | null) {
    await updateProjectGroup(projectId, groupId);
    restoreProjectRailFocus(groupId ? { groupId } : { projectId });
  }
  async function prepareGroupProject(group: AgentProjectGroup) {
    const existing = workspace.projects.find(
      (project) => project.id === group.groupProjectId,
    );
    if (existing) return existing;
    const result: { prepared: AgentProject | null } = { prepared: null };
    const prepared = await execute(async () => {
      result.prepared = await api.prepareAgentGroupProject(group.id);
    });
    return prepared ? result.prepared : null;
  }
  async function openGroupOverview(group: AgentProjectGroup) {
    const project = await prepareGroupProject(group);
    if (project) await selectProject(project);
  }
  async function createGroupSession(
    group: AgentProjectGroup,
    preset: (typeof agentPresets)[number],
  ) {
    const project = await prepareGroupProject(group);
    if (project) await createSession(project, preset);
  }
  function reorderProjects(projectIds: string[]) {
    preserveDisplayedProjectSelection();
    setProjectOrder(projectIds);
  }
  async function cloneProject(request: GitCloneRequest) {
    if (closing.current || isBusy()) return;
    setCloneRecovery(null);
    const result: { cloned: AgentProject | null; failure: unknown } = {
      cloned: null,
      failure: null,
    };
    const succeeded = await execute(async () => {
      try {
        result.cloned = await gitApi.cloneGitRepository(request);
      } catch (reason) {
        result.failure = reason;
        throw new Error(gitErrorMessage(reason));
      }
    });
    if (result.cloned) {
      if (succeeded && (await prepareProjectNavigation(result.cloned.id)))
        showProject(result.cloned.id);
      setForm(null);
      onGitPanelVisibleChange?.(true);
    } else if (
      result.failure &&
      typeof result.failure === "object" &&
      "path" in result.failure &&
      typeof result.failure.path === "string"
    ) {
      setCloneRecovery({ request, path: result.failure.path });
    }
  }
  async function openWorktree(
    project: AgentProject,
    worktree: Omit<AgentProjectWorktree, "projectIds">,
    repositoryProjectId = selectedProject
      ? (groupByProjectId.get(selectedProject.id)?.repositoryProjectId ??
        selectedProject.id)
      : null,
  ) {
    if (!(await prepareProjectNavigation(project.id))) return;
    if (repositoryProjectId)
      rememberWorktreeProject(repositoryProjectId, project.id, worktree);
    if (!(await retry())) return;
    showProject(project.id);
    refreshBranches();
  }
  async function openExternalWorktree(
    repositoryProjectId: string,
    worktree: AgentProjectWorktree,
    transferNavigationFocus = false,
  ) {
    if (closing.current || isBusy()) return;
    const latestWorkspace = current.current.workspace;
    const repositoryProject = latestWorkspace.projects.find(
      (project) => project.id === repositoryProjectId,
    );
    if (!repositoryProject) return;
    const group = worktrees.find(
      (value) =>
        value.repositoryProjectId === repositoryProjectId ||
        value.projectIds.includes(repositoryProjectId),
    );
    const existing = findWorktreeProject(
      latestWorkspace.projects,
      group,
      worktree.path,
      agentEnvironmentKey(repositoryProject.environment),
    );
    if (existing) {
      await selectProject(existing);
      onGitPanelVisibleChange?.(true);
      return;
    }
    const project: AgentProject = {
      ...repositoryProject,
      id: crypto.randomUUID(),
      name: worktreeName(worktree),
      path: worktree.path,
    };
    rememberWorktreeProject(
      group?.repositoryProjectId ?? repositoryProjectId,
      project.id,
      {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
      },
    );
    if (await execute(() => api.saveAgentProject(project))) {
      if (!(await prepareProjectNavigation(project.id))) return;
      showProject(project.id);
      if (transferNavigationFocus)
        setNavigationFocusRequest((value) => value + 1);
      refreshBranches();
      onGitPanelVisibleChange?.(true);
    }
  }
  async function openPreservedClone(recovery: GitCloneRecovery) {
    if (closing.current || isBusy()) return;
    const project: AgentProject = {
      id: recovery.request.id,
      name: recovery.request.name,
      environment: recovery.request.environment,
      path: recovery.path,
    };
    if (await execute(() => api.saveAgentProject(project))) {
      if (await prepareProjectNavigation(project.id)) showProject(project.id);
      setForm(null);
      setCloneRecovery(null);
      onGitPanelVisibleChange?.(true);
    }
  }
  async function saveSession(
    session: AgentSession,
    splitParentId?: string,
  ): Promise<boolean> {
    if (closing.current) return false;
    const isNew = !workspace.sessions.some((item) => item.id === session.id);
    const saved = await execute(() => api.saveAgentSession(session));
    if (saved) {
      setForm(null);
      if (isNew && splitParentId) {
        setTerminalSplits((current) => ({
          ...current,
          [splitParentId]: session.id,
        }));
        setSelection((current) => {
          if (current.sessionId !== splitParentId) return current;
          lastSessionByProject.current[session.projectId] = session.id;
          return { ...current, sessionId: session.id };
        });
        void launch(session, false);
      } else if (isNew) selectSession(session, true);
    }
    return saved;
  }
  async function renameSession(sessionId: string, customName: string | null) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session || (session.customName ?? null) === customName) {
      setForm(null);
      return;
    }
    await saveSession({ ...session, customName });
  }
  async function createSession(
    project: AgentProject,
    preset: (typeof agentPresets)[number],
    splitParentId?: string,
  ) {
    if (sessionLaunchBlocked(workspace, project.id)) return;
    const name = uniqueAgentSessionName(
      workspace.sessions,
      project.id,
      preset.name,
    );
    await saveSession(
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        name,
        executable: preset.executable,
        args: defaultAgentArgs(settings.agentPresetArgs, preset.executable),
        ...(preset.executable === ompConversationExecutable && {
          kind: "conversation" as const,
        }),
        createdAt: new Date().toISOString(),
      },
      splitParentId,
    );
  }
  // shortcut: a saved session whose workspace reload fails returns null, leaving an extra favorite session
  // with no automation; return its id once saved if reload failures show up.
  // A favorite: closing its tab keeps the session the automation runs in.
  async function createAutomationSession(
    projectId: string,
    executable: string,
    name: string,
  ) {
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId,
      name,
      customName: name,
      executable,
      args: defaultAgentArgs(settings.agentPresetArgs, executable),
      createdAt: new Date().toISOString(),
      favorite: true,
    };
    return (await execute(() => api.saveAgentSession(session)))
      ? session.id
      : null;
  }
  async function reopenSession(sessionId: string, launchOpen = false) {
    const target = workspace.sessions.find(
      (session) => session.id === sessionId,
    );
    if (!target) return false;
    if (!closedSessionIds.has(sessionId) && !hiddenSessionIds.has(sessionId))
      return selectSession(target, launchOpen);
    if (
      closing.current ||
      !(await execute(() => {
        if (sessionLaunchBlocked(current.current.workspace, target.projectId))
          throw new LocalizedOperationError(s.issueAgentProjectDisconnected);
        return api.setAgentSessionClosed(sessionId, false);
      }))
    )
      return false;
    setHiddenSessionIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    // Relaunching resumes the conversation linked to the session.
    return selectSession(target, true);
  }
  // The server runs automations in a detached session: opening must attach to it.
  // shortcut: success is the selection, not the attach, so a failed SSH attach still marks the run
  // seen; await the launch here if runs opened while the server is unreachable must stay unread.
  async function openAutomationSession(sessionId: string) {
    const projectId = workspace.sessions.find(
      (session) => session.id === sessionId,
    )?.projectId;
    return (
      (await reopenSession(sessionId, true)) &&
      !!projectId &&
      !sessionLaunchBlocked(current.current.workspace, projectId)
    );
  }
  // The session outlives its deleted issue: it returns to the rail like any session.
  function handleIssueDeleted(issueId: string) {
    const sessionId = kanbanIssueSessions.find(
      (link) => link.issueId === issueId,
    )?.sessionId;
    setDeletedIssueIds((current) => new Set(current).add(issueId));
    if (sessionId)
      setHiddenSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    void retry();
  }
  const selectedWorktreeProjectIds = (path: string) =>
    (selectedProject
      ? groupByProjectId.get(selectedProject.id)
      : undefined
    )?.worktrees.find((worktree) => worktree.path === path)?.projectIds ?? [];
  function prepareSessionRemoval(session: AgentSession) {
    const detachedSessionId = terminalSplits[session.id];
    const detachedSession = detachedSessionId
      ? workspace.sessions.find((item) => item.id === detachedSessionId)
      : undefined;
    const splitParentId = splitParentByChild.get(session.id);
    const remaining = [
      ...(detachedSession ? [detachedSession] : []),
      ...visibleSessions.filter((item) => item.id === splitParentId),
      ...visibleSessions.filter(
        (item) =>
          item.projectId === session.projectId && item.id !== session.id,
      ),
    ];
    setTerminalSplits((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([parentId, childId]) =>
            parentId !== session.id && childId !== session.id,
        ),
      ),
    );
    if (selection.sessionId !== session.id) {
      returnFocusRef.current = selectedSession
        ? (sessionTabRefs.current.get(selectedSession.id) ??
          addSessionRef.current)
        : addSessionRef.current;
      return;
    }
    const next = remaining[0];
    if (next) {
      lastSessionByProject.current[session.projectId] = next.id;
      setSelection({ projectId: session.projectId, sessionId: next.id });
      returnFocusRef.current =
        sessionTabRefs.current.get(next.id) ?? addSessionRef.current;
    } else {
      delete lastSessionByProject.current[session.projectId];
      setSelection({ projectId: session.projectId, sessionId: null });
      returnFocusRef.current = addSessionRef.current;
    }
  }
  /** Resolves to whether the disconnection was attempted, even if it failed. */
  async function disconnectProject(project: AgentProject) {
    const transition = reserveSshTransition(project.id, false);
    if (!transition) return false;
    try {
      // The backend disconnects every project sharing this SSH connection.
      const affectsSelected =
        !!selectedProject &&
        (selectedProject.id === project.id ||
          (selectedProject.environment.kind === "ssh" &&
            project.environment.kind === "ssh" &&
            JSON.stringify(selectedProject.environment.ssh) ===
              JSON.stringify(project.environment.ssh)));
      if (affectsSelected && !(await prepareProjectNavigation(null, true)))
        return false;
      if (await execute(() => api.setAgentProjectConnected(project.id, false)))
        setConfirmation((current) =>
          current?.kind === "disconnect" ? null : current,
        );
      return true;
    } finally {
      releaseSshTransition(transition);
    }
  }
  async function deleteWithoutServer(deletion: Deletion) {
    const projectId =
      deletion.kind === "project"
        ? deletion.project.id
        : deletion.kind === "group"
          ? groupDeletionProjectIds(deletion)[0]
          : deletion.session.projectId;
    // shortcut: only the first project's exact SSH connection is disconnected; group members on the same host with another identity file stay connected and the retry fails again, disconnect each distinct connection if users mix keys in one group.
    const project = workspace.projects.find((item) => item.id === projectId);
    // A partially failed disconnection still marks the project offline; the deletion re-checks it.
    if (project && (await disconnectProject(project)))
      await performAction(deletion);
  }
  // The dialog holds a group snapshot; worktree reconciliation can change its members meanwhile.
  const currentGroup = (group: AgentProjectGroup) =>
    projectGroups.find((item) => item.id === group.id) ?? group;
  async function performAction(requested: Confirmation | Deletion) {
    if (requested.kind === "disconnect") {
      await disconnectProject(requested.project);
      return;
    }
    const action =
      requested.kind === "group"
        ? { ...requested, group: currentGroup(requested.group) }
        : requested;
    if (closing.current || isBusy()) return;
    if (
      (action.kind === "close" || action.kind === "session") &&
      pinnedSessionIds.has(action.session.id)
    )
      return;
    const leavesCurrentProject =
      (action.kind === "project" &&
        action.project.id === selectedProject?.id) ||
      (action.kind === "group" &&
        !!selectedProject &&
        groupDeletionProjectIds(action).includes(selectedProject.id)) ||
      (action.kind === "worktree" &&
        action.projects.some((project) => project.id === selectedProject?.id));
    if (leavesCurrentProject && !(await prepareProjectNavigation(null, true)))
      return;
    // shortcut: with the Git panel expanded the tabs are inert, so a rail close drops focus to body; restore it in the rail if keyboard users hit it.
    const transferNavigationFocus =
      action.kind === "session" ||
      (action.kind === "close" &&
        (selection.sessionId === action.session.id ||
          document.activeElement?.closest<HTMLElement>(".agent-activity-item")
            ?.dataset.sessionId === action.session.id ||
          sessionTabRefs.current
            .get(action.session.id)
            ?.closest(".agent-session-tab-item")
            ?.contains(document.activeElement) === true));
    const closingSplitSessionId =
      action.kind === "close" ? terminalSplits[action.session.id] : undefined;
    const closingSplitParentId =
      action.kind === "close"
        ? splitParentByChild.get(action.session.id)
        : undefined;
    let closeSucceeded = false;
    let worktreeMutationSucceeded = false;
    if (action.kind === "close") {
      setLaunchFailed(null);
      setHiddenSessionIds((current) => new Set(current).add(action.session.id));
      prepareSessionRemoval(action.session);
      if (transferNavigationFocus)
        setNavigationFocusRequest((value) => value + 1);
      setClosingSessionId(action.session.id);
    }
    if (action.kind === "restart") setStartingSessionId(action.session.id);
    const succeeded = await execute(async () => {
      if (
        action.kind === "project" ||
        action.kind === "group" ||
        action.kind === "worktree" ||
        action.kind === "session" ||
        action.kind === "close"
      ) {
        const statuses = await api.listAgentStatuses();
        updateStatuses(statuses);
        const projectIds =
          action.kind === "worktree"
            ? action.projects.map((project) => project.id)
            : action.kind === "group"
              ? groupDeletionProjectIds(action)
              : [];
        const ids =
          action.kind === "project"
            ? fullWorkspace.sessions
                .filter((session) => session.projectId === action.project.id)
                .map((session) => session.id)
            : action.kind === "worktree" || action.kind === "group"
              ? fullWorkspace.sessions
                  .filter((session) => projectIds.includes(session.projectId))
                  .map((session) => session.id)
              : [action.session.id];
        const running = statuses.some(
          (status) =>
            ids.includes(status.sessionId) && status.state === "running",
        );
        if (action.kind === "worktree") await stopProjectSessions(projectIds);
        else if (action.kind !== "close" && running)
          throw new LocalizedOperationError(s.stopFirst);
        if (action.kind === "close" && running) {
          await api.stopAgentSession(action.session.id);
          await waitForExit(action.session.id);
        }
        if (action.kind === "project") {
          const restore = await handOverGroupMembership([action.project.id]);
          try {
            await api.deleteAgentProject(action.project.id);
          } catch (reason) {
            await restore();
            throw reason;
          }
        } else if (action.kind === "group") {
          const { retainedFolder } = await api.deleteAgentProjectGroup(
            action.group.id,
            !!action.deleteProjects,
          );
          if (retainedFolder)
            notifyWarning(s.groupFolderRetained(retainedFolder));
        } else if (action.kind === "worktree") {
          const restore = await handOverGroupMembership(
            action.projects.map((project) => project.id),
          );
          try {
            const merge = action.merge;
            // The rail snapshot can predate a commit, such as a resolved merge conflict.
            const current = merge
              ? (
                  await gitApi.readGitWorktrees(action.repositoryProjectId)
                ).find(
                  (worktree) =>
                    worktree.path === action.worktree.path &&
                    worktree.branch === merge.branch,
                )
              : undefined;
            const result = merge
              ? await gitApi.mergeGitWorktree(
                  action.repositoryProjectId,
                  { ...(current ?? action.worktree), branch: merge.branch },
                  merge.base,
                )
              : await gitApi.removeGitWorktree(
                  action.repositoryProjectId,
                  action.worktree,
                );
            worktreeMutationSucceeded = true;
            forgetWorktree(action.repositoryProjectId, action.worktree.path);
            if (result.warning)
              notifyWarning(
                result.warning.trim() ||
                  gitStrings.operationCompletedWithWarning,
              );
          } catch (reason) {
            await restore();
            const failure = new Error(gitErrorMessage(reason));
            if (
              action.merge &&
              gitErrorCode(failure.message) === "mergeConflict"
            ) {
              // An unregistered worktree has no project to host the agent.
              if (projectIds.length > 0)
                setFailedMerge({
                  error: failure,
                  conflict: {
                    projectIds,
                    branch: action.merge.branch,
                    base: action.merge.base,
                  },
                });
              // The resolving agent must not open behind the modal confirmation.
              setConfirmation(null);
            }
            throw failure;
          }
        } else if (
          action.kind === "close" &&
          (action.session.favorite ||
            workspace.automationSessionIds?.includes(action.session.id) ||
            kanbanIssueSessions.some(
              (link) => link.sessionId === action.session.id,
            ))
        ) {
          await api.setAgentSessionClosed(action.session.id, true);
          closeSucceeded = true;
          return;
        } else {
          await api.deleteAgentSession(action.session.id);
          if (action.kind === "close") closeSucceeded = true;
        }
        setTerminalTitles((current) => {
          const next = { ...current };
          ids.forEach((id) => delete next[id]);
          return next;
        });
      } else {
        const statuses = await api.listAgentStatuses();
        updateStatuses(statuses);
        const status = statuses.find(
          (item) => item.sessionId === action.session.id,
        );
        if (status?.state === "running")
          await api.stopAgentSession(action.session.id);
        if (action.kind === "restart")
          await start(
            action.session.id,
            status?.state === "running"
              ? await waitForExit(action.session.id)
              : status,
          );
      }
    });
    if (action.kind === "restart") setStartingSessionId(null);
    if (
      !succeeded &&
      (requested.kind === "close" ||
        requested.kind === "session" ||
        requested.kind === "project" ||
        requested.kind === "group")
    )
      // The original object keeps `remoteStopConfirmation` identity matching.
      setFailedDeletion(requested);
    if (action.kind === "close") {
      if (!closeSucceeded) {
        setHiddenSessionIds((current) => {
          const next = new Set(current);
          next.delete(action.session.id);
          return next;
        });
        if (closingSplitSessionId) {
          if (
            lastSessionByProject.current[action.session.projectId] ===
            closingSplitSessionId
          )
            lastSessionByProject.current[action.session.projectId] =
              action.session.id;
          setTerminalSplits((current) => ({
            ...current,
            [action.session.id]: closingSplitSessionId,
          }));
        }
        if (closingSplitParentId)
          setTerminalSplits((current) => ({
            ...current,
            [closingSplitParentId]: action.session.id,
          }));
      }
      setClosingSessionId(null);
    }
    if (succeeded || worktreeMutationSucceeded) {
      if (action.kind === "project")
        returnFocusRef.current = addProjectRef.current;
      if (action.kind === "group") {
        if (
          selection.projectId &&
          groupDeletionProjectIds(action).includes(selection.projectId)
        )
          setSelection({ projectId: null, sessionId: null });
        returnFocusRef.current = addProjectRef.current;
        if (!action.deleteProjects)
          restoreProjectRailFocus({ projectId: action.group.projectIds[0] });
      }
      if (action.kind === "worktree") {
        const removedIds = new Set(
          action.projects.map((project) => project.id),
        );
        if (selection.projectId && removedIds.has(selection.projectId)) {
          const fallback =
            groupByProjectId
              .get(selection.projectId)
              ?.projectIds.find((id) => !removedIds.has(id)) ?? null;
          setSelection({ projectId: fallback, sessionId: null });
        }
        returnFocusRef.current = addProjectRef.current;
        refreshBranches();
      }
      if (action.kind === "session") {
        prepareSessionRemoval(action.session);
        if (transferNavigationFocus)
          setNavigationFocusRequest((value) => value + 1);
      }
      setConfirmation(null);
      if (action.kind === "restart") setFocusRequest((value) => value + 1);
    }
  }
  const disconnectIncomplete =
    confirmation?.kind === "disconnect" &&
    !!error &&
    (workspace.disconnectedProjectIds ?? []).includes(confirmation.project.id);
  const disconnectPending =
    confirmation?.kind === "disconnect" &&
    sshTransition?.projectId === confirmation.project.id &&
    !sshTransition.connected;
  const remoteStopConfirmation =
    !!remoteStopDeletion && confirmation === remoteStopDeletion;
  const confirmationText = confirmation
    ? confirmationDialogText(s, confirmation, {
        runningWorktreeSessions:
          confirmation.kind === "worktree"
            ? fullWorkspace.sessions.filter(
                (session) =>
                  confirmation.projects.some(
                    (project) => project.id === session.projectId,
                  ) && statusOf(session.id)?.state === "running",
              ).length
            : 0,
        disconnectIncomplete,
        remoteStopFailed: remoteStopConfirmation,
      })
    : null;
  function dismissConfirmation() {
    setError(null);
    setConfirmation(null);
  }
  const navigation = (
    <AgentProjectRail
      hidden={hidden}
      embedded={!!sidebarContainer}
      closing={closingSessionId !== null}
      serviceOperating={pendingServiceKeys.size > 0}
      savingFavorite={savingFavorite}
      workspace={workspace}
      projects={filteredProjects}
      groups={filteredProjectGroups}
      projectGroups={projectGroups}
      worktreeGroups={worktreeGroups}
      orderedProjects={orderedProjects}
      railProjects={railProjects}
      sectionOrder={reconciledProjectSectionOrder}
      hiddenProjectCount={hiddenProjectCount}
      visibleSessions={visibleSessions}
      activeSessionId={boardSelected ? undefined : selectedSession?.id}
      selectedProjectId={railSelectedProjectId}
      branches={branches}
      branchError={branchError}
      collapsed={collapsed}
      onlyWithAgents={hideProjectsWithoutAgents}
      quickWorktreeLoadingProjectId={quickWorktree.loadingProjectId}
      startingSessionId={startingSessionId}
      terminalSplits={terminalSplits}
      statusOf={statusOf}
      isWorking={isWorking}
      attentionOf={tabAttention}
      statusLabel={statusLabel}
      sessionName={sessionName}
      hasLoaded={hasLoaded}
      loading={projectsLoading}
      refreshing={projectsRefreshing}
      disabled={disabled}
      navigationDisabled={navigationDisabled}
      reorderDisabled={projectReorderDisabled}
      returnFocusRef={returnFocusRef}
      addProjectRef={addProjectRef}
      onCollapsedChange={setCollapsed}
      onOnlyWithAgentsChange={updateHideProjectsWithoutAgents}
      onSelectProject={selectProject}
      onSelectSession={(session) => void selectSession(session)}
      onCloseSession={(session) =>
        void performAction({ kind: "close", session })
      }
      pinnedSessionIds={pinnedSessionIds}
      onOpenForm={openForm}
      onClone={() => {
        setCloneRecovery(null);
        openForm({ kind: "clone", fromMenu: true });
      }}
      onAsk={ask}
      onMoveProjectToGroup={(projectId, groupId) =>
        void moveProjectToGroup(projectId, groupId)
      }
      onDropProjectInGroup={(projectId, groupId) =>
        void updateProjectGroup(projectId, groupId)
      }
      onOpenExternalWorktree={openExternalWorktree}
      onRequestQuickWorktree={quickWorktree.open}
      onOpenGroupOverview={openGroupOverview}
      onCreateGroupSession={createGroupSession}
      onReorderProjects={reorderProjects}
      onSectionOrderChange={setProjectSectionOrder}
      onDeleteGroup={(group) => ask({ kind: "group", group, fromMenu: true })}
      onSaveProjectAppearance={(projectId, change) =>
        closing.current
          ? Promise.resolve(false)
          : saveProjectAppearance(projectId, change)
      }
      onSaveGroupAppearance={(groupId, change) =>
        closing.current
          ? Promise.resolve(false)
          : saveGroupAppearance(groupId, change)
      }
    />
  );
  // A Design board's project, or one to host a new board: worktrees too, never missing or disconnected.
  const availableDesignProject = (projectId: string) =>
    missingProjectIds.includes(projectId) ||
    (workspace.disconnectedProjectIds ?? []).includes(projectId)
      ? undefined
      : workspace.projects.find((project) => project.id === projectId);
  const launchProjects = agentLaunchProjects(
    listedProjects,
    missingProjectIds,
    groupByProjectId,
    groupOverviewProjects,
  );

  const content = (
    <>
      {desktop && !hidden && sshAddress && selectedProject && statusBarContainer
        ? createPortal(
            <AgentSshStatusControl
              s={s}
              sshAddress={sshAddress}
              selectedProject={selectedProject}
              selectedProjectDisconnected={selectedProjectDisconnected}
              sshState={sshState}
              sshActiveCount={sshActiveCount}
              sshTransition={sshTransition}
              disabled={disabled}
              handleSshForwardBusyChange={handleSshForwardBusyChange}
              toggleRef={sshControlRef}
              onToggle={() => {
                if (closing.current || isBusy() || sshTransitionRef.current)
                  return;
                if (selectedProjectDisconnected)
                  void connectProject(selectedProject.id);
                else {
                  returnFocusRef.current = sshControlRef.current;
                  ask({
                    kind: "disconnect",
                    project: selectedProject,
                    fromMenu: true,
                  });
                }
              }}
              servicesToggle={
                services.available && !boardSelected ? (
                  <button
                    ref={services.toggleRef}
                    type="button"
                    className="agent-ssh-toggle agent-services-toggle"
                    aria-pressed={services.open}
                    aria-controls={
                      services.open ? "agent-services-dock" : undefined
                    }
                    onClick={() => services.setView({ open: !services.open })}
                  >
                    <span
                      className={`agent-status-dot is-${services.runningCount > 0 ? "running" : "idle"}`}
                      aria-hidden="true"
                    />
                    {s.services} {services.runningCount}/{services.count}
                  </button>
                ) : null
              }
            />,
            statusBarContainer,
          )
        : null}
      <section
        className="agent-workspace"
        data-launching={startingSessionId !== null || undefined}
        data-closing={closingSessionId !== null || undefined}
        data-service-operating={pendingServiceKeys.size > 0 || undefined}
        data-saving-favorite={savingFavorite || undefined}
        hidden={hidden}
        aria-label={s.title}
      >
        {!desktop ? (
          <EmptyState
            description={s.desktop}
            fill
            icon={<TerminalSquare />}
            title={s.title}
          />
        ) : (
          <>
            {sidebarContainer
              ? createPortal(navigation, sidebarContainer)
              : navigation}
            <div className="agent-main">
              <AgentSessionTabs
                hidden={boardSelected}
                project={selectedProject}
                sessions={selectedProjectSessions}
                selectedSession={selectedSession}
                splitSession={splitSession}
                splitChildren={splitChildren}
                activePaneId={activePaneId}
                pinnedSessionIds={pinnedSessionIds}
                startingSessionId={startingSessionId}
                statusOf={statusOf}
                isWorking={isWorking}
                attentionOf={paneAttention}
                statusLabel={paneStatusLabel}
                sessionName={sessionName}
                resumeMessage={selectedResumeMessage}
                tabReorder={tabReorder}
                disabled={disabled}
                navigationDisabled={navigationDisabled}
                disconnected={selectedProjectLaunchBlocked}
                gitPanelAvailable={projectToolsAvailable}
                gitPanelVisible={gitPanelVisible && !issueShown && !designShown}
                gitPanelButtonRef={gitPanelButtonRef}
                returnFocusRef={returnFocusRef}
                sessionTabRefs={sessionTabRefs}
                addSessionRef={addSessionRef}
                issuePanel={
                  issuePanelSession && projectToolsAvailable
                    ? {
                        identifier: activeIssueLink?.issueIdentifier ?? null,
                        visible: issueShown,
                      }
                    : null
                }
                issuePanelButtonRef={issuePanelButtonRef}
                onToggleIssuePanel={() => toggleIssuePanel()}
                designPanel={
                  issuePanelSession && projectToolsAvailable
                    ? { linked: !!activeDesignLink, visible: designShown }
                    : null
                }
                designPanelButtonRef={designPanelButtonRef}
                onToggleDesignPanel={toggleDesignPanel}
                onGitPanelVisibleChange={(visible) => {
                  if (issueShown) showGitInsteadOfIssue();
                  else if (designShown) showGitInsteadOfDesign();
                  else onGitPanelVisibleChange?.(visible);
                }}
                onSelectSession={(session) =>
                  void selectSession(session, closingSessionId === null)
                }
                onCloseSession={(session) =>
                  void performAction({ kind: "close", session })
                }
                onRenameSession={(session) =>
                  openForm({ kind: "session", session, fromMenu: true })
                }
                onCreateSession={createSession}
                onCloseSplit={closeTerminalSplit}
                onReorderSession={reorderSession}
                onToggleSessionPin={toggleSessionPin}
                onToggleSessionFavorite={toggleSessionFavorite}
                favoriteSessions={favoriteSessions}
                onReopenSession={(session) => void reopenSession(session.id)}
                canSplitSession={canSplitSession}
                onSplitSession={moveSessionIntoSplit}
                onAsk={ask}
              />
              {kanbanOpened ? (
                <div className="agent-kanban" hidden={!kanbanSelected}>
                  <KanbanBoard
                    issueRequest={kanbanIssueRequest}
                    panel={{
                      container: gitPanelContainer ?? null,
                      visible: kanbanSelected,
                      hidden: boardIssuePanelHidden,
                      onShow: () => onBoardIssuePanelHiddenChange?.(false),
                      expanded: gitPanelExpanded,
                      onExpandedChange: (expanded) =>
                        onGitPanelExpandedChange?.(expanded),
                      onIssueOpenChange: onBoardIssuePanelChange,
                    }}
                  />
                </div>
              ) : null}
              {automationsOpened ? (
                <div className="agent-kanban" hidden={board !== "automations"}>
                  {/* shortcut: its saves are not in the close guard, so closing during an edit's SSH call can
                      leave the server's schedule newer than the list's; guard them if users report it. */}
                  <AutomationsBoard
                    visible={!hidden && board === "automations"}
                    projects={[
                      ...listedProjects.filter(
                        (project) => !missingProjectIds.includes(project.id),
                      ),
                      ...groupOverviewProjects,
                    ]}
                    sessions={workspace.sessions}
                    disconnectedProjectIds={
                      workspace.disconnectedProjectIds ?? []
                    }
                    blockedProjectIds={workspace.projects
                      .filter((project) =>
                        sessionLaunchBlocked(workspace, project.id),
                      )
                      .map((project) => project.id)}
                    onCreateSession={createAutomationSession}
                    onDeleteSession={async (sessionId) => {
                      await execute(() => api.deleteAgentSession(sessionId));
                    }}
                    onRenameSession={async (sessionId, name) => {
                      const session = workspace.sessions.find(
                        (item) => item.id === sessionId,
                      );
                      return (
                        !!session &&
                        (await saveSession({ ...session, customName: name }))
                      );
                    }}
                    onOpenSession={openAutomationSession}
                    onConnectProject={(projectId) =>
                      void connectProject(projectId)
                    }
                    onServerReached={() => void retry()}
                    onAutomationDeleted={(sessionId) => {
                      setHiddenSessionIds((current) => {
                        const next = new Set(current);
                        next.delete(sessionId);
                        return next;
                      });
                      void retry();
                    }}
                  />
                </div>
              ) : null}
              {designOpened ? (
                <div className="agent-kanban" hidden={board !== "design"}>
                  <DesignWorkspace
                    visible={!hidden && board === "design"}
                    sessions={fullWorkspace.sessions}
                    projects={workspace.projects}
                    unavailableProjectIds={
                      new Set(
                        fullWorkspace.projects
                          .filter(
                            (project) =>
                              missingProjectIds.includes(project.id) ||
                              sessionLaunchBlocked(fullWorkspace, project.id),
                          )
                          .map((project) => project.id),
                      )
                    }
                    statusOf={statusOf}
                    startingSessionId={startingSessionId}
                    onStart={(session) => void launch(session, false)}
                    onStop={async (sessionId) => {
                      await api.stopAgentSession(sessionId);
                      await waitForExit(sessionId);
                    }}
                    onSessionsChange={() => void retry()}
                    sessionRequest={designSessionRequest}
                    onDisplayedSessionChange={setDesignSessionId}
                    boardSessions={fullWorkspace.designBoardSessions ?? []}
                    sessionName={sessionName}
                    onOpenSession={(sessionId) => void reopenSession(sessionId)}
                    launchProjects={launchProjects.filter(
                      (project) => !sessionLaunchBlocked(workspace, project.id),
                    )}
                    overviewProjectIds={groupProjectIds}
                    boardProject={availableDesignProject}
                    onStartAgent={startDesignAgent}
                    registerTransitionGuard={registerTransitionGuard}
                    renderTerminal={(session, visible) => {
                      const environment = fullWorkspace.projects.find(
                        (project) => project.id === session.projectId,
                      )?.environment;
                      return (
                        <AgentTerminal
                          sessionId={session.id}
                          name={sessionName(session)}
                          state={statusOf(session.id)?.state ?? "idle"}
                          visible={visible}
                          runRevision={revisions[session.id] ?? 0}
                          focusRequest={null}
                          remote={environment?.kind === "ssh"}
                          imagePasteSequence={
                            environment &&
                            agentImagePasteSequence(
                              session.executable,
                              environment,
                              navigator.platform,
                            )
                          }
                          notice={missingAgentNotice(session)}
                        />
                      );
                    }}
                  />
                </div>
              ) : null}
              <div className="agent-surface" hidden={boardSelected}>
                {!hasLoaded ? (
                  loading ? (
                    <div
                      className="agent-loading-state"
                      role="status"
                      aria-label={s.loading}
                    >
                      <LoaderCircle
                        size={14}
                        className="app-loading-spinner"
                        aria-hidden="true"
                      />
                    </div>
                  ) : null
                ) : !selectedSession ? (
                  <EmptyState
                    actions={
                      selectedProject &&
                      selectedProjectSessions.length === 0 ? (
                        <NewSessionMenu
                          prominent
                          projectName={selectedProject.name}
                          disabled={disabled || selectedProjectLaunchBlocked}
                          returnFocusRef={returnFocusRef}
                          triggerRef={addSessionRef}
                          onPreset={(preset) =>
                            void createSession(selectedProject, preset)
                          }
                        />
                      ) : !projectToolsAvailable ? (
                        <>
                          <Button
                            disabled={disabled}
                            startIcon={<GitBranch />}
                            onClick={() => {
                              setCloneRecovery(null);
                              openForm({ kind: "clone" });
                            }}
                          >
                            {s.cloneRepository}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={disabled}
                            startIcon={<Folder />}
                            onClick={() => openForm({ kind: "project" })}
                          >
                            {s.openRepository}
                          </Button>
                        </>
                      ) : undefined
                    }
                    description={
                      selectedProject ? s.chooseSession : s.emptyBody
                    }
                    fill
                    icon={<TerminalSquare />}
                    title={selectedProject?.name ?? s.title}
                  />
                ) : null}
              </div>
              <div
                ref={terminalStackRef}
                className={`agent-terminal-stack${splitSession ? " is-split" : ""}`}
                hidden={boardSelected || !selectedSession}
              >
                {tabReorder.splitDropSide ? (
                  <div
                    className="agent-terminal-split-drop-overlay"
                    data-active={tabReorder.splitDropSide}
                    aria-hidden="true"
                  >
                    <span data-side="left" />
                    <span data-side="right" />
                  </div>
                ) : null}
                {terminalSessions.map((session) => {
                  const environment = workspace.projects.find(
                    (project) => project.id === session.projectId,
                  )!.environment;
                  const visible =
                    !hidden &&
                    !boardSelected &&
                    (selectedSession?.id === session.id ||
                      splitSession?.id === session.id);
                  const status = statusOf(session.id);
                  const group = workspace.groups?.find(
                    (item) => item.groupProjectId === session.projectId,
                  );
                  return session.kind === "conversation" ? (
                    <AgentConversation
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      // shortcut: assumes each member's link exists; a real folder of that name in the group folder, or a failed link, makes `@<folder>/…` point elsewhere. Have the backend report created links if that bites.
                      mentionRoots={
                        group &&
                        groupMentionRoots(
                          group.projectIds.flatMap((id) =>
                            workspace.projects.filter(
                              (project) => project.id === id,
                            ),
                          ),
                        )
                      }
                      name={sessionName(session)}
                      onFocus={activatePane}
                      state={status?.state ?? "idle"}
                      resumable={status?.resume === "linked"}
                      starting={startingSessionId === session.id}
                      visible={visible}
                      runRevision={revisions[session.id] ?? 0}
                      focusRequest={
                        activePaneId === session.id ? focusRequest : null
                      }
                      onStart={() => void launch(session)}
                      onRestart={() =>
                        void performAction({ kind: "restart", session })
                      }
                      notice={missingAgentNotice(session)}
                      remote={environment.kind === "ssh"}
                    />
                  ) : (
                    <AgentTerminal
                      key={session.id}
                      sessionId={session.id}
                      name={sessionName(session)}
                      onTitleChange={updateTerminalTitle}
                      onFocus={activatePane}
                      state={status?.state ?? "idle"}
                      visible={visible}
                      runRevision={revisions[session.id] ?? 0}
                      focusRequest={
                        activePaneId === session.id ? focusRequest : null
                      }
                      remote={environment.kind === "ssh"}
                      imagePasteSequence={agentImagePasteSequence(
                        session.executable,
                        environment,
                        navigator.platform,
                      )}
                      notice={missingAgentNotice(session)}
                    />
                  );
                })}
              </div>
              {services.open &&
              services.selectedSource &&
              services.selectedService ? (
                <ProjectServicesDock
                  id="agent-services-dock"
                  hidden={boardSelected}
                  onClose={() => {
                    services.setView({ open: false });
                    services.toggleRef.current?.focus();
                  }}
                >
                  <ProjectServicesPanel
                    sections={services.sources.map((source) => ({
                      projectId: source.project.id,
                      projectName: source.project.name,
                      services: source.services,
                      launchableServiceIds: source.launchableServiceIds,
                      sessions: source.sessions,
                      serviceBranches: source.state.serviceBranches,
                      disconnected: source.disconnected,
                    }))}
                    statuses={workspace.statuses}
                    pendingServiceKeys={pendingServiceKeys}
                    grouped={services.key !== selectedProject?.id}
                    selectedServiceKey={projectServiceKey(
                      services.selectedSource.project.id,
                      services.selectedService.id,
                    )}
                    disabled={disabled}
                    onServiceChange={(projectId, serviceId) => {
                      services.setView({ projectId, serviceId });
                      setServiceFocusRequest((value) => (value ?? 0) + 1);
                    }}
                    onStartServices={(projectId, started) =>
                      services.requestStart({
                        kind: "start",
                        projectId,
                        services: started,
                      })
                    }
                    onStopServices={(projectId, stopped) => {
                      setFailedConnectProjectId(null);
                      setLaunchFailed(null);
                      void stopServices(
                        projectId,
                        stopped.map((service) => service.id),
                      );
                    }}
                    onRestartService={(projectId, service) =>
                      services.requestStart({
                        kind: "restart",
                        projectId,
                        services: [service],
                      })
                    }
                    terminal={
                      services.selectedSession ? (
                        <AgentTerminal
                          sessionId={services.selectedSession.id}
                          name={services.selectedService.label}
                          state={services.selectedStatus?.state ?? "idle"}
                          visible={!hidden && !boardSelected}
                          runRevision={
                            revisions[services.selectedSession.id] ?? 0
                          }
                          focusRequest={serviceFocusRequest}
                          remote
                        />
                      ) : undefined
                    }
                  />
                </ProjectServicesDock>
              ) : null}
            </div>
          </>
        )}
      </section>
      {gitPanelContainer
        ? createPortal(
            <>
              <GitPanel
                project={selectedProject}
                projects={workspace.projects}
                disconnected={selectedProjectDisconnected}
                projectsLoading={!hasLoaded && !loadError}
                projectsError={!hasLoaded ? loadError : null}
                branchRevision={branchRevision}
                visible={
                  !hidden &&
                  !boardSelected &&
                  gitPanelVisible &&
                  projectToolsAvailable &&
                  !selectedProjectGroup &&
                  !issueShown &&
                  !designShown
                }
                expanded={gitPanelExpanded}
                onClose={() => onGitPanelVisibleChange?.(false)}
                onExpandedChange={onGitPanelExpandedChange}
                onRetryProjects={() => void retry()}
                openFileRequest={openFileRequest}
                onOpenFileRequestHandled={(id) =>
                  setOpenFileRequest((request) =>
                    request?.id === id ? null : request,
                  )
                }
                onOpenFile={(path) => {
                  if (selectedProject)
                    setOpenFileRequest({
                      id: ++openFileRequestId.current,
                      path,
                      projectId: selectedProject.id,
                      // The reveal moves focus to the editor; the Git view that held it is hidden.
                      selection: { line: 1, start: 0, end: 0 },
                      // shortcut: image previews mount no editor, so focus is still lost; add a fallback target if keyboard users open images here.
                    });
                }}
                onOpenProjectById={(projectId) => {
                  const target = workspace.projects.find(
                    (project) => project.id === projectId,
                  );
                  if (target) selectProject(target);
                }}
                onOpenExternalWorktree={(worktree) => {
                  if (selectedProject)
                    void openExternalWorktree(
                      groupByProjectId.get(selectedProject.id)
                        ?.repositoryProjectId ?? selectedProject.id,
                      { ...worktree, projectIds: [] },
                    );
                }}
                onWorktreeCreated={openWorktree}
                onWorktreeRemoved={(worktree) => {
                  const group = selectedProject
                    ? groupByProjectId.get(selectedProject.id)
                    : undefined;
                  if (group)
                    forgetWorktree(group.repositoryProjectId, worktree.path);
                }}
                worktreeRunningSessions={(worktree) => {
                  const projectIds = selectedWorktreeProjectIds(worktree.path);
                  return fullWorkspace.sessions.filter(
                    (session) =>
                      projectIds.includes(session.projectId) &&
                      statusOf(session.id)?.state === "running",
                  ).length;
                }}
                onStopWorktreeSessions={(worktree) =>
                  stopProjectSessions(selectedWorktreeProjectIds(worktree.path))
                }
                worktreeProjectIds={(worktree) =>
                  selectedWorktreeProjectIds(worktree.path)
                }
                onResolveMergeConflict={(conflict) =>
                  void resolveMergeConflict(conflict)
                }
                onPrepareWorktreeRemoval={(worktree) =>
                  handOverGroupMembership(
                    selectedWorktreeProjectIds(worktree.path),
                  )
                }
                onMutation={refreshBranches}
                onBranchRead={observeBranch}
                registerProjectNavigationGuard={registerProjectNavigationGuard}
                registerTransitionGuard={registerTransitionGuard}
                commentTargets={commentTargets}
                activeAgentTarget={activeAgentTarget}
                onAgentInput={(sessionId) => {
                  const session = workspace.sessions.find(
                    (candidate) => candidate.id === sessionId,
                  );
                  if (!session) return;
                  void selectSession(session).then((selected) => {
                    if (selected && gitPanelExpanded)
                      onGitPanelExpandedChange?.(false);
                  });
                }}
                forgeLoginRevision={forgeLoginRevision}
                onForgeLogin={(kind) => {
                  if (selectedProject)
                    void startForgeLogin(selectedProject.id, kind);
                }}
              />
              {selectedProjectGroup ? (
                <ProjectGroupPanel
                  key={selectedProjectGroup.id}
                  groupName={selectedProjectGroup.name}
                  members={orderedProjects.filter((project) =>
                    selectedProjectGroup.projectIds.includes(project.id),
                  )}
                  disconnectedProjectIds={
                    workspace.disconnectedProjectIds ?? []
                  }
                  workingSessions={workspace.sessions.filter(
                    (session) =>
                      (session.projectId ===
                        selectedProjectGroup.groupProjectId ||
                        selectedProjectGroup.projectIds.includes(
                          session.projectId,
                        )) &&
                      isWorking(session.id),
                  )}
                  commentTargets={runningAgentTargets.filter(
                    (target) =>
                      target.projectId ===
                        selectedProjectGroup.groupProjectId ||
                      selectedProjectGroup.projectIds.includes(
                        target.projectId,
                      ),
                  )}
                  visible={
                    !hidden &&
                    !boardSelected &&
                    gitPanelVisible &&
                    !issueShown &&
                    !designShown
                  }
                  expanded={gitPanelExpanded}
                  onExpandedChange={onGitPanelExpandedChange}
                  onClose={() => onGitPanelVisibleChange?.(false)}
                  onMutation={refreshBranches}
                  onBranchRead={observeBranch}
                  onSelectProject={(projectId) => {
                    const target = workspace.projects.find(
                      (project) => project.id === projectId,
                    );
                    if (target) selectProject(target);
                  }}
                />
              ) : null}
              {issueShown && issuePanelSession ? (
                <KanbanIssuePanel
                  sessionId={issuePanelSession.id}
                  projectId={
                    groupByProjectId.get(issuePanelSession.projectId)
                      ?.repositoryProjectId ?? issuePanelSession.projectId
                  }
                  selection={
                    activeIssueLink
                      ? {
                          id: activeIssueLink.issueId,
                          identifier: activeIssueLink.issueIdentifier,
                          source: activeIssueLink.source,
                        }
                      : null
                  }
                  expanded={gitPanelExpanded}
                  onExpandedChange={(expanded) =>
                    onGitPanelExpandedChange?.(expanded)
                  }
                  onClose={() => closeIssuePanel()}
                  onDeleted={() => {
                    showGitInsteadOfIssue();
                    if (gitPanelExpanded) onGitPanelExpandedChange?.(false);
                    focusGitPanelButton();
                  }}
                  onOpenInKanban={openIssueInKanban}
                />
              ) : null}
              {designShown && issuePanelSession ? (
                <DesignSessionPanel
                  key={issuePanelSession.id}
                  sessionId={issuePanelSession.id}
                  projectId={
                    groupByProjectId.get(issuePanelSession.projectId)
                      ?.repositoryProjectId ?? issuePanelSession.projectId
                  }
                  boardId={activeDesignLink?.boardId ?? null}
                  running={statusOf(issuePanelSession.id)?.state === "running"}
                  projects={workspace.projects}
                  // The repository, not the session's worktree: deleting a worktree project would delete its boards.
                  hostProject={availableDesignProject(
                    groupByProjectId.get(issuePanelSession.projectId)
                      ?.repositoryProjectId ?? issuePanelSession.projectId,
                  )}
                  onLinkChange={() => void retry()}
                  onOpenBoard={(board) => openDesignBoard(board.sessionId)}
                  onClose={closeDesignPanel}
                />
              ) : null}
            </>,
            gitPanelContainer,
          )
        : null}
      {quickOpen && selectedProject && !selectedProjectDisconnected
        ? createPortal(
            <QuickOpenDialog
              roots={searchRoots}
              onClose={() => setQuickOpen(false)}
              onSelect={(projectId, path) =>
                void openFoundFile({ projectId, path })
              }
            />,
            document.body,
          )
        : null}
      {projectSearch && selectedProject && !selectedProjectDisconnected
        ? createPortal(
            <ProjectSearchDialog
              roots={searchRoots}
              initialQuery={
                projectSearch.selectionQuery ?? lastProjectSearch.query
              }
              initialOptions={lastProjectSearch.options}
              onClose={() => setProjectSearch(null)}
              onStateChange={setLastProjectSearch}
              onSelect={({ projectId, path, line, start, end }) =>
                void openFoundFile({
                  projectId,
                  path,
                  selection: { line, start, end },
                })
              }
            />,
            document.body,
          )
        : null}
      {form
        ? createPortal(
            form.kind === "project" ? (
              <AgentProjectForm
                returnFocusRef={form.fromMenu ? returnFocusRef : undefined}
                project={form.project}
                projects={workspace.projects}
                hasSessions={fullWorkspace.sessions.some(
                  (session) => session.projectId === form.project?.id,
                )}
                groupLocked={projectGroups.some((group) =>
                  group.projectIds.includes(form.project?.id ?? ""),
                )}
                linearLinkable={
                  !form.project ||
                  (!groupProjectIds.has(form.project.id) &&
                    (groupByProjectId.get(form.project.id)
                      ?.repositoryProjectId ?? form.project.id) ===
                      form.project.id)
                }
                linearProjectLinks={workspace.linearProjectLinks ?? []}
                busy={disabled}
                onCancel={() => {
                  if (!disabled) setForm(null);
                }}
                onSave={saveProject}
                onSaveMany={saveProjects}
              />
            ) : form.kind === "group" ? (
              <AgentProjectGroupForm
                returnFocusRef={form.fromMenu ? returnFocusRef : undefined}
                group={form.group}
                environment={
                  workspace.projects.find(
                    (project) => project.id === form.group?.groupProjectId,
                  )?.environment
                }
                projects={railProjects.filter(
                  (project) =>
                    !missingProjectIds.includes(project.id) ||
                    !!form.group?.projectIds.includes(project.id),
                )}
                busy={disabled}
                onCancel={() => {
                  if (!disabled) setForm(null);
                }}
                onSave={saveProjectGroup}
              />
            ) : form.kind === "session" ? (
              <AgentSessionForm
                returnFocusRef={form.fromMenu ? returnFocusRef : undefined}
                session={form.session}
                currentName={sessionName(form.session)}
                busy={disabled}
                onCancel={() => {
                  if (!disabled) setForm(null);
                }}
                onSave={(customName) =>
                  void renameSession(form.session.id, customName)
                }
              />
            ) : (
              <GitCloneForm
                returnFocusRef={form.fromMenu ? returnFocusRef : undefined}
                projects={workspace.projects}
                busy={disabled}
                recovery={cloneRecovery}
                onCancel={() => {
                  if (!disabled) {
                    setForm(null);
                    setCloneRecovery(null);
                  }
                }}
                onClone={cloneProject}
                onOpenPreserved={openPreservedClone}
              />
            ),
            document.body,
          )
        : null}
      {!hidden && quickWorktree.draft
        ? createPortal(
            <GitWorktreeDialog
              request={quickWorktree.draft.request}
              busy={busy}
              changed={false}
              description={`${gitStrings.currentBranch} : ${quickWorktree.draft.base}`}
              returnFocusRef={returnFocusRef}
              onBranchChange={quickWorktree.changeBranch}
              onChange={quickWorktree.change}
              onCancel={() => {
                if (!busy) {
                  setError(null);
                  quickWorktree.close();
                }
              }}
              onCreate={() => void quickWorktree.create()}
            />,
            document.body,
          )
        : null}
      {confirmation && confirmationText
        ? createPortal(
            <ConfirmationDialog
              returnFocusRef={
                confirmation.fromMenu ? returnFocusRef : undefined
              }
              title={confirmationText.title}
              description={confirmationText.description}
              cancelLabel={disconnectIncomplete ? s.dismiss : s.cancel}
              closeLabel={disconnectIncomplete ? s.dismiss : s.cancel}
              confirmLabel={confirmationText.confirmLabel}
              confirmPending={busy || disconnectPending}
              confirmVariant={disconnectIncomplete ? "primary" : "danger"}
              cancelDisabled={disabled}
              confirmDisabled={disabled}
              onCancel={() => {
                if (!disabled) {
                  if (disconnectIncomplete) dismissConfirmation();
                  else setConfirmation(null);
                }
              }}
              onConfirm={() => {
                if (disconnectIncomplete) dismissConfirmation();
                else if (remoteStopConfirmation && remoteStopDeletion)
                  void deleteWithoutServer(remoteStopDeletion);
                else void performAction(confirmation);
              }}
            >
              {confirmation.kind === "group" &&
              currentGroup(confirmation.group).projectIds.length > 0 &&
              !remoteStopConfirmation ? (
                <label className="confirmation-dialog-option">
                  <Checkbox
                    checked={!!confirmation.deleteProjects}
                    disabled={disabled}
                    onCheckedChange={(deleteProjects) =>
                      setConfirmation({ ...confirmation, deleteProjects })
                    }
                  />
                  {s.deleteGroupProjects(
                    currentGroup(confirmation.group).projectIds.length,
                  )}
                </label>
              ) : null}
            </ConfirmationDialog>,
            document.body,
          )
        : null}
      {services.trustRequest ? (
        <AgentServiceTrustDialog
          services={
            services.sources.find(
              (source) =>
                source.project.id === services.trustRequest?.projectId,
            )?.state.manifest?.services
          }
          pending={services.trustPending}
          onCancel={services.cancelTrust}
          onConfirm={() => void services.confirmTrust()}
        />
      ) : null}
    </>
  );
  return (
    <KanbanControllerProvider
      enabled={kanbanOpened}
      visible={!hidden && (kanbanSelected || issueShown)}
      projects={listedProjects.filter(
        (project) => !missingProjectIds.includes(project.id),
      )}
      kanbanProjects={launchProjects}
      overviewProjectIds={groupProjectIds}
      linearProjectLinks={workspace.linearProjectLinks ?? []}
      issueSessions={kanbanIssueSessions}
      sessions={workspace.sessions}
      statuses={workspace.statuses}
      closedSessionIds={closedSessionIds}
      terminalTitles={terminalTitles}
      onOpenProject={(projectId) => {
        const target = workspace.projects.find(
          (project) => project.id === projectId,
        );
        if (target) void selectProject(target);
      }}
      onOpenSession={(sessionId) => void reopenSession(sessionId)}
      onIssueDeleted={handleIssueDeleted}
      // The session link moved to the Linear issue: reload, nothing to release.
      onIssueTransferred={() => void retry()}
      onStartIssueAgent={startIssueAgent}
      // Only a failed mutation rejects: the controller goes on after a failed reload.
      onLinkSessionIssue={async (sessionId, issue) => {
        if (closing.current)
          throw new LocalizedOperationError(s.issueAgentBusy);
        await api.linkAgentSessionKanbanIssue(sessionId, issue);
        void retry();
      }}
      onUnlinkSessionIssue={async (sessionId) => {
        if (closing.current)
          throw new LocalizedOperationError(s.issueAgentBusy);
        await api.unlinkAgentSessionIssue(sessionId);
        void retry();
      }}
    >
      {content}
    </KanbanControllerProvider>
  );
}
