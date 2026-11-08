/** Transcript of an OMP conversation session, rebuilt from `omp --mode rpc-ui` records. */

import {
  agentConversationCommands,
  type AgentConversationCommand,
} from "./agentConversationCommands";
import { agentConversationDialog } from "./agentConversationDialogs";
import { count, isObject, text, type Json } from "./agentConversationRecords";
import { askAnswers, resultChanges } from "./agentConversationToolResults";

type AgentConversationToolStatus = "pending" | "running" | "done" | "error";

/** OMP's `ImageContent`, without its `type`. */
export type AgentConversationImage = { data: string; mimeType: string };

export type AgentConversationDiffLine = {
  kind: "context" | "added" | "removed" | "gap";
  /** Line number in the file; null for a gap marker. */
  line: number | null;
  text: string;
};

export type AgentConversationFileChange = {
  path: string | null;
  lines: AgentConversationDiffLine[];
};

export type AgentConversationTool = {
  type: "tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** What the model said the call is for. */
  intent: string | null;
  status: AgentConversationToolStatus;
  output: string;
  /** Files an edit or a write changed, as OMP reports them. */
  changes: AgentConversationFileChange[] | null;
  /** What the user answered an `ask` call, question by question. */
  answers: AgentConversationAskAnswer[] | null;
  /** Soreno's clock when the run started it; unknown for history. */
  startedAt: number | null;
  durationMs: number | null;
};

export type AgentConversationBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | AgentConversationTool;

type AgentConversationNotice =
  | { kind: "retry"; attempt: number; maxAttempts: number; message: string }
  | {
      kind: "compacted";
      tokensBefore: number | null;
      tokensAfter: number | null;
    }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string }
  | { kind: "goal"; goal: AgentConversationGoal | null }
  | { kind: "output"; message: string }
  | { kind: "changelog"; markdown: string };

export type AgentConversationEntry =
  | { id: number; role: "user"; text: string; images: AgentConversationImage[] }
  | {
      id: number;
      role: "assistant";
      blocks: AgentConversationBlock[];
      streaming: boolean;
      error: string | null;
      aborted: boolean;
    }
  | { id: number; role: "notice"; notice: AgentConversationNotice };

export type AgentConversationAskQuestion = {
  id: string;
  question: string;
  header: string | null;
  options: { label: string; description: string | null }[];
  multi: boolean;
  recommended: number | null;
};

export type AgentConversationAskAnswer = {
  question: string;
  selected: string[];
  custom: string | null;
};

export type AgentConversationDialog =
  | {
      kind: "approval";
      id: string;
      tool: string;
      detail: string;
      options: string[];
      /** The running tool call waiting for this answer. */
      toolCallId: string | null;
    }
  | {
      kind: "select";
      id: string;
      title: string;
      options: { label: string; description: string | null }[];
    }
  | { kind: "confirm"; id: string; title: string; message: string }
  | {
      kind: "input";
      id: string;
      title: string;
      placeholder: string;
      secret: boolean;
    }
  | { kind: "editor"; id: string; title: string; prefill: string }
  | { kind: "ask"; id: string; questions: AgentConversationAskQuestion[] };

/** The `extension_ui_response` fields answering a dialog, besides its type and id. */
export type AgentConversationDialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | {
      answers: {
        id: string;
        selectedOptions: string[];
        customInput?: string;
      }[];
    };

export type AgentConversationModel = {
  provider: string;
  id: string;
  name: string;
  /** The model accepts images in a prompt. */
  images: boolean;
};

export type AgentConversationStats = {
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  totalTokens: number;
  cost: number | null;
};

export type AgentConversationSubagent = {
  id: string;
  /** OMP's agent definition it runs, such as `task` or `reviewer`. */
  agent: string | null;
  index: number;
  description: string | null;
  status: "running" | "completed" | "failed" | "aborted";
  /** What it says it is doing now. */
  activity: string | null;
  toolCount: number;
  tokens: number;
  durationMs: number | null;
  /** The `task` call that started it. */
  parentToolCallId: string | null;
};

export type AgentConversationTodoStatus =
  "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export type AgentConversationTodoPhase = {
  name: string;
  tasks: { content: string; status: AgentConversationTodoStatus }[];
};

export type AgentConversationQueuedMessage = {
  /** As OMP shows it; `remove_queued_message` takes it verbatim. */
  text: string;
  queue: "steering" | "followUp";
  /** Already steered into the running reply: OMP can no longer take it back. */
  live: boolean;
};

