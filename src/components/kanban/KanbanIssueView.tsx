import {
  ExternalLink,
  ListPlus,
  Maximize2,
  Minimize2,
  Send,
  SquareKanban,
  Trash2,
  TriangleAlert,
  Unlink,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isNewer } from "../../domain/dateTime";
import {
  type KanbanComment,
  type KanbanIssue,
  type KanbanIssueDetail,
  type KanbanIssueSelection,
} from "../../domain/kanban";
import type { KanbanController } from "../../hooks/useKanbanController";
import { useKanbanIssue } from "../../hooks/useKanbanIssue";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { LoadingState } from "../ui/LoadingState";
import { KanbanLinearBadge } from "./KanbanIssueCard";
import { KanbanIssueContent } from "./KanbanIssueContent";
import "./KanbanIssueView.css";

const noAgentComments: readonly KanbanComment[] = [];

type KanbanIssueViewProps = {
  kanban: KanbanController;
  selection: KanbanIssueSelection;
  onBack: () => void;
  // Runs instead of `onBack` once the issue is deleted.
  onDeleted?: () => void;
  onCreateSubIssue: (parent: KanbanIssue, trigger: HTMLElement) => void;
  onOpenIssue: (issue: KanbanIssueSelection) => void;
  // The side panel's controls; `onOpenKanban` and `onUnlink` are set beside an agent session only.
  panel: {
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    onOpenKanban?: () => void;
    // Unlinks the issue from the session; rejects with an error to show.
    onUnlink?: () => Promise<void>;
  };
};

