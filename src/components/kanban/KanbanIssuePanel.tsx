import { Search, SquareKanban, SquarePen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  defaultCreateSource,
  type KanbanIssue,
  type KanbanIssueSelection,
} from "../../domain/kanban";
import {
  useKanbanControllerContext,
  type KanbanController,
} from "../../hooks/useKanbanController";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { KanbanStateIcon } from "./KanbanIssueCard";
import {
  KanbanIssueCreateDialog,
  type KanbanIssueCreateDefaults,
} from "./KanbanIssueCreateDialog";
import { KanbanIssueView } from "./KanbanIssueView";

type KanbanIssuePanelProps = {
  sessionId: string;
  // Soreno project a new issue of the session belongs to.
  projectId: string | undefined;
  // Null while the session has no issue: the panel offers to create or choose one.
  selection: KanbanIssueSelection | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  onDeleted: () => void;
  // The panel only shows the session's own issue: other issues open in the board.
  onOpenInKanban: (issue: KanbanIssueSelection) => void;
};

// Done or canceled issues are no agent's task anymore.
const closedStateTypes: Record<string, true> = {
  canceled: true,
  completed: true,
};

/** An agent session's linked issue beside its terminal; renders under an enabled `KanbanControllerProvider`. */
export function KanbanIssuePanel({
  sessionId,
  projectId,
  selection,
  expanded,
  onExpandedChange,
  onClose,
  onDeleted,
  onOpenInKanban,
}: KanbanIssuePanelProps) {
  const kanban = useKanbanControllerContext();
  // The board sits in a hidden pane meanwhile, so its own dialog would not show.
  const [createDefaults, setCreateDefaults] =
    useState<KanbanIssueCreateDefaults | null>(null);
  // The panel outlives session switches, so the dialog links the session it was opened for.
  const [createSessionId, setCreateSessionId] = useState(sessionId);
  const createReturnFocusRef = useRef<HTMLElement | null>(null);
  // The create button moves between the empty state and the list: the ref follows the mounted one.
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Set while linking or unlinking from the panel, so the view that replaces the gone one takes the focus.
  const focusSwitchRef = useRef(false);
  const releaseLinearTeam = kanban?.releaseLinearTeam;
  useEffect(() => {
    if (!createDefaults) releaseLinearTeam?.();
  }, [createDefaults, releaseLinearTeam]);
  useEffect(() => {
    if (!focusSwitchRef.current) return;
    focusSwitchRef.current = false;
    hostRef.current
      ?.querySelector<HTMLElement>(".kanban-issue-view, .kanban-issue-attach")
      ?.focus({ preventScroll: true });
  }, [selection?.id]);
  if (!kanban) return null;
  // A transfer shows the Linear issue before the session link is reloaded.
  const shown =
    selection && (kanban.replacedIssues.get(selection.id) ?? selection);

  async function switchIssue(change: () => Promise<void>) {
    focusSwitchRef.current = true;
    try {
      await change();
    } catch (error) {
      focusSwitchRef.current = false;
      throw error;
    }
  }
  const attach = (issue: KanbanIssue, target = sessionId) =>
    target === sessionId
      ? switchIssue(() => kanban.attachSessionIssue(target, issue))
      : kanban.attachSessionIssue(target, issue);

  return (
    <div className="kanban-issue-panel" ref={hostRef}>
      {shown ? (
        <KanbanIssueView
          // A pending confirmation must not act on another session's or issue's view.
          key={`${sessionId}:${shown.source}:${shown.id}`}
          kanban={kanban}
          onBack={onClose}
          onCreateSubIssue={(parent, trigger) => {
            createReturnFocusRef.current = trigger;
            setCreateDefaults({
              source: parent.source,
              column: null,
              project: parent.project,
              parentId: parent.id,
            });
          }}
          onDeleted={onDeleted}
          onOpenIssue={onOpenInKanban}
          panel={{
            expanded,
            onExpandedChange,
            onOpenKanban: () => onOpenInKanban(shown),
            onUnlink: () =>
              switchIssue(() =>
                kanban.detachSessionIssue(sessionId, shown.identifier),
              ),
          }}
          selection={shown}
        />
      ) : (
        <KanbanIssueAttach
          kanban={kanban}
          projectId={projectId}
          onAttach={(issue) => attach(issue)}
          onClose={onClose}
          createButtonRef={createButtonRef}
          onCreate={() => {
            const project = kanban.kanbanProjects.find(
              ({ id }) => id === projectId,
            );
            setCreateSessionId(sessionId);
            setCreateDefaults({
              source: defaultCreateSource(
                "all",
                kanban.rememberedCreateSource,
                kanban.linearAvailable,
              ),
              column: null,
              project: project ? { id: project.id, name: project.name } : null,
            });
          }}
        />
      )}
      {createDefaults &&
      kanban.createDialog &&
      (createDefaults.source !== "linear" || kanban.linear) ? (
        <KanbanIssueCreateDialog
          {...kanban.createDialog}
          defaults={createDefaults}
          forSession={!createDefaults.parentId}
          // A creation resolving after a newer dialog opened must close only its own dialog.
          onClose={() =>
            setCreateDefaults((current) =>
              current === createDefaults ? null : current,
            )
          }
          onCreate={
            createDefaults.parentId
              ? kanban.createDialog.onCreate
              : async (source, input) => {
                  const issue = await kanban.createBoardIssue(
                    source,
                    input,
                    null,
                  );
                  // The issue exists: a failed link is reported without reopening its draft.
                  void attach(issue, createSessionId).catch((error: unknown) =>
                    notifyError(kanban.formatError(error)),
                  );
                }
          }
          returnFocusRef={
            createDefaults.parentId ? createReturnFocusRef : createButtonRef
          }
        />
      ) : null}
    </div>
  );
}