export type AgentConversationState = {
  entries: AgentConversationEntry[];
  nextId: number;
  /** Between `agent_start` and `session_settled`: OMP may still continue on its own. */
  busy: boolean;
  /** No turn runs: only background jobs (a backgrounded `bash`, an async `task`) keep it busy. */
  background: boolean;
  dialogs: AgentConversationDialog[];
  /** Messages typed during a run, waiting for OMP to take them. */
  queued: AgentConversationQueuedMessage[];
  model: AgentConversationModel | null;
  models: AgentConversationModel[];
  /** OMP's slash commands in its order, builtins limited to those that fit the chat. */
  commands: AgentConversationCommand[];
  thinkingLevel: string | null;
  thinkingLevels: string[];
  exit: { exitCode: number | null; stderr: string } | null;
  /** The user stopped the run: OMP reports the interrupted request as an error. */
  aborting: boolean;
  /** OMP answered `get_messages`: an empty transcript is then a new conversation. */
  historyLoaded: boolean;
  /** OMP reports a compaction, automatic or not. */
  compacting: boolean;
  stats: AgentConversationStats | null;
  /** Agents OMP's `task` tool started, by index. */
  subagents: AgentConversationSubagent[];
  /** OMP's todo list, as its `todo` tool last left it. */
  todos: AgentConversationTodoPhase[];
  /** OMP's goal while it is pursued, paused or out of budget. */
  goal: AgentConversationGoal | null;
  /** OMP's side questions (`/btw`), kept outside the transcript, newest first. */
  btw: AgentConversationBtwTopic[];
  /** What the side-question panel shows: one topic, every topic, or nothing. */
  btwView: { topic: string } | "history" | null;
};

export type AgentConversationGoal = { objective: string; status: string };

/** One side question; OMP's statuses: running, complete, cancelled, error, interrupted. */
export type AgentConversationBtwTurn = {
  question: string;
  answer: string;
  status: string;
  error: string | null;
};

/** A side-question topic: its first question, then its follow-ups. */
export type AgentConversationBtwTopic = {
  id: string;
  createdAt: number;
  turns: AgentConversationBtwTurn[];
};

export type AgentConversationRecord = Record<string, unknown> & {
  type?: unknown;
};

/** A past OMP conversation of the project; mirrors `ConversationHistoryEntry` in Rust. */
export type AgentConversationHistoryEntry = {
  path: string;
  /** Its title, else its first message; null when neither is known. */
  title: string | null;
  /** Milliseconds since the Unix epoch. */
  modified: number;
  /** The conversation OMP holds. */
  current: boolean;
};

/** One page of the resume picker; mirrors `ConversationHistoryPage` in Rust. */
export type AgentConversationHistoryPage = {
  entries: AgentConversationHistoryEntry[];
  /** Older conversations remain past this page. */
  more: boolean;
};

export const initialAgentConversationState: AgentConversationState = {
  entries: [],
  nextId: 1,
  busy: false,
  background: false,
  dialogs: [],
  queued: [],
  model: null,
  models: [],
  commands: [],
  thinkingLevel: null,
  thinkingLevels: [],
  exit: null,
  aborting: false,
  historyLoaded: false,
  compacting: false,
  stats: null,
  subagents: [],
  todos: [],
  goal: null,
  btw: [],
  btwView: null,
};

function goalOf(value: unknown): AgentConversationGoal | null {
  return isObject(value)
    ? { objective: text(value.objective), status: text(value.status) }
    : null;
}

// A completed or dropped goal no longer runs: OMP clears it without a later update.
const pursued = (goal: AgentConversationGoal | null) =>
  goal && goal.status !== "complete" && goal.status !== "dropped" ? goal : null;

function btwTopic(value: unknown): AgentConversationBtwTopic | null {
  if (!isObject(value) || !text(value.id)) return null;
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  return {
    id: text(value.id),
    createdAt: count(value.createdAt) ?? 0,
    turns: [value, ...followUps.filter(isObject)].map((turn) => ({
      question: text(turn.question),
      answer: text(turn.answer),
      status: text(turn.status),
      error: text(turn.error) || null,
    })),
  };
}

export const agentConversationBtwRunning = (topic: AgentConversationBtwTopic) =>
  topic.turns[topic.turns.length - 1].status === "running";

/** Records `topic`; a running one is what the panel shows. */
function withBtwTopic(
  state: AgentConversationState,
  topic: AgentConversationBtwTopic,
): AgentConversationState {
  return {
    ...state,
    btw: [topic, ...state.btw.filter(({ id }) => id !== topic.id)].sort(
      (left, right) => right.createdAt - left.createdAt,
    ),
    btwView: agentConversationBtwRunning(topic)
      ? { topic: topic.id }
      : state.btwView,
  };
}

