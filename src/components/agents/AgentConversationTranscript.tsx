import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileSearch,
  FileText,
  Globe,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  SquareTerminal,
  Timer,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useEffect, useState } from "react";
import type {
  AgentConversationBlock,
  AgentConversationDiffLine,
  AgentConversationEntry,
  AgentConversationSubagent,
  AgentConversationTool,
} from "../../domain/agentConversation";
import { splitAgentConversationPrompt } from "../../domain/agentConversationAttachments";
import { withoutIssueSummaryTags } from "../../domain/kanbanAgent";
import { MarkdownContent } from "../MarkdownContent";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { AgentImagePreview } from "./AgentImagePreview";
import { SubagentList } from "./AgentConversationSubagents";
import { label } from "./agentConversationStrings";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationTranscript.css";

/** Diff and output previews stop here: the full text stays in OMP's history. */
const PREVIEW_LINES = 400;
const COPIED_FEEDBACK_MS = 1500;

type Strings = AgentStrings["conversation"];

// Memoized: every delta re-renders the view, and old diffs are costly to rebuild.
export const ConversationEntry = memo(function ConversationEntry({
  entry,
  awaiting,
  subagents,
  onCopy,
  hideTools,
  s,
}: {
  entry: AgentConversationEntry;
  /** Tool calls waiting for an approval. */
  awaiting: ReadonlySet<string>;
  subagents: readonly AgentConversationSubagent[];
  onCopy: (text: string) => Promise<boolean>;
  /** Shows only the replies: tool calls and reasoning are left out. */
  hideTools: boolean;
  s: Strings;
}) {
  if (entry.role === "user") {
    const { text, files } = splitAgentConversationPrompt(entry.text);
    return (
      <article className="agent-conversation-message is-user">
        {entry.images.length > 0 ? (
          <div className="agent-conversation-images">
            {entry.images.map((image, index) => (
              <AgentImagePreview
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                name={s.image(index + 1)}
                label={s.previewAttachment(s.image(index + 1))}
              />
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="agent-conversation-user-row">
            <div
              className="agent-conversation-actions"
              role="group"
              aria-label={s.messageActions}
            >
              <CopyButton text={text} onCopy={onCopy} s={s} />
            </div>
            <p className="agent-conversation-user-text">
              {/* Split keeps [text, blank, skill name] triples. */}
              {text.split(/(^|\s)\/skill:(\S+)/).map((part, index) =>
                index % 3 === 2 ? (
                  <span key={index} className="agent-conversation-skill">
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </p>
          </div>
        ) : null}
        {files.length > 0 ? (
          <ul className="agent-conversation-files" aria-label={s.attachments}>
            {files.map((file, index) => (
              <li key={index}>
                <FileText size={13} aria-hidden="true" />
                <span>{file.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    );
  }
  if (entry.role === "notice") {
    const { notice } = entry;
    if (notice.kind === "output")
      return (
        <pre className="agent-conversation-command-output">
          {notice.message}
        </pre>
      );
    if (notice.kind === "changelog")
      return (
        <MarkdownContent
          className="agent-conversation-prose"
          content={notice.markdown}
        />
      );
    // OMP info notices can list hundreds of names (e.g. mounted MCP tools).
    if (notice.kind === "info" && notice.message.length > 200)
      return (
        <details className="agent-conversation-thinking">
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            <span className="agent-conversation-notice-summary">
              {notice.message}
            </span>
          </summary>
          <p className="agent-conversation-notice">{notice.message}</p>
        </details>
      );
    return (
      <p
        className={`agent-conversation-notice${notice.kind === "error" ? " is-error" : ""}`}
        role={notice.kind === "error" ? "alert" : undefined}
      >
        {notice.kind === "retry"
          ? s.retry(notice.attempt, notice.maxAttempts, notice.message)
          : notice.kind === "compacted"
            ? s.compacted(notice.tokensBefore, notice.tokensAfter)
            : notice.kind === "goal"
              ? notice.goal
                ? s.goal(
                    notice.goal.objective,
                    label(s.goalStatuses, notice.goal.status),
                  )
                : s.noGoal
              : notice.message}
      </p>
    );
  }
  // Running agents live in the dock above the composer; the transcript keeps the finished ones.
  const finished = subagents.filter(({ status }) => status !== "running");
  const blocks = entry.blocks.filter((block) => {
    if (block.type === "text") return block.text.trim();
    if (hideTools)
      return (
        block.type === "tool" &&
        block.name === "task" &&
        finished.some((agent) => agent.parentToolCallId === block.id)
      );
    return block.type === "tool" || block.text.trim();
  });
  if (blocks.length === 0 && !entry.error && !entry.aborted) return null;
  return (
    <article className="agent-conversation-message is-agent">
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {hideTools && block.type === "tool" ? null : (
            <Block
              block={block}
              streaming={entry.streaming}
              awaiting={block.type === "tool" && awaiting.has(block.id)}
              s={s}
            />
          )}
          {block.type === "tool" && block.name === "task" ? (
            <SubagentList
              agents={finished.filter(
                (agent) => agent.parentToolCallId === block.id,
              )}
              s={s}
            />
          ) : null}
          {/* Under the text it copies: tools may follow it in the same reply. */}
          {block.type === "text" && !entry.streaming ? (
            <div
              className="agent-conversation-actions"
              role="group"
              aria-label={s.messageActions}
            >
              <CopyButton text={block.text.trim()} onCopy={onCopy} s={s} />
            </div>
          ) : null}
        </Fragment>
      ))}
      {entry.error ? (
        <p className="agent-conversation-notice is-error" role="alert">
          {entry.error}
        </p>
      ) : entry.aborted ? (
        <p className="agent-conversation-notice">{s.aborted}</p>
      ) : null}
    </article>
  );
});

function CopyButton({
  text,
  onCopy,
  s,
}: {
  text: string;
  onCopy: (text: string) => Promise<boolean>;
  s: Strings;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? s.copied : s.copy;
  return (
    <IconButton
      size="small"
      aria-label={label}
      title={label}
      onClick={() => void onCopy(text).then(setCopied)}
    >
      {copied ? <Check className="app-icon-button-feedback" /> : <Copy />}
    </IconButton>
  );
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: SquareTerminal,
  eval: SquareTerminal,
  edit: FilePen,
  write: FilePen,
  read: FileText,
  grep: FileSearch,
  find: FileSearch,
  search: FileSearch,
  ls: FileSearch,
  task: Bot,
  wait: Timer,
  web_search: Globe,
  fetch: Globe,
  browser: Globe,
  todo: ListTodo,
  ask: MessageCircleQuestion,
};

/** The one argument that tells what a call works on. */
function toolSubject(tool: AgentConversationTool) {
  const { args } = tool;
  if (Array.isArray(args.tasks))
    return args.tasks
      .map((task) =>
        task && typeof task === "object" && typeof task.name === "string"
          ? task.name
          : "",
      )
      .filter(Boolean)
      .join(", ");
  for (const key of [
    "command",
    "path",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // A hashline edit names its file as the model wrote it, in its first line: `[path#TAG]`.
  const input = typeof args.input === "string" ? args.input : "";
  return /^\[([^\]#\n]+)#/.exec(input)?.[1] ?? tool.changes?.[0]?.path ?? "";
}

/** What an edit or a write changed; null for the other tools. */
function toolChanges(tool: AgentConversationTool) {
  if (tool.status === "error") return null;
  if (tool.changes?.length) return tool.changes;
  if (tool.name === "write" && typeof tool.args.content === "string")
    return [
      {
        path: typeof tool.args.path === "string" ? tool.args.path : null,
        lines: tool.args.content
          .replace(/\n$/, "")
          .split("\n")
          .map((text, index): AgentConversationDiffLine => ({
            kind: "added",
            line: index + 1,
            text,
          })),
      },
    ];
  return null;
}

function Block({
  block,
  streaming,
  awaiting,
  s,
}: {
  block: AgentConversationBlock;
  streaming: boolean;
  awaiting: boolean;
  s: Strings;
}) {
  if (block.type === "text")
    return (
      <MarkdownContent
        className="agent-conversation-prose"
        content={withoutIssueSummaryTags(block.text)}
      />
    );
  if (block.type === "thinking")
    return (
      <details className="agent-conversation-thinking">
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          {s.reasoning}
        </summary>
        <p>{block.text.trim()}</p>
      </details>
    );
  return (
    <ToolRow tool={block} streaming={streaming} awaiting={awaiting} s={s} />
  );
}

function ToolRow({
  tool,
  streaming,
  awaiting,
  s,
}: {
  tool: AgentConversationTool;
  streaming: boolean;
  awaiting: boolean;
  s: Strings;
}) {
  const Icon = Object.prototype.hasOwnProperty.call(TOOL_ICONS, tool.name)
    ? TOOL_ICONS[tool.name]
    : Wrench;
  const changes = toolChanges(tool);
  const added = changes?.reduce(
    (sum, file) =>
      sum + file.lines.filter(({ kind }) => kind === "added").length,
    0,
  );
  const removed = changes?.reduce(
    (sum, file) =>
      sum + file.lines.filter(({ kind }) => kind === "removed").length,
    0,
  );
  // A question lasts as long as the user takes to answer: no duration to show.
  const timed =
    (tool.status === "done" || tool.status === "error") && tool.name !== "ask";
  // A call the model is still writing has no name yet.
  const preparing = !tool.name;
  // A running question only waits on the user.
  const answering = tool.name === "ask" && tool.status === "running";
  const blocked = awaiting || answering;
  const running =
    !blocked &&
    (tool.status === "running" || (tool.status === "pending" && streaming));
  const status = awaiting
    ? s.toolAwaiting
    : answering
      ? s.toolAnswering
      : preparing
        ? s.toolPreparing
        : s.toolStatus[tool.status];
  const detail = changes?.length ? (
    changes.map((file, index) => (
      <Diff
        key={index}
        path={changes.length > 1 ? file.path : null}
        lines={file.lines}
        s={s}
      />
    ))
  ) : tool.output ? (
    <Output text={tool.output} s={s} />
  ) : null;
  return (
    <details
      className={`agent-conversation-tool is-${blocked ? "awaiting" : tool.status}`}
    >
      <summary title={tool.intent ?? undefined}>
        <span className="agent-conversation-tool-icon" aria-hidden="true">
          {running ? (
            <LoaderCircle className="app-loading-spinner" size={14} />
          ) : (
            <Icon size={14} />
          )}
        </span>
        <span className="agent-conversation-tool-name">
          {preparing ? s.toolPreparing : s.toolName(tool.name)}
        </span>
        <code className="agent-conversation-tool-subject">
          {toolSubject(tool)}
        </code>
        {added || removed ? (
          <span className="agent-conversation-tool-changes">
            {added ? <span className="git-lines-added">+{added}</span> : null}
            {removed ? (
              <span className="git-lines-deleted">−{removed}</span>
            ) : null}
          </span>
        ) : null}
        {preparing ? null : (
          <span className="agent-conversation-tool-status">
            {status}
            {timed && tool.durationMs !== null
              ? ` · ${s.duration(tool.durationMs)}`
              : null}
          </span>
        )}
      </summary>
      {tool.intent ? (
        <p className="agent-conversation-tool-intent">{tool.intent}</p>
      ) : null}
      {detail}
    </details>
  );
}

function Output({ text, s }: { text: string; s: Strings }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const hidden = lines.length - PREVIEW_LINES;
  return (
    <pre className="agent-conversation-tool-output">
      {hidden > 0 ? lines.slice(0, PREVIEW_LINES).join("\n") : text}
      {hidden > 0 ? (
        <span className="agent-conversation-more">{`\n${s.moreLines(hidden)}`}</span>
      ) : null}
    </pre>
  );
}

function Diff({
  path,
  lines,
  s,
}: {
  path: string | null;
  lines: AgentConversationDiffLine[];
  s: Strings;
}) {
  const hidden = lines.length - PREVIEW_LINES;
  return (
    <div className="agent-conversation-diff">
      {path ? <div className="agent-conversation-diff-path">{path}</div> : null}
      <pre>
        {lines.slice(0, PREVIEW_LINES).map((line, index) => (
          <span key={index} className={`is-${line.kind}`}>
            <span className="agent-conversation-diff-gutter" aria-hidden="true">
              {line.line ?? ""}
            </span>
            <span className="agent-conversation-diff-sign" aria-hidden="true">
              {line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "−"
                  : " "}
            </span>
            {line.kind === "gap" ? line.text || "⋯" : line.text}
            {"\n"}
          </span>
        ))}
        {hidden > 0 ? (
          <span className="is-gap">{s.moreLines(hidden)}</span>
        ) : null}
      </pre>
    </div>
  );
}

export function Elapsed({
  since,
  s,
}: {
  since: number;
  s: AgentStrings["conversation"];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - since) / 1000);
  // A second's work needs no counter.
  return seconds >= 2 ? (
    <span className="agent-conversation-elapsed">{s.elapsed(seconds)}</span>
  ) : null;
}

export function Stopped({
  exit,
  idle,
  resumable,
  remote,
  onStart,
  s,
}: {
  exit: { exitCode: number | null; stderr: string } | null;
  idle: boolean;
  resumable: boolean;
  remote: boolean;
  onStart: () => void;
  s: AgentStrings["conversation"];
}) {
  // OpenSSH exits 255 when the connection drops, e.g. after the computer slept.
  const connectionLost = remote && exit?.exitCode === 255;
  const crashed = !!exit && exit.exitCode !== 0 && !connectionLost;
  return (
    <div className={`agent-conversation-stopped${crashed ? " is-error" : ""}`}>
      {crashed ? <CircleAlert size={16} aria-hidden="true" /> : null}
      <p>
        {connectionLost
          ? s.connectionLost
          : crashed
            ? s.crashed(exit.exitCode)
            : idle
              ? s.idle
              : s.stopped}
      </p>
      {crashed && exit.stderr.trim() ? (
        <pre className="agent-conversation-tool-output">
          {exit.stderr.trim()}
        </pre>
      ) : null}
      <Button size="small" variant="primary" onClick={onStart}>
        {resumable ? s.resume : s.start}
      </Button>
    </div>
  );
}
