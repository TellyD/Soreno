import type {
  AgentConversationAskAnswer,
  AgentConversationDiffLine,
  AgentConversationFileChange,
} from "./agentConversation";
import { isObject, text } from "./agentConversationRecords";

const DIFF_LINE = /^([ +-])\s*(\d+)\|(.*)$/;

/** OMP's numbered diff: ` 12|kept`, `-13|removed`, `+13|added`; other lines mark a gap. */
function parseAgentConversationDiff(diff: string): AgentConversationDiffLine[] {
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map((row) => {
      const match = DIFF_LINE.exec(row);
      if (!match) return { kind: "gap", line: null, text: row.trim() };
      return {
        kind:
          match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "context",
        line: Number(match[2]),
        text: match[3],
      };
    });
}

/** The changes a tool result or stream update reports, if any. */
export function resultChanges(
  details: unknown,
): AgentConversationFileChange[] | null {
  if (!isObject(details)) return null;
  if (Array.isArray(details.files)) {
    const files = details.files.filter(isObject).flatMap((file) =>
      typeof file.diff === "string"
        ? [
            {
              path: text(file.path) || null,
              lines: parseAgentConversationDiff(file.diff),
            },
          ]
        : [],
    );
    return files.length ? files : null;
  }
  return typeof details.diff === "string"
    ? [
        {
          path: text(details.path) || null,
          lines: parseAgentConversationDiff(details.diff),
        },
      ]
    : null;
}

/** One answer per question an `ask` result reports: a single question or `results`. */
export function askAnswers(
  details: unknown,
): AgentConversationAskAnswer[] | null {
  if (!isObject(details)) return null;
  const results = Array.isArray(details.results)
    ? details.results.filter(isObject)
    : typeof details.question === "string"
      ? [details]
      : null;
  return (
    results?.map((result) => ({
      question: text(result.question),
      selected: Array.isArray(result.selectedOptions)
        ? result.selectedOptions.filter(
            (option): option is string => typeof option === "string",
          )
        : [],
      custom:
        typeof result.customInput === "string" ? result.customInput : null,
    })) ?? null
  );
}