function withLatestBtwTurn(
  topic: AgentConversationBtwTopic,
  change: (turn: AgentConversationBtwTurn) => AgentConversationBtwTurn,
): AgentConversationBtwTopic {
  const turns = [...topic.turns];
  turns[turns.length - 1] = change(turns[turns.length - 1]);
  return { ...topic, turns };
}

const TODO_STATUSES: Record<string, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
};

function todoPhases(value: unknown): AgentConversationTodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isObject).flatMap((phase) => {
    const tasks = (Array.isArray(phase.tasks) ? phase.tasks : [])
      .filter(isObject)
      .flatMap((task) =>
        text(task.content)
          ? [
              {
                content: text(task.content),
                // OMP statuses are free text: `__proto__` must not resolve through Object.prototype.
                status: Object.prototype.hasOwnProperty.call(
                  TODO_STATUSES,
                  text(task.status),
                )
                  ? (task.status as AgentConversationTodoStatus)
                  : "pending",
              },
            ]
          : [],
      );
    return tasks.length ? [{ name: text(phase.name), tasks }] : [];
  });
}

// Local command output keeps the terminal's colors; the view shows plain text.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .map((part) => (part.type === "text" ? text(part.text) : ""))
    .join("");
}

function contentImages(content: unknown): AgentConversationImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isObject)
    .flatMap((part) =>
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
        ? [{ data: part.data, mimeType: part.mimeType }]
        : [],
    );
}

/** The messages `abort_and_restore_queue` took back, oldest first, and whether OMP dropped some. */
export function agentConversationRestoredQueue(data: unknown): {
  messages: { text: string; images: AgentConversationImage[] }[];
  incomplete: boolean;
} {
  if (!isObject(data)) return { messages: [], incomplete: false };
  const messages = [data.steering, data.followUp].flatMap((queue) =>
    (Array.isArray(queue) ? queue : []).filter(isObject).map((item) => {
      const images = contentImages(item.images);
      // OMP names a message without text after its image.
      const message =
        images.length && item.text === "[Image]" ? "" : text(item.text);
      return { text: message, images };
    }),
  );
  return {
    messages,
    incomplete: data.imagesDropped === true || data.truncated === true,
  };
}

function model(value: unknown): AgentConversationModel | null {
  if (!isObject(value) || typeof value.id !== "string") return null;
  return {
    provider: text(value.provider),
    id: value.id,
    name: text(value.name) || value.id,
    images: Array.isArray(value.input) && value.input.includes("image"),
  };
}

function resultOutput(result: unknown, fallback: string) {
  if (!isObject(result)) return fallback;
  // A read reports the lines it numbered for the model; its details keep them plain.
  const details = isObject(result.details) ? result.details : {};
  const display = isObject(details.displayContent)
    ? details.displayContent.text
    : undefined;
  return typeof display === "string" ? display : contentText(result.content);
}

function newTool(
  id: unknown,
  name: unknown,
  args: unknown,
  intent: unknown = undefined,
): AgentConversationTool {
  const values = isObject(args) ? args : {};
  return {
    type: "tool",
    id: text(id),
    name: text(name),
    args: values,
    intent: text(intent) || text(values.i) || null,
    status: "pending",
    output: "",
    changes: null,
    answers: null,
    startedAt: null,
    durationMs: null,
  };
}

function assistantBlocks(content: unknown): AgentConversationBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isObject).flatMap((part): AgentConversationBlock[] => {
    if (part.type === "text") return [{ type: "text", text: text(part.text) }];
    if (part.type === "thinking")
      return [{ type: "thinking", text: text(part.thinking) }];
    if (part.type === "toolCall")
      return [newTool(part.id, part.name, part.arguments, part.intent)];
    return [];
  });
}

type NewEntry = AgentConversationEntry extends infer Entry
  ? Entry extends AgentConversationEntry
    ? Omit<Entry, "id">
    : never
  : never;

function withEntry(
  state: AgentConversationState,
  entry: NewEntry,
): AgentConversationState {
  return {
    ...state,
    entries: [...state.entries, { ...entry, id: state.nextId }],
    nextId: state.nextId + 1,
  };
}

