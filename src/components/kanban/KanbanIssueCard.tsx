import {
  Bot,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleUserRound,
  CircleX,
  Ellipsis,
  GitPullRequest,
  LoaderCircle,
  OctagonAlert,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  type LucideIcon,
} from "lucide-react";
import type { DOMAttributes, RefObject } from "react";
import {
  type AgentProject,
  type AgentSessionActivity,
} from "../../domain/agentSessions";
import {
  kanbanPriorityName,
  type KanbanIssue,
  type KanbanPriorityName,
  type KanbanWorkflowState,
} from "../../domain/kanban";
import type { KanbanIssueAgentSession } from "../../domain/kanbanAgent";
import type { BoardDragPreview } from "../../hooks/useBoardDragAndDrop";
import { useI18n, type TranslationKey } from "../../i18n";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";

const stateIcons: Record<string, LucideIcon> = {
  backlog: CircleDashed,
  canceled: CircleX,
  completed: CircleCheck,
  started: CircleDot,
  unstarted: Circle,
};

const priorityIcons: Record<KanbanPriorityName, LucideIcon> = {
  high: SignalHigh,
  low: SignalLow,
  medium: SignalMedium,
  none: Ellipsis,
  urgent: OctagonAlert,
};

export const kanbanPriorityLabelKeys: Record<
  KanbanPriorityName,
  TranslationKey
> = {
  high: "kanban.priority.high",
  low: "kanban.priority.low",
  medium: "kanban.priority.medium",
  none: "kanban.priority.none",
  urgent: "kanban.priority.urgent",
};

const kanbanAgentActivityLabelKeys: Record<
  AgentSessionActivity,
  TranslationKey
> = {
  awaiting: "kanban.agent.activity.awaiting",
  running: "kanban.agent.activity.running",
  stopped: "kanban.agent.activity.stopped",
  waiting: "kanban.agent.activity.waiting",
  working: "kanban.agent.activity.working",
};

export function kanbanAgentStateLabelKey({
  activity,
  closed,
}: KanbanIssueAgentSession): TranslationKey {
  return closed
    ? "kanban.agent.closed"
    : kanbanAgentActivityLabelKeys[activity];
}

export function KanbanPriorityIcon({
  priority,
  size,
}: {
  priority: KanbanPriorityName;
  size: number;
}) {
  const Icon = priorityIcons[priority];
  return (
    <span
      aria-hidden="true"
      className={`kanban-priority-icon kanban-priority-${priority}`}
    >
      {priority === "low" || priority === "medium" || priority === "high" ? (
        <Signal className="kanban-priority-track" size={size} />
      ) : null}
      <Icon size={size} />
    </span>
  );
}

export function kanbanDateFormatter(locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
  });
  return (value: string) => formatter.format(new Date(value));
}

export function KanbanStateIcon({
  size,
  state,
}: {
  size: number;
  state: Pick<KanbanWorkflowState, "color" | "type">;
}) {
  const Icon = stateIcons[state.type] ?? Circle;
  return (
    <Icon
      aria-hidden="true"
      className="kanban-state-icon"
      color={state.color}
      size={size}
    />
  );
}

export function KanbanUserAvatar({
  size,
  url,
}: {
  size: number;
  url: string | undefined;
}) {
  return url ? (
    <img
      alt=""
      className="kanban-avatar"
      height={size}
      src={url}
      width={size}
    />
  ) : (
    <CircleUserRound
      aria-hidden="true"
      className="kanban-avatar-empty"
      size={size}
    />
  );
}

export function KanbanLinearBadge() {
  const { t } = useI18n();
  return (
    <span className="kanban-chip kanban-source-badge">
      {t("kanban.source.linear")}
    </span>
  );
}

type KanbanIssueCardProps = {
  agentSession: KanbanIssueAgentSession | undefined;
  formatDate: (value: string) => string;
  isDragging: boolean;
  issue: KanbanIssue;
  project: AgentProject | undefined;
  onOpenIssue: (issue: KanbanIssue) => void;
  onOpenProject: (projectId: string) => void;
  onOpenUrl: (url: string) => void;
  pointerHandlers: Pick<
    DOMAttributes<HTMLElement>,
    "onPointerCancel" | "onPointerDown" | "onPointerMove" | "onPointerUp"
  >;
  state: KanbanWorkflowState;
};

