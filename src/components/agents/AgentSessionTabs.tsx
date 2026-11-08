import { ContextMenu } from "@base-ui/react/context-menu";
import {
  ArrowLeft,
  ArrowRight,
  GitCompareArrows,
  LoaderCircle,
  MonitorSmartphone,
  Palette,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  Square,
  SquareKanban,
  SquareSplitHorizontal,
  Star,
  StarOff,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, type MouseEvent, type RefObject } from "react";
import { agentAttachCommand } from "../../data/agentSessionsApi";
import { writeClipboardText } from "../../data/clipboard";
import {
  agentProviderLabel,
  type agentPresets,
  type AgentProject,
  type AgentSession,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import type { AgentSessionAttention } from "../../domain/agentAttention";
import { errorMessage } from "../../domain/errors";
import { notifyError, notifyInfo } from "../../notifications";
import type {
  AgentTabReorder,
  SplitDropSide,
} from "../../hooks/useAgentTabReorder";
import { IconButton } from "../ui/IconButton";
import { scrollWheelHorizontally } from "../ui/horizontalWheel";
import { MenuItem } from "../ui/Menu";
import { AgentProviderIcon } from "./AgentProviderIcon";
import {
  FavoriteSessionsMenu,
  NewSessionMenu,
  RowContextMenu,
} from "./AgentWorkspaceMenus";
import type { Confirmation } from "./agentConfirmation";
import { useAgentStrings } from "./agentStrings";
import { formatOperationError } from "./operationError";

type AgentSessionTabsProps = {
  hidden: boolean;
  project: AgentProject | undefined;
  /** Visible tabs of the project, pinned first. */
  sessions: AgentSession[];
  selectedSession: AgentSession | undefined;
  splitSession: AgentSession | undefined;
  /** Secondary pane of each split tab, keyed by the tab's session id. */
  splitChildren: ReadonlyMap<string, AgentSession>;
  activePaneId: string | undefined;
  pinnedSessionIds: ReadonlySet<string>;
  startingSessionId: string | null;
  statusOf: (id: string) => AgentSessionStatus | undefined;
  isWorking: (id: string) => boolean;
  attentionOf: (id: string) => AgentSessionAttention | null;
  statusLabel: (id: string) => string;
  sessionName: (session: AgentSession) => string;
  /** Resume hint for the selected session while it is not running. */
  resumeMessage: string | null;
  tabReorder: AgentTabReorder;
  disabled: boolean;
  navigationDisabled: boolean;
  disconnected: boolean;
  gitPanelAvailable: boolean;
  gitPanelVisible: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  sessionTabRefs: RefObject<Map<string, HTMLButtonElement>>;
  addSessionRef: RefObject<HTMLButtonElement | null>;
  gitPanelButtonRef: RefObject<HTMLButtonElement | null>;
  /** Side panel for the active pane's agent session: its linked issue, or a way to link one (null identifier). */
  issuePanel: { identifier: string | null; visible: boolean } | null;
  issuePanelButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleIssuePanel: () => void;
  /** The active pane's Design board, or a way to link one. */
  designPanel: { linked: boolean; visible: boolean } | null;
  designPanelButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleDesignPanel: () => void;
  onGitPanelVisibleChange?: (visible: boolean) => void;
  onSelectSession: (session: AgentSession) => void;
  onCloseSession: (session: AgentSession) => void;
  onRenameSession: (session: AgentSession) => void;
  onCreateSession: (
    project: AgentProject,
    preset: (typeof agentPresets)[number],
    splitParentId?: string,
  ) => Promise<void>;
  onCloseSplit: (parentId: string) => void;
  onReorderSession: (id: string, index: number) => void;
  onToggleSessionPin: (session: AgentSession) => void;
  onToggleSessionFavorite: (session: AgentSession) => void;
  /** Favorites of the project, open or closed, listed at the start of the tabs. */
  favoriteSessions: readonly AgentSession[];
  onReopenSession: (session: AgentSession) => void;
  canSplitSession: (id: string, side: SplitDropSide) => boolean;
  onSplitSession: (id: string, side: SplitDropSide) => void;
  onAsk: (confirmation: Confirmation) => void;
};

export function AgentSessionTabs({
  hidden,
  project: selectedProject,
  sessions: selectedProjectSessions,
  selectedSession,
  splitSession,
  splitChildren,
  activePaneId,
  pinnedSessionIds,
  startingSessionId,
  statusOf,
  isWorking,
  attentionOf,
  statusLabel,
  sessionName,
  resumeMessage: selectedResumeMessage,
  tabReorder,
  disabled,
  navigationDisabled,
  disconnected: selectedProjectDisconnected,
  gitPanelAvailable,
  gitPanelVisible,
  returnFocusRef,
  sessionTabRefs,
  addSessionRef,
  gitPanelButtonRef,
  issuePanel,
  issuePanelButtonRef,
  onToggleIssuePanel,
  designPanel,
  designPanelButtonRef,
  onToggleDesignPanel,
  onGitPanelVisibleChange,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onCreateSession: createSession,
  onCloseSplit: closeTerminalSplit,
  onReorderSession: reorderSession,
  onToggleSessionPin: toggleSessionPin,
  onToggleSessionFavorite: toggleSessionFavorite,
  favoriteSessions,
  onReopenSession,
  canSplitSession,
  onSplitSession: moveSessionIntoSplit,
  onAsk: ask,
}: AgentSessionTabsProps) {
  const s = useAgentStrings();
  const resumeHintId = useId();
  const pinnedTabCount = selectedProjectSessions.filter((session) =>
    pinnedSessionIds.has(session.id),
  ).length;
  const dropAfterId = tabReorder.dropAtEnd
    ? selectedProjectSessions
        .filter((session) => session.id !== tabReorder.draggingId)
        .slice(-1)[0]?.id
    : null;
  const sessionActions = (session: AgentSession, index: number) => (
    <>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Pencil />} />}
        onClick={() => onRenameSession(session)}
      >
        {s.rename}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        disabled={
          index === 0 ||
          (!pinnedSessionIds.has(session.id) && index === pinnedTabCount)
        }
        render={<MenuItem leading={<ArrowLeft />} />}
        onClick={() => reorderSession(session.id, index - 1)}
      >
        {s.moveTabLeft}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        disabled={
          index === selectedProjectSessions.length - 1 ||
          (pinnedSessionIds.has(session.id) && index === pinnedTabCount - 1)
        }
        render={<MenuItem leading={<ArrowRight />} />}
        onClick={() => reorderSession(session.id, index + 1)}
      >
        {s.moveTabRight}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        render={
          <MenuItem
            leading={pinnedSessionIds.has(session.id) ? <PinOff /> : <Pin />}
          />
        }
        onClick={() => toggleSessionPin(session)}
      >
        {pinnedSessionIds.has(session.id) ? s.unpinTab : s.pinTab}
      </ContextMenu.Item>
      {favoriteAction(session)}
      {canSplitSession(session.id, "left") ? (
        <ContextMenu.Item
          nativeButton
          render={<MenuItem leading={<ArrowLeft />} />}
          onClick={() => moveSessionIntoSplit(session.id, "left")}
        >
          {s.splitTerminalLeft}
        </ContextMenu.Item>
      ) : null}
      {canSplitSession(session.id, "right") ? (
        <ContextMenu.Item
          nativeButton
          render={<MenuItem leading={<ArrowRight />} />}
          onClick={() => moveSessionIntoSplit(session.id, "right")}
        >
          {s.splitTerminalRight}
        </ContextMenu.Item>
      ) : null}
      {processActions(session)}
      {removeAction(session)}
    </>
  );
  const paneActions = (tab: AgentSession, pane: AgentSession) => (
    <>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Pencil />} />}
        onClick={() => onRenameSession(pane)}
      >
        {s.rename}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<SquareSplitHorizontal />} />}
        onClick={() => {
          closeTerminalSplit(tab.id);
          // The child's menu unmounts with the split; the selected one refocuses its terminal.
          if (selectedSession?.id !== tab.id)
            requestAnimationFrame(() =>
              sessionTabRefs.current.get(pane.id)?.focus(),
            );
        }}
      >
        {s.detachSplitTerminal}
      </ContextMenu.Item>
      {favoriteAction(pane)}
      {processActions(pane)}
      {removeAction(pane, pinnedSessionIds.has(tab.id))}
    </>
  );
  const favoriteAction = (session: AgentSession) => (
    <ContextMenu.Item
      nativeButton
      render={<MenuItem leading={session.favorite ? <StarOff /> : <Star />} />}
      onClick={() => toggleSessionFavorite(session)}
    >
      {session.favorite ? s.removeSessionFavorite : s.addSessionFavorite}
    </ContextMenu.Item>
  );
  const copyAttachCommand = async (session: AgentSession) => {
    const key = "agent-session:attach-command";
    try {
      await writeClipboardText(await agentAttachCommand(session.id));
      notifyInfo(s.attachCommandCopied, { key });
    } catch (reason) {
      notifyError(formatOperationError(s, { message: errorMessage(reason) }), {
        key,
      });
    }
  };
  const processActions = (session: AgentSession) =>
    statusOf(session.id)?.state === "running" ? (
      <>
        <ContextMenu.Item
          nativeButton
          render={<MenuItem leading={<Square />} />}
          onClick={() => ask({ kind: "stop", session, fromMenu: true })}
        >
          {s.stop}
        </ContextMenu.Item>
        <ContextMenu.Item
          nativeButton
          render={<MenuItem leading={<RotateCw />} />}
          onClick={() => ask({ kind: "restart", session, fromMenu: true })}
        >
          {s.restart}
        </ContextMenu.Item>
        {selectedProject?.environment.kind === "ssh" &&
        session.kind !== "conversation" ? (
          <ContextMenu.Item
            nativeButton
            render={<MenuItem leading={<MonitorSmartphone />} />}
            onClick={() => void copyAttachCommand(session)}
          >
            {s.copyAttachCommand}
          </ContextMenu.Item>
        ) : null}
      </>
    ) : null;
  const removeAction = (
    session: AgentSession,
    pinned = pinnedSessionIds.has(session.id),
  ) => (
    <ContextMenu.Item
      nativeButton
      disabled={statusOf(session.id)?.state === "running" || pinned}
      render={
        <MenuItem
          danger
          leading={<Trash2 />}
          title={
            pinned
              ? s.unpinFirst
              : statusOf(session.id)?.state === "running"
                ? s.stopFirst
                : undefined
          }
        />
      }
      onClick={() => ask({ kind: "session", session, fromMenu: true })}
    >
      {s.removeSession}
    </ContextMenu.Item>
  );
  const pane = (tab: AgentSession, session: AgentSession, split: boolean) => {
    const pinned = pinnedSessionIds.has(tab.id);
    const busy = startingSessionId === session.id || isWorking(session.id);
    const describedLabel = [
      sessionName(session),
      agentProviderLabel(session.executable),
      statusLabel(session.id),
      split ? s.splitPane : null,
      pinned ? s.pinnedTab : null,
    ];
    const resumable =
      selectedSession?.id === session.id && !!selectedResumeMessage;
    const closeOnMiddleClick = (event: MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (!disabled && !pinned) onCloseSession(session);
    };
    return (
      <>
        <button
          ref={(element) => {
            if (element) sessionTabRefs.current.set(session.id, element);
            else sessionTabRefs.current.delete(session.id);
          }}
          type="button"
          className="agent-session-tab"
          aria-current={
            selectedSession?.id === tab.id && activePaneId === session.id
              ? "page"
              : undefined
          }
          aria-busy={busy || undefined}
          aria-label={describedLabel.filter(Boolean).join(" · ")}
          title={[...describedLabel, resumable ? selectedResumeMessage : null]
            .filter(Boolean)
            .join(" · ")}
          aria-describedby={resumable ? resumeHintId : undefined}
          disabled={navigationDisabled}
          onPointerDown={(event) => tabReorder.startDrag(tab.id, event)}
          onAuxClick={closeOnMiddleClick}
          onClick={() => onSelectSession(session)}
        >
          <span className="agent-session-indicator">
            {busy ? (
              <LoaderCircle
                size={13}
                className="app-loading-spinner"
                role="status"
                aria-label={statusLabel(session.id)}
              />
            ) : (
              <span
                className={`agent-status-dot is-${attentionOf(session.id) ?? statusOf(session.id)?.state ?? "idle"}`}
                aria-hidden="true"
              />
            )}
          </span>
          <AgentProviderIcon executable={session.executable} />
          {pinned ? null : (
            <span className="agent-session-name">{sessionName(session)}</span>
          )}
        </button>
        {pinned ? null : (
          <IconButton
            size="small"
            className="agent-session-close"
            aria-label={`${s.closeSession} · ${sessionName(session)}`}
            title={s.closeSession}
            disabled={disabled}
            onClick={() => onCloseSession(session)}
            onAuxClick={closeOnMiddleClick}
          >
            <X aria-hidden="true" />
          </IconButton>
        )}
      </>
    );
  };
  const hasTabs = !!selectedProject;
  const tabsRef = tabReorder.containerRef;
  useEffect(() => {
    const nav = tabsRef.current;
    if (!hasTabs || !nav) return;
    const wheel = (event: WheelEvent) => scrollWheelHorizontally(nav, event);
    nav.addEventListener("wheel", wheel, { passive: false });
    return () => nav.removeEventListener("wheel", wheel);
  }, [hasTabs, tabsRef]);
  return (
    <header className="agent-terminal-toolbar" hidden={hidden}>
      {selectedProject ? (
        <nav
          ref={tabReorder.containerRef}
          className={`agent-session-tabs${tabReorder.isReordering ? " is-reordering" : ""}`}
          data-reorderable={
            (!disabled && selectedProjectSessions.length > 1) || undefined
          }
          aria-label={s.sessionTabs}
        >
          <FavoriteSessionsMenu
            projectName={selectedProject.name}
            sessions={favoriteSessions}
            disabled={disabled}
            sessionName={sessionName}
            returnFocusRef={returnFocusRef}
            onOpen={onReopenSession}
            onRename={onRenameSession}
            onRemove={toggleSessionFavorite}
          />
          {selectedProjectSessions.map((session, index) => {
            const child = splitChildren.get(session.id);
            const selected = selectedSession?.id === session.id;
            return (
              <div
                key={session.id}
                ref={(element) => {
                  if (element)
                    tabReorder.itemRefs.current.set(session.id, element);
                  else tabReorder.itemRefs.current.delete(session.id);
                }}
                className={`agent-session-tab-item${selected ? " is-selected" : ""}${child ? " is-split" : ""}${pinnedSessionIds.has(session.id) ? " is-pinned" : ""}${tabReorder.draggingId === session.id ? " is-dragging" : ""}`}
                data-drop={
                  tabReorder.dropBeforeId === session.id
                    ? "before"
                    : dropAfterId === session.id
                      ? "after"
                      : undefined
                }
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
              >
                <RowContextMenu
                  className={`agent-session-pane${selected && activePaneId === session.id ? " is-active" : ""}`}
                  disabled={disabled}
                  returnFocusRef={returnFocusRef}
                  actions={() => sessionActions(session, index)}
                >
                  {pane(session, session, !!child)}
                </RowContextMenu>
                {child ? (
                  <RowContextMenu
                    className={`agent-session-pane${selected && activePaneId === child.id ? " is-active" : ""}`}
                    disabled={disabled}
                    returnFocusRef={returnFocusRef}
                    actions={() => paneActions(session, child)}
                  >
                    {pane(session, child, true)}
                  </RowContextMenu>
                ) : null}
              </div>
            );
          })}
          {selectedProjectSessions.length > 0 ||
          selectedProject.environment.kind === "ssh" ? (
            <NewSessionMenu
              projectName={selectedProject.name}
              disabled={disabled || selectedProjectDisconnected}
              returnFocusRef={returnFocusRef}
              triggerRef={addSessionRef}
              onPreset={(preset) => void createSession(selectedProject, preset)}
              split={
                selectedSession
                  ? {
                      onPreset: (preset) =>
                        void createSession(
                          selectedProject,
                          preset,
                          selectedSession.id,
                        ),
                      onDetach: splitSession
                        ? () => closeTerminalSplit(selectedSession.id)
                        : null,
                    }
                  : undefined
              }
            />
          ) : null}
        </nav>
      ) : (
        <strong>{s.terminal}</strong>
      )}
      <span id={resumeHintId} className="agent-resume-hint sr-only">
        {selectedResumeMessage}
      </span>
      <div className="agent-terminal-actions">
        {issuePanel ? (
          <IconButton
            ref={issuePanelButtonRef}
            size="small"
            aria-label={
              issuePanel.identifier
                ? s.issuePanel(issuePanel.identifier)
                : s.issuePanelLink
            }
            title={
              issuePanel.identifier
                ? s.issuePanel(issuePanel.identifier)
                : s.issuePanelLink
            }
            selected={issuePanel.visible}
            // No aria-controls: the layout returns focus from a closed panel to the Changes button.
            aria-pressed={issuePanel.visible}
            aria-expanded={issuePanel.visible}
            onClick={onToggleIssuePanel}
          >
            <SquareKanban aria-hidden="true" />
          </IconButton>
        ) : null}
        {designPanel ? (
          <IconButton
            ref={designPanelButtonRef}
            size="small"
            aria-label={
              designPanel.linked ? s.designPanel : s.designPanelLink
            }
            title={designPanel.linked ? s.designPanel : s.designPanelLink}
            selected={designPanel.visible}
            aria-pressed={designPanel.visible}
            aria-expanded={designPanel.visible}
            onClick={onToggleDesignPanel}
          >
            <Palette aria-hidden="true" />
          </IconButton>
        ) : null}
        {gitPanelAvailable ? (
          <IconButton
            ref={gitPanelButtonRef}
            size="small"
            aria-label={s.changes}
            title={s.changes}
            selected={gitPanelVisible}
            aria-controls="workspace-agent-git"
            aria-pressed={gitPanelVisible}
            aria-expanded={gitPanelVisible}
            onClick={() => onGitPanelVisibleChange?.(!gitPanelVisible)}
          >
            <GitCompareArrows aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}