/** Applies `update` to the tool block `toolCallId` of the latest assistant entry holding it. */
function updateTool(
  state: AgentConversationState,
  toolCallId: string,
  update: (tool: AgentConversationTool) => AgentConversationTool,
): AgentConversationState {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.role !== "assistant") continue;
    const blockIndex = entry.blocks.findIndex(
      (block) => block.type === "tool" && block.id === toolCallId,
    );
    if (blockIndex < 0) continue;
    const blocks = [...entry.blocks];
    blocks[blockIndex] = update(blocks[blockIndex] as AgentConversationTool);
    const entries = [...state.entries];
    entries[index] = { ...entry, blocks };
    return { ...state, entries };
  }
  return state;
}

function toolResult(
  state: AgentConversationState,
  message: Json,
): AgentConversationState {
  return updateTool(state, text(message.toolCallId), (tool) => ({
    ...tool,
    status: message.isError === true ? "error" : "done",
    output: resultOutput(message, tool.output),
    changes: resultChanges(message.details) ?? tool.changes,
    answers:
      tool.name === "ask"
        ? (askAnswers(message.details) ?? tool.answers)
        : null,
  }));
}

function finishedAssistant(message: Json, aborting = false) {
  const aborted =
    message.stopReason === "aborted" ||
    (aborting && message.stopReason === "error");
  return {
    role: "assistant" as const,
    blocks: assistantBlocks(message.content),
    streaming: false,
    error:
      message.stopReason === "error" && !aborted
        ? text(message.errorMessage) || "Unknown error"
        : null,
    aborted,
  };
}

/** Adds a finished message: from history, or as the authoritative end of a stream. */
function appendMessage(
  state: AgentConversationState,
  message: unknown,
): AgentConversationState {
  if (!isObject(message)) return state;
  switch (message.role) {
    case "user":
      // Hidden companions and agent handoffs are not what the user typed.
      if (message.attribution !== undefined && message.attribution !== "user")
        return state;
      return withEntry(state, {
        role: "user",
        text: contentText(message.content),
        images: contentImages(message.content),
      });
    case "custom": {
      // A `/skill:` command is stored expanded; its details keep what the user typed.
      if (
        message.customType !== "skill-prompt" ||
        message.attribution !== "user"
      )
        return state;
      const details = isObject(message.details) ? message.details : {};
      const name = text(details.name);
      const args = text(details.args).trim();
      return withEntry(state, {
        role: "user",
        text:
          text(details.__queueChipText).trim() ||
          text(details.prompt).trim() ||
          (name ? `/skill:${name}${args ? ` ${args}` : ""}` : args),
        images: contentImages(message.content),
      });
    }
    case "assistant":
      return withEntry(state, finishedAssistant(message));
    case "toolResult":
      return toolResult(state, message);
    case "compactionSummary":
      return withEntry(state, {
        role: "notice",
        notice: {
          kind: "compacted",
          tokensBefore: count(message.tokensBefore),
          tokensAfter: count(message.tokensAfter),
        },
      });
    default:
      return state;
  }
}

function streamingIndex(state: AgentConversationState) {
  const index = state.entries.length - 1;
  const entry = state.entries[index];
  return entry?.role === "assistant" && entry.streaming ? index : -1;
}

type AssistantEntry = Extract<AgentConversationEntry, { role: "assistant" }>;

function updateStreaming(
  state: AgentConversationState,
  update: (entry: AssistantEntry) => AssistantEntry,
): AgentConversationState {
  const index = streamingIndex(state);
  if (index < 0) return state;
  const entry = state.entries[index] as AssistantEntry;
  const updated = update(entry);
  if (updated === entry) return state;
  const entries = [...state.entries];
  entries[index] = updated;
  return { ...state, entries };
}

/** Adds a notice that leaves a streaming reply last, so its next updates still reach it. */
function noticeBeforeStream(
  state: AgentConversationState,
  notice: AgentConversationNotice,
) {
  const index = streamingIndex(state);
  if (index < 0) return withEntry(state, { role: "notice", notice });
  const entries = [...state.entries];
  entries.splice(index, 0, { role: "notice", notice, id: state.nextId });
  return { ...state, entries, nextId: state.nextId + 1 };
}

