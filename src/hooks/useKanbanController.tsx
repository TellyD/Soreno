import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { sendAgentSessionMessage } from "../data/agentSessionsApi";
import { loadKanbanIssue } from "../data/kanbanApi";
import {
  visibleIssueAgentPresets,
  type AgentProject,
  type AgentProjectLinearLink,
  type AgentSession,
  type AgentSessionKanbanIssue,
  type AgentSessionStatus,
} from "../domain/agentSessions";
import { formatShortDateTime } from "../domain/dateTime";
import { errorMessage } from "../domain/errors";
import {
  kanbanColumn,
  kanbanErrorCode,
  linearColumnState,
  transferDescription,
  transferLabelIds,
  type KanbanBoard,
  type KanbanIssue,
  type KanbanIssueCreateInput,
  type KanbanIssueDetail,
  type KanbanIssuePatch,
  type KanbanIssueSelection,
  type KanbanSource,
} from "../domain/kanban";
import {
  kanbanIssueAgents,
  kanbanIssueAssignment,
  kanbanIssueRelease,
  type KanbanIssueAgentRequest,
  type KanbanIssueAgentTarget,
} from "../domain/kanbanAgent";
import { useI18n } from "../i18n";
import { notifyError } from "../notifications";
import { useAppSettings } from "../settings";
import { useKanbanAgentSummaries } from "./useKanbanAgentSummaries";
import { useKanbanBoard } from "./useKanbanBoard";
import { useKanbanErrorFormatter } from "./useKanbanErrorFormatter";
import { useKanbanIssueRequests } from "./useKanbanIssueRequests";
import { useStoredPreference } from "./useStoredPreference";

const keepStored = (stored: string | null) => stored;
/** Last agent preset started on an issue or a Design board, shared by both. */
export const useLastAgentPreset = () =>
  useStoredPreference(
    "soreno.kanban.agentPreset.v1",
    "soreno:agent-preset-change",
    keepStored,
  );
const linearTeamKey = "soreno.kanban.linearTeam.v1";
const createSourceKey = "soreno.kanban.createSource.v1";

export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Optional preference. */
  }
}

function readCreateSource(): KanbanSource | null {
  const saved = readPreference(createSourceKey);
  return saved === "local" || saved === "linear" ? saved : null;
}

// States that already mean work began or ended; starting an agent leaves them as is.
const settledStateTypes: Record<string, true> = {
  canceled: true,
  completed: true,
  started: true,
};

// The move to the first in-progress state an agent taking the issue makes, if any.
function startedMove(
  issue: KanbanIssue,
  boards: { board: KanbanBoard | null; linear: KanbanBoard | null },
) {
  const states =
    (issue.source === "linear" ? boards.linear : boards.board)?.states ?? [];
  const state = states.find(({ id }) => id === issue.stateId);
  const started = linearColumnState("inProgress", states);
  return state && started && !settledStateTypes[state.type]
    ? { from: state.id, to: started.id }
    : null;
}

export type KanbanControllerOptions = {
  // Non-group Soreno projects, so a chip still opens an issue's worktree project.
  projects: AgentProject[];
  // Soreno projects an issue can belong to.
  kanbanProjects: AgentProject[];
  // Group overview projects: their folder is no Git repo, so agents start there without a worktree.
  overviewProjectIds: ReadonlySet<string>;
  // A change reloads Linear, whose board lists the projects linked in its workspace.
  linearProjectLinks: readonly AgentProjectLinearLink[];
  issueSessions: readonly AgentSessionKanbanIssue[];
  sessions: readonly AgentSession[];
  statuses: readonly AgentSessionStatus[];
  closedSessionIds: ReadonlySet<string>;
  // Session names read from terminal titles, as shown on the tabs.
  terminalTitles: Readonly<Record<string, string>>;
  // The board or an issue panel is on screen; Linear refreshes only then.
  visible: boolean;
  onOpenProject: (projectId: string) => void;
  onOpenSession: (sessionId: string) => void;
  // Runs once the issue is deleted; its agent session link is gone with it.
  onIssueDeleted?: (issueId: string) => void;
  // Runs once the local issue is sent to Linear; its agent session link moved to the Linear issue.
  onIssueTransferred?: (localIssueId: string) => void;
  onStartIssueAgent: (request: KanbanIssueAgentRequest) => Promise<void>;
  // Links a session started without an issue; rejects with a displayable error.
  onLinkSessionIssue: (
    sessionId: string,
    issue: KanbanIssueSelection,
  ) => Promise<void>;
  // Forgets the session's issue link; rejects with a displayable error.
  onUnlinkSessionIssue: (sessionId: string) => Promise<void>;
};

