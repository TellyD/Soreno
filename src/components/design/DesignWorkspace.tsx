import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Crosshair,
  FileText,
  FileUp,
  LoaderCircle,
  Palette,
  Pencil,
  Paperclip,
  Play,
  Plus,
  Redo2,
  ScrollText,
  Trash2,
  X,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  attachAgentFile,
  sendAgentSessionMessage,
} from "../../data/agentSessionsApi";
import { readTerminalClipboard } from "../../data/clipboard";
import {
  AGENT_CONVERSATION_ATTACHMENT_LIMIT,
  AGENT_CONVERSATION_IMAGE_MARKERS,
  AGENT_CONVERSATION_IMAGE_TYPES,
  agentConversationImageMarker,
  insertAgentConversationToken,
  renumberAgentConversationImageMarkers,
} from "../../domain/agentConversationAttachments";
import {
  agentSessionActivity,
  AGENT_ATTACHMENT_MAX_BYTES,
  type AgentProject,
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionDesignBoard,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import { base64ToBytes } from "../../domain/base64";
import {
  designDraftText,
  designPrompt,
  DesignPromptTooLargeError,
  type DesignAgentRequest,
  type DesignBoard,
  type DesignFrame,
  type DesignTarget,
} from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { isImeComposing, isTextFieldTarget } from "../../domain/keyboard";
import { useAgentSessionMessage } from "../../hooks/useAgentSessionMessage";
import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { useDesignBoard } from "../../hooks/useDesignBoard";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { useAgentStrings } from "../agents/agentStrings";
import { AgentConversationDraftBackdrop } from "../agents/AgentConversationDraftBackdrop";
import { AgentImagePreview } from "../agents/AgentImagePreview";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import type {
  AgentSessionRequest,
  AgentTransitionGuard,
} from "../agents/AgentWorkspace";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { DesignCanvas } from "./DesignCanvas";
import { DesignBoardForm, type DesignBoardFormValues } from "./DesignBoardForm";
import {
  DesignImplement,
  DesignLinkedAgents,
  type DesignImplementOptions,
} from "./DesignAgents";
import "../agents/AgentConversation.css";
import "../agents/AgentConversationComposer.css";
import "./DesignWorkspace.css";

const boardTarget: DesignTarget = { kind: "board" };
const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

type BoardForm = { kind: "create" } | { kind: "rename"; board: DesignBoard };

type DesignWorkspaceProps = {
  visible: boolean;
  sessions: readonly AgentSession[];
  /** Projects of the agents space; the unavailable ones cannot host a new board. */
  projects: readonly AgentProject[];
  unavailableProjectIds: ReadonlySet<string>;
  statusOf: (sessionId: string) => AgentSessionStatus | undefined;
  startingSessionId: string | null;
  onStart: (session: AgentSession) => void;
  /** Stops a running session and waits for its exit. */
  onStop: (sessionId: string) => Promise<void>;
  /** The board sessions list changed: the agents workspace reloads its sessions. */
  onSessionsChange: () => void;
  renderTerminal: (session: AgentSession, visible: boolean) => ReactNode;
  /** A clicked notification of a board's session opens that board. */
  sessionRequest?: AgentSessionRequest;
  /** Session of the board on screen, for the agents' attention tracking. */
  onDisplayedSessionChange: (sessionId: string | null) => void;
  /** Coding agents linked to boards, shown on their board. */
  boardSessions: readonly AgentSessionDesignBoard[];
  sessionName: (session: AgentSession) => string;
  onOpenSession: (sessionId: string) => void;
  launchProjects: readonly AgentProject[];
  overviewProjectIds: ReadonlySet<string>;
  boardProject: (projectId: string) => AgentProject | undefined;
  onStartAgent: (request: DesignAgentRequest) => Promise<void>;
  /** Closing Soreno waits for the board's pending frame writes. */
  registerTransitionGuard?: (guard: AgentTransitionGuard) => () => void;
};

/** A pasted image: its marker `[Image #n]` in the draft stands for the nth one. */
type DesignDraftImage = { name: string; file: File; src: string };
// Attachments are uploaded at send: an agent relaunch empties its folder, and a draft outlives runs.
type DesignDraft = {
  text: string;
  images: readonly DesignDraftImage[];
  /** Other files, whose paths follow the text. */
  files: readonly File[];
};
const emptyDraft: DesignDraft = { text: "", images: [], files: [] };
const revokeDraftImages = (draft: DesignDraft) =>
  draft.images.forEach((image) => URL.revokeObjectURL(image.src));

type SentPrompt = {
  boardId: string;
  draft: DesignDraft;
  /** What the send returned; the watcher follows it. */
  sent: AgentSessionMessage;
  delivery: AgentSessionMessage;
};

/** A frame a targeted prompt asked to rework, until its HTML changes or the agent's turn ends. */
type BusyFrame = {
  boardId: string;
  frameId: string;
  /** The frame's `updatedAt` when the prompt left: any later write ends the mark. */
  updatedAt: string;
  /** False when the prompt was read while another board was shown: the next `updatedAt` seen is adopted. */
  baselineKnown: boolean;
  sentId: string;
  /** The session status when the prompt was first seen read (undefined before): it belongs to the earlier turn. */
  readStatus?: AgentSessionStatus | null;
  /** The agent has worked since the prompt was read: going idle afterwards ends the mark. */
  sawWorking: boolean;
};

/** Follows one sent prompt until the agent reads it or it fails. */
function PromptDelivery({
  sent,
  onChange,
}: {
  sent: AgentSessionMessage;
  onChange: (delivery: AgentSessionMessage) => void;
}) {
  const delivery = useAgentSessionMessage(sent);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (delivery) onChangeRef.current(delivery);
  }, [delivery]);
  return null;
}

