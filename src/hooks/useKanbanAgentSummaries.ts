import { useEffect, useRef, useState } from "react";
import { completeAgentKanbanIssue } from "../data/agentSessionsApi";
import type {
  AgentSession,
  AgentSessionKanbanIssue,
  AgentSessionStatus,
} from "../domain/agentSessions";
import type {
  KanbanComment,
  KanbanIssueUpdate,
  KanbanSource,
} from "../domain/kanban";
import { signAgentSummary } from "../domain/kanbanAgent";
import type { I18nContextValue } from "../i18n";
import { notifyError } from "../notifications";

export function useKanbanAgentSummaries({
  statuses,
  issueSessions,
  sessions,
  applyServerUpdate,
  reloadBoard,
  formatError,
  t,
}: {
  statuses: readonly AgentSessionStatus[];
  issueSessions: readonly AgentSessionKanbanIssue[];
  sessions: readonly AgentSession[];
  applyServerUpdate: (source: KanbanSource, update: KanbanIssueUpdate) => void;
  reloadBoard: (source?: KanbanSource) => void;
  formatError: (error: unknown) => string;
  t: I18nContextValue["t"];
}) {
  // Ids already sent this run; the backend claims each summary once across restarts.
  const sentSummaryIdsRef = useRef(new Set<string>());
  const [agentComments, setAgentComments] = useState<
    ReadonlyMap<string, readonly KanbanComment[]>
  >(() => new Map());
  useEffect(() => {
    for (const { sessionId, issueSummary } of statuses) {
      if (!issueSummary || sentSummaryIdsRef.current.has(issueSummary.id))
        continue;
      sentSummaryIdsRef.current.add(issueSummary.id);
      const link = issueSessions.find((link) => link.sessionId === sessionId);
      const identifier = link?.issueIdentifier ?? "";
      const executable =
        sessions.find(({ id }) => id === sessionId)?.executable ??
        link?.executable ??
        "";
      completeAgentKanbanIssue(
        sessionId,
        issueSummary.id,
        signAgentSummary(issueSummary.text, executable),
      )
        .then((completion) => {
          if (!completion) return;
          if (link) {
            const { issueId } = link;
            setAgentComments((current) => {
              const comments = (current.get(issueId) ?? []).filter(
                ({ id }) => id !== completion.comment.id,
              );
              return new Map(current).set(issueId, [
                ...comments,
                completion.comment,
              ]);
            });
            if (completion.update)
              applyServerUpdate(link.source, completion.update);
          }
          // The summary may link a pull request the board card derives.
          reloadBoard(link?.source);
        })
        .catch((error: unknown) =>
          notifyError(
            t("kanban.error.agentSummary", {
              identifier,
              detail: formatError(error),
            }),
          ),
        );
    }
  }, [
    applyServerUpdate,
    formatError,
    issueSessions,
    reloadBoard,
    sessions,
    statuses,
    t,
  ]);
  return agentComments;
}
