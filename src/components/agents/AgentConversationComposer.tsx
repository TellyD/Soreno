import { Menu } from "@base-ui/react/menu";
import {
  ArrowUp,
  Ellipsis,
  EyeOff,
  FileText,
  History,
  ImageIcon,
  LoaderCircle,
  Paperclip,
  Sparkle,
  Square,
  SquarePen,
  SquareSlash,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { searchProjectFiles } from "../../data/projectFilesApi";
import type { AgentConversationState } from "../../domain/agentConversation";
import {
  agentConversationCommandAt,
  agentConversationCommandMatches,
  insertAgentConversationCommand,
  type AgentConversationCommandToken,
} from "../../domain/agentConversationCommands";
import {
  AGENT_CONVERSATION_IMAGE_MARKERS,
  agentConversationImageCount,
  type AgentConversationAttachment,
} from "../../domain/agentConversationAttachments";
import {
  agentConversationHistory,
  recallAgentConversationMessage,
  type AgentConversationRecall,
} from "../../domain/agentConversationHistory";
import {
  agentConversationMentionAt,
  agentConversationMentionToken,
  insertAgentConversationMention,
  interleaveMentionPaths,
  type AgentConversationMention,
  type AgentConversationMentionRoot,
} from "../../domain/agentConversationMentions";
import { isImeComposing, listNavigation } from "../../domain/keyboard";
import { projectFileName, projectFileParent } from "../../domain/projectFiles";
import { readRecentProjectFiles } from "../../domain/recentProjectFiles";
import { useAppSettings } from "../../settings";
import { FileIcon } from "../FileIcon";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { Select } from "../ui/Select";
import { AgentImagePreview } from "./AgentImagePreview";
import { label } from "./agentConversationStrings";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationComposer.css";

type Strings = AgentStrings["conversation"];

const MENTION_RESULTS = 8;
const MENTION_SEARCH_DELAY = 60;

export type PendingAttachment = { id: number; name: string };

type AgentConversationComposerProps = {
  /** `@` completes the paths of these projects: the folder OMP runs in, or a group overview's members. */
  mentionRoots: readonly AgentConversationMentionRoot[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange: (draft: string) => void;
  attachments: readonly AgentConversationAttachment[];
  onAttach: (files: File[]) => void;
  /** A paste without text nor files: an image may only be on the native clipboard. */
  onPasteWithoutFiles: () => void;
  onRemoveAttachment: (index: number) => void;
  /** Files still being read or transferred, each cancellable: sending waits for them. */
  pending: readonly PendingAttachment[];
  onCancelPending: (id: number) => void;
  conversation: Pick<
    AgentConversationState,
    | "busy"
    | "background"
    | "compacting"
    | "entries"
    | "queued"
    | "model"
    | "models"
    | "commands"
    | "thinkingLevel"
    | "thinkingLevels"
    | "stats"
    | "goal"
  >;
  running: boolean;
  /** Running, with no step, compaction or conversation switch in progress. */
  idle: boolean;
  /** A conversation switch is pending: the draft can be neither edited nor sent. */
  locked: boolean;
  onSubmit: () => void;
  onAbort: () => void;
  onModelChange: (modelKey: string) => void;
  onThinkingLevelChange: (level: string) => void;
  onNewConversation: () => void;
  onResumeConversation: () => void;
  toolsHidden: boolean;
  onToolsHiddenChange: (hidden: boolean) => void;
  s: Strings;
};

/** `provider/id`: two providers may serve the same model id. */
export const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}/${model.id}`;

export function AgentConversationComposer({
  mentionRoots,
  textareaRef,
  draft,
  onDraftChange,
  attachments,
  onAttach,
  onPasteWithoutFiles,
  onRemoveAttachment,
  pending,
  onCancelPending,
  conversation,
  running,
  idle,
  locked,
  onSubmit,
  onAbort,
  onModelChange,
  onThinkingLevelChange,
  onNewConversation,
  onResumeConversation,
  toolsHidden,
  onToolsHiddenChange,
  s,
}: AgentConversationComposerProps) {
  const previewId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<AgentConversationAttachment | null>(
    null,
  );
  const previewAttachment =
    preview?.kind === "file" && attachments.includes(preview) ? preview : null;
  const { stats } = conversation;
  const working = conversation.busy || conversation.compacting;
  const mentionListId = useId();
  // Callers rebuild the list on each render: key the searches on its content.
  const rootsKey = JSON.stringify(mentionRoots);
  const roots = useMemo(
    () => JSON.parse(rootsKey) as AgentConversationMentionRoot[],
    [rootsKey],
  );
  const [mention, setMention] = useState<AgentConversationMention | null>(null);
  const [mentionResults, setMentionResults] = useState<{
    query: string;
    paths: string[];
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionCaret = useRef<number | null>(null);
  const mentionRefresh = useRef<Promise<unknown>>(Promise.resolve());
  // The text and caret a completion left: its token must not reopen as a mention.
  const mentionDone = useRef<{ text: string; caret: number } | null>(null);
  // The draft may have changed without a caret event (sent, restored): drop a stale mention.
  const activeMention =
    mention && !locked && draft.startsWith(`@${mention.query}`, mention.start)
      ? mention
      : null;
  const mentionPaths =
    activeMention && mentionResults?.query === activeMention.query
      ? mentionResults.paths
      : [];
  const mentionStart = activeMention?.start;
  const mentionQuery = activeMention?.query;
  const [command, setCommand] = useState<AgentConversationCommandToken | null>(
    null,
  );
  const activeCommand =
    command && !locked && draft.startsWith(`/${command.query}`, command.start)
      ? command
      : null;
  const { hiddenChatCommands } = useAppSettings().settings;
  const commandMatches = activeCommand
    ? agentConversationCommandMatches(
        conversation.commands.filter(
          ({ name }) => !hiddenChatCommands.includes(name),
        ),
        activeCommand,
      )
    : [];
  const suggestions = mentionPaths.length || commandMatches.length;
  const commandStart = activeCommand?.start;
  const commandQuery = activeCommand?.query;
  const [recall, setRecall] = useState<AgentConversationRecall>(null);
  const draftParts = draft.split(AGENT_CONVERSATION_IMAGE_MARKERS);
  const backdrop = useRef<HTMLDivElement>(null);

  function syncBackdrop() {
    if (backdrop.current && textareaRef.current)
      backdrop.current.scrollTop = textareaRef.current.scrollTop;
  }

  // Grows with its content up to the stylesheet's max height.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    syncBackdrop();
  }, [draft, textareaRef]);

  // A marker holds a space, so it may wrap: its chip would then sit over one fragment only.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const markSplitChips = () =>
      backdrop.current
        ?.querySelectorAll(".agent-conversation-draft-chip")
        .forEach((chip) =>
          chip.classList.toggle("is-split", chip.getClientRects().length > 1),
        );
    markSplitChips();
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(markSplitChips);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft, textareaRef]);

  // No dependencies: a completion may leave the draft unchanged and only move the caret.
  useLayoutEffect(() => {
    if (mentionCaret.current === null) return;
    textareaRef.current?.setSelectionRange(
      mentionCaret.current,
      mentionCaret.current,
    );
    mentionCaret.current = null;
  });

  // Refreshes the file index once per mention: its keystrokes then search the cached one.
  useEffect(() => {
    if (mentionStart === undefined) return;
    mentionRefresh.current = Promise.allSettled(
      roots.map((root) => searchProjectFiles(root.projectId, "", true)),
    );
  }, [roots, mentionStart]);

  // shortcut: a catalog update shrinking the open list keeps a stale index (Enter falls back to the first); reset on `conversation.commands` if it bites.
  useEffect(() => setMentionIndex(0), [commandStart, commandQuery]);

  useEffect(() => {
    document
      .getElementById(`${mentionListId}-${mentionIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [mentionListId, mentionIndex]);

  useEffect(() => {
    setMentionIndex(0);
    if (mentionQuery === undefined) return;
    const prefixed = (root: AgentConversationMentionRoot, paths: string[]) =>
      paths
        .map((path) => (root.folder ? `${root.folder}/${path}` : path))
        .filter((path) => agentConversationMentionToken(path) !== null);
    if (!mentionQuery) {
      setMentionResults({
        query: "",
        paths: interleaveMentionPaths(
          roots.map((root) =>
            prefixed(root, readRecentProjectFiles(root.projectId)),
          ),
          MENTION_RESULTS,
        ),
      });
      return;
    }
    // `@folder/…` searches only that member.
    const scoped = roots.find(
      (root) => root.folder && mentionQuery.startsWith(`${root.folder}/`),
    );
    const searches = scoped
      ? [{ root: scoped, query: mentionQuery.slice(scoped.folder.length + 1) }]
      : roots.map((root) => ({ root, query: mentionQuery }));
    let current = true;
    const timer = window.setTimeout(async () => {
      // Searching before the refresh ends would read a stale or cold inventory.
      await mentionRefresh.current;
      if (!current) return;
      Promise.all(
        searches.map(({ root, query }) =>
          query
            ? searchProjectFiles(
                root.projectId,
                query,
                false,
                readRecentProjectFiles(root.projectId),
              )
                .then((result) =>
                  prefixed(
                    root,
                    result.entries.map((entry) => entry.path),
                  ),
                )
                // A failed search leaves the mention as typed text, without hiding other members' results.
                .catch(() => [])
            : prefixed(root, readRecentProjectFiles(root.projectId)),
        ),
      ).then((lists) => {
        if (!current) return;
        setMentionResults({
          query: mentionQuery,
          paths: interleaveMentionPaths(lists, MENTION_RESULTS),
        });
      });
    }, MENTION_SEARCH_DELAY);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [roots, mentionQuery]);

  function updateMention(textarea: HTMLTextAreaElement) {
    const caret = textarea.selectionStart;
    const done = mentionDone.current;
    const open =
      caret === textarea.selectionEnd &&
      !(done?.text === textarea.value && done.caret === caret);
    setMention(open ? agentConversationMentionAt(textarea.value, caret) : null);
    setCommand(open ? agentConversationCommandAt(textarea.value, caret) : null);
  }

  function chooseMention(path: string) {
    if (!activeMention) return;
    const next = insertAgentConversationMention(draft, activeMention, path);
    if (!next) return;
    mentionCaret.current = next.caret;
    mentionDone.current = next;
    setMention(null);
    onDraftChange(next.text);
  }

  function chooseCommand(name: string) {
    if (!activeCommand) return;
    const next = insertAgentConversationCommand(draft, activeCommand, name);
    mentionCaret.current = next.caret;
    mentionDone.current = next;
    setCommand(null);
    onDraftChange(next.text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposing(event.nativeEvent) || locked) return;
    if ((activeMention || activeCommand) && event.key === "Escape") {
      event.preventDefault();
      setMention(null);
      setCommand(null);
      return;
    }
    if (suggestions > 0) {
      const move = listNavigation(event.key, suggestions);
      if (move && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setMentionIndex(move);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        if (mentionPaths.length > 0)
          chooseMention(mentionPaths[mentionIndex] ?? mentionPaths[0]);
        else
          chooseCommand(
            (commandMatches[mentionIndex] ?? commandMatches[0]).name,
          );
        return;
      }
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    ) {
      const textarea = event.currentTarget;
      const caret = textarea.selectionStart;
      // shortcut: logical lines, so ↑ on a soft-wrapped first line recalls instead of moving up a row; measure rows if users trip on it.
      const edge =
        caret === textarea.selectionEnd &&
        (event.key === "ArrowUp"
          ? !draft.slice(0, caret).includes("\n")
          : !draft.includes("\n", caret));
      const next =
        edge &&
        recallAgentConversationMessage(
          agentConversationHistory(conversation),
          recall,
          draft,
          event.key,
        );
      if (next) {
        event.preventDefault();
        // ↑ leaves the caret on the first line, ↓ on the last: the next press keeps browsing.
        const at = event.key === "ArrowUp" ? 0 : next.text.length;
        mentionCaret.current = at;
        mentionDone.current = { text: next.text, caret: at };
        setMention(null);
        setCommand(null);
        setRecall(next.recall);
        onDraftChange(next.text);
        return;
      }
    }
    if (event.key === "Escape" && working && !draft) {
      event.preventDefault();
      onAbort();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    onSubmit();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked) return event.preventDefault();
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      onAttach(files);
    } else if (!event.clipboardData.types.includes("text/plain"))
      onPasteWithoutFiles();
  }

  const models = conversation.models;
  const currentModel = conversation.model;
  const modelOptions = models.map((model) => ({
    value: modelKey(model),
    label: model.name,
    // Second line: dated snapshots share their family's name, the id tells them apart.
    description: models.some(
      (other) => other !== model && other.name === model.name,
    )
      ? `${model.provider} · ${model.id}`
      : model.provider,
  }));
  // The running model may not be in the list (credentials removed since): keep it shown.
  if (
    currentModel &&
    !models.some((model) => modelKey(model) === modelKey(currentModel))
  )
    modelOptions.unshift({
      value: modelKey(currentModel),
      label: currentModel.name,
      description: currentModel.provider,
    });

  return (
    <div className="agent-conversation-composer">
      {mentionPaths.length > 0 ? (
        <MenuSurface
          id={mentionListId}
          role="listbox"
          aria-label={s.mentionFiles}
          className="agent-conversation-mentions"
        >
          {mentionPaths.map((path, index) => (
            <MenuItem
              key={path}
              id={`${mentionListId}-${index}`}
              role="option"
              aria-selected={index === mentionIndex}
              selected={index === mentionIndex}
              tabIndex={-1}
              leading={<FileIcon name={projectFileName(path)} size={14} />}
              title={path}
              // Keeps the focus, and so the caret, in the draft.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => chooseMention(path)}
            >
              {projectFileName(path)}
              {projectFileParent(path) ? (
                <span className="agent-conversation-mention-detail">
                  {projectFileParent(path)}
                </span>
              ) : null}
            </MenuItem>
          ))}
        </MenuSurface>
      ) : commandMatches.length > 0 ? (
        <MenuSurface
          id={mentionListId}
          role="listbox"
          aria-label={s.commands}
          className="agent-conversation-mentions"
        >
          {commandMatches.map(({ name, description }, index) => (
            <MenuItem
              key={name}
              id={`${mentionListId}-${index}`}
              role="option"
              aria-selected={index === mentionIndex}
              selected={index === mentionIndex}
              tabIndex={-1}
              leading={
                name.startsWith("skill:") ? <Sparkle /> : <SquareSlash />
              }
              title={description || name}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => chooseCommand(name)}
            >
              {name}
              {description ? (
                <span className="agent-conversation-mention-detail">
                  {description}
                </span>
              ) : null}
            </MenuItem>
          ))}
        </MenuSurface>
      ) : null}
      <div
        className="agent-conversation-input"
        // The whole frame reads as the field: a click on its padding writes.
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        {attachments.length > 0 || pending.length > 0 ? (
          <ul
            className="agent-conversation-attachments"
            aria-label={s.attachments}
          >
            {attachments.map((attachment, index) => {
              // Images go by the number of their marker in the draft.
              const name =
                attachment.kind === "image"
                  ? s.image(
                      agentConversationImageCount(
                        attachments.slice(0, index + 1),
                      ),
                    )
                  : attachment.name;
              return (
                <li key={index}>
                  {attachment.kind === "image" ? (
                    <AgentImagePreview
                      src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`}
                      name={attachment.name}
                      label={s.previewAttachment(name)}
                    />
                  ) : (
                    <FileText size={14} aria-hidden="true" />
                  )}
                  {attachment.kind === "file" ? (
                    <button
                      type="button"
                      className="agent-conversation-attachment-toggle"
                      aria-label={s.previewAttachment(name)}
                      aria-expanded={previewAttachment === attachment}
                      aria-controls={
                        previewAttachment === attachment ? previewId : undefined
                      }
                      title={name}
                      onClick={() =>
                        setPreview(preview === attachment ? null : attachment)
                      }
                    >
                      {name}
                    </button>
                  ) : (
                    <span title={attachment.name}>{name}</span>
                  )}
                  <IconButton
                    size="small"
                    aria-label={s.removeAttachment(name)}
                    title={s.removeAttachment(name)}
                    disabled={locked}
                    onClick={() => onRemoveAttachment(index)}
                  >
                    <X />
                  </IconButton>
                </li>
              );
            })}
            {pending.map((item) => (
              <li key={`pending-${item.id}`}>
                <LoaderCircle
                  className="app-loading-spinner"
                  size={14}
                  role="status"
                  aria-label={s.attachmentSending(item.name)}
                />
                <span title={item.name}>{item.name}</span>
                <IconButton
                  size="small"
                  aria-label={s.cancelAttachment(item.name)}
                  title={s.cancelAttachment(item.name)}
                  onClick={() => onCancelPending(item.id)}
                >
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}
        {previewAttachment ? (
          <section
            id={previewId}
            className="agent-conversation-attachment-preview"
            aria-label={s.previewAttachment(previewAttachment.name)}
          >
            <pre tabIndex={0}>{previewAttachment.file.content}</pre>
          </section>
        ) : null}
        <div
          className={`agent-conversation-draft${draftParts.length > 1 ? " has-chips" : ""}`}
        >
          {/* A textarea cannot style its text: chips are drawn beneath its transparent copy. */}
          {draftParts.length > 1 ? (
            <div
              ref={backdrop}
              className="agent-conversation-draft-backdrop"
              aria-hidden="true"
            >
              {draftParts.map((part, index) =>
                index % 2 ? (
                  <span key={index} className="agent-conversation-draft-chip">
                    {part}
                    <span>
                      <ImageIcon size={12} />
                      <span>{part.slice(1, -1)}</span>
                    </span>
                  </span>
                ) : (
                  part
                ),
              )}
              {/* Keeps a trailing empty line, so both scroll as far. */}
              {"\u200b"}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            aria-label={s.placeholder}
            aria-autocomplete="list"
            aria-controls={suggestions > 0 ? mentionListId : undefined}
            aria-activedescendant={
              suggestions > 0 ? `${mentionListId}-${mentionIndex}` : undefined
            }
            disabled={!running}
            // Stays focusable during a switch, so the draft is kept in view.
            readOnly={locked}
            onChange={(event) => {
              mentionDone.current = null;
              onDraftChange(event.currentTarget.value);
              updateMention(event.currentTarget);
            }}
            onSelect={(event) => updateMention(event.currentTarget)}
            onScroll={syncBackdrop}
            onBlur={() => {
              setMention(null);
              setCommand(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={conversation.busy ? s.placeholderBusy : s.placeholder}
            rows={1}
            value={draft}
          />
        </div>
        <div className="agent-conversation-controls">
          <IconButton
            aria-label={s.attach}
            title={s.attach}
            disabled={!running || locked}
            onClick={() => picker.current?.click()}
          >
            <Paperclip />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              onAttach(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {currentModel ? (
            <Select
              size="small"
              popupClassName="agent-conversation-select-popup"
              aria-label={s.model}
              disabled={!idle || modelOptions.length < 2}
              value={modelKey(currentModel)}
              valueLabel={currentModel.name}
              options={modelOptions}
              onValueChange={onModelChange}
              search={{ placeholder: s.modelSearch, empty: s.noModel }}
            />
          ) : null}
          {conversation.thinkingLevels.length > 1 &&
          conversation.thinkingLevel ? (
            <Select
              size="small"
              popupClassName="agent-conversation-select-popup"
              aria-label={s.thinking}
              disabled={!idle}
              value={conversation.thinkingLevel}
              valueLabel={`${s.thinking} : ${label(
                s.thinkingLevels,
                conversation.thinkingLevel,
              )}`}
              options={conversation.thinkingLevels.map((level) => ({
                value: level,
                label: label(s.thinkingLevels, level),
              }))}
              onValueChange={onThinkingLevelChange}
            />
          ) : null}
          <div className="agent-conversation-controls-end">
            {conversation.goal ? (
              <>
                <span
                  className="agent-conversation-goal"
                  title={conversation.goal.objective}
                >
                  {s.goalIndicator(
                    label(s.goalStatuses, conversation.goal.status),
                  )}
                </span>
                {stats?.contextPercent != null ? (
                  <span
                    className="agent-conversation-separator"
                    aria-hidden="true"
                  />
                ) : null}
              </>
            ) : null}
            {stats?.contextPercent != null ? (
              <span
                className="agent-conversation-context"
                title={
                  stats.contextTokens !== null && stats.contextWindow !== null
                    ? s.contextTitle(
                        stats.contextTokens,
                        stats.contextWindow,
                        stats.totalTokens,
                        stats.cost,
                      )
                    : undefined
                }
              >
                {s.context(stats.contextPercent)}
              </span>
            ) : null}
            <IconButton
              aria-label={s.hideTools}
              aria-pressed={toolsHidden}
              selected={toolsHidden}
              title={s.hideTools}
              onClick={() => onToolsHiddenChange(!toolsHidden)}
            >
              <EyeOff />
            </IconButton>
            <Menu.Root modal={false}>
              <Menu.Trigger
                render={
                  <IconButton aria-label={s.moreActions} title={s.moreActions}>
                    <Ellipsis />
                  </IconButton>
                }
              />
              <Menu.Portal>
                <Menu.Positioner
                  className="agent-menu-positioner"
                  sideOffset={4}
                  align="end"
                  side="top"
                  collisionPadding={8}
                >
                  <Menu.Popup
                    render={<MenuSurface className="agent-actions-menu" />}
                  >
                    <Menu.Item
                      nativeButton
                      disabled={!idle}
                      render={<MenuItem leading={<SquarePen />} />}
                      onClick={onNewConversation}
                    >
                      {s.newConversation}
                    </Menu.Item>
                    <Menu.Item
                      nativeButton
                      disabled={!idle}
                      render={<MenuItem leading={<History />} />}
                      onClick={onResumeConversation}
                    >
                      {s.resumeConversation}
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            {/* While OMP works, an empty draft turns the send button into Stop. */}
            {working && !draft.trim() && attachments.length === 0 ? (
              <IconButton
                className="agent-conversation-send is-stop"
                aria-label={conversation.background ? s.stopBackground : s.stop}
                title={conversation.background ? s.stopBackground : s.stopHint}
                onClick={onAbort}
              >
                <Square />
              </IconButton>
            ) : (
              <IconButton
                className="agent-conversation-send"
                aria-label={s.send}
                title={s.send}
                disabled={
                  !running ||
                  conversation.compacting ||
                  locked ||
                  pending.length > 0 ||
                  (!draft.trim() && attachments.length === 0)
                }
                onClick={onSubmit}
              >
                <ArrowUp />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