export function DesignWorkspace({
  visible,
  sessions,
  projects,
  unavailableProjectIds,
  statusOf,
  startingSessionId,
  onStart,
  onStop,
  onSessionsChange,
  renderTerminal,
  sessionRequest,
  onDisplayedSessionChange,
  boardSessions,
  sessionName,
  onOpenSession,
  launchProjects,
  overviewProjectIds,
  boardProject,
  onStartAgent,
  registerTransitionGuard,
}: DesignWorkspaceProps) {
  const { t } = useI18n();
  const design = useDesignBoard(visible, registerTransitionGuard);
  const { board, boards } = design;
  const [form, setForm] = useState<BoardForm | null>(null);
  const [deleting, setDeleting] = useState<DesignBoard | null>(null);
  const [pending, setPending] = useState(false);
  // Outside the remounted board view: a prompt queued then switched away from is still followed.
  const [drafts, setDrafts] = useState<Record<string, DesignDraft>>({});
  const [sentPrompts, setSentPrompts] = useState<SentPrompt[]>([]);
  const [busyFrames, setBusyFrames] = useState<BusyFrame[]>([]);
  const settledPrompts = useRef(new Set<string>());
  const liveBoardIds = useRef(new Set<string>());
  liveBoardIds.current = new Set(boards.map(({ id }) => id));
  function forgetBoards(keep: (boardId: string) => boolean) {
    setSentPrompts((list) => {
      const next = list.filter((item) => keep(item.boardId));
      if (next.length === list.length) return list;
      list.forEach(
        (item) => keep(item.boardId) || revokeDraftImages(item.draft),
      );
      return next;
    });
    setBusyFrames((list) => {
      const next = list.filter((item) => keep(item.boardId));
      return next.length === list.length ? list : next;
    });
    setDrafts((current) => {
      const ids = Object.keys(current).filter((id) => !keep(id));
      if (!ids.length) return current;
      const next = { ...current };
      for (const id of ids) {
        revokeDraftImages(next[id]);
        delete next[id];
      }
      return next;
    });
  }
  // A deleted board's messages never settle: its prompts and draft go with it.
  useEffect(() => {
    if (design.loaded) forgetBoards((id) => liveBoardIds.current.has(id));
  }, [boards, design.loaded]);
  function followPrompt(prompt: SentPrompt, delivery: AgentSessionMessage) {
    if (delivery.status === "queued") {
      setSentPrompts((list) =>
        list.map((item) =>
          item.sent.id === delivery.id ? { ...item, delivery } : item,
        ),
      );
      return;
    }
    if (settledPrompts.current.has(delivery.id)) return;
    settledPrompts.current.add(delivery.id);
    setSentPrompts((list) =>
      list.filter((item) => item.sent.id !== delivery.id),
    );
    // shortcut: a draft edited after a board switch during the send still shares these URLs, so its thumbnails break (paths still go out); count URL references if users hit it.
    if (delivery.status !== "failed") return revokeDraftImages(prompt.draft);
    setBusyFrames((list) => list.filter((item) => item.sentId !== delivery.id));
    notifyError(
      delivery.error
        ? t("design.deliveryFailedReason", { reason: delivery.error })
        : t("design.deliveryFailed"),
    );
    // Several failures: the first refills an empty draft, each one is notified.
    setDrafts((current) => {
      const draft = current[prompt.boardId];
      if (!draft?.text.trim() && !draft?.images.length && !draft?.files.length)
        return { ...current, [prompt.boardId]: prompt.draft };
      revokeDraftImages(prompt.draft);
      return current;
    });
  }
  const boardQueued = sentPrompts.filter(
    (item) => item.boardId === board?.id && item.delivery.status === "queued",
  );
  const queuedPrompt = boardQueued[boardQueued.length - 1]?.delivery;
  const queuedIds = new Set(
    sentPrompts
      .filter((prompt) => prompt.delivery.status === "queued")
      .map((prompt) => prompt.sent.id),
  );
  const shownFrame = (item: BusyFrame) =>
    item.boardId === board?.id
      ? design.frames.find(
          (frame) =>
            frame.boardId === item.boardId && frame.id === item.frameId,
        )
      : undefined;
  const busyFrameIds = new Set(
    busyFrames
      .filter((item) => {
        const frame = shownFrame(item);
        return (
          !!frame &&
          (queuedIds.has(item.sentId) ||
            !item.baselineKnown ||
            frame.updatedAt === item.updatedAt)
        );
      })
      .map((item) => item.frameId),
  );
  // Marks end once the agent has read the prompt and then rewrote the frame, ended its turn or stopped.
  useEffect(() => {
    if (!busyFrames.length) return;
    let changed = false;
    const next = busyFrames.flatMap((item) => {
      const sessionId = boards.find(({ id }) => id === item.boardId)?.sessionId;
      const status = sessionId ? statusOf(sessionId) : undefined;
      const activity = agentSessionActivity(status);
      const frame = shownFrame(item);
      const rewrite =
        frame && frame.updatedAt !== item.updatedAt ? frame : undefined;
      // Still queued: rewrites and work belong to an earlier turn.
      if (queuedIds.has(item.sentId)) {
        if (!rewrite) return [item];
        changed = true;
        return [{ ...item, updatedAt: rewrite.updatedAt }];
      }
      if (item.readStatus === undefined) {
        changed = true;
        return [
          {
            ...item,
            readStatus: status ?? null,
            // Rewrites made while the board was away may predate the read.
            baselineKnown: item.baselineKnown && item.boardId === board?.id,
          },
        ];
      }
      if (
        // An unknown status (not loaded yet) is not a stop.
        (status && activity === "stopped") ||
        (item.sawWorking &&
          activity !== "working" &&
          activity !== "awaiting") ||
        (item.baselineKnown && rewrite)
      ) {
        changed = true;
        return [];
      }
      let updated = item;
      if (!item.baselineKnown && frame)
        updated = {
          ...updated,
          updatedAt: frame.updatedAt,
          baselineKnown: true,
        };
      // Only a status polled after the read speaks for this prompt's turn.
      // shortcut: a new turn starting while the polled status object stays identical (still working) misses the end-of-turn clear; the rewrite or stop clears remain. Track a status revision if marks linger.
      const fresh = !!status && status !== item.readStatus;
      // Awaiting an answer also means the turn started: a blocked agent reports both.
      if (
        fresh &&
        (activity === "working" || activity === "awaiting") &&
        !item.sawWorking
      )
        updated = { ...updated, sawWorking: true };
      if (updated !== item) changed = true;
      return [updated];
    });
    if (changed) setBusyFrames(next);
  });
  const switcherRef = useRef<HTMLButtonElement>(null);
  const projectName = (id: string | null) =>
    id === null
      ? t("design.noProject")
      : (projects.find((project) => project.id === id)?.name ?? id);
  const session = board
    ? sessions.find((item) => item.id === board.sessionId)
    : undefined;
  const displayedSessionId = visible ? (board?.sessionId ?? null) : null;

  useEffect(() => {
    onDisplayedSessionChange(displayedSessionId);
  }, [displayedSessionId, onDisplayedSessionChange]);

  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!sessionRequest || handledRequest.current === sessionRequest.id) return;
    const requested = boards.find(
      (item) => item.sessionId === sessionRequest.sessionId,
    );
    if (!requested) return;
    handledRequest.current = sessionRequest.id;
    design.selectBoard(requested.id);
  }, [sessionRequest, boards, design.selectBoard]);

  async function submitForm(values: DesignBoardFormValues) {
    if (!form || pending) return;
    setPending(true);
    try {
      if (form.kind === "create") {
        await design.createBoard(
          values.name,
          values.projectId,
          values.executable,
        );
        onSessionsChange();
      } else await design.renameBoard(form.board.id, values.name);
      setForm(null);
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    if (!deleting || pending) return;
    setPending(true);
    try {
      if (statusOf(deleting.sessionId)?.state === "running")
        await onStop(deleting.sessionId);
      await design.deleteBoard(deleting.id);
      const deletedId = deleting.id;
      forgetBoards((id) => id !== deletedId);
      onSessionsChange();
      setDeleting(null);
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  const openCreate = () => setForm({ kind: "create" });

  return (
    <section className="design-workspace" aria-label={t("views.design")}>
      {sentPrompts.map((prompt) => (
        <PromptDelivery
          key={prompt.sent.id}
          sent={prompt.sent}
          onChange={(delivery) => followPrompt(prompt, delivery)}
        />
      ))}
      {board ? (
        <DesignBoardView
          key={board.id}
          board={board}
          frames={design.frames}
          session={session}
          status={session && statusOf(session.id)}
          starting={!!session && startingSessionId === session.id}
          deleting={pending && deleting?.id === board.id}
          unavailable={
            !!session && unavailableProjectIds.has(session.projectId)
          }
          visible={visible}
          onStart={onStart}
          onFrameChange={(frame) => void design.updateFrame(frame)}
          onDuplicate={(frameId) => void design.duplicateFrame(frameId)}
          onDelete={(frameId) => void design.deleteFrame(frameId)}
          history={{
            canUndo: design.canUndo,
            canRedo: design.canRedo,
            undo: () => void design.undo(),
            redo: () => void design.redo(),
          }}
          draft={drafts[board.id] ?? emptyDraft}
          onDraftChange={(draft) =>
            setDrafts((current) => ({ ...current, [board.id]: draft }))
          }
          queued={queuedPrompt ?? null}
          busyFrameIds={busyFrameIds}
          onSent={(sent, draft, frameId) => {
            const boardId = board.id;
            // A late answer: the board may be gone, or its draft retyped meanwhile.
            if (!liveBoardIds.current.has(boardId)) return;
            setSentPrompts((list) => [
              ...list,
              { boardId, draft, sent, delivery: sent },
            ]);
            setDrafts((current) =>
              current[boardId] === draft
                ? { ...current, [boardId]: emptyDraft }
                : current,
            );
            const frame = frameId
              ? design.frames.find((item) => item.id === frameId)
              : undefined;
            if (frame && frame.boardId === boardId)
              setBusyFrames((list) => [
                ...list.filter(
                  (item) =>
                    item.boardId !== boardId || item.frameId !== frame.id,
                ),
                {
                  boardId,
                  frameId: frame.id,
                  updatedAt: frame.updatedAt,
                  baselineKnown: true,
                  sentId: sent.id,
                  sawWorking: false,
                },
              ]);
          }}
          renderTerminal={renderTerminal}
          implement={{
            projects: launchProjects,
            overviewProjectIds,
            boardProject,
            onStart: onStartAgent,
          }}
          agents={
            <DesignLinkedAgents
              boardId={board.id}
              links={boardSessions}
              sessions={sessions}
              statusOf={statusOf}
              sessionName={sessionName}
              onOpenSession={onOpenSession}
            />
          }
          switcher={
            <Menu.Root modal={false}>
              <Menu.Trigger
                ref={switcherRef}
                render={
                  <Button
                    size="small"
                    className="design-switcher"
                    title={t("design.boards")}
                    endIcon={<ChevronDown />}
                  >
                    <span className="design-switcher-name">{board.name}</span>
                    <span className="design-switcher-project">
                      {projectName(board.projectId)}
                    </span>
                  </Button>
                }
              />
              <Menu.Portal>
                <Menu.Positioner
                  className="agent-menu-positioner"
                  sideOffset={6}
                  align="start"
                  collisionPadding={8}
                >
                  <Menu.Popup
                    render={<MenuSurface className="design-switcher-menu" />}
                  >
                    {boards.map((item) => (
                      <Menu.Item
                        key={item.id}
                        nativeButton
                        render={
                          <MenuItem
                            selected={item.id === board.id}
                            trailing={
                              item.id === board.id ? <Check /> : undefined
                            }
                          />
                        }
                        onClick={() => design.selectBoard(item.id)}
                      >
                        {item.name}
                        <span className="design-switcher-detail">
                          {projectName(item.projectId)}
                        </span>
                      </Menu.Item>
                    ))}
                    <Menu.Separator className="agent-menu-separator" />
                    <Menu.Item
                      nativeButton
                      render={<MenuItem leading={<Plus />} />}
                      onClick={openCreate}
                    >
                      {t("design.newBoard")}
                    </Menu.Item>
                    <Menu.Item
                      nativeButton
                      render={<MenuItem leading={<Pencil />} />}
                      onClick={() => setForm({ kind: "rename", board })}
                    >
                      {t("design.rename")}
                    </Menu.Item>
                    <Menu.Item
                      nativeButton
                      render={<MenuItem danger leading={<Trash2 />} />}
                      onClick={() => setDeleting(board)}
                    >
                      {t("design.delete")}
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          }
        />
      ) : design.loaded ? (
        <EmptyState
          fill
          icon={<Palette />}
          title={t("design.emptyTitle")}
          description={t("design.emptyBody")}
          actions={
            <Button variant="primary" startIcon={<Plus />} onClick={openCreate}>
              {t("design.newBoard")}
            </Button>
          }
        />
      ) : null}
      {/* Portalled: the drawer and prompt bar stack above anything left inside the board. */}
      {form ? (
        <DesignBoardForm
          board={form.kind === "rename" ? form.board : undefined}
          projects={launchProjects}
          pending={pending}
          returnFocusRef={switcherRef}
          onCancel={() => setForm(null)}
          onSubmit={(values) => void submitForm(values)}
        />
      ) : null}
      {deleting
        ? createPortal(
            <ConfirmationDialog
              title={t("design.deleteTitle", { name: deleting.name })}
              description={t("design.deleteDescription")}
              cancelLabel={t("design.cancel")}
              closeLabel={t("design.close")}
              confirmLabel={t("design.delete")}
              confirmPending={pending}
              cancelDisabled={pending}
              returnFocusRef={switcherRef}
              onCancel={() => setDeleting(null)}
              onConfirm={() => void confirmDelete()}
            />,
            document.body,
          )
        : null}
    </section>
  );
}

type DesignBoardViewProps = {
  board: DesignBoard;
  frames: readonly DesignFrame[];
  session: AgentSession | undefined;
  status: AgentSessionStatus | undefined;
  starting: boolean;
  unavailable: boolean;
  /** The board is being deleted: its agent, stopped for it, must not restart. */
  deleting: boolean;
  visible: boolean;
  onStart: (session: AgentSession) => void;
  onFrameChange: (frame: DesignFrame) => void;
  onDuplicate: (frameId: string) => void;
  onDelete: (frameId: string) => void;
  history: {
    canUndo: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
  };
  draft: DesignDraft;
  onDraftChange: (draft: DesignDraft) => void;
  /** The board's latest prompt not yet read by the agent. */
  queued: AgentSessionMessage | null;
  /** Frames a targeted prompt is reworking. */
  busyFrameIds: ReadonlySet<string>;
  /** `frameId`: the frame the prompt targeted, null for the whole board. */
  onSent: (
    sent: AgentSessionMessage,
    draft: DesignDraft,
    frameId: string | null,
  ) => void;
  renderTerminal: (session: AgentSession, visible: boolean) => ReactNode;
  switcher: ReactNode;
  implement: DesignImplementOptions;
  agents: ReactNode;
};

/** One open board: keyed by board, so its target and logs reset on switch; its draft lives outside. */
function DesignBoardView({
  board,
  frames,
  session,
  status,
  starting,
  unavailable,
  deleting,
  visible,
  onStart,
  onFrameChange,
  onDuplicate,
  onDelete,
  history,
  draft,
  onDraftChange,
  queued,
  busyFrameIds,
  onSent,
  renderTerminal,
  switcher,
  implement,
  agents,
}: DesignBoardViewProps) {
  const { t } = useI18n();
  const s = useAgentStrings();
  const [target, setTarget] = useState<DesignTarget>(boardTarget);
  const [sending, setSending] = useState(false);
  // Native clipboard reads in flight, before their image reaches the draft.
  const [reading, setReading] = useState(0);
  const [logsOpen, setLogsOpen] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const logsButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Where an inserted marker leaves the caret, until the textarea renders it.
  const caret = useRef<number | null>(null);
  // The latest draft between renders: attachments added together each build on the previous one.
  const draftNow = useRef(draft);
  const seenDraft = useRef(draft);
  if (seenDraft.current !== draft) {
    seenDraft.current = draft;
    draftNow.current = draft;
  }
  function setDraft(next: DesignDraft) {
    draftNow.current = next;
    onDraftChange(next);
  }
  const attachable = useRef(false);
  const mounted = useRef(false);
  const running = status?.state === "running";
  const activity = agentSessionActivity(status);
  // A deleted frame no longer holds the target.
  const targetFrame =
    target.kind === "board"
      ? undefined
      : frames.find((frame) => frame.id === target.frameId);
  const shownTarget = targetFrame ? target : boardTarget;

  // Started once per opening: an agent already running, failed or stopped later waits for the Start button.
  const started = useRef(false);
  useEffect(() => {
    if (!visible || !session || started.current || unavailable || deleting)
      return;
    // shortcut: the attempt is consumed even when `launch` returns early because another launch is busy; wait for the launcher if boards opened mid-launch stay stopped.
    started.current = true;
    if (!starting && !running) onStart(session);
  }, [visible, session, unavailable, deleting, starting, running, onStart]);

  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    if (!visible) return;
    function handleKey(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const mod = isMacOS ? event.metaKey : event.ctrlKey;
      const redo =
        (key === "z" && event.shiftKey) ||
        (!isMacOS && key === "y" && !event.shiftKey);
      if (
        event.altKey ||
        isImeComposing(event) ||
        isTextFieldTarget(event.target) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (key === "/" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        textareaRef.current?.focus();
        return;
      }
      if (!mod || !(key === "z" || redo)) return;
      event.preventDefault();
      if (redo) historyRef.current.redo();
      else historyRef.current.undo();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [visible]);
  const undoLabel = `${t("design.undo")} (${isMacOS ? "⌘Z" : "Ctrl+Z"})`;
  const redoLabel = `${t("design.redo")} (${isMacOS ? "⇧⌘Z" : "Ctrl+Y"})`;

  const disabledReason = !session
    ? s.starting
    : unavailable
      ? t("design.unavailable")
      : starting
        ? s.starting
        : running
          ? null
          : t("design.stopped");
  attachable.current = isTauri() && !disabledReason && !sending;
  const drop = useFileDropTarget(
    () => mounted.current && attachable.current,
    attachFiles,
  );
  // Keyed per board: a late clipboard read must not land in a draft edited since.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    textareaRef.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft.text]);

  /** Images join the draft as chips with a marker at the caret; other files as chips only. */
  function attachFiles(files: File[]) {
    if (!mounted.current || !attachable.current || !files.length) return;
    const current = draftNow.current;
    const unsupported = files.find(
      (file) =>
        file.type.startsWith("image/") &&
        !AGENT_CONVERSATION_IMAGE_TYPES[file.type],
    );
    if (unsupported)
      return notifyError(
        t("design.imageUnsupported", { name: unsupported.name }),
      );
    if (
      current.images.length + current.files.length + files.length >
      AGENT_CONVERSATION_ATTACHMENT_LIMIT
    )
      return notifyError(s.conversation.attachmentRefused({ reason: "count" }));
    if (files.some((file) => file.size > AGENT_ATTACHMENT_MAX_BYTES))
      return notifyError(s.terminalAttachmentTooLarge);
    const added = files.filter((file) => file.type.startsWith("image/"));
    const images = [
      ...current.images,
      ...added.map((file) => ({
        name: file.name,
        file,
        src: URL.createObjectURL(file),
      })),
    ];
    const others = [
      ...current.files,
      ...files.filter((file) => !file.type.startsWith("image/")),
    ];
    if (!added.length) setDraft({ ...current, files: others });
    else {
      const textarea = textareaRef.current;
      const next = insertAgentConversationToken(
        current.text,
        caret.current ??
          (textarea?.value === current.text
            ? textarea.selectionStart
            : current.text.length),
        added
          .map((_, index) =>
            agentConversationImageMarker(current.images.length + index + 1),
          )
          .join(" "),
      );
      caret.current = next.caret;
      setDraft({ text: next.text, images, files: others });
    }
    textareaRef.current?.focus();
  }

  function removeImage(index: number) {
    const current = draftNow.current;
    URL.revokeObjectURL(current.images[index].src);
    setDraft({
      text: renumberAgentConversationImageMarkers(current.text, (n) =>
        n === index + 1 ? null : n > index + 1 ? n - 1 : n,
      ),
      images: current.images.filter((_, position) => position !== index),
      files: current.files,
    });
  }

  function removeFile(index: number) {
    const current = draftNow.current;
    setDraft({
      ...current,
      files: current.files.filter((_, position) => position !== index),
    });
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      attachFiles(files);
      return;
    }
    if (event.clipboardData.types.includes("text/plain") || !attachable.current)
      return;
    // A screenshot some webviews paste without a file: the native clipboard has it.
    setReading((count) => count + 1);
    void readTerminalClipboard(true)
      .then((clipboard) => {
        if (clipboard.type !== "image" || !clipboard.dataBase64) return;
        const type = clipboard.mimeType ?? "image/png";
        attachFiles([
          new File(
            [base64ToBytes(clipboard.dataBase64)],
            `image.${type.split("/")[1]}`,
            { type },
          ),
        ]);
      })
      .catch(() => notifyError(s.terminalAttachmentError))
      .finally(() => setReading((count) => count - 1));
  }
  // In the prompt bar, the latest step of what was sent: sending, queued, then the agent's turn.
  const working = !sending && !queued && activity === "working";
  const awaiting = !sending && !queued && activity === "awaiting";
  const promptStatus = sending
    ? t("design.sending")
    : queued
      ? queued.error
        ? t("design.queuedReason", { reason: queued.error })
        : t("design.queued")
      : working
        ? t("design.drawing")
        : awaiting
          ? t("design.awaitingAnswer")
          : null;
  const statusLabel = starting
    ? s.starting
    : activity === "working"
      ? s.working
      : activity === "awaiting"
        ? s.awaiting
        : running
          ? s.running
          : s.stopped;

  async function send() {
    if (!session || disabledReason || sending || reading) return;
    if (!draft.text.trim() && !draft.images.length && !draft.files.length)
      return;
    setSending(true);
    try {
      const upload = async (files: readonly File[]) => {
        const paths: string[] = [];
        for (const file of files)
          paths.push(await attachAgentFile(session.id, file));
        return paths;
      };
      // shortcut: a prompt over 64 KiB is refused only after its attachments are uploaded, leaving files until the next relaunch; preflight designPrompt with the markers if users hit it.
      const images = await upload(draft.images.map((image) => image.file));
      const files = await upload(draft.files);
      let body: string;
      try {
        body = designPrompt(
          [designDraftText(draft.text, images), ...files].join(" ").trim(),
          frames,
          shownTarget,
        );
      } catch (reason) {
        if (!(reason instanceof DesignPromptTooLargeError)) throw reason;
        notifyError(t("design.promptTooLarge"));
        return;
      }
      const message = await sendAgentSessionMessage(
        session.id,
        crypto.randomUUID(),
        body,
      );
      onSent(
        message,
        draft,
        shownTarget.kind === "board" ? null : shownTarget.frameId,
      );
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  }

  const targetLabel =
    shownTarget.kind === "element"
      ? t("design.target.element", { selector: shownTarget.selector })
      : targetFrame
        ? t("design.target.frame", { title: targetFrame.title })
        : t("design.target.board");

  return (
    <>
      <DesignCanvas
        frames={frames}
        viewKey={`board:${board.id}`}
        target={shownTarget}
        onTargetChange={setTarget}
        targeting={targeting}
        onTargetingChange={setTargeting}
        shortcuts={visible}
        onFrameChange={onFrameChange}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        busyFrameIds={busyFrameIds}
        empty={
          <EmptyState
            icon={<Palette />}
            title={t("design.framesEmptyTitle")}
            description={t("design.framesEmptyBody")}
          />
        }
      />
      <div className="design-toolbar">
        {switcher}
        <span className="design-agent" role="status">
          {starting || activity === "working" ? (
            <LoaderCircle
              size={12}
              className="app-loading-spinner"
              aria-hidden="true"
            />
          ) : (
            <span
              className={`agent-status-dot is-${activity === "awaiting" ? "awaiting" : (status?.state ?? "idle")}`}
              aria-hidden="true"
            />
          )}
          {session ? (
            <AgentProviderIcon executable={session.executable} size={13} />
          ) : null}
          {statusLabel}
        </span>
        {session && !running && !starting && !unavailable ? (
          <Button
            size="small"
            startIcon={<Play />}
            onClick={() => onStart(session)}
          >
            {t("design.start")}
          </Button>
        ) : null}
        <IconButton
          aria-label={undoLabel}
          title={undoLabel}
          disabled={!history.canUndo}
          onClick={history.undo}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          aria-label={redoLabel}
          title={redoLabel}
          disabled={!history.canRedo}
          onClick={history.redo}
        >
          <Redo2 />
        </IconButton>
        {agents}
        <DesignImplement
          board={board}
          frames={frames}
          target={shownTarget}
          options={implement}
        />
        <Button
          ref={logsButtonRef}
          size="small"
          startIcon={<ScrollText />}
          aria-pressed={logsOpen}
          aria-controls={logsOpen ? `design-logs-${board.id}` : undefined}
          disabled={!session}
          onClick={() => setLogsOpen(!logsOpen)}
        >
          {t("design.logs")}
        </Button>
      </div>
      <div
        className="design-prompt agent-conversation-composer"
        {...drop.handlers}
      >
        {drop.active ? (
          <div className="agent-conversation-file-drop" aria-hidden="true">
            <FileUp size={34} strokeWidth={1.75} />
            <span>{s.conversation.dropFiles}</span>
          </div>
        ) : null}
        <div
          className="agent-conversation-input"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          <ul
            className="agent-conversation-attachments"
            aria-label={t("design.target.label")}
          >
            <li className="design-prompt-target">
              <Palette size={14} aria-hidden="true" />
              <span title={targetLabel}>{targetLabel}</span>
              {shownTarget.kind !== "board" ? (
                <IconButton
                  size="small"
                  aria-label={t("design.target.remove")}
                  title={t("design.target.remove")}
                  onClick={() => setTarget(boardTarget)}
                >
                  <X />
                </IconButton>
              ) : null}
            </li>
          </ul>
          {draft.images.length > 0 || draft.files.length > 0 ? (
            <ul
              className="agent-conversation-attachments"
              aria-label={s.conversation.attachments}
            >
              {draft.images.map((image, index) => {
                const name = s.conversation.image(index + 1);
                return (
                  <li key={image.src}>
                    <AgentImagePreview
                      src={image.src}
                      name={image.name}
                      label={s.conversation.previewAttachment(name)}
                    />
                    <span title={image.name}>{name}</span>
                    <IconButton
                      size="small"
                      aria-label={s.conversation.removeAttachment(name)}
                      title={s.conversation.removeAttachment(name)}
                      disabled={sending}
                      onClick={() => removeImage(index)}
                    >
                      <X />
                    </IconButton>
                  </li>
                );
              })}
              {draft.files.map((file, index) => (
                <li key={`file-${index}`}>
                  <FileText size={14} aria-hidden="true" />
                  <span title={file.name}>{file.name}</span>
                  <IconButton
                    size="small"
                    aria-label={s.conversation.removeAttachment(file.name)}
                    title={s.conversation.removeAttachment(file.name)}
                    disabled={sending}
                    onClick={() => removeFile(index)}
                  >
                    <X />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
          <div
            className={`agent-conversation-draft${AGENT_CONVERSATION_IMAGE_MARKERS.test(draft.text) ? " has-chips" : ""}`}
          >
            <AgentConversationDraftBackdrop
              draft={draft.text}
              ref={backdropRef}
            />
            <textarea
              ref={textareaRef}
              aria-label={t("design.placeholder")}
              disabled={!!disabledReason}
              readOnly={sending}
              placeholder={disabledReason ?? t("design.placeholder")}
              rows={1}
              value={draft.text}
              onChange={(event) =>
                setDraft({
                  ...draftNow.current,
                  text: event.currentTarget.value,
                })
              }
              onScroll={(event) => {
                if (backdropRef.current)
                  backdropRef.current.scrollTop = event.currentTarget.scrollTop;
              }}
              onPaste={onPaste}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  isImeComposing(event.nativeEvent)
                )
                  return;
                event.preventDefault();
                void send();
              }}
            />
          </div>
          <div className="agent-conversation-controls">
            <IconButton
              aria-label={t("design.canvas.target")}
              title={t("design.canvas.target")}
              aria-pressed={targeting}
              selected={targeting}
              disabled={!frames.length}
              onClick={() => setTargeting(!targeting)}
            >
              <Crosshair />
            </IconButton>
            <IconButton
              aria-label={s.conversation.attach}
              title={s.conversation.attach}
              disabled={!attachable.current}
              onClick={() => pickerRef.current?.click()}
            >
              <Paperclip />
            </IconButton>
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attachFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <div className="agent-conversation-controls-end">
              {/* Always mounted: a live region announces changes only once it exists. */}
              <span
                className="agent-conversation-context design-prompt-status"
                role="status"
                title={(!sending && queued?.error) || undefined}
              >
                {working ? (
                  <LoaderCircle
                    size={12}
                    className="app-loading-spinner"
                    aria-hidden="true"
                  />
                ) : null}
                {promptStatus}
              </span>
              {awaiting && session ? (
                <button
                  type="button"
                  className="design-prompt-logs"
                  onClick={() => setLogsOpen(true)}
                >
                  {t("design.openLogs")}
                </button>
              ) : null}
              <IconButton
                className="agent-conversation-send"
                aria-label={t("design.send")}
                title={disabledReason ?? t("design.send")}
                disabled={
                  !!disabledReason ||
                  sending ||
                  reading > 0 ||
                  (!draft.text.trim() &&
                    !draft.images.length &&
                    !draft.files.length)
                }
                onClick={() => void send()}
              >
                <ArrowUp />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
      {logsOpen && session ? (
        <aside
          id={`design-logs-${board.id}`}
          className="design-logs"
          aria-label={t("design.logs")}
        >
          <header className="design-logs-header">
            <h2>{t("design.logs")}</h2>
            <IconButton
              aria-label={t("design.closeLogs")}
              title={t("design.closeLogs")}
              onClick={() => {
                setLogsOpen(false);
                logsButtonRef.current?.focus();
              }}
            >
              <X />
            </IconButton>
          </header>
          {renderTerminal(session, visible)}
        </aside>
      ) : null}
    </>
  );
}