function KanbanIssueAttach({
  kanban,
  projectId,
  onAttach,
  onClose,
  onCreate,
  createButtonRef,
}: {
  kanban: KanbanController;
  projectId: string | undefined;
  onAttach: (issue: KanbanIssue) => Promise<void>;
  onClose: () => void;
  onCreate: () => void;
  createButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [attaching, setAttaching] = useState(false);
  const { board, issueAgents, issues, linear } = kanban;
  const states = useMemo(
    () =>
      new Map(
        [...(board?.states ?? []), ...(linear?.states ?? [])].map((state) => [
          state.id,
          state,
        ]),
      ),
    [board, linear],
  );
  // Open issues without an agent, those of the session's project first.
  const available = useMemo(() => {
    const free = issues.filter((issue) => {
      const state = states.get(issue.stateId);
      return (
        !issueAgents.live.has(issue.id) &&
        !(state && closedStateTypes[state.type])
      );
    });
    return [
      ...free.filter((issue) => issue.project?.id === projectId),
      ...free.filter((issue) => issue.project?.id !== projectId),
    ];
  }, [issueAgents, issues, projectId, states]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? available.filter((issue) =>
          `${issue.identifier} ${issue.title}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : available;
  }, [available, query]);

  async function choose(issue: KanbanIssue) {
    setAttaching(true);
    try {
      await onAttach(issue);
    } catch (error) {
      notifyError(kanban.formatError(error));
    } finally {
      setAttaching(false);
    }
  }
  const createButton = (
    <Button
      ref={createButtonRef}
      disabled={attaching || !kanban.createDialog}
      onClick={onCreate}
      size="small"
      startIcon={<SquarePen />}
    >
      {t("kanban.attach.create")}
    </Button>
  );

  return (
    <section
      aria-label={t("kanban.attach.title")}
      className="kanban-issue-attach"
      tabIndex={-1}
    >
      <header className="agent-git-panel-header">
        <div className="git-panel-heading">
          <h2>{t("kanban.attach.title")}</h2>
        </div>
        <div className="git-panel-header-actions">
          <IconButton
            aria-label={t("kanban.attach.close")}
            onClick={onClose}
            size="small"
            title={t("kanban.attach.close")}
          >
            <X />
          </IconButton>
        </div>
      </header>
      {board ? (
        <div className="kanban-issue-attach-body">
          {available.length === 0 ? (
            <EmptyState
              fill
              size="compact"
              icon={<SquareKanban />}
              title={t("kanban.attach.emptyTitle")}
              description={t("kanban.attach.empty")}
              actions={createButton}
            />
          ) : (
            <>
              {createButton}
              <Input
                aria-label={t("kanban.attach.search")}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("kanban.attach.search")}
                size="small"
                startIcon={<Search />}
                type="search"
                value={query}
              />
              {candidates.length > 0 ? (
                <ul className="kanban-issue-children">
                  {candidates.map((issue) => {
                    const state = states.get(issue.stateId);
                    return (
                      <li key={`${issue.source}:${issue.id}`}>
                        <button
                          className="kanban-issue-child"
                          disabled={attaching}
                          onClick={() => void choose(issue)}
                          type="button"
                        >
                          {state ? (
                            <KanbanStateIcon size={14} state={state} />
                          ) : null}
                          <span className="kanban-card-identifier">
                            {issue.identifier}
                          </span>
                          <span className="kanban-issue-child-title">
                            {issue.title}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="kanban-issue-muted">
                  {t("kanban.attach.noMatch")}
                </p>
              )}
            </>
          )}
        </div>
      ) : kanban.error ? (
        <p className="kanban-issue-attach-body kanban-issue-muted" role="alert">
          {kanban.formatError(kanban.error)}
        </p>
      ) : (
        <LoadingState className="kanban-board-status">
          {t("kanban.loading")}
        </LoadingState>
      )}
    </section>
  );
}
