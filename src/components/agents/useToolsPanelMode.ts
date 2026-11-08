import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  AgentSession,
  AgentSessionDesignBoard,
} from "../../domain/agentSessions";
import { isPanelToggleChord } from "../../domain/keyboard";

const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

/** What the project tools panel shows for the active agent: its issue, its Design board or Git. */
export function useToolsPanelMode({
  issuePanelSession,
  activePaneId,
  designBoardSessions,
  hidden,
  boardSelected,
  projectToolsAvailable,
  gitPanelContainer,
  gitPanelVisible,
  gitPanelExpanded,
  onGitPanelVisibleChange,
  onGitPanelExpandedChange,
  onIssueOpen,
}: {
  issuePanelSession: AgentSession | undefined;
  activePaneId: string | undefined;
  designBoardSessions: readonly AgentSessionDesignBoard[];
  hidden: boolean;
  boardSelected: boolean;
  projectToolsAvailable: boolean;
  gitPanelContainer: HTMLElement | null | undefined;
  gitPanelVisible: boolean;
  gitPanelExpanded: boolean;
  onGitPanelVisibleChange?: (visible: boolean) => void;
  onGitPanelExpandedChange?: (expanded: boolean) => void;
  onIssueOpen: () => void;
}) {
  // Sessions whose linked issue takes the project tools' place.
  // shortcut: closed sessions stay in the set until the panel closes; prune against workspace.sessions if it ever matters.
  const [issuePanelSessions, setIssuePanelSessions] = useState<
    ReadonlySet<string>
  >(() => new Set());
  function setIssuePanelOpen(sessionId: string | undefined, open: boolean) {
    if (!sessionId) return;
    setIssuePanelSessions((current) => {
      if (current.has(sessionId) === open) return current;
      const next = new Set(current);
      if (open) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }
  const issuePanelButtonRef = useRef<HTMLButtonElement>(null);
  const gitPanelButtonRef = useRef<HTMLButtonElement>(null);
  // Session whose issue or design opened the closed tools: closing it closes them again.
  const panelOpenedBy = useRef<string | null>(null);
  // Closing the panel, however it happens, leaves every issue for Git.
  if (issuePanelSessions.size && !gitPanelVisible)
    setIssuePanelSessions(new Set());
  useEffect(() => {
    if (!gitPanelVisible) panelOpenedBy.current = null;
  }, [gitPanelVisible]);
  // Focused after the commit: an expanded panel leaves the toolbar inert until then.
  const [toolbarFocusRequest, setToolbarFocusRequest] = useState<{
    ref: RefObject<HTMLButtonElement | null>;
  } | null>(null);
  useEffect(() => {
    toolbarFocusRequest?.ref.current?.focus();
  }, [toolbarFocusRequest]);
  const issueShown =
    !!issuePanelSession &&
    issuePanelSessions.has(issuePanelSession.id) &&
    gitPanelVisible &&
    !boardSelected;
  function toggleIssuePanel(returnFocus = true) {
    if (issueShown) {
      closeIssuePanel(returnFocus);
      return;
    }
    if (!gitPanelVisible) panelOpenedBy.current = issuePanelSession?.id ?? null;
    setIssuePanelOpen(issuePanelSession?.id, true);
    setDesignPanelSession(null);
    onIssueOpen();
    onGitPanelVisibleChange?.(true);
    onGitPanelExpandedChange?.(false);
    // The issue hides the Git view that may hold the focus.
    if (returnFocus) setToolbarFocusRequest({ ref: issuePanelButtonRef });
  }
  function closeIssuePanel(returnFocus = true) {
    setIssuePanelOpen(issuePanelSession?.id, false);
    if (panelOpenedBy.current === issuePanelSession?.id) {
      onGitPanelVisibleChange?.(false);
      panelOpenedBy.current = null;
    }
    if (gitPanelExpanded) onGitPanelExpandedChange?.(false);
    if (returnFocus) setToolbarFocusRequest({ ref: issuePanelButtonRef });
  }
  const toggleIssuePanelRef = useRef(toggleIssuePanel);
  toggleIssuePanelRef.current = toggleIssuePanel;
  const issuePanelAvailable =
    !hidden && !boardSelected && !!issuePanelSession && projectToolsAvailable;
  useEffect(() => {
    if (!issuePanelAvailable) return;
    // Capture phase: a focused terminal would otherwise send the chord as input.
    function toggleIssuePanelFromKeyboard(event: KeyboardEvent) {
      if (
        !isPanelToggleChord(event, "k", isMacOS) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      // Focus leaves the panel only when the panel had it; a terminal keeps it.
      // shortcut: an open Select popup is portalled outside the panel, so closing from it leaves focus on the body; map popups to their trigger if keyboard users hit it.
      const focusInPanel = !!gitPanelContainer?.contains(
        document.activeElement,
      );
      // Unmounting a focused input fires no blur, and the issue title saves on blur.
      // shortcut: untested, as it needs the real issue panel under AgentWorkspace; cover it once the panel has a light harness.
      if (focusInPanel) (document.activeElement as HTMLElement).blur();
      toggleIssuePanelRef.current(focusInPanel);
    }
    document.addEventListener("keydown", toggleIssuePanelFromKeyboard, true);
    return () =>
      document.removeEventListener(
        "keydown",
        toggleIssuePanelFromKeyboard,
        true,
      );
  }, [issuePanelAvailable, gitPanelContainer]);
  function showGitInsteadOfIssue() {
    setIssuePanelOpen(issuePanelSession?.id, false);
    if (panelOpenedBy.current === issuePanelSession?.id)
      panelOpenedBy.current = null;
  }
  // The agent's Design board takes the project tools' place like its issue, one at a time.
  const [designPanelSession, setDesignPanelSession] = useState<string | null>(
    null,
  );
  const designPanelButtonRef = useRef<HTMLButtonElement>(null);
  if (designPanelSession && !gitPanelVisible) setDesignPanelSession(null);
  const activeDesignLink = activePaneId
    ? designBoardSessions.find((link) => link.sessionId === activePaneId)
    : undefined;
  const designShown =
    !!issuePanelSession &&
    designPanelSession === issuePanelSession.id &&
    gitPanelVisible &&
    !boardSelected;
  function toggleDesignPanel() {
    if (designShown) {
      closeDesignPanel();
      return;
    }
    if (!gitPanelVisible) panelOpenedBy.current = issuePanelSession?.id ?? null;
    setIssuePanelOpen(issuePanelSession?.id, false);
    setDesignPanelSession(issuePanelSession?.id ?? null);
    onGitPanelVisibleChange?.(true);
    onGitPanelExpandedChange?.(false);
    setToolbarFocusRequest({ ref: designPanelButtonRef });
  }
  function closeDesignPanel() {
    setDesignPanelSession(null);
    if (panelOpenedBy.current === issuePanelSession?.id) {
      onGitPanelVisibleChange?.(false);
      panelOpenedBy.current = null;
    }
    if (gitPanelExpanded) onGitPanelExpandedChange?.(false);
    setToolbarFocusRequest({ ref: designPanelButtonRef });
  }
  function showGitInsteadOfDesign() {
    setDesignPanelSession(null);
    if (panelOpenedBy.current === issuePanelSession?.id)
      panelOpenedBy.current = null;
  }

  return {
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
    focusGitPanelButton: () =>
      setToolbarFocusRequest({ ref: gitPanelButtonRef }),
  };
}
