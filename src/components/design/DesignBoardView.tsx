import { isTauri } from "@tauri-apps/api/core";
import {
  ArrowUp,
  Crosshair,
  FileText,
  FileUp,
  LoaderCircle,
  Palette,
  Paperclip,
  Play,
  Redo2,
  ScrollText,
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
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import { base64ToBytes } from "../../domain/base64";
import {
  designDraftText,
  designPrompt,
  DesignPromptTooLargeError,
  type DesignBoard,
  type DesignFrame,
  type DesignTarget,
} from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { isImeComposing, isTextFieldTarget } from "../../domain/keyboard";
import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { useAgentStrings } from "../agents/agentStrings";
import { AgentConversationDraftBackdrop } from "../agents/AgentConversationDraftBackdrop";
import { AgentImagePreview } from "../agents/AgentImagePreview";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { DesignCanvas } from "./DesignCanvas";
import { DesignImplement, type DesignImplementOptions } from "./DesignAgents";

const boardTarget: DesignTarget = { kind: "board" };
const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

/** A pasted image: its marker `[Image #n]` in the draft stands for the nth one. */
type DesignDraftImage = { name: string; file: File; src: string };
// Attachments are uploaded at send: an agent relaunch empties its folder, and a draft outlives runs.
export type DesignDraft = {
  text: string;
  images: readonly DesignDraftImage[];
  /** Other files, whose paths follow the text. */
  files: readonly File[];
};

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
export function DesignBoardView({
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
