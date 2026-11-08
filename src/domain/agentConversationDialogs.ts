import type {
  AgentConversationAskQuestion,
  AgentConversationDialog,
  AgentConversationRecord,
  AgentConversationState,
  AgentConversationTool,
} from "./agentConversation";
import { count, isObject, text } from "./agentConversationRecords";

/** The latest running call of `tool` no dialog waits on yet. */
function waitingToolCall(state: AgentConversationState, tool: string) {
  const claimed = new Set(
    state.dialogs.flatMap((dialog) =>
      dialog.kind === "approval" && dialog.toolCallId
        ? [dialog.toolCallId]
        : [],
    ),
  );
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.role !== "assistant") continue;
    const block = [...entry.blocks]
      .reverse()
      .find(
        (candidate): candidate is AgentConversationTool =>
          candidate.type === "tool" &&
          candidate.name === tool &&
          candidate.status === "running" &&
          !claimed.has(candidate.id),
      );
    if (block) return block.id;
  }
  return null;
}

const APPROVAL = /^Allow tool: (\S+)\n?([\s\S]*)$/;

/** The questions of an `ask` request or tool call. */
export function agentConversationAskQuestions(
  value: unknown,
): AgentConversationAskQuestion[] {
  return (Array.isArray(value) ? value : [])
    .filter(isObject)
    .map((question) => ({
      id: text(question.id),
      question: text(question.question),
      header: text(question.header) || null,
      options: (Array.isArray(question.options) ? question.options : [])
        .filter(isObject)
        .map((option) => ({
          label: text(option.label),
          description: text(option.description) || null,
        })),
      multi: question.multi === true,
      recommended: count(question.recommended),
    }));
}

/** The dialog an `extension_ui_request` opens, or null for other methods. */
export function agentConversationDialog(
  record: AgentConversationRecord,
  state: AgentConversationState,
): AgentConversationDialog | null {
  if (record.type !== "extension_ui_request" || typeof record.id !== "string")
    return null;
  const id = record.id;
  const title = text(record.title);
  switch (record.method) {
    case "select": {
      const labels = Array.isArray(record.options)
        ? record.options.filter(
            (option): option is string => typeof option === "string",
          )
        : [];
      const approval = APPROVAL.exec(title);
      if (approval)
        return {
          kind: "approval",
          id,
          tool: approval[1],
          detail: approval[2].trim(),
          options: labels,
          toolCallId: waitingToolCall(state, approval[1]),
        };
      const details = Array.isArray(record.optionDetails)
        ? record.optionDetails
        : [];
      return {
        kind: "select",
        id,
        title,
        options: labels.map((label, index) => {
          const detail = details[index];
          return {
            label,
            description: isObject(detail)
              ? text(detail.description) || null
              : null,
          };
        }),
      };
    }
    case "confirm":
      return { kind: "confirm", id, title, message: text(record.message) };
    case "input":
      return {
        kind: "input",
        id,
        title,
        placeholder: text(record.placeholder),
        secret: record.secret === true,
      };
    case "editor":
      return { kind: "editor", id, title, prefill: text(record.prefill) };
    case "ask":
      return {
        kind: "ask",
        id,
        questions: agentConversationAskQuestions(record.questions),
      };
    default:
      return null;
  }
}
