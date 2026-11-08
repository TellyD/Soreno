import { Plus } from "lucide-react";
import { useMemo } from "react";
import type { AgentProject } from "../../domain/agentSessions";
import {
  droppedIssueStateId,
  groupIssuesByState,
  issueColumnStateId,
  visibleStates,
  type KanbanBoardTab,
  type KanbanBoard as KanbanBoardData,
  type KanbanIssue,
  type KanbanIssuePatch,
  type KanbanWorkflowState,
} from "../../domain/kanban";
import type { KanbanIssueAgentSession } from "../../domain/kanbanAgent";
import {
  boardColumnAtPoint,
  useBoardDragAndDrop,
} from "../../hooks/useBoardDragAndDrop";
import { useI18n } from "../../i18n";
import { CountBadge } from "../ui/CountBadge";
import { IconButton } from "../ui/IconButton";
import {
  KanbanIssueCard,
  KanbanIssueDragPreview,
  KanbanStateIcon,
  kanbanDateFormatter,
} from "./KanbanIssueCard";

type KanbanColumnsProps = {
  agentSessions: ReadonlyMap<string, KanbanIssueAgentSession>;
  board: KanbanBoardData;
  issues: readonly KanbanIssue[];
  knownProjects: ReadonlyMap<string, AgentProject>;
  linearStates: readonly KanbanWorkflowState[];
  locale: string;
  onCreateIssue: (stateId: string, trigger: HTMLElement) => void;
  onOpenIssue: (issue: KanbanIssue) => void;
  onOpenProject: (projectId: string) => void;
  onOpenUrl: (url: string) => void;
  onUpdateIssue: (issue: KanbanIssue, patch: KanbanIssuePatch) => void;
  tab: KanbanBoardTab;
};

export function KanbanColumns({
  agentSessions,
  board,
  issues: boardIssues,
  knownProjects,
  linearStates,
  locale,
  onCreateIssue,
  onOpenIssue,
  onOpenProject,
  onOpenUrl,
  onUpdateIssue,
  tab,
}: KanbanColumnsProps) {
  const { t } = useI18n();
  const states = useMemo(
    () => visibleStates(board.states, tab),
    [board.states, tab],
  );
  const groups = useMemo(
    () => groupIssuesByState(boardIssues, board.states, linearStates),
    [boardIssues, board.states, linearStates],
  );
  const issueState = (issue: KanbanIssue) =>
    (issue.source === "linear" ? linearStates : board.states).find(
      ({ id }) => id === issue.stateId,
    );
  const formatDate = useMemo(() => kanbanDateFormatter(locale), [locale]);
  const drag = useBoardDragAndDrop<KanbanIssue, string>({
    canStartDrag: (_issue, target) => !target.closest("[data-kanban-no-drag]"),
    columnAtPoint: (x, y) => boardColumnAtPoint(x, y, "data-kanban-state"),
    getColumn: (issue) =>
      issueColumnStateId(issue, board.states, linearStates) ?? issue.stateId,
    getId: (issue) => issue.id,
    onDrop: (issue, column) => {
      const stateId = droppedIssueStateId(
        issue,
        column,
        board.states,
        linearStates,
      );
      if (stateId) onUpdateIssue(issue, { stateId });
    },
    onTap: onOpenIssue,
  });

  return (
    <div className="kanban-columns">
      {states.map((state) => {
        const issues = groups.get(state.id) ?? [];
        return (
          <section
            aria-label={state.name}
            className={`kanban-column${
              drag.dropColumn === state.id ? " drop-target" : ""
            }`}
            data-kanban-state={state.id}
            key={state.id}
          >
            <header className="kanban-column-header">
              <KanbanStateIcon size={14} state={state} />
              <h2>{state.name}</h2>
              <CountBadge count={issues.length} />
              <IconButton
                aria-label={t("kanban.create.inState", { state: state.name })}
                className="kanban-column-create"
                onClick={(event) =>
                  onCreateIssue(state.id, event.currentTarget)
                }
                size="small"
                title={t("kanban.create.inState", { state: state.name })}
              >
                <Plus size={14} />
              </IconButton>
            </header>
            <div className="kanban-column-body">
              {issues.map((issue) => (
                <KanbanIssueCard
                  agentSession={agentSessions.get(issue.id)}
                  formatDate={formatDate}
                  isDragging={drag.draggedId === issue.id}
                  issue={issue}
                  key={issue.id}
                  onOpenIssue={onOpenIssue}
                  onOpenProject={onOpenProject}
                  onOpenUrl={onOpenUrl}
                  pointerHandlers={drag.getPointerHandlers(issue)}
                  project={
                    issue.project
                      ? knownProjects.get(issue.project.id)
                      : undefined
                  }
                  state={issueState(issue) ?? state}
                />
              ))}
            </div>
          </section>
        );
      })}
      {drag.dragPreview ? (
        <KanbanIssueDragPreview
          dragPreview={drag.dragPreview}
          previewRef={drag.previewRef}
          state={issueState(drag.dragPreview.item)}
        />
      ) : null}
    </div>
  );
}