export type KanbanAgentPrompt = {
  issue: KanbanIssue;
  project: AgentProject;
  stateName: string;
};

/** Kanban state and edits shared by the board and the agents' issue panel, so both stay one copy. */
export function useKanbanController({
  projects,
  kanbanProjects,
  overviewProjectIds,
  linearProjectLinks,
  issueSessions,
  sessions,
  statuses,
  closedSessionIds,
  terminalTitles,
  visible,
  onOpenProject,
  onOpenSession,
  onIssueDeleted,
  onIssueTransferred,
  onStartIssueAgent,
  onLinkSessionIssue,
  onUnlinkSessionIssue,
}: KanbanControllerOptions) {
  const { locale, t } = useI18n();
  const [linearTeamId, setLinearTeamId] = useState(() =>
    readPreference(linearTeamKey),
  );
  const kanban = useKanbanBoard({ linearTeamId, visible });
  const {
    applyServerUpdate,
    board,
    connectLinear,
    createIssue,
    createLabel,
    deleteIssue,
    disconnectLinear,
    error,
    issues,
    linear,
    linearConnected,
    linearError,
    linearWorkspaces,
    loading,
    reload: reloadBoard,
    transferIssue,
    updateIssue,
  } = kanban;
  const selectLinearTeam = useCallback((teamId: string) => {
    setLinearTeamId(teamId);
    writePreference(linearTeamKey, teamId);
  }, []);

  const knownProjects = useMemo(
    () =>
      new Map(
        [...projects, ...kanbanProjects].map((project) => [
          project.id,
          project,
        ]),
      ),
    [kanbanProjects, projects],
  );
  const linearKanbanProjects = useMemo(
    () =>
      kanbanProjects.filter((project) =>
        linear?.linkedProjectIds.includes(project.id),
      ),
    [kanbanProjects, linear],
  );
  const linearAvailable = linearConnected && linear !== null;

  const issueAgents = useMemo(
    () =>
      kanbanIssueAgents(
        issueSessions,
        sessions,
        statuses,
        closedSessionIds,
        terminalTitles,
      ),
    [issueSessions, sessions, statuses, closedSessionIds, terminalTitles],
  );

  const formatError = useKanbanErrorFormatter();

  const openExternal = useCallback(
    (url: string) => {
      void openUrl(url).catch(() => notifyError(t("kanban.error.openLink")));
    },
    [t],
  );

  const updateBoardIssue = useCallback(
    (issue: KanbanIssue, patch: KanbanIssuePatch) => {
      void updateIssue(issue, patch).catch((error: unknown) =>
        notifyError(formatError(error)),
      );
    },
    [formatError, updateIssue],
  );

  // Deleted issues map to null, transferred ones to their Linear issue, so every open view follows.
  const [replacedIssues, setReplacedIssues] = useState<
    ReadonlyMap<string, KanbanIssueSelection | null>
  >(() => new Map());
  const deleteBoardIssue = useCallback(
    async (issue: KanbanIssue) => {
      await deleteIssue(issue);
      setReplacedIssues((current) => new Map(current).set(issue.id, null));
      onIssueDeleted?.(issue.id);
    },
    [deleteIssue, onIssueDeleted],
  );

  const transferBoardIssue = useCallback(
    async (issue: KanbanIssue, detail: KanbanIssueDetail) => {
      if (!linear) return;
      const localState = board?.states.find(({ id }) => id === issue.stateId);
      const state =
        localState &&
        linearColumnState(kanbanColumn(localState), linear.states);
      const description = transferDescription(
        detail.description,
        detail.comments,
        t("kanban.issue.transferComments", { identifier: issue.identifier }),
        (value) => formatShortDateTime(value, locale),
      );
      const projectId = issue.project?.id;
      const input: KanbanIssueCreateInput = {
        teamId: linear.team.id,
        title: issue.title,
        priority: issue.priority,
        labelIds: transferLabelIds(issue.labels, linear.labels),
      };
      if (description.trim()) input.description = description;
      if (state) input.stateId = state.id;
      // shortcut: reads the last board load, so a project linked while its reload is pending transfers without its project; wait for the reload if users link then transfer at once.
      if (projectId && linear.linkedProjectIds.includes(projectId)) {
        input.projectId = projectId;
      }
      let created: KanbanIssue;
      try {
        created = await transferIssue(
          issue,
          input,
          detail.comments.map(({ id, body }) => ({ id, body })),
          detail.description,
        );
      } catch (error) {
        // The Linear issue exists while the local one stayed: list it.
        if (kanbanErrorCode(errorMessage(error)) === "transferIncomplete")
          reloadBoard("linear");
        throw error;
      }
      setReplacedIssues((current) =>
        new Map(current).set(issue.id, {
          id: created.id,
          identifier: created.identifier,
          source: "linear",
        }),
      );
      onIssueTransferred?.(issue.id);
    },
    [board, linear, locale, onIssueTransferred, reloadBoard, t, transferIssue],
  );

  const localTeamId = board?.team.id;
  const linearTeamIdShown = linear?.team.id;
  const createBoardLabel = useCallback(
    async (source: KanbanSource, name: string) => {
      const teamId = source === "linear" ? linearTeamIdShown : localTeamId;
      if (!teamId) return null;
      try {
        return await createLabel(source, teamId, name);
      } catch (error) {
        notifyError(formatError(error));
        return null;
      }
    },
    [createLabel, formatError, linearTeamIdShown, localTeamId],
  );

  // Rust resolves a Linear issue's Soreno project from these links: a changed link reloads Linear.
  const linkKey = linearProjectLinks
    .map((link) => `${link.projectId}:${link.linearProjectId}`)
    .join(",");
  const linkKeyRef = useRef(linkKey);
  useEffect(() => {
    if (linkKeyRef.current === linkKey) return;
    linkKeyRef.current = linkKey;
    reloadBoard("linear");
  }, [linkKey, reloadBoard]);
  const agentComments = useKanbanAgentSummaries({
    statuses,
    issueSessions,
    sessions,
    applyServerUpdate,
    reloadBoard,
    formatError,
    t,
  });

  const [agentPreset, setAgentPreset] = useLastAgentPreset();
  // A start resolves after reloads, so moves read the latest board seen.
  const latestBoardRef = useRef({ issues, board, linear });
  useLayoutEffect(() => {
    latestBoardRef.current = { issues, board, linear };
  }, [board, issues, linear]);
  // Issues whose agent is starting: the ref guards synchronously, the state renders.
  const startingAgentIssueIdsRef = useRef(new Set<string>());
  const [startingAgentIssueIds, setStartingAgentIssueIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // The card moves to the first in-progress state as the start begins, and back if the start fails.
  const reserveAgentStart = useCallback(
    async (
      issueId: string,
      start: () => Promise<void>,
      known?: KanbanIssue,
    ) => {
      const starting = startingAgentIssueIdsRef.current;
      if (starting.has(issueId)) return;
      starting.add(issueId);
      setStartingAgentIssueIds(new Set(starting));
      const current = latestBoardRef.current;
      const issue = current.issues.find(({ id }) => id === issueId) ?? known;
      const moved = issue ? startedMove(issue, current) : null;
      let moveFailed = false;
      if (issue && moved) {
        void updateIssue(issue, { stateId: moved.to }).catch(
          (error: unknown) => {
            moveFailed = true;
            notifyError(formatError(error));
          },
        );
      }
      try {
        await start();
      } catch (error) {
        // A rejected move already rolls back to `from`; restoring would confirm `to`.
        if (moved && !moveFailed) {
          // Without a commit since the start, the issue is as the move left it.
          const latest = latestBoardRef.current.issues;
          const shown =
            latest === current.issues
              ? issue && { ...issue, stateId: moved.to }
              : latest.find(({ id }) => id === issueId);
          // A state chosen meanwhile wins over the restore.
          if (shown?.stateId === moved.to) {
            updateBoardIssue(shown, { stateId: moved.from });
          }
        }
        throw error;
      } finally {
        starting.delete(issueId);
        setStartingAgentIssueIds(new Set(starting));
      }
    },
    [formatError, updateBoardIssue, updateIssue],
  );
  const startIssueAgent = useCallback(
    async (request: KanbanIssueAgentRequest) => {
      await onStartIssueAgent(request);
      setAgentPreset(request.executable);
    },
    [onStartIssueAgent, setAgentPreset],
  );
  const startDetailIssueAgent = useCallback(
    (request: KanbanIssueAgentRequest) =>
      reserveAgentStart(request.issue.id, () => startIssueAgent(request)),
    [reserveAgentStart, startIssueAgent],
  );

  // The dialog may be gone by then, so failures name the issue.
  const startBoardIssueAgent = useCallback(
    (boardIssue: KanbanIssue, target: KanbanIssueAgentTarget) =>
      reserveAgentStart(
        boardIssue.id,
        async () => {
          // The board issue lacks the branch name derived for the worktree.
          const { id, identifier, title, description, branchName } =
            await loadKanbanIssue(boardIssue.source, boardIssue.id);
          await startIssueAgent({
            ...target,
            issue: {
              id,
              identifier,
              title,
              description,
              branchName,
              source: boardIssue.source,
            },
          });
        },
        boardIssue,
      ).catch((error: unknown) =>
        notifyError(
          t("kanban.error.agentStart", {
            identifier: boardIssue.identifier,
            detail: formatError(error),
          }),
        ),
      ),
    [formatError, reserveAgentStart, startIssueAgent, t],
  );

  const { settings } = useAppSettings();
  const presets = visibleIssueAgentPresets(settings.hiddenAgentPresets);
  const preset =
    presets.find(({ executable }) => executable === agentPreset) ?? presets[0];
  const [agentPrompt, setAgentPrompt] = useState<KanbanAgentPrompt | null>(
    null,
  );
  // An agent started elsewhere withdraws the offer.
  if (agentPrompt && issueAgents.live.has(agentPrompt.issue.id)) {
    setAgentPrompt(null);
  }
  // Moving an issue into the in-progress column offers to start its agent, without waiting for the save.
  const moveBoardIssue = useCallback(
    (issue: KanbanIssue, patch: KanbanIssuePatch) => {
      const states = (issue.source === "linear" ? linear : board)?.states ?? [];
      const target = states.find(({ id }) => id === patch.stateId);
      const from = states.find(({ id }) => id === issue.stateId);
      const project = issue.project && knownProjects.get(issue.project.id);
      if (
        !target ||
        !project ||
        kanbanColumn(target) !== "inProgress" ||
        (from && kanbanColumn(from) === "inProgress") ||
        issueAgents.live.has(issue.id) ||
        startingAgentIssueIdsRef.current.has(issue.id)
      ) {
        updateBoardIssue(issue, patch);
        return;
      }
      void updateIssue(issue, patch).catch((error: unknown) => {
        setAgentPrompt((current) =>
          current?.issue.id === issue.id ? null : current,
        );
        notifyError(formatError(error));
      });
      setAgentPrompt({ issue, project, stateName: target.name });
    },
    [
      board,
      formatError,
      issueAgents,
      knownProjects,
      linear,
      updateBoardIssue,
      updateIssue,
    ],
  );
  const dismissAgentPrompt = useCallback(() => setAgentPrompt(null), []);
  const confirmAgentPrompt = useCallback(() => {
    if (!agentPrompt) return;
    setAgentPrompt(null);
    void startBoardIssueAgent(agentPrompt.issue, {
      projectId: agentPrompt.project.id,
      executable: preset.executable,
      presetName: preset.name,
      worktree: !overviewProjectIds.has(agentPrompt.project.id),
      open: false,
    });
  }, [agentPrompt, overviewProjectIds, preset, startBoardIssueAgent]);

  // True while a create dialog awaits the backend, when it ignores dismissal.
  const creatingRef = useRef(false);
  const isCreating = useCallback(() => creatingRef.current, []);
  // Switching teams would unmount a create dialog still sending its draft: deferred until it closes.
  const deferredLinearTeamRef = useRef<string | null>(null);
  const followLinearTeam = useCallback(
    (teamId: string) => {
      deferredLinearTeamRef.current = creatingRef.current ? teamId : null;
      if (!creatingRef.current) selectLinearTeam(teamId);
    },
    [selectLinearTeam],
  );
  // shortcut: a team deferred during a creation whose dialog owner unmounted meanwhile waits for the next dialog close; release it in the controller if that sequence shows up.
  // Called by a create dialog's owner once it has closed.
  const releaseLinearTeam = useCallback(() => {
    const teamId = deferredLinearTeamRef.current;
    if (creatingRef.current || teamId === null) return;
    deferredLinearTeamRef.current = null;
    selectLinearTeam(teamId);
  }, [selectLinearTeam]);
  const [rememberedCreateSource, setRememberedCreateSource] =
    useState(readCreateSource);
  // Each new object reloads the parent shown in any issue view, listing the new sub-issue.
  const [createdSubIssue, setCreatedSubIssue] = useState<{
    parentId: string;
  } | null>(null);
  const createBoardIssue = useCallback(
    async (
      source: KanbanSource,
      input: KanbanIssueCreateInput,
      agent: KanbanIssueAgentTarget | null,
    ) => {
      creatingRef.current = true;
      let issue: KanbanIssue;
      try {
        issue = await createIssue(source, input);
      } finally {
        creatingRef.current = false;
      }
      if (input.parentId) setCreatedSubIssue({ parentId: input.parentId });
      // A sub-issue follows its parent, so only a chosen destination is remembered.
      else {
        setRememberedCreateSource(source);
        writePreference(createSourceKey, source);
      }
      if (agent) void startBoardIssueAgent(issue, agent);
      return issue;
    },
    [createIssue, startBoardIssueAgent],
  );

  // Takes a session started without an issue onto it, as if the agent had been started from it.
  const attachSessionIssue = useCallback(
    async (sessionId: string, issue: KanbanIssue) => {
      // Loaded first: an unlink during a later load would precede the assignment.
      const { description } = await loadKanbanIssue(issue.source, issue.id);
      await onLinkSessionIssue(sessionId, {
        id: issue.id,
        identifier: issue.identifier,
        source: issue.source,
      });
      const latest = latestBoardRef.current;
      const shown = latest.issues.find(({ id }) => id === issue.id) ?? issue;
      const moved = startedMove(shown, latest);
      if (moved) updateBoardIssue(shown, { stateId: moved.to });
      try {
        await sendAgentSessionMessage(
          sessionId,
          crypto.randomUUID(),
          kanbanIssueAssignment({ ...shown, description }),
        );
      } catch (error) {
        notifyError(
          t("kanban.error.agentAssign", {
            identifier: issue.identifier,
            detail: formatError(error),
          }),
        );
      }
    },
    [formatError, onLinkSessionIssue, t, updateBoardIssue],
  );

  // The issue keeps its state; the agent is told its summaries no longer go anywhere.
  const detachSessionIssue = useCallback(
    async (sessionId: string, identifier: string) => {
      await onUnlinkSessionIssue(sessionId);
      try {
        await sendAgentSessionMessage(
          sessionId,
          crypto.randomUUID(),
          kanbanIssueRelease(identifier),
        );
      } catch (error) {
        notifyError(
          t("kanban.error.agentRelease", {
            identifier,
            detail: formatError(error),
          }),
        );
      }
    },
    [formatError, onUnlinkSessionIssue, t],
  );

  // Bumped when a view saves an issue's description or comments, so the other views reload it.
  const revisionRef = useRef(0);
  const [issueRevisions, setIssueRevisions] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const issueContentSaved = useCallback(
    (issue: KanbanIssueSelection) => {
      // Linear cards take pull requests from attachments, not from the text.
      if (issue.source === "local") reloadBoard("local");
      const revision = ++revisionRef.current;
      setIssueRevisions((current) => new Map(current).set(issue.id, revision));
      return revision;
    },
    [reloadBoard],
  );
  useKanbanIssueRequests(({ issue, updated }) => {
    if (!issue) return;
    // issueContentSaved reloads the local board and the views showing the issue.
    if (updated) issueContentSaved(issue);
    if (!updated || issue.source === "linear") reloadBoard(issue.source);
  });

  const createDialog = useMemo(
    () =>
      board
        ? {
            agentPreset,
            formatError,
            knownProjects,
            linear:
              linearAvailable && linear
                ? { ...linear, projects: linearKanbanProjects }
                : null,
            local: { ...board, projects: kanbanProjects },
            overviewProjectIds,
            onCreate: createBoardIssue,
            onCreateLabel: createBoardLabel,
          }
        : null,
    [
      agentPreset,
      board,
      createBoardIssue,
      createBoardLabel,
      formatError,
      kanbanProjects,
      knownProjects,
      linear,
      linearAvailable,
      linearKanbanProjects,
      overviewProjectIds,
    ],
  );

  return useMemo(
    () => ({
      agentComments,
      agentPreset,
      agentPrompt,
      board,
      confirmAgentPrompt,
      connectLinear,
      createBoardLabel,
      createDialog,
      createdSubIssue,
      deleteBoardIssue,
      disconnectLinear,
      dismissAgentPrompt,
      error,
      followLinearTeam,
      formatError,
      isCreating,
      attachSessionIssue,
      detachSessionIssue,
      createBoardIssue,
      issueAgents,
      issueContentSaved,
      issueRevisions,
      issues,
      kanbanProjects,
      knownProjects,
      linear,
      linearAvailable,
      linearConnected,
      linearError,
      linearKanbanProjects,
      linearWorkspaces,
      loading,
      moveBoardIssue,
      onOpenProject,
      onOpenSession,
      openExternal,
      overviewProjectIds,
      preset,
      releaseLinearTeam,
      reload: reloadBoard,
      rememberedCreateSource,
      replacedIssues,
      selectLinearTeam,
      sessions,
      startDetailIssueAgent,
      startingAgentIssueIds,
      statuses,
      terminalTitles,
      transferBoardIssue,
    }),
    [
      agentComments,
      agentPreset,
      agentPrompt,
      board,
      confirmAgentPrompt,
      connectLinear,
      createBoardLabel,
      createDialog,
      createdSubIssue,
      deleteBoardIssue,
      disconnectLinear,
      dismissAgentPrompt,
      error,
      followLinearTeam,
      formatError,
      isCreating,
      attachSessionIssue,
      detachSessionIssue,
      createBoardIssue,
      issueAgents,
      issueContentSaved,
      issueRevisions,
      issues,
      kanbanProjects,
      knownProjects,
      linear,
      linearAvailable,
      linearConnected,
      linearError,
      linearKanbanProjects,
      linearWorkspaces,
      loading,
      moveBoardIssue,
      onOpenProject,
      onOpenSession,
      openExternal,
      overviewProjectIds,
      preset,
      releaseLinearTeam,
      reloadBoard,
      rememberedCreateSource,
      replacedIssues,
      selectLinearTeam,
      sessions,
      startDetailIssueAgent,
      startingAgentIssueIds,
      statuses,
      terminalTitles,
      transferBoardIssue,
    ],
  );
}

export type KanbanController = ReturnType<typeof useKanbanController>;

const KanbanControllerContext = createContext<KanbanController | null>(null);

/** Null until the provider is enabled and its controller mounted. */
export function useKanbanControllerContext() {
  return useContext(KanbanControllerContext);
}

/**
 * Wraps a subtree that stays mounted: enabling it mounts the controller beside the children,
 * so Kanban is only fetched once enabled and the children never remount.
 */
export function KanbanControllerProvider({
  children,
  enabled,
  ...options
}: KanbanControllerOptions & { children: ReactNode; enabled: boolean }) {
  const [controller, setController] = useState<KanbanController | null>(null);
  return (
    <KanbanControllerContext.Provider value={enabled ? controller : null}>
      {enabled ? (
        <KanbanControllerHost {...options} onChange={setController} />
      ) : null}
      {children}
    </KanbanControllerContext.Provider>
  );
}

function KanbanControllerHost({
  onChange,
  ...options
}: KanbanControllerOptions & {
  onChange: (controller: KanbanController | null) => void;
}) {
  const controller = useKanbanController(options);
  useLayoutEffect(() => onChange(controller), [controller, onChange]);
  useLayoutEffect(() => () => onChange(null), [onChange]);
  return null;
}