function streamUpdate(
  state: AgentConversationState,
  event: unknown,
): AgentConversationState {
  if (!isObject(event) || typeof event.contentIndex !== "number") return state;
  const index = event.contentIndex;
  return updateStreaming(state, (entry) => {
    // OMP opens content blocks in order; an index past the end would leave a hole.
    if (index > entry.blocks.length) return entry;
    const blocks = [...entry.blocks];
    const current: AgentConversationBlock | undefined = blocks[index];
    switch (event.type) {
      case "text_start":
        blocks[index] = { type: "text", text: "" };
        break;
      case "thinking_start":
        blocks[index] = { type: "thinking", text: "" };
        break;
      case "text_delta":
      case "thinking_delta":
        if (current?.type === "text" || current?.type === "thinking")
          blocks[index] = {
            ...current,
            text: current.text + text(event.delta),
          };
        break;
      case "text_end":
        blocks[index] = { type: "text", text: text(event.content) };
        break;
      case "thinking_end":
        blocks[index] = { type: "thinking", text: text(event.content) };
        break;
      case "toolcall_start": {
        // OMP 18.13.2 names the call in `block`; before, it stays anonymous until its end.
        const call = isObject(event.block) ? event.block : {};
        blocks[index] = newTool(call.id, call.name, {}, call.intent);
        break;
      }
      case "toolcall_end": {
        const call = isObject(event.toolCall) ? event.toolCall : {};
        // Live diffs may already have reached the block being closed.
        const changes = current?.type === "tool" ? current.changes : null;
        blocks[index] = {
          ...newTool(call.id, call.name, call.arguments, call.intent),
          changes,
        };
        break;
      }
      default:
        return entry;
    }
    return { ...entry, blocks };
  });
}

/** Keeps live tool progress when the final message replaces the streamed one. */
function endStream(
  state: AgentConversationState,
  message: Json,
): AgentConversationState {
  const index = streamingIndex(state);
  if (index < 0)
    return withEntry(state, finishedAssistant(message, state.aborting));
  const streamed = state.entries[index] as AssistantEntry;
  const progress = new Map(
    streamed.blocks.flatMap((block) =>
      block.type === "tool" ? [[block.id, block] as const] : [],
    ),
  );
  const finished = finishedAssistant(message, state.aborting);
  const entries = [...state.entries];
  entries[index] = {
    ...finished,
    id: streamed.id,
    blocks: finished.blocks.map((block) => {
      const live = block.type === "tool" ? progress.get(block.id) : undefined;
      return block.type === "tool" && live
        ? {
            ...block,
            intent: block.intent ?? live.intent,
            status: live.status,
            output: live.output,
            changes: live.changes,
            startedAt: live.startedAt,
            durationMs: live.durationMs,
          }
        : block;
    }),
  };
  return { ...state, entries };
}

function settle(state: AgentConversationState): AgentConversationState {
  return {
    ...state,
    busy: false,
    background: false,
    aborting: false,
    dialogs: [],
    entries: state.entries.map((entry) =>
      entry.role === "assistant" && entry.streaming
        ? { ...entry, streaming: false }
        : entry,
    ),
  };
}

function stats(data: Json): AgentConversationStats {
  const usage = isObject(data.contextUsage) ? data.contextUsage : {};
  const tokens = isObject(data.tokens) ? data.tokens : {};
  return {
    contextTokens: count(usage.tokens),
    contextWindow: count(usage.contextWindow),
    contextPercent: count(usage.percent),
    totalTokens: count(tokens.total) ?? 0,
    cost: count(data.cost),
  };
}

const SUBAGENT_STATUS: Record<string, AgentConversationSubagent["status"]> = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  aborted: "aborted",
  cancelled: "aborted",
};

/** Merges what a lifecycle, progress or registry entry tells about one subagent. */
function withSubagent(
  state: AgentConversationState,
  entry: unknown,
): AgentConversationState {
  if (!isObject(entry) || !text(entry.id)) return state;
  const id = text(entry.id);
  const known = state.subagents.find((agent) => agent.id === id);
  const status = text(entry.status);
  const agent: AgentConversationSubagent = {
    id,
    agent: text(entry.agent) || known?.agent || null,
    index: count(entry.index) ?? known?.index ?? state.subagents.length,
    description: text(entry.description) || known?.description || null,
    status: status
      ? Object.prototype.hasOwnProperty.call(SUBAGENT_STATUS, status)
        ? SUBAGENT_STATUS[status]
        : "running"
      : (known?.status ?? "running"),
    activity: text(entry.lastIntent) || known?.activity || null,
    toolCount: count(entry.toolCount) ?? known?.toolCount ?? 0,
    tokens: count(entry.tokens) ?? known?.tokens ?? 0,
    durationMs: count(entry.durationMs) ?? known?.durationMs ?? null,
    parentToolCallId:
      text(entry.parentToolCallId) || known?.parentToolCallId || null,
  };
  return {
    ...state,
    subagents: [
      ...state.subagents.filter((other) => other.id !== id),
      agent,
    ].sort((left, right) => left.index - right.index),
  };
}

