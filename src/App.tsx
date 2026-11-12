import "./App.css";
import {
  CalendarClock,
  FileText,
  House,
  ListTodo,
  LoaderCircle,
  Palette,
  Settings,
  SquareKanban,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import {
  ActivityBar,
  ActivityBarItem,
  ReorderableActivityItems,
} from "./components/ActivityBar";
import { AppTitleBar } from "./components/AppTitleBar";
import type {
  AgentBoard,
  AgentBoardRequest,
  AgentSessionRequest,
  AgentTransitionGuard,
} from "./components/agents/AgentWorkspace";
import { useAgentStrings } from "./components/agents/agentStrings";
import { readKanbanSelected } from "./components/agents/agentWorkspaceStorage";
import { EditorPane } from "./components/EditorPane";
import { NoteBrowser } from "./components/NoteBrowser";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { TaskBoard } from "./components/tasks/TaskBoard";
import { TaskLinkedNoteEditor } from "./components/tasks/TaskLinkedNoteEditor";
import {
  isNoteCollectionView,
  normalizeLibraryView,
  type LibraryView,
} from "./domain/library";
import {
  listenAgentNotificationActivated,
  takeAgentNotificationActivation,
} from "./data/agentAttentionApi";
import { listenOpenSettings } from "./data/appMenuApi";
import type { KanbanIssueSelection } from "./domain/kanban";
import type { Note } from "./domain/notes";
import { selectStatusBarSaveStateText } from "./domain/saveStatus";
import { agentTextSizeOptions, defaultAppSettings } from "./data/settingsApi";
import { notifyError } from "./notifications";
import { useI18n } from "./i18n";
import { useKanbanIssueRequestNotifications } from "./hooks/useKanbanIssueRequests";
import { useNotesController } from "./hooks/useNotesController";
import { useTasksController } from "./hooks/useTasksController";
import { useSynchronizedSpinners } from "./hooks/useSynchronizedSpinners";
import { useStoredPreference } from "./hooks/useStoredPreference";
import { useAppSettings } from "./settings";

const loadAgentWorkspace = () =>
  import("./components/agents/AgentWorkspace").then((module) => ({
    default: module.AgentWorkspace,
  }));
const AgentWorkspace = lazy(loadAgentWorkspace);
const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";
const parseSidebarHidden = (stored: string | null) => stored === "true";
const activityTabs = [
  "kanban",
  "automations",
  "design",
  "tasks",
  "notes",
] as const;
type ActivityTab = (typeof activityTabs)[number];
// Keeps known tabs once, in saved order, then appends any tab missing from older saves.
const parseActivityTabOrder = (stored: string | null): ActivityTab[] => [
  ...new Set([
    ...(stored?.split(",") ?? []).filter((id): id is ActivityTab =>
      activityTabs.includes(id as ActivityTab),
    ),
    ...activityTabs,
  ]),
];

function App() {
  useSynchronizedSpinners();
  useKanbanIssueRequestNotifications((issue) =>
    handleShowAgentWorkspace("kanban", issue),
  );
  const { t } = useI18n();
  const agentStrings = useAgentStrings();
  const { settings, updateSettings } = useAppSettings();
  const notes = useNotesController({
    beforeClose: async () => {
      if (transitionInFlight.current) return false;
      let prepared = false;
      try {
        for (const guard of agentTransitionGuards.current) {
          if (!(await guard.prepare())) return false;
        }
        prepared = await prepareTransition();
        return prepared;
      } catch {
        return false;
      } finally {
        if (!prepared) cancelAgentTransition();
      }
    },
    onCloseCancelled: () => {
      cancelAgentTransition();
      if (transitionInFlight.current === "close") releaseTransition();
    },
    noteLockMinutes: settings.noteLockMinutes,
  });
  const activeVaultId = notes.activeVault?.id ?? null;
  const tasks = useTasksController(activeVaultId);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [layoutResetRequest, setLayoutResetRequest] = useState(0);
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const [taskEditorNoteId, setTaskEditorNoteId] = useState<string | null>(null);
  const [isNoteBrowserVisible, setIsNoteBrowserVisible] = useState(true);
  const [isSidebarHidden, setIsSidebarHidden] = useStoredPreference(
    "soreno:sidebar-hidden",
    "soreno:sidebar-hidden-change",
    parseSidebarHidden,
  );
  const [activityTabOrder, setActivityTabOrder] = useStoredPreference(
    "soreno:activity-tab-order",
    "soreno:activity-tab-order-change",
    parseActivityTabOrder,
  );
  const agentTransitionGuards = useRef(new Set<AgentTransitionGuard>());
  const cancelAgentTransition = useCallback(() => {
    for (const guard of agentTransitionGuards.current) guard.cancel?.();
  }, []);
  const [hasOpenedAgents, setHasOpenedAgents] = useState(false);
  const [isAgentNavigationPending, startAgentNavigation] = useTransition();
  const agentNavigationIntent = useRef<"notes" | "agents" | null>(null);
  const [isAgentGitPanelOpen, setIsAgentGitPanelOpen] = useState(() => {
    try {
      return localStorage.getItem("soreno:git-panel-open") !== "false";
    } catch {
      return true;
    }
  });
  const [isAgentGitPanelExpanded, setIsAgentGitPanelExpanded] = useState(false);
  const [isAgentBoardIssueOpen, setIsAgentBoardIssueOpen] = useState(false);
  // Hidden by the panel shortcut while the Kanban keeps its issue open.
  const [isAgentBoardIssueHidden, setIsAgentBoardIssueHidden] = useState(false);
  const [agentProjectToolsAvailable, setAgentProjectToolsAvailable] =
    useState(true);
  const [agentBoard, setAgentBoard] = useState<AgentBoard | null>(() =>
    readKanbanSelected() ? "kanban" : null,
  );
  // A panel expanded over the previous board would hide the requested session.
  const changeAgentBoard = useCallback(
    (board: AgentBoard | null) => {
      if (board === agentBoard) return;
      setAgentBoard(board);
      setIsAgentGitPanelExpanded(false);
    },
    [agentBoard],
  );
  const [agentBoardRequest, setAgentBoardRequest] =
    useState<AgentBoardRequest>();
  const [agentSessionRequest, setAgentSessionRequest] =
    useState<AgentSessionRequest>();
  useEffect(() => {
    try {
      localStorage.setItem(
        "soreno:git-panel-open",
        String(isAgentGitPanelOpen),
      );
    } catch {
      /* Panel persistence is optional. */
    }
  }, [isAgentGitPanelOpen]);
  const [agentSidebarContainer, setAgentSidebarContainer] =
    useState<HTMLDivElement | null>(null);
  const [agentGitPanelContainer, setAgentGitPanelContainer] =
    useState<HTMLDivElement | null>(null);
  const [agentStatusBarContainer, setAgentStatusBarContainer] =
    useState<HTMLDivElement | null>(null);
  const lastNotesView = useRef<LibraryView>("all");
  const registerAgentTransitionGuard = useCallback(
    (guard: AgentTransitionGuard) => {
      agentTransitionGuards.current.add(guard);
      return () => {
        agentTransitionGuards.current.delete(guard);
      };
    },
    [],
  );
  const transitionInFlight = useRef<"close" | "vault" | null>(null);
  const [isPreparingTransition, setIsPreparingTransition] = useState(false);
  const releaseTransition = useCallback(() => {
    transitionInFlight.current = null;
    setIsPreparingTransition(false);
  }, []);
  const prepareTransition = useCallback(
    async (reason: "close" | "vault" = "close") => {
      if (transitionInFlight.current) return false;
      transitionInFlight.current = reason;
      // Commit inert before flushing; no new task edit can start during the flush.
      flushSync(() => setIsPreparingTransition(true));
      try {
        await tasks.flushPendingTasks();
        return true;
      } catch {
        // A failed flush must leave the pending edits available for retry.
        releaseTransition();
        return false;
      }
    },
    [releaseTransition, tasks.flushPendingTasks],
  );

  useEffect(() => {
    const preventUnsavedUnload = (event: BeforeUnloadEvent) => {
      if (
        [...agentTransitionGuards.current].some((guard) =>
          guard.hasPendingWork(),
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventUnsavedUnload);
    return () =>
      window.removeEventListener("beforeunload", preventUnsavedUnload);
  }, []);
  const activeView = notes.activeView;
  const isChangingVault = notes.isChangingVault || isPreparingTransition;
  const isNoteView = isNoteCollectionView(activeView);
  const isTaskView = activeView === "tasks";
  const isAgentsView = activeView === "agents";
  useEffect(() => {
    if (activeView === "agents") setHasOpenedAgents(true);
    else if (isNoteCollectionView(activeView))
      lastNotesView.current = activeView;
    if (!isAgentNavigationPending) agentNavigationIntent.current = null;
  }, [activeView, isAgentNavigationPending]);
  const taskEditorNote =
    !isChangingVault &&
    isTaskView &&
    taskEditorNoteId &&
    notes.selectedNote?.id === taskEditorNoteId
      ? notes.selectedNote
      : null;
  const saveStateText = selectStatusBarSaveStateText([
    {
      lastSavedAt: notes.lastSavedAt,
      saveState: notes.saveState,
      saveStateText: notes.saveStateText,
    },
    {
      lastSavedAt: tasks.lastSavedAt,
      saveState: tasks.saveState,
      saveStateText: tasks.saveStateText,
    },
  ]);

  useEffect(() => {
    function disableNativeContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    function disableNativeShortcut(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const browserShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (key === "r" ||
          key === "g" ||
          (!event.shiftKey && (key === "f" || key === "p")));
      if (browserShortcut || key === "f3" || key === "f5") {
        event.preventDefault();
      }
    }

    document.addEventListener("contextmenu", disableNativeContextMenu);
    document.addEventListener("keydown", disableNativeShortcut);

    return () => {
      document.removeEventListener("contextmenu", disableNativeContextMenu);
      document.removeEventListener("keydown", disableNativeShortcut);
    };
  }, []);

  useEffect(() => {
    // Bubble phase: editors (Markdown bold) and the terminal (Ctrl+B) keep keys they handle.
    function toggleSidebar(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "b" ||
        (isMacOS
          ? !event.metaKey || event.ctrlKey
          : !event.ctrlKey || event.metaKey) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      const panelId = isSidebarHidden
        ? undefined
        : document.activeElement?.closest(
            ".workspace-navigation .workspace-navigation-panel",
          )?.id;
      if (panelId)
        document
          .querySelector<HTMLElement>(
            `.activity-bar [aria-controls="${panelId}"]`,
          )
          ?.focus();
      setIsSidebarHidden(!isSidebarHidden);
    }
    document.addEventListener("keydown", toggleSidebar);
    return () => document.removeEventListener("keydown", toggleSidebar);
  }, [isSidebarHidden, setIsSidebarHidden]);

  useEffect(() => {
    // Capture phase: a focused terminal would otherwise send the chord as input.
    function toggleGitPanel(event: KeyboardEvent) {
      const mod = isMacOS
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      // macOS Option composes event.key; elsewhere event.key keeps AltGr characters out.
      const toggle =
        event.altKey &&
        !event.shiftKey &&
        (isMacOS ? event.code === "KeyB" : event.key.toLowerCase() === "b");
      // Non-Latin layouts fall back to the physical key, as agentGridKeys does.
      const expand =
        event.shiftKey &&
        !event.altKey &&
        (/^[a-z]$/i.test(event.key)
          ? event.key.toLowerCase() === "m"
          : event.key > "\x7e" && event.code === "KeyM");
      // In the Kanban, the right panel holds the open issue instead of Git.
      const boardIssue = agentBoard === "kanban" && isAgentBoardIssueOpen;
      if (
        event.isComposing ||
        !mod ||
        !(toggle || expand) ||
        !isAgentsView ||
        !(agentBoard === null ? agentProjectToolsAvailable : boardIssue) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const open = boardIssue ? !isAgentBoardIssueHidden : isAgentGitPanelOpen;
      const setOpen = (next: boolean) =>
        boardIssue
          ? setIsAgentBoardIssueHidden(!next)
          : setIsAgentGitPanelOpen(next);
      if (toggle) {
        setOpen(!open);
        return;
      }
      // A closed panel opens straight into the expanded view.
      setIsAgentGitPanelExpanded(!open || !isAgentGitPanelExpanded);
      setOpen(true);
    }
    document.addEventListener("keydown", toggleGitPanel, true);
    return () => document.removeEventListener("keydown", toggleGitPanel, true);
  }, [
    agentProjectToolsAvailable,
    agentBoard,
    isAgentsView,
    isAgentBoardIssueOpen,
    isAgentBoardIssueHidden,
    isAgentGitPanelOpen,
    isAgentGitPanelExpanded,
  ]);

  useEffect(() => {
    if (!isAgentsView || agentBoard !== null) return;
    // Capture phase: a focused terminal would otherwise send the chord as input.
    function changeAgentTextSize(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        (isMacOS
          ? !event.metaKey || event.ctrlKey
          : !event.ctrlKey || event.metaKey) ||
        document.querySelector('[aria-modal="true"]') ||
        // A focused Design preview zooms with the same chords.
        (event.target as Element | null)?.closest?.(".design-canvas")
      )
        return;
      // Shift is allowed for "+"; physical codes only for non-ASCII keys (AZERTY's "à" for 0).
      const key = event.key > "\x7e" ? event.code : event.key;
      const step =
        key === "=" || key === "+" || key === "Equal"
          ? 1
          : key === "-" || key === "Minus"
            ? -1
            : key === "0" || key === "Digit0"
              ? 0
              : null;
      if (step === null) return;
      event.preventDefault();
      event.stopPropagation();
      void updateSettings(({ agentTextSize }) => {
        const index = agentTextSizeOptions.indexOf(agentTextSize) + step;
        return {
          agentTextSize:
            step === 0
              ? defaultAppSettings.agentTextSize
              : agentTextSizeOptions[
                  Math.min(Math.max(index, 0), agentTextSizeOptions.length - 1)
                ],
        };
      }).catch(() => notifyError(t("settings.updateError")));
    }
    document.addEventListener("keydown", changeAgentTextSize, true);
    return () =>
      document.removeEventListener("keydown", changeAgentTextSize, true);
  }, [agentBoard, isAgentsView, t, updateSettings]);

  useEffect(() => {
    const modalSelector = '[aria-modal="true"]';
    const openSettings = () => {
      if (!document.querySelector(modalSelector)) setIsSettingsOpen(true);
    };
    // Capture phase: a focused terminal would otherwise send the chord as input.
    function handleShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.key !== "," ||
        event.altKey ||
        event.shiftKey ||
        (isMacOS
          ? !event.metaKey || event.ctrlKey
          : !event.ctrlKey || event.metaKey) ||
        document.querySelector(modalSelector)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setIsSettingsOpen(true);
    }
    document.addEventListener("keydown", handleShortcut, true);
    const unlisten = isTauri()
      ? listenOpenSettings(openSettings).catch(() => undefined)
      : undefined;
    return () => {
      document.removeEventListener("keydown", handleShortcut, true);
      void unlisten?.then((stop) => stop?.());
    };
  }, []);

  useEffect(() => {
    if (
      taskEditorNoteId &&
      (!isTaskView || !notes.notes.some((note) => note.id === taskEditorNoteId))
    ) {
      setTaskEditorNoteId(null);
    }
  }, [isTaskView, notes.notes, taskEditorNoteId]);

  function handleSelectView(view: LibraryView) {
    notes.handleSelectView(view);
    if (isNoteCollectionView(view)) setIsNoteBrowserVisible(true);
  }

  function handleShowLibraryView(view: LibraryView) {
    if (
      view !== activeView ||
      isAgentNavigationPending ||
      agentNavigationIntent.current === "agents"
    ) {
      agentNavigationIntent.current = "notes";
      notes.handleSelectView(view);
    }
  }

  function showAgentsView() {
    if (!isAgentsView) {
      agentNavigationIntent.current = "agents";
      startAgentNavigation(() => notes.handleSelectView("agents"));
    }
  }

  function handleShowAgentWorkspace(
    board: AgentBoard | null,
    issue?: KanbanIssueSelection,
  ) {
    setAgentBoardRequest((request) => ({
      board,
      id: (request?.id ?? 0) + 1,
      issue,
    }));
    showAgentsView();
  }

  const showAgentSession = useRef<(sessionId: string) => void>(() => {});
  // The workspace picks the board: a Design session opens its whiteboard.
  showAgentSession.current = (sessionId) => {
    showAgentsView();
    setAgentSessionRequest((request) => ({
      sessionId,
      id: (request?.id ?? 0) + 1,
    }));
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Rust keeps the clicked session until taken: taking it once listening loses no click.
    const takeActivation = () =>
      void takeAgentNotificationActivation()
        .then((sessionId) => {
          if (sessionId && !disposed) showAgentSession.current(sessionId);
        })
        .catch(() => undefined);
    listenAgentNotificationActivated(() => {
      if (!disposed) takeActivation();
    }).then(
      (stop) => {
        if (disposed) return stop();
        unlisten = stop;
        takeActivation();
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function handleOpenTaskAttachedNote(note: Note) {
    const didSelectNote = await notes.handleSelectNote(note);

    if (didSelectNote) {
      setTaskEditorNoteId(note.id);
    }
  }

  async function handleCreateNote() {
    const createdNote = await notes.handleCreateNote();

    if (createdNote) {
      setEditorFocusRequest((request) => request + 1);
    }
  }

  function handleEditorFocusRequestHandled(request: number) {
    setEditorFocusRequest((currentRequest) =>
      currentRequest === request ? 0 : currentRequest,
    );
  }

  async function changeVaultAfterTransition(
    changeVault: () => Promise<unknown>,
  ) {
    if (!(await prepareTransition("vault"))) return;
    try {
      await changeVault();
    } finally {
      releaseTransition();
    }
  }

  async function handleCreateVault(name: string) {
    await changeVaultAfterTransition(() => notes.handleCreateVault(name));
  }

  async function handleSelectVault(id: string) {
    if (id !== activeVaultId) {
      await changeVaultAfterTransition(() => notes.handleSelectVault(id));
    }
  }

  async function handleDeleteVault(id: string) {
    if (id === activeVaultId) {
      await changeVaultAfterTransition(() => notes.handleDeleteVault(id));
    } else {
      await notes.handleDeleteVault(id);
    }
  }

  if (notes.isBootstrapping) {
    return (
      <main className="app-shell app-shell-loading" aria-busy="true">
        <AppTitleBar />
        <div className="app-loading" role="status" aria-live="polite">
          <LoaderCircle
            size={22}
            className="app-loading-spinner"
            aria-hidden="true"
          />
          <span>{t("notes.loading")}</span>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AppTitleBar />

      <div
        className="workspace-stage"
        aria-busy={isChangingVault}
        inert={isChangingVault}
      >
        <ActivityBar
          aria-label={t("sidebar.workspace")}
          footer={
            <ActivityBarItem
              icon={<Settings />}
              label={t("sidebar.settings")}
              selected={false}
              aria-haspopup="dialog"
              onClick={() => setIsSettingsOpen(true)}
            />
          }
        >
          <ActivityBarItem
            icon={<House />}
            label={t("views.agents")}
            selected={isAgentsView && agentBoard === null}
            aria-controls="workspace-agents-navigation"
            onFocus={() => void loadAgentWorkspace()}
            onPointerEnter={() => void loadAgentWorkspace()}
            onClick={() => {
              // Switching views keeps a sidebar hidden by Ctrl+B; re-clicking the active view reveals it.
              if (isAgentsView && agentBoard === null)
                setIsSidebarHidden(false);
              handleShowAgentWorkspace(null);
            }}
          />
          <ReorderableActivityItems
            order={activityTabOrder}
            onReorder={setActivityTabOrder}
            items={{
              kanban: (
                <ActivityBarItem
                  icon={<SquareKanban />}
                  label={agentStrings.kanban}
                  selected={isAgentsView && agentBoard === "kanban"}
                  onFocus={() => void loadAgentWorkspace()}
                  onPointerEnter={() => void loadAgentWorkspace()}
                  onClick={() => handleShowAgentWorkspace("kanban")}
                />
              ),
              automations: (
                <ActivityBarItem
                  icon={<CalendarClock />}
                  label={t("views.automations")}
                  selected={isAgentsView && agentBoard === "automations"}
                  onFocus={() => void loadAgentWorkspace()}
                  onPointerEnter={() => void loadAgentWorkspace()}
                  onClick={() => handleShowAgentWorkspace("automations")}
                />
              ),
              design: (
                <ActivityBarItem
                  icon={<Palette />}
                  label={t("views.design")}
                  selected={isAgentsView && agentBoard === "design"}
                  onFocus={() => void loadAgentWorkspace()}
                  onPointerEnter={() => void loadAgentWorkspace()}
                  onClick={() => handleShowAgentWorkspace("design")}
                />
              ),
              notes: (
                <ActivityBarItem
                  icon={<FileText />}
                  label={t("sidebar.notes")}
                  selected={isNoteView}
                  aria-controls="workspace-notes-navigation"
                  onClick={() => {
                    if (isNoteView) setIsSidebarHidden(false);
                    handleShowLibraryView(
                      isNoteView
                        ? activeView
                        : normalizeLibraryView(
                            lastNotesView.current,
                            notes.noteTypes,
                          ),
                    );
                  }}
                />
              ),
              tasks: (
                <ActivityBarItem
                  icon={<ListTodo />}
                  label={t("views.tasks")}
                  selected={isTaskView}
                  onClick={() => handleShowLibraryView("tasks")}
                />
              ),
            }}
          />
        </ActivityBar>
        <ResizableWorkspace
          layoutResetRequest={layoutResetRequest}
          browserVisible={isNoteView ? isNoteBrowserVisible : !isAgentsView}
          sidebar={
            <div
              className="workspace-navigation"
              data-hidden={isSidebarHidden || undefined}
              inert={isSidebarHidden}
            >
              <div
                id="workspace-notes-navigation"
                className="workspace-navigation-panel"
                hidden={!isNoteView}
              >
                <Sidebar
                  activeView={activeView}
                  counts={notes.noteCounts}
                  noteTypes={notes.noteTypes}
                  onCreateNoteType={notes.handleCreateNoteType}
                  onDeleteNoteType={notes.handleDeleteNoteType}
                  onDropNote={(noteId, kind) =>
                    void notes.handleChangeNoteType(kind, noteId)
                  }
                  onReorderNoteTypes={notes.handleReorderNoteTypes}
                  onSelectView={handleSelectView}
                  onUpdateNoteType={notes.handleUpdateNoteType}
                />
              </div>
              <div
                id="workspace-agents-navigation"
                className="workspace-navigation-panel"
                hidden={!isAgentsView || agentBoard !== null}
                ref={setAgentSidebarContainer}
              />
            </div>
          }
          browser={
            <>
              {isNoteView ? (
                <NoteBrowser
                  activeView={activeView}
                  isCreateNoteDisabled={notes.isCreatingNote || isChangingVault}
                  isLoading={notes.isLoading && !isChangingVault}
                  noteTypes={notes.noteTypes}
                  notes={notes.visibleNotes}
                  onChangeSortOrder={notes.setNoteSortOrder}
                  onCreateNote={handleCreateNote}
                  onSearchChange={notes.setSearchQuery}
                  onSelectNote={notes.handleSelectNote}
                  searchQuery={notes.searchQuery}
                  selectedNoteId={notes.selectedNote?.id ?? null}
                  sortOrder={notes.noteSortOrder}
                />
              ) : null}
              {isTaskView ? (
                <TaskBoard
                  isLoading={tasks.isLoading}
                  onCreateTask={tasks.handleCreateTask}
                  onDeleteTask={tasks.handleDeleteTask}
                  notes={notes.notes}
                  onOpenAttachedNote={handleOpenTaskAttachedNote}
                  onUpdateTaskAttachedNote={tasks.handleUpdateTaskAttachedNote}
                  onUpdateTaskPriority={tasks.handleUpdateTaskPriority}
                  onUpdateTaskStatus={tasks.handleUpdateTaskStatus}
                  onUpdateTaskTitle={tasks.handleUpdateTaskTitle}
                  tasks={tasks.tasks}
                />
              ) : null}
            </>
          }
          editor={
            <>
              {isNoteView ? (
                <EditorPane
                  content={notes.content}
                  encryption={notes.noteEncryption}
                  readOnly={isChangingVault}
                  isCreateNoteDisabled={notes.isCreatingNote || isChangingVault}
                  noteTypes={notes.noteTypes}
                  onChangeNoteType={notes.handleChangeNoteType}
                  onContentChange={notes.handleContentChange}
                  editorFocusRequest={editorFocusRequest}
                  isNoteBrowserVisible={isNoteBrowserVisible}
                  onToggleNoteBrowser={() =>
                    setIsNoteBrowserVisible((visible) => !visible)
                  }
                  onEditorFocusRequestHandled={handleEditorFocusRequestHandled}
                  onCreateNote={handleCreateNote}
                  onDeleteNote={notes.handleDeleteNote}
                  onToggleNoteArchived={notes.handleToggleNoteArchived}
                  onToggleNotePinned={notes.handleToggleNotePinned}
                  onToggleNoteFavorite={notes.handleToggleNoteFavorite}
                  selectedNote={notes.selectedNote}
                />
              ) : null}
              <Suspense
                fallback={
                  isAgentsView ? (
                    <div
                      className="app-loading"
                      role="status"
                      aria-label={agentStrings.loading}
                    >
                      <LoaderCircle
                        size={16}
                        className="app-loading-spinner"
                        aria-hidden="true"
                      />
                    </div>
                  ) : null
                }
              >
                {isAgentsView || hasOpenedAgents ? (
                  <AgentWorkspace
                    gitPanelContainer={agentGitPanelContainer}
                    gitPanelExpanded={isAgentGitPanelExpanded}
                    statusBarContainer={agentStatusBarContainer}
                    gitPanelVisible={isAgentGitPanelOpen}
                    hidden={!isAgentsView}
                    boardRequest={agentBoardRequest}
                    onGitPanelExpandedChange={setIsAgentGitPanelExpanded}
                    onGitPanelVisibleChange={setIsAgentGitPanelOpen}
                    onBoardChange={changeAgentBoard}
                    onBoardIssuePanelChange={setIsAgentBoardIssueOpen}
                    boardIssuePanelHidden={isAgentBoardIssueHidden}
                    onBoardIssuePanelHiddenChange={setIsAgentBoardIssueHidden}
                    onProjectToolsAvailableChange={
                      setAgentProjectToolsAvailable
                    }
                    onShowWorkspace={handleShowAgentWorkspace}
                    sessionRequest={agentSessionRequest}
                    sidebarContainer={agentSidebarContainer}
                    registerTransitionGuard={registerAgentTransitionGuard}
                  />
                ) : null}
              </Suspense>
            </>
          }
          editorVisible={isNoteView || isAgentsView}
          rightPanel={
            <div
              className="agent-git-panel-host"
              hidden={!isAgentsView}
              ref={setAgentGitPanelContainer}
            />
          }
          rightPanelId="workspace-agent-git"
          rightPanelExpanded={
            isAgentsView &&
            (agentProjectToolsAvailable || agentBoard !== null) &&
            isAgentGitPanelExpanded
          }
          rightPanelResizeLabel={agentStrings.resizeChanges}
          rightPanelVisible={
            isAgentsView &&
            (agentBoard === null
              ? agentProjectToolsAvailable && isAgentGitPanelOpen
              : agentBoard === "kanban" &&
                isAgentBoardIssueOpen &&
                !isAgentBoardIssueHidden)
          }
          sidebarVisible={
            !isSidebarHidden &&
            (isNoteView || (isAgentsView && agentBoard === null))
          }
        />

        {taskEditorNote ? (
          <TaskLinkedNoteEditor
            key={taskEditorNote.id}
            content={notes.content}
            encryption={notes.noteEncryption}
            note={taskEditorNote}
            noteTypes={notes.noteTypes}
            onChangeNoteType={notes.handleChangeNoteType}
            onClose={() => setTaskEditorNoteId(null)}
            onContentChange={notes.handleContentChange}
            onCreateNote={handleCreateNote}
            onDeleteNote={notes.handleDeleteNote}
            onToggleNoteArchived={notes.handleToggleNoteArchived}
            onToggleNotePinned={notes.handleToggleNotePinned}
            onToggleNoteFavorite={notes.handleToggleNoteFavorite}
          />
        ) : null}
      </div>

      <StatusBar
        activeVault={notes.activeVault}
        cancelPreparedClose={notes.cancelPreparedClose}
        connectionStatusRef={setAgentStatusBarContainer}
        isChangingVault={isChangingVault}
        vaults={notes.vaults}
        onCreateVault={handleCreateVault}
        onDeleteVault={handleDeleteVault}
        onRenameVault={notes.handleRenameVault}
        onSelectVault={handleSelectVault}
        prepareToClose={notes.prepareToClose}
        saveStateText={saveStateText}
        showNotesInfo={!isAgentsView}
      />
      {isSettingsOpen ? (
        <SettingsModal
          noteEncryption={notes.noteEncryption}
          onClose={() => setIsSettingsOpen(false)}
          onResetLayout={() => setLayoutResetRequest((request) => request + 1)}
        />
      ) : null}
    </main>
  );
}

export default App;