export function KanbanIssueCard({
  agentSession,
  formatDate,
  isDragging,
  issue,
  project,
  onOpenIssue,
  onOpenProject,
  onOpenUrl,
  pointerHandlers,
  state,
}: KanbanIssueCardProps) {
  const { t } = useI18n();
  const priority = kanbanPriorityName(issue.priority);
  const priorityLabel = t(kanbanPriorityLabelKeys[priority]);
  const agentLabel = agentSession
    ? t("kanban.agent.session", {
        activity: t(kanbanAgentStateLabelKey(agentSession)),
        name: agentSession.name,
      })
    : undefined;

  return (
    <article
      className={`kanban-card${isDragging ? " dragging" : ""}`}
      {...pointerHandlers}
    >
      <div className="kanban-card-top">
        <span className="kanban-card-identifier">{issue.identifier}</span>
        {issue.source === "linear" ? <KanbanLinearBadge /> : null}
      </div>

      <div className="kanban-card-title-row">
        <KanbanStateIcon size={14} state={state} />
        <button
          className="kanban-card-open"
          data-kanban-issue={issue.id}
          // Pointer clicks open the issue through the board's tap handling; this covers the keyboard.
          onClick={(event) => {
            if (event.detail === 0) onOpenIssue(issue);
          }}
          title={t("kanban.openIssue", { identifier: issue.identifier })}
          type="button"
        >
          <span className="kanban-card-title">{issue.title}</span>
        </button>
      </div>

      <div className="kanban-card-chips">
        <span
          aria-label={priorityLabel}
          className="kanban-chip kanban-priority"
          role="img"
          title={priorityLabel}
        >
          <KanbanPriorityIcon priority={priority} size={14} />
        </span>
        {issue.assignee ? (
          <span
            className="kanban-chip"
            title={t("kanban.issue.assignee")}
          >
            <KanbanUserAvatar size={14} url={issue.assignee.avatarUrl} />
            <span className="kanban-chip-label">{issue.assignee.name}</span>
          </span>
        ) : null}
        {agentSession ? (
          <span
            aria-label={agentLabel}
            className={`kanban-chip kanban-chip-agent is-${agentSession.activity}`}
            role="img"
            title={agentLabel}
          >
            {agentSession.activity === "working" ? (
              <LoaderCircle className="app-loading-spinner" size={14} />
            ) : (
              <Bot size={14} />
            )}
          </span>
        ) : null}
        {issue.project && project ? (
          <button
            aria-label={t("kanban.openProject", { name: project.name })}
            className="kanban-chip kanban-chip-project kanban-chip-button"
            data-kanban-no-drag
            onClick={() => onOpenProject(project.id)}
            title={t("kanban.openProject", { name: project.name })}
            type="button"
          >
            <AgentProjectIcon project={project} size={13} />
            <span className="kanban-chip-label">{project.name}</span>
          </button>
        ) : issue.project ? (
          <span className="kanban-chip kanban-chip-project">
            <AgentProjectIcon project={undefined} size={13} />
            <span className="kanban-chip-label">{issue.project.name}</span>
          </span>
        ) : null}
        {issue.pullRequests.map((pullRequest) => (
          <button
            aria-label={t("kanban.pullRequest", { number: pullRequest.number })}
            className="kanban-chip kanban-chip-button"
            data-kanban-no-drag
            key={pullRequest.url}
            onClick={() => onOpenUrl(pullRequest.url)}
            title={t("kanban.pullRequest", { number: pullRequest.number })}
            type="button"
          >
            <GitPullRequest aria-hidden="true" size={13} />
            <span className="kanban-chip-label">#{pullRequest.number}</span>
          </button>
        ))}
      </div>

      <div className="kanban-card-footer">
        <span>
          {t("kanban.created", { date: formatDate(issue.createdAt) })}
        </span>
        <span>
          {t("kanban.updated", { date: formatDate(issue.updatedAt) })}
        </span>
      </div>
    </article>
  );
}

export function KanbanIssueDragPreview({
  dragPreview,
  previewRef,
  state,
}: {
  dragPreview: BoardDragPreview<KanbanIssue>;
  previewRef: RefObject<HTMLElement | null>;
  state: KanbanWorkflowState | undefined;
}) {
  return (
    <article
      aria-hidden="true"
      className="kanban-card kanban-drag-preview"
      ref={previewRef}
      style={{
        left: dragPreview.x,
        minHeight: dragPreview.height,
        top: dragPreview.y,
        width: dragPreview.width,
      }}
    >
      <div className="kanban-card-top">
        <span className="kanban-card-identifier">
          {dragPreview.item.identifier}
        </span>
        {dragPreview.item.source === "linear" ? <KanbanLinearBadge /> : null}
      </div>
      <div className="kanban-card-title-row">
        {state ? <KanbanStateIcon size={14} state={state} /> : <span />}
        <span className="kanban-card-title">{dragPreview.item.title}</span>
      </div>
    </article>
  );
}