function response(
  state: AgentConversationState,
  record: AgentConversationRecord,
) {
  // An older OMP without subagent snapshots, a command list or side questions simply has none to show.
  if (
    record.success !== true &&
    (record.command === "get_subagents" ||
      record.command === "get_available_commands" ||
      record.command === "get_btw_history")
  )
    return state;
  // An older OMP without it gets a plain `abort` instead.
  if (record.success !== true && record.command === "abort_and_restore_queue")
    return state;
  if (record.success !== true)
    return noticeBeforeStream(state, {
      kind: "error",
      message: text(record.error) || text(record.command),
    });
  const data = isObject(record.data) ? record.data : {};
  switch (record.command) {
    case "get_state": {
      const context = stats(data);
      return {
        ...state,
        model: model(data.model),
        thinkingLevel: text(data.thinkingLevel) || null,
        busy: data.isSettled === false || data.isStreaming === true,
        background:
          data.isSettled === false &&
          data.isStreaming !== true &&
          data.isCompacting !== true &&
          data.hasPendingAsyncWork === true,
        compacting: data.isCompacting === true,
        stats: isObject(data.contextUsage)
          ? {
              ...(state.stats ?? context),
              contextTokens: context.contextTokens,
              contextWindow: context.contextWindow,
              contextPercent: context.contextPercent,
            }
          : state.stats,
        todos: todoPhases(data.todoPhases) ?? state.todos,
        // `get_state` returns OMP's goal mode state, which wraps the goal.
        goal: pursued(goalOf(isObject(data.goal) ? data.goal.goal : null)),
      };
    }
    case "get_messages": {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const index = streamingIndex(state);
      const loaded = messages.reduce<AgentConversationState>(appendMessage, {
        ...state,
        entries: [],
        historyLoaded: true,
      });
      // OMP lists a reply only at its `message_end`: the one streaming stays last.
      return index < 0
        ? loaded
        : { ...loaded, entries: [...loaded.entries, state.entries[index]] };
    }
    case "get_available_models":
      return {
        ...state,
        models: (Array.isArray(data.models) ? data.models : [])
          .map(model)
          .filter((value): value is AgentConversationModel => value !== null),
      };
    case "get_available_commands":
      return { ...state, commands: agentConversationCommands(data.commands) };
    case "goal": {
      const goal = goalOf(data.goal);
      return {
        ...noticeBeforeStream(state, { kind: "goal", goal }),
        goal: pursued(goal),
      };
    }
    // The `btw_record` that started it came first, and its deltas may have followed.
    case "btw": {
      const topic = btwTopic(data.record);
      return topic && !state.btw.some(({ id }) => id === topic.id)
        ? withBtwTopic(state, topic)
        : state;
    }
    case "get_btw_history": {
      const btw = (Array.isArray(data.records) ? data.records : [])
        .map(btwTopic)
        .filter((topic) => topic !== null);
      // A reattached view finds the question still running.
      const running = btw.find(agentConversationBtwRunning);
      return {
        ...state,
        btw,
        btwView: state.btwView ?? (running ? { topic: running.id } : null),
      };
    }
    case "set_model":
      return { ...state, model: model(data) ?? state.model };
    case "get_available_thinking_levels":
      return {
        ...state,
        thinkingLevels: (Array.isArray(data.levels) ? data.levels : []).filter(
          (level): level is string => typeof level === "string",
        ),
      };
    case "get_session_stats":
      return { ...state, stats: stats(data) };
    case "get_subagents":
      return (Array.isArray(data.subagents) ? data.subagents : []).reduce(
        withSubagent,
        state,
      );
    case "new_session":
    case "switch_session":
      return data.cancelled === true
        ? state
        : { ...state, subagents: [], btw: [], btwView: null };
    default:
      return state;
  }
}

