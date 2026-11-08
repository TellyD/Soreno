import { useEffect, useRef } from "react";
import { listenKanbanIssueRequests } from "../data/kanbanApi";
import type {
  KanbanIssueRequestEvent,
  KanbanIssueSelection,
} from "../domain/kanban";
import { useI18n } from "../i18n";
import { notifyError, notifyInfo } from "../notifications";
import { useKanbanErrorFormatter } from "./useKanbanErrorFormatter";

/** Subscribes for the owner's lifetime; the latest `onRequest` is always called. */
export function useKanbanIssueRequests(
  onRequest: (event: KanbanIssueRequestEvent) => void,
) {
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Tauri registers the handler before the promise settles, so a disposed subscription can still fire.
    listenKanbanIssueRequests((event) => {
      if (!disposed) onRequestRef.current(event);
    }).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Announces every agent-requested Kanban issue creation or edit, whichever view is open; "Open" calls the latest `onOpenIssue`. */
export function useKanbanIssueRequestNotifications(
  onOpenIssue: (issue: KanbanIssueSelection) => void,
) {
  const { t } = useI18n();
  const formatError = useKanbanErrorFormatter();
  const onOpenIssueRef = useRef(onOpenIssue);
  onOpenIssueRef.current = onOpenIssue;

  useKanbanIssueRequests(({ error, issue, sessionName, title, updated }) => {
    if (issue) {
      notifyInfo(
        t(
          updated ? "kanban.issueRequest.updated" : "kanban.issueRequest.created",
          { identifier: issue.identifier, session: sessionName, title },
        ),
        {
          action: {
            label: t("kanban.issueRequest.open"),
            onAction: () => onOpenIssueRef.current(issue),
          },
        },
      );
      return;
    }
    notifyError(
      t(
        updated
          ? "kanban.issueRequest.updateFailed"
          : "kanban.issueRequest.failed",
        { error: formatError(error ?? ""), session: sessionName, title },
      ),
    );
  });
}
