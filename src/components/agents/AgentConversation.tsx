import { isTauri } from "@tauri-apps/api/core";
import { FileUp, MessagesSquare, Newspaper, RotateCw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { attachAgentFile } from "../../data/agentSessionsApi";
import {
  blobBase64,
  readTerminalClipboard,
  writeClipboardText,
} from "../../data/clipboard";
import type { AgentConversationImage } from "../../domain/agentConversation";
import type { AgentConversationMentionRoot } from "../../domain/agentConversationMentions";
import {
  AGENT_CONVERSATION_ATTACHMENT_LIMIT,
  AGENT_CONVERSATION_IMAGE_TYPES,
  agentConversationAttachmentRefusal,
  agentConversationImageCount,
  agentConversationImageMarker,
  agentConversationFileText,
  agentConversationPrompt,
  insertAgentConversationToken,
  renumberAgentConversationImageMarkers,
  splitAgentConversationPrompt,
  type AgentConversationAttachment,
} from "../../domain/agentConversationAttachments";
import {
  agentConversationBtwRequest,
  agentConversationGoalRequest,
  recordChatCommandCatalog,
} from "../../domain/agentConversationCommands";
import {
  AgentAttachmentTooLargeError,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import { errorMessage } from "../../domain/errors";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { useStoredPreference } from "../../hooks/useStoredPreference";
import { useOmpUpdate } from "../../hooks/useOmpUpdate";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import {
  AgentConversationComposer,
  modelKey,
  type PendingAttachment,
} from "./AgentConversationComposer";
import { AgentConversationBtw } from "./AgentConversationBtw";
import { AgentConversationDialog } from "./AgentConversationDialog";
import { AgentConversationResumeDialog } from "./AgentConversationResumeDialog";
import { AgentConversationSubagents } from "./AgentConversationSubagents";
import { AgentConversationTodos } from "./AgentConversationTodos";
import {
  ConversationEntry,
  Elapsed,
  Stopped,
} from "./AgentConversationTranscript";
import { useAgentStrings } from "./agentStrings";
import "./AgentConversation.css";

type AgentConversationProps = {
  sessionId: string;
  projectId: string;
  /** A group overview's members, searched by `@` instead of its own folder. */
  mentionRoots?: readonly AgentConversationMentionRoot[];
  name: string;
  state: AgentSessionStatus["state"];
  /** The session has a conversation OMP can resume. */
  resumable: boolean;
  /** Soreno is launching it: the stopped panel would flash before the run starts. */
  starting: boolean;
  visible: boolean;
  runRevision: number;
  focusRequest: number | null;
  onFocus?: (sessionId: string) => void;
  onStart: () => void;
  /** Stops then starts the run, e.g. to pick up an updated OMP. */
  onRestart: () => void;
  /** Replaces the stopped panel, e.g. when OMP is not installed. */
  notice?: ReactNode;
  remote?: boolean;
};

const imageAttachment = (
  image: AgentConversationImage,
  name: string,
): AgentConversationAttachment => ({
  kind: "image",
  name,
  // Base64 holds 3 bytes in 4 characters.
  size: Math.floor((image.data.length * 3) / 4),
  image,
});

// Within this distance of the end, new content keeps the view at the bottom.
const STICK_PX = 80;

const parseToolsHidden = (stored: string | null) => stored === "true";

export function AgentConversation({
  sessionId,
  projectId,
  mentionRoots,
  name,
  state: runState,
  resumable,
  starting,
  visible,
  runRevision,
  focusRequest,
  onFocus,
  onStart,
  onRestart,
  notice,
  remote = false,
}: AgentConversationProps) {
  const s = useAgentStrings().conversation;
  const running = runState === "running";
  const conversation = useAgentConversation(
    sessionId,
    runState !== "idle",
    runRevision,
  );
  const [draft, setDraftState] = useState("");
  const [attachments, setAttachmentsState] = useState<
    AgentConversationAttachment[]
  >([]);
  // Mirrors of the composer, current between renders: late reads and refusals check them.
  const draftNow = useRef(draft);
  const attachmentsNow = useRef(attachments);
  // Where the last insertion left the caret, until the textarea renders it.
  const draftCaret = useRef<number | null>(null);
  // Files are read one batch at a time, each checked against the ones added before it.
  const attachQueue = useRef(Promise.resolve());
  // Files waiting or being read; cancelling one drops it from here, and its result is ignored.
  const [pending, setPendingState] = useState<PendingAttachment[]>([]);
  const pendingNow = useRef(pending);
  const nextPending = useRef(0);
  // A new conversation is on its way: the transcript is about to be replaced.
  const [switching, setSwitching] = useState(false);
  const [resumePicker, setResumePicker] = useState(false);
  // Shared by every open conversation: toggling it in one updates them all.
  const [toolsHidden, setToolsHidden] = useStoredPreference(
    "soreno.agents.hide-tools.v1",
    "soreno:agents-hide-tools-change",
    parseToolsHidden,
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastScrollTop = useRef(0);
  // Each send's generation: an older refusal never restores over a newer message.
  const submission = useRef(0);
  const { state } = conversation;
  const { entries, dialogs, busy, compacting, commands } = state;
  const ready = running && conversation.loaded;
  const loading = starting || (running && !conversation.loaded);
  const idle = ready && !busy && !compacting && !switching;
  const workStarted = useWorkStart(busy || compacting);

  // Where the focus was when a request found the composer disabled; undefined: none pending.
  const deferredFocus = useRef<Element | null | undefined>(undefined);

  useEffect(() => {
    const textarea = composer.current;
    deferredFocus.current = undefined;
    if (!visible || focusRequest === null || !textarea) return;
    // Activating the pane from one of its fields (a request's answer) keeps that focus.
    if (
      document.querySelector('[aria-modal="true"]') ||
      textarea
        .closest(".agent-conversation")
        ?.contains(document.activeElement)
    )
      return;
    if (textarea.disabled) deferredFocus.current = document.activeElement;
    else textarea.focus();
  }, [focusRequest, visible]);

  // Settings show the last chat opened: a hidden one never overwrites it.
  useEffect(() => {
    if (visible && commands.length) recordChatCommandCatalog(commands);
  }, [commands, visible]);

  useEffect(() => {
    const from = deferredFocus.current;
    if (!ready || from === undefined) return;
    deferredFocus.current = undefined;
    // The user moved the focus while the run started: it stays there.
    const active = document.activeElement;
    if (visible && (active === from || active === document.body))
      composer.current?.focus();
  }, [ready, visible]);

  useEffect(() => {
    const element = history.current;
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [entries, dialogs, busy, compacting, visible]);

  // A late-sized block (a rendered diagram) grows the transcript after the render;
  // a taller composer or a smaller window shrinks the visible history instead.
  useEffect(() => {
    const element = history.current;
    const column = element?.firstElementChild;
    if (!element || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(column);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const drop = useFileDropTarget(
    () => ready && !switching,
    (files) => attach(files),
  );

  function setDraft(next: string) {
    draftNow.current = next;
    setDraftState(next);
  }

  function setAttachments(next: AgentConversationAttachment[]) {
    attachmentsNow.current = next;
    setAttachmentsState(next);
  }

  useLayoutEffect(() => {
    const caret = draftCaret.current;
    draftCaret.current = null;
    const textarea = composer.current;
    if (caret !== null && textarea) textarea.setSelectionRange(caret, caret);
  });

  /** Inserts `token` at the caret, or at the end when the textarea lags the draft. */
  function insertInDraft(token: string) {
    const textarea = composer.current;
    const draft = draftNow.current;
    const next = insertAgentConversationToken(
      draft,
      draftCaret.current ??
        (textarea?.value === draft ? textarea.selectionStart : draft.length),
      token,
    );
    draftCaret.current = next.caret;
    setDraft(next.text);
  }

  function removeAttachment(index: number) {
    const list = attachmentsNow.current;
    if (list[index]?.kind === "image") {
      const removed = agentConversationImageCount(list.slice(0, index + 1));
      setDraft(
        renumberAgentConversationImageMarkers(draftNow.current, (n) =>
          n === removed ? null : n > removed ? n - 1 : n,
        ),
      );
    }
    setAttachments(list.filter((_, position) => position !== index));
  }

  function queueAttachments(read: () => Promise<void>) {
    attachQueue.current = attachQueue.current
      .then(read)
      .catch((reason: unknown) =>
        conversation.reportError(errorMessage(reason)),
      );
  }

  /** Adds `attachment` unless the latest attachments leave it no room. */
  function addAttachment(attachment: AgentConversationAttachment) {
    const refusal = agentConversationAttachmentRefusal(
      attachmentsNow.current,
      {
        name: attachment.name,
        size: attachment.size,
        image: attachment.kind === "image",
      },
      state.model?.images ?? false,
    );
    if (refusal) conversation.reportError(s.attachmentRefused(refusal));
    else {
      const next = [...attachmentsNow.current, attachment];
      setAttachments(next);
      if (attachment.kind === "image")
        insertInDraft(
          agentConversationImageMarker(agentConversationImageCount(next)),
        );
    }
    return refusal;
  }

  function setPending(next: PendingAttachment[]) {
    pendingNow.current = next;
    setPendingState(next);
  }

  const isPending = (id: number) =>
    pendingNow.current.some((item) => item.id === id);

  // shortcut: a path left in the draft dies with the run that received it, a restart before
  // sending leaves it dangling; track uploaded paths per run if users trip on it.
  /** Uploads `file` where OMP can read it, like a terminal drop, and inserts its path in the draft. */
  async function attachByPath(file: File, id: number) {
    // An upload cannot be aborted: a file cancelled while it was read never starts one.
    if (!isPending(id)) return;
    try {
      const path = await attachAgentFile(sessionId, file);
      if (!isPending(id)) return;
      insertInDraft(path);
    } catch (reason) {
      conversation.reportError(
        reason instanceof AgentAttachmentTooLargeError
          ? s.attachmentTooLarge(file.name)
          : `${file.name}: ${errorMessage(reason)}`,
      );
    }
  }

  async function readAttachment(
    file: File,
    image: boolean,
    id: number,
  ): Promise<AgentConversationAttachment | null> {
    try {
      if (image)
        return imageAttachment(
          { data: await blobBase64(file), mimeType: file.type },
          file.name,
        );
      const content = agentConversationFileText(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (content !== null)
        return {
          kind: "file",
          name: file.name,
          size: file.size,
          file: { name: file.name, content },
        };
      await attachByPath(file, id);
    } catch (reason) {
      conversation.reportError(`${file.name}: ${errorMessage(reason)}`);
    }
    return null;
  }

  /** Inlines images the model reads and small text files; any other file goes by path. */
  function attach(files: File[]) {
    if (!ready || switching) return;
    // A drop of a whole folder's files is more likely a slip than a request.
    if (files.length > AGENT_CONVERSATION_ATTACHMENT_LIMIT) {
      conversation.reportError(s.attachmentRefused({ reason: "count" }));
      return;
    }
    const batch = files.map((file) => ({
      id: ++nextPending.current,
      name: file.name,
      file,
    }));
    setPending([
      ...pendingNow.current,
      ...batch.map(({ id, name }) => ({ id, name })),
    ]);
    queueAttachments(async () => {
      try {
        for (const { id, file } of batch) {
          if (!isPending(id)) continue;
          const image = AGENT_CONVERSATION_IMAGE_TYPES[file.type] === true;
          // Checked before reading too, so an oversized file is never read.
          const refusal = agentConversationAttachmentRefusal(
            attachmentsNow.current,
            { name: file.name, size: file.size, image },
            state.model?.images ?? false,
          );
          if (refusal?.reason === "count") {
            conversation.reportError(s.attachmentRefused(refusal));
            break;
          }
          if (refusal) await attachByPath(file, id);
          else {
            const attachment = await readAttachment(file, image, id);
            if (
              attachment &&
              isPending(id) &&
              addAttachment(attachment)?.reason === "count"
            )
              break;
          }
          setPending(pendingNow.current.filter((item) => item.id !== id));
        }
      } finally {
        setPending(
          pendingNow.current.filter(
            (item) => !batch.some((entry) => entry.id === item.id),
          ),
        );
      }
    });
  }

  /** A screenshot some webviews paste without a file: the native clipboard has it. */
  function attachClipboardImage() {
    if (!isTauri() || !ready || switching) return;
    const id = ++nextPending.current;
    setPending([
      ...pendingNow.current,
      {
        id,
        name: s.image(agentConversationImageCount(attachmentsNow.current) + 1),
      },
    ]);
    queueAttachments(async () => {
      try {
        const clipboard = await readTerminalClipboard(true).catch(() => null);
        if (
          !isPending(id) ||
          clipboard?.type !== "image" ||
          !clipboard.dataBase64
        )
          return;
        addAttachment(
          imageAttachment(
            {
              data: clipboard.dataBase64,
              mimeType: clipboard.mimeType ?? "image/png",
            },
            s.image(agentConversationImageCount(attachmentsNow.current) + 1),
          ),
        );
      } finally {
        setPending(pendingNow.current.filter((item) => item.id !== id));
      }
    });
  }

  const { reportError, cancelSubagent } = conversation;
  const copy = useCallback(
    async (text: string) => {
      try {
        await writeClipboardText(text);
        return true;
      } catch (reason) {
        reportError(s.copyFailed(errorMessage(reason)));
        return false;
      }
    },
    [reportError, s],
  );

  async function newConversation() {
    setSwitching(true);
    try {
      await conversation.newConversation();
    } finally {
      setSwitching(false);
    }
  }

  async function resumeConversation(path: string) {
    setSwitching(true);
    try {
      const switched = await conversation.switchConversation(path);
      if (switched === "cancelled") conversation.reportError(s.resumeCancelled);
    } finally {
      setSwitching(false);
    }
  }

  function submit() {
    // Rendered state, like `draft` and `attachments`: a result not rendered yet still blocks.
    if (!ready || compacting || switching || pending.length > 0) return;
    const message = draft.trim();
    if (!message && attachments.length === 0) return;
    const image = attachments.find((item) => item.kind === "image");
    // The model may have changed since the image was attached; OMP would drop it.
    if (image && !state.model?.images) {
      conversation.reportError(
        s.attachmentRefused({ reason: "images", name: image.name }),
      );
      return;
    }
    // OMP's goal and side-question requests carry no attachments: they would be lost.
    const command = agentConversationGoalRequest(message)
      ? "/goal"
      : agentConversationBtwRequest(message)
        ? "/btw"
        : null;
    if (attachments.length > 0 && command) {
      conversation.reportError(s.commandAttachments(command));
      return;
    }
    const generation = ++submission.current;
    const sent = attachments;
    nearBottom.current = true;
    setDraft("");
    setAttachments([]);
    void conversation
      .prompt(
        agentConversationPrompt(
          message,
          sent.flatMap((item) => (item.kind === "file" ? [item.file] : [])),
        ),
        sent.flatMap((item) => (item.kind === "image" ? [item.image] : [])),
      )
      .then((accepted) => {
        // Only the latest refused message comes back, and only into an empty composer.
        if (accepted || generation !== submission.current) return;
        if (draftNow.current.trim() || attachmentsNow.current.length) return;
        setDraft(draft);
        setAttachments(sent);
      });
  }

  /** The messages still queued come back into the composer, before what it holds. */
  async function stop() {
    const { messages: restored, incomplete } = await conversation.abort();
    if (incomplete) conversation.reportError(s.restoreIncomplete);
    if (restored.length === 0) return;
    const messages = restored.map(({ text, images }) => ({
      ...splitAgentConversationPrompt(text),
      images,
    }));
    // Each message numbered its images from 1: they follow the images before them now.
    let images = 0;
    const texts = messages.map(({ text, images: own }) => {
      const offset = images;
      images += own.length;
      return renumberAgentConversationImageMarkers(text, (n) => n + offset);
    });
    setDraft(
      [
        ...texts,
        renumberAgentConversationImageMarkers(
          draftNow.current,
          (n) => n + images,
        ),
      ]
        .filter((text) => text.trim())
        .join("\n\n"),
    );
    // Already taken out of OMP, so none is refused; a refused send brings them back.
    const next: AgentConversationAttachment[] = [];
    for (const { files, images } of messages) {
      for (const file of files)
        next.push({
          kind: "file",
          name: file.name,
          size: new TextEncoder().encode(file.content).length,
          file,
        });
      for (const image of images)
        next.push(
          imageAttachment(
            image,
            s.image(agentConversationImageCount(next) + 1),
          ),
        );
    }
    setAttachments([...next, ...attachmentsNow.current]);
  }

  const lastEntry = entries[entries.length - 1];
  const lastReply = lastEntry?.role === "assistant" ? lastEntry : null;
  // Visible streamed text or running tools show their own progress; hidden tools leave only the last block.
  const streamingText =
    !!lastReply?.streaming &&
    lastReply.blocks
      .slice(toolsHidden ? -1 : 0)
      .some((block) => block.type === "text" && block.text);
  const toolRunning =
    !toolsHidden &&
    !!lastReply?.blocks.some(
      (block) => block.type === "tool" && block.status === "running",
    );
  const thinking =
    (busy || compacting) &&
    dialogs.length === 0 &&
    !streamingText &&
    !toolRunning;
  const awaiting = useMemo(
    () =>
      new Set(
        dialogs.flatMap((dialog) =>
          dialog.kind === "approval" && dialog.toolCallId
            ? [dialog.toolCallId]
            : [],
        ),
      ),
    [dialogs],
  );
  // A resumed conversation is blank until its history arrives, never "new".
  const empty =
    ready &&
    entries.length === 0 &&
    !busy &&
    !compacting &&
    (state.historyLoaded || !resumable);
  const dialog = running ? dialogs[0] : undefined;
  const dialogView = dialog ? (
    <AgentConversationDialog
      key={dialog.id}
      dialog={dialog}
      waiting={dialogs.length - 1}
      onAnswer={(answer) => {
        void conversation.answer(dialog, answer);
        composer.current?.focus({ preventScroll: true });
      }}
      s={s}
    />
  ) : null;
  const { ompUpdate, ompUpdated, setOmpUpdated, updatingOmp, updateOmp } =
    useOmpUpdate(projectId, empty, onRestart, s.updateError);

  return (
    <section
      className="agent-conversation"
      hidden={!visible}
      aria-label={s.label(name)}
      onFocus={onFocus ? () => onFocus(sessionId) : undefined}
      {...drop.handlers}
    >
      {drop.active ? (
        <div className="agent-conversation-file-drop" aria-hidden="true">
          <FileUp size={34} strokeWidth={1.75} />
          <span>{s.dropFiles}</span>
        </div>
      ) : null}
      <div
        ref={history}
        className="agent-conversation-history"
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          // A scroll event lands a frame late: content grown meanwhile (an image) must not unstick.
          nearBottom.current =
            scrollHeight - scrollTop - clientHeight < STICK_PX ||
            (nearBottom.current && scrollTop >= lastScrollTop.current);
          lastScrollTop.current = scrollTop;
        }}
      >
        <div className="agent-conversation-column">
          {empty ? (
            <EmptyState
              icon={<MessagesSquare />}
              title={s.emptyTitle}
              description={s.emptyBody}
              size="compact"
              actions={
                ompUpdate ? (
                  <Button
                    disabled={updatingOmp}
                    aria-busy={updatingOmp}
                    startIcon={<RotateCw />}
                    onClick={() => void updateOmp(ompUpdate)}
                  >
                    {updatingOmp ? s.updating : s.update}
                  </Button>
                ) : ompUpdated ? (
                  <Button
                    disabled={!idle}
                    startIcon={<Newspaper />}
                    onClick={() => {
                      setOmpUpdated(null);
                      // The empty transcript stays at its top: the newest release first.
                      nearBottom.current = false;
                      void conversation.prompt("/changelog");
                    }}
                  >
                    {s.showChangelog}
                  </Button>
                ) : null
              }
            >
              {ompUpdate
                ? s.updateAvailable(ompUpdate)
                : ompUpdated
                  ? s.updated(ompUpdated)
                  : null}
            </EmptyState>
          ) : null}
          {entries.map((entry) => (
            <ConversationEntry
              key={entry.id}
              entry={entry}
              awaiting={awaiting}
              subagents={state.subagents}
              onCopy={copy}
              hideTools={toolsHidden}
              s={s}
            />
          ))}
          {/* Kept while busy, only hidden: a tool or streamed text taking over must not shift the transcript. */}
          {busy || compacting || loading ? (
            <div
              className={`agent-conversation-activity${thinking || loading ? "" : " is-hidden"}`}
              role="status"
              aria-live="polite"
            >
              <span
                className="agent-conversation-activity-dot"
                aria-hidden="true"
              />
              <span>
                {loading
                  ? s.starting
                  : compacting
                    ? s.compacting
                    : state.background
                      ? s.background
                      : s.working}
              </span>
              {workStarted !== null ? (
                <Elapsed since={workStarted} s={s} />
              ) : null}
            </div>
          ) : null}
          {!running && !starting
            ? (notice ?? (
                <Stopped
                  exit={state.exit}
                  idle={runState === "idle"}
                  resumable={resumable}
                  remote={remote}
                  onStart={onStart}
                  s={s}
                />
              ))
            : null}
        </div>
      </div>
      <div className="agent-conversation-dock">
        <AgentConversationBtw
          key={
            state.btwView && state.btwView !== "history"
              ? state.btwView.topic
              : ""
          }
          topics={state.btw}
          view={state.btwView}
          disabled={!ready || switching}
          onShow={conversation.showBtw}
          onCancel={(id) => void conversation.cancelBtw(id)}
          onFollowUp={conversation.askBtw}
          s={s}
        />
        <AgentConversationTodos phases={state.todos} s={s} />
        <AgentConversationSubagents
          agents={state.subagents}
          onCancel={(id) => void cancelSubagent(id)}
          s={s}
        />
        {dialogView}
        {state.queued.length > 0 ? (
          <ul className="agent-conversation-queue" aria-label={s.queued}>
            {state.queued.map((message, index) => {
              const { text, files } = splitAgentConversationPrompt(
                message.text,
              );
              return (
                <li key={index}>
                  <span>
                    {text ||
                      files.map((file) => file.name).join(", ") ||
                      s.attachments}
                  </span>
                  {message.live ? null : (
                    <IconButton
                      size="small"
                      aria-label={s.removeQueued}
                      title={s.removeQueued}
                      disabled={switching}
                      onClick={() => void conversation.removeQueued(message)}
                    >
                      <X />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        <AgentConversationComposer
          mentionRoots={mentionRoots ?? [{ projectId, folder: "" }]}
          textareaRef={composer}
          draft={draft}
          onDraftChange={setDraft}
          attachments={attachments}
          onAttach={attach}
          onPasteWithoutFiles={attachClipboardImage}
          onRemoveAttachment={removeAttachment}
          pending={pending}
          onCancelPending={(id) =>
            setPending(pendingNow.current.filter((item) => item.id !== id))
          }
          conversation={state}
          running={ready}
          idle={idle}
          locked={switching}
          onSubmit={submit}
          onAbort={() => void stop()}
          onModelChange={(key) => {
            const model = state.models.find(
              (candidate) => modelKey(candidate) === key,
            );
            if (model) void conversation.setModel(model);
          }}
          onThinkingLevelChange={(level) =>
            void conversation.setThinkingLevel(level)
          }
          onNewConversation={() => void newConversation()}
          onResumeConversation={() => setResumePicker(true)}
          toolsHidden={toolsHidden}
          onToolsHiddenChange={setToolsHidden}
          s={s}
        />
        {resumePicker
          ? createPortal(
              <AgentConversationResumeDialog
                sessionId={sessionId}
                onClose={() => setResumePicker(false)}
                onSelect={(path) => void resumeConversation(path)}
                s={s}
              />,
              document.body,
            )
          : null}
      </div>
    </section>
  );
}

/** When the current stretch of work started, on Soreno's clock; null while idle. */
function useWorkStart(working: boolean) {
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    setStart(working ? Date.now() : null);
  }, [working]);
  return start;
}