export function applyAgentConversationRecord(
  state: AgentConversationState,
  record: AgentConversationRecord,
): AgentConversationState {
  switch (record.type) {
    case "response":
      return response(state, record);
    case "agent_start":
      return { ...state, busy: true, background: false };
    // The turn yielded to its background jobs, whose results may wake it again.
    case "agent_end":
      return record.awaitingAsyncWork === true
        ? { ...state, background: true }
        : state;
    case "session_settled":
      return settle(state);
    case "message_start":
      if (!isObject(record.message)) return state;
      if (record.message.role === "user" || record.message.role === "custom")
        return appendMessage(state, record.message);
      if (record.message.role === "assistant")
        return withEntry(state, {
          role: "assistant",
          blocks: assistantBlocks(record.message.content),
          streaming: true,
          error: null,
          aborted: false,
        });
      return state;
    case "message_update":
      return streamUpdate(state, record.assistantMessageEvent);
    case "message_end":
      if (!isObject(record.message)) return state;
      if (record.message.role === "assistant")
        return endStream(state, record.message);
      if (record.message.role === "toolResult")
        return toolResult(state, record.message);
      return state;
    case "tool_execution_start":
      return updateTool(state, text(record.toolCallId), (tool) => ({
        ...tool,
        args: isObject(record.args) ? record.args : tool.args,
        intent: text(record.intent) || tool.intent,
        status: "running",
        startedAt:
          typeof record.receivedAt === "number" ? record.receivedAt : null,
      }));
    case "tool_execution_update":
      return updateTool(state, text(record.toolCallId), (tool) => ({
        ...tool,
        output: resultOutput(record.partialResult, tool.output),
      }));
    case "tool_stream_update": {
      const update = isObject(record.update) ? record.update : {};
      const id = text(record.toolCallId);
      const stream = (tool: AgentConversationTool) => ({
        ...tool,
        changes: resultChanges(update) ?? tool.changes,
      });
      const updated = updateTool(state, id, stream);
      if (updated !== state || !id) return updated;
      // OMP before 18.13.2 names a streamed call only at its end.
      return updateStreaming(state, (entry) => {
        for (let index = entry.blocks.length - 1; index >= 0; index -= 1) {
          const block = entry.blocks[index];
          if (block.type !== "tool" || block.id) continue;
          const blocks = [...entry.blocks];
          blocks[index] = stream({
            ...block,
            id,
            name: text(record.toolName) || block.name,
          });
          return { ...entry, blocks };
        }
        return entry;
      });
    }
    case "tool_execution_end": {
      const details = isObject(record.result) ? record.result.details : null;
      const ended = updateTool(state, text(record.toolCallId), (tool) => ({
        ...tool,
        status: record.isError === true ? "error" : "done",
        output: resultOutput(record.result, tool.output),
        changes: resultChanges(details) ?? tool.changes,
        answers:
          tool.name === "ask" ? (askAnswers(details) ?? tool.answers) : null,
        durationMs:
          typeof record.receivedAt === "number" && tool.startedAt !== null
            ? Math.max(0, record.receivedAt - tool.startedAt)
            : null,
      }));
      const todos =
        record.toolName === "todo" && isObject(details)
          ? todoPhases(details.phases)
          : null;
      return todos ? { ...ended, todos } : ended;
    }
    case "todo_auto_clear":
      return { ...state, todos: [] };
    case "goal_updated":
      return { ...state, goal: pursued(goalOf(record.goal)) };
    case "btw_record": {
      const topic = btwTopic(record.record);
      // A topic is known from its start: a late end belongs to a conversation left since.
      return topic &&
        (agentConversationBtwRunning(topic) ||
          state.btw.some(({ id }) => id === topic.id))
        ? withBtwTopic(state, topic)
        : state;
    }
    case "btw_delta":
      return {
        ...state,
        btw: state.btw.map((topic) =>
          topic.id === record.recordId && agentConversationBtwRunning(topic)
            ? withLatestBtwTurn(topic, (turn) => ({
                ...turn,
                answer: turn.answer + text(record.delta),
              }))
            : topic,
        ),
      };
    case "soreno_btw_view":
      return {
        ...state,
        btwView: record.view as AgentConversationState["btwView"],
      };
    case "queue_update": {
      const live = Number(record.liveSteered) || 0;
      return {
        ...state,
        queued: (["steering", "followUp"] as const).flatMap((queue) => {
          const items = record[queue];
          return Array.isArray(items)
            ? items
                .filter((item): item is string => typeof item === "string")
                .map((text, index) => ({
                  text,
                  queue,
                  live: queue === "steering" && index < live,
                }))
            : [];
        }),
      };
    }
    case "thinking_level_changed":
      return { ...state, thinkingLevel: text(record.thinkingLevel) || null };
    case "config_update":
      return { ...state, model: model(record.model) ?? state.model };
    case "auto_retry_start":
      return noticeBeforeStream(state, {
        kind: "retry",
        attempt: Number(record.attempt) || 1,
        maxAttempts: Number(record.maxAttempts) || 1,
        message: text(record.errorMessage),
      });
    case "compaction_start":
    case "auto_compaction_start":
    case "manual_compaction_start":
      return { ...state, compacting: true, background: false };
    // `/compact` reports its result through `command_output`.
    case "manual_compaction_end":
      return { ...state, compacting: false };
    case "compaction_end":
    case "auto_compaction_end": {
      const ended = { ...state, compacting: false };
      if (record.aborted === true) return ended;
      if (record.errorMessage)
        return noticeBeforeStream(ended, {
          kind: "error",
          message: text(record.errorMessage),
        });
      const result = isObject(record.result) ? record.result : {};
      return noticeBeforeStream(ended, {
        kind: "compacted",
        tokensBefore: count(result.tokensBefore),
        tokensAfter: count(result.tokensAfter),
      });
    }
    case "command_output": {
      const output = text(record.text).replace(ANSI, "").trim();
      // `/compact` reports its end only as text: shown like any other compaction.
      const compacted =
        /^Compaction complete\.(?: Tokens: (\d+) -> (\d+))?/.exec(output);
      if (compacted)
        return noticeBeforeStream(state, {
          kind: "compacted",
          tokensBefore: compacted[1] ? Number(compacted[1]) : null,
          tokensAfter: compacted[2] ? Number(compacted[2]) : null,
        });
      if (!output) return state;
      // `/changelog` prints OMP's CHANGELOG.md sections, each opening on its version heading.
      return noticeBeforeStream(
        state,
        /^## \[?\d+\.\d+\.\d+/.test(output)
          ? { kind: "changelog", markdown: output }
          : { kind: "output", message: output },
      );
    }
    case "notice":
      return text(record.message)
        ? noticeBeforeStream(state, {
            kind: record.level === "error" ? "error" : "info",
            message: text(record.message),
          })
        : state;
    case "extension_ui_request": {
      const dialog = agentConversationDialog(record, state);
      if (dialog) return { ...state, dialogs: [...state.dialogs, dialog] };
      if (record.method === "cancel")
        return {
          ...state,
          dialogs: state.dialogs.filter(({ id }) => id !== record.targetId),
        };
      if (record.method === "notify" && text(record.message))
        return noticeBeforeStream(
          state,
          record.notifyType === "error"
            ? { kind: "error", message: text(record.message) }
            : { kind: "info", message: text(record.message) },
        );
      return state;
    }
    case "soreno_abort_requested":
      return state.busy ? { ...state, aborting: true } : state;
    case "soreno_dialog_answered": {
      const answered = state.dialogs.find(({ id }) => id === record.id);
      const next = {
        ...state,
        dialogs: state.dialogs.filter(({ id }) => id !== record.id),
      };
      // An approved call runs from the answer: the wait is not its duration.
      return answered?.kind === "approval" &&
        answered.toolCallId &&
        typeof record.receivedAt === "number"
        ? updateTool(next, answered.toolCallId, (tool) => ({
            ...tool,
            startedAt: record.receivedAt as number,
          }))
        : next;
    }
    case "soreno_exited": {
      const settled = settle(state);
      return {
        ...settled,
        compacting: false,
        // The process held its tools and subagents: none of them runs anymore.
        entries: settled.entries.map((entry) =>
          entry.role === "assistant"
            ? {
                ...entry,
                blocks: entry.blocks.map((block) =>
                  block.type === "tool" &&
                  (block.status === "running" || block.status === "pending")
                    ? { ...block, status: "error" }
                    : block,
                ),
              }
            : entry,
        ),
        subagents: state.subagents.map((agent) =>
          agent.status === "running" ? { ...agent, status: "aborted" } : agent,
        ),
        btw: state.btw.map((topic) =>
          agentConversationBtwRunning(topic)
            ? withLatestBtwTurn(topic, (turn) => ({
                ...turn,
                status: "interrupted",
              }))
            : topic,
        ),
        exit: {
          exitCode:
            typeof record.exitCode === "number" ? record.exitCode : null,
          stderr: text(record.stderr),
        },
      };
    }
    case "subagent_lifecycle":
      return withSubagent(state, record.payload);
    case "subagent_progress": {
      const payload = isObject(record.payload) ? record.payload : {};
      return withSubagent(state, {
        parentToolCallId: payload.parentToolCallId,
        ...(isObject(payload.progress) ? payload.progress : {}),
      });
    }
    case "available_commands_update":
      return { ...state, commands: agentConversationCommands(record.commands) };
    default:
      return state;
  }
}