export function KanbanIssueView({
  kanban,
  selection,
  onBack,
  onDeleted = onBack,
  onCreateSubIssue,
  onOpenIssue,
  panel,
}: KanbanIssueViewProps) {
  const { locale, t } = useI18n();
  const { formatError, followLinearTeam: onLinearTeam } = kanban;
  const sourceBoard =
    selection.source === "linear" ? kanban.linear : kanban.board;
  const agentSession = kanban.issueAgents.live.get(selection.id);
  const agentComments =
    kanban.agentComments.get(selection.id) ?? noAgentComments;
  // shortcut: a Linear issue past the board's 500 loaded cards has no board copy, so its properties are read-only here; edit from the loaded detail if large teams report it.
  const boardIssue = kanban.issues.find(
    ({ id, source }) => id === selection.id && source === selection.source,
  );
  const { createdSubIssue } = kanban;
  const onTransferIssue =
    kanban.linearAvailable && selection.source === "local"
      ? kanban.transferBoardIssue
      : undefined;
  const transferTeamName = kanban.linear?.team.name;
  const {
    addComment,
    deleteComment: deleteIssueComment,
    detail,
    error,
    receiveComment,
    reload,
    updateDescription,
  } = useKanbanIssue(selection);
  // Another view saved this issue: reload it. Its own saves already refreshed it.
  const revision = kanban.issueRevisions.get(selection.id) ?? 0;
  const seenRevisionRef = useRef({ id: selection.id, revision });
  useEffect(() => {
    const seen = seenRevisionRef.current;
    seenRevisionRef.current = { id: selection.id, revision };
    if (seen.id === selection.id && seen.revision !== revision) reload();
  }, [reload, revision, selection.id]);
  function contentSaved(saved: KanbanIssueSelection) {
    const savedRevision = kanban.issueContentSaved(saved);
    if (seenRevisionRef.current.id === saved.id)
      seenRevisionRef.current = { id: saved.id, revision: savedRevision };
  }
  const linearTeamId = detail?.source === "linear" ? detail.teamId : undefined;
  // shortcut: the board and the panel share one Linear team, so a hidden view of another team loses its edit controls until reopened; follow the visible view's team if multi-team users hit it.
  useEffect(() => {
    if (linearTeamId) onLinearTeam(linearTeamId);
  }, [linearTeamId, onLinearTeam]);
  const viewRef = useRef<HTMLElement>(null);
  const { onOpenKanban, onUnlink } = panel;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  const [transferring, setTransferring] = useState(false);
  // "pending" while the panel's issue is being unlinked from its session.
  const [unlinking, setUnlinking] = useState<"confirm" | "pending" | null>(
    null,
  );
  const [commentToDelete, setCommentToDelete] = useState<{
    issueId: string;
    comment: KanbanComment;
  } | null>(null);
  // Opening another issue abandons a confirmation started on the previous one.
  const pendingComment =
    commentToDelete?.issueId === selection.id ? commentToDelete.comment : null;
  if (commentToDelete && !pendingComment) setCommentToDelete(null);
  // A deletion still running for another issue must not lock or close this confirmation.
  const [deletingComment, setDeletingComment] = useState<KanbanComment | null>(
    null,
  );
  const commentDeletionPending =
    deletingComment !== null && deletingComment === pendingComment;
  const pendingCommentRef = useRef(pendingComment);
  pendingCommentRef.current = pendingComment;
  // Null returns focus to the comment's delete button; set once that button is gone.
  const commentReturnFocusRef = useRef<HTMLElement | null>(null);

  // Beside a session the issue follows the active session, which keeps the focus.
  useEffect(() => {
    if (!onUnlink) viewRef.current?.focus({ preventScroll: true });
  }, [selection.id]);

  useEffect(() => {
    if (createdSubIssue?.parentId === selection.id) reload();
    // Only a new creation reloads; opening another issue already loads it.
  }, [createdSubIssue]);

  // The board polls Linear; a newer board copy means the shown body and comments are stale.
  const linearBoardUpdatedAt =
    boardIssue?.source === "linear" ? boardIssue.updatedAt : undefined;
  const detailUpdatedAt = detail?.updatedAt;
  useEffect(() => {
    if (
      linearBoardUpdatedAt &&
      detailUpdatedAt &&
      isNewer(
        { updatedAt: linearBoardUpdatedAt },
        { updatedAt: detailUpdatedAt },
      )
    )
      reload();
    // Keyed on the timestamps only: an unchanged reloaded detail must not reload again.
  }, [linearBoardUpdatedAt, detailUpdatedAt]);

  // A replayed cached version would overwrite a newer body loaded from the backend.
  const deliveredCommentsRef = useRef(new WeakSet<KanbanComment>());
  useEffect(() => {
    for (const comment of agentComments) {
      if (deliveredCommentsRef.current.has(comment)) continue;
      deliveredCommentsRef.current.add(comment);
      receiveComment(selection.id, comment);
    }
  }, [agentComments, receiveComment, selection.id]);

  const confirming =
    confirmingDelete ||
    confirmingTransfer ||
    unlinking !== null ||
    pendingComment !== null;
  useEffect(() => {
    // The confirmations handle their own Escape.
    if (confirming) return;
    function backOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const { target } = event;
      // Other panes and portalled popups keep their own Escape handling.
      if (
        target instanceof Node &&
        target !== document.body &&
        !viewRef.current?.contains(target)
      ) {
        return;
      }
      // A view in a hidden board or panel leaves Escape to the one on screen.
      if (viewRef.current?.closest("[hidden]")) return;
      // A closed Select trigger is still a combobox, so only an open popup keeps Escape.
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            "input, textarea, select, [role='combobox'][aria-expanded='true']",
          ))
      ) {
        return;
      }
      event.preventDefault();
      onBack();
    }
    document.addEventListener("keydown", backOnEscape);
    return () => document.removeEventListener("keydown", backOnEscape);
  }, [confirming, onBack]);

  async function deleteIssue(issue: KanbanIssue) {
    setDeleting(true);
    try {
      await kanban.deleteBoardIssue(issue);
      onDeleted();
    } catch (deleteError) {
      setDeleting(false);
      setConfirmingDelete(false);
      notifyError(formatError(deleteError));
    }
  }

  async function transferIssue(
    issue: KanbanIssue,
    issueDetail: KanbanIssueDetail,
  ) {
    setTransferring(true);
    try {
      await onTransferIssue?.(issue, issueDetail);
    } catch (transferError) {
      notifyError(formatError(transferError));
    } finally {
      setTransferring(false);
      setConfirmingTransfer(false);
    }
  }

  async function deleteComment(comment: KanbanComment) {
    setDeletingComment(comment);
    try {
      await deleteIssueComment(comment.id);
      if (pendingCommentRef.current === comment) {
        commentReturnFocusRef.current = viewRef.current;
      }
      contentSaved(selection);
    } catch (deleteError) {
      notifyError(formatError(deleteError));
    } finally {
      setDeletingComment((current) => (current === comment ? null : current));
      setCommentToDelete((current) =>
        current?.comment === comment ? null : current,
      );
    }
  }

  const identifier = detail?.identifier ?? selection.identifier;
  const actions =
    boardIssue || detail?.url ? (
      <>
        {detail?.url ? (
          <IconButton
            aria-label={t("kanban.linear.open")}
            onClick={() => detail.url && kanban.openExternal(detail.url)}
            size="small"
            title={t("kanban.linear.open")}
          >
            <ExternalLink size={14} />
          </IconButton>
        ) : null}
        {boardIssue ? (
          <>
            <IconButton
              aria-label={t("kanban.issue.createSubIssue")}
              onClick={(event) =>
                onCreateSubIssue(boardIssue, event.currentTarget)
              }
              size="small"
              title={t("kanban.issue.createSubIssue")}
            >
              <ListPlus size={14} />
            </IconButton>
            {onTransferIssue && detail ? (
              <IconButton
                aria-label={t("kanban.issue.transfer")}
                // The backend also refuses an issue with a parent, which the detail does not expose.
                disabled={detail.children.length > 0}
                onClick={() => setConfirmingTransfer(true)}
                size="small"
                title={
                  detail.children.length > 0
                    ? t("kanban.issue.transferBlocked")
                    : t("kanban.issue.transfer")
                }
              >
                <Send size={14} />
              </IconButton>
            ) : null}
            <IconButton
              aria-label={t("kanban.issue.delete")}
              onClick={() => setConfirmingDelete(true)}
              size="small"
              title={t("kanban.issue.delete")}
              tone="danger"
            >
              <Trash2 size={14} />
            </IconButton>
          </>
        ) : null}
      </>
    ) : null;
  const expandLabel = !panel.expanded
    ? t("kanban.panel.expand")
    : onUnlink
      ? t("kanban.panel.collapse")
      : t("kanban.panel.collapseBoard");
  const title = boardIssue?.title ?? detail?.title;

  return (
    <section
      aria-label={selection.identifier}
      className="kanban-issue-view"
      ref={viewRef}
      tabIndex={-1}
    >
      <header className="agent-git-panel-header">
        <div className="git-panel-heading">
          <h2>{identifier}</h2>
          {selection.source === "linear" ? <KanbanLinearBadge /> : null}
          {title ? <p title={title}>{title}</p> : null}
        </div>
        <div className="git-panel-header-actions">
          {actions}
          {onUnlink ? (
            <IconButton
              aria-label={t("kanban.panel.unlink")}
              onClick={() => setUnlinking("confirm")}
              size="small"
              title={t("kanban.panel.unlink")}
            >
              <Unlink />
            </IconButton>
          ) : null}
          {onOpenKanban ? (
            <IconButton
              aria-label={t("kanban.panel.openKanban")}
              onClick={onOpenKanban}
              size="small"
              title={t("kanban.panel.openKanban")}
            >
              <SquareKanban />
            </IconButton>
          ) : null}
          <IconButton
            aria-label={expandLabel}
            aria-pressed={panel.expanded}
            data-git-expand
            onClick={() => panel.onExpandedChange(!panel.expanded)}
            size="small"
            title={expandLabel}
          >
            {panel.expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <IconButton
            aria-label={t("kanban.panel.close")}
            onClick={onBack}
            size="small"
            title={t("kanban.panel.close")}
          >
            <X />
          </IconButton>
        </div>
      </header>

      {detail ? (
        <KanbanIssueContent
          agentPreset={kanban.agentPreset}
          agentSession={agentSession}
          agentStarting={kanban.startingAgentIssueIds.has(selection.id)}
          sessions={kanban.sessions}
          statuses={kanban.statuses}
          terminalTitles={kanban.terminalTitles}
          endedAgent={kanban.issueAgents.ended.get(selection.id)}
          boardIssue={boardIssue}
          detail={detail}
          formatError={formatError}
          kanbanProjects={
            selection.source === "linear"
              ? kanban.linearKanbanProjects
              : kanban.kanbanProjects
          }
          key={detail.id}
          knownProjects={kanban.knownProjects}
          labels={sourceBoard?.labels ?? []}
          locale={locale}
          onAddComment={async (body) => {
            await addComment(body);
            contentSaved(selection);
          }}
          onDeleteComment={(comment) => {
            commentReturnFocusRef.current = null;
            setCommentToDelete({ issueId: selection.id, comment });
          }}
          onCreateLabel={(name) =>
            kanban.createBoardLabel(selection.source, name)
          }
          onSaveDescription={async (description) => {
            const stored = await updateDescription(description);
            contentSaved(selection);
            return stored;
          }}
          onOpenIssue={onOpenIssue}
          onOpenProject={kanban.onOpenProject}
          overviewProjectIds={kanban.overviewProjectIds}
          besideSession={!!onUnlink}
          onOpenSession={kanban.onOpenSession}
          onOpenUrl={kanban.openExternal}
          onStartAgent={kanban.startDetailIssueAgent}
          onUpdateIssue={kanban.moveBoardIssue}
          states={sourceBoard?.states ?? []}
        />
      ) : error ? (
        <EmptyState
          fill
          icon={<TriangleAlert />}
          title={t("kanban.issue.error")}
          description={formatError(error)}
          actions={
            <>
              <Button onClick={reload} variant="primary">
                {t("kanban.retry")}
              </Button>
              <Button onClick={onBack}>{t("kanban.panel.close")}</Button>
            </>
          }
        />
      ) : (
        <LoadingState className="kanban-board-status">
          {t("kanban.issue.loading")}
        </LoadingState>
      )}

      {boardIssue && confirmingDelete ? (
        <ConfirmationDialog
          cancelDisabled={deleting}
          cancelLabel={t("kanban.issue.deleteDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={deleting}
          confirmLabel={t("kanban.issue.deleteDialog.confirm")}
          confirmPending={deleting}
          description={
            <>
              {t("kanban.issue.deleteDialog.description", {
                identifier: boardIssue.identifier,
              })}
              {agentSession
                ? ` ${t("kanban.issue.deleteDialog.sessionKept", {
                    session: agentSession.name,
                  })}`
                : null}
            </>
          }
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void deleteIssue(boardIssue)}
          title={t("kanban.issue.deleteDialog.title", {
            identifier: boardIssue.identifier,
          })}
        />
      ) : null}
      {boardIssue && detail && onTransferIssue && confirmingTransfer ? (
        <ConfirmationDialog
          cancelDisabled={transferring}
          cancelLabel={t("kanban.issue.deleteDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={transferring}
          confirmLabel={t("kanban.issue.transferDialog.confirm")}
          confirmPending={transferring}
          confirmVariant="primary"
          description={
            <>
              {t("kanban.issue.transferDialog.description", {
                identifier: boardIssue.identifier,
                team: transferTeamName ?? "",
              })}
              {agentSession
                ? ` ${t("kanban.issue.transferDialog.sessionKept", {
                    session: agentSession.name,
                  })}`
                : null}
            </>
          }
          onCancel={() => setConfirmingTransfer(false)}
          onConfirm={() => void transferIssue(boardIssue, detail)}
          title={t("kanban.issue.transferDialog.title", {
            identifier: boardIssue.identifier,
          })}
        />
      ) : null}
      {onUnlink && unlinking ? (
        <ConfirmationDialog
          cancelDisabled={unlinking === "pending"}
          cancelLabel={t("kanban.issue.deleteDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={unlinking === "pending"}
          confirmLabel={t("kanban.panel.unlinkDialog.confirm")}
          confirmPending={unlinking === "pending"}
          description={t("kanban.panel.unlinkDialog.description", {
            identifier,
            session: agentSession?.name ?? "",
          })}
          onCancel={() => setUnlinking(null)}
          onConfirm={() => {
            setUnlinking("pending");
            onUnlink().then(
              () => setUnlinking(null),
              (unlinkError: unknown) => {
                setUnlinking(null);
                notifyError(formatError(unlinkError));
              },
            );
          }}
          title={t("kanban.panel.unlinkDialog.title", { identifier })}
        />
      ) : null}
      {pendingComment ? (
        <ConfirmationDialog
          cancelDisabled={commentDeletionPending}
          cancelLabel={t("kanban.issue.deleteDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={commentDeletionPending}
          confirmLabel={t("kanban.issue.deleteDialog.confirm")}
          confirmPending={commentDeletionPending}
          description={t("kanban.issue.comment.deleteDialog.description")}
          onCancel={() => setCommentToDelete(null)}
          onConfirm={() => void deleteComment(pendingComment)}
          returnFocusRef={commentReturnFocusRef}
          title={t("kanban.issue.comment.deleteDialog.title")}
        />
      ) : null}
    </section>
  );
}
