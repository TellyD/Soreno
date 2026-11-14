import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronDown,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  agentSessionActivity,
  type AgentProject,
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionDesignBoard,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import { type DesignAgentRequest, type DesignBoard } from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { useAgentSessionMessage } from "../../hooks/useAgentSessionMessage";
import { useDesignBoard } from "../../hooks/useDesignBoard";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import type {
  AgentSessionRequest,
  AgentTransitionGuard,
} from "../agents/AgentWorkspace";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { DesignBoardView, type DesignDraft } from "./DesignBoardView";
import { DesignBoardForm, type DesignBoardFormValues } from "./DesignBoardForm";
import { DesignLinkedAgents } from "./DesignAgents";
import "../agents/AgentConversation.css";
import "../agents/AgentConversationComposer.css";
import "./DesignWorkspace.css";

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
