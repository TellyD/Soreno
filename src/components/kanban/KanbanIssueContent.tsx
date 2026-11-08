import {
  CircleUserRound,
  FolderOpen,
  GitPullRequest,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import { openKanbanImage } from "../../data/kanbanApi";
import {
  type AgentProject,
  type AgentSession,
  type AgentSessionStatus,
  type AgentSessionKanbanIssue,
} from "../../domain/agentSessions";
import {
  kanbanImageName,
  kanbanPriorityName,
  type KanbanComment,
  type KanbanIssue,
  type KanbanIssueDetail,
  type KanbanIssuePatch,
  type KanbanIssueSelection,
  type KanbanLabel,
  type KanbanWorkflowState,
} from "../../domain/kanban";
import {
  kanbanAgentComment,
  kanbanCommentTargets,
  type KanbanIssueAgentRequest,
  type KanbanIssueAgentSession,
} from "../../domain/kanbanAgent";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { MarkdownContent, type MarkdownLocalLinks } from "../MarkdownContent";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { CountBadge } from "../ui/CountBadge";
import { IconButton } from "../ui/IconButton";
import {
  KanbanPriorityIcon,
  KanbanStateIcon,
  KanbanUserAvatar,
  kanbanDateFormatter,
  kanbanPriorityLabelKeys,
} from "./KanbanIssueCard";
import { KanbanCommentComposer } from "./KanbanCommentComposer";
import { KanbanCommentToAgent } from "./KanbanCommentToAgent";
import { KanbanIssueAgentSection } from "./KanbanIssueAgentSection";
import { KanbanIssueDescription } from "./KanbanIssueDescription";
import {
  KanbanLabelDot,
  KanbanLabelsMenu,
  KanbanPrioritySelect,
  KanbanProjectSelect,
  KanbanStateSelect,
} from "./KanbanIssueFieldControls";
import { KanbanIssueSidebar } from "./KanbanIssueSidebar";
import { KanbanIssueTitle } from "./KanbanIssueTitle";

type KanbanIssueDetailProps = {
  // Executable of the last started agent preset, if remembered.
  agentPreset: string | null;
  agentSession: KanbanIssueAgentSession | undefined;
  // An agent start for the shown issue is in flight.
  agentStarting: boolean;
  // Shown beside the issue's own session: comments go to that agent or nowhere, and it needs no open button.
  besideSession: boolean;
  // All agent sessions, statuses and terminal titles: comments go to the issue's or its project's agents.
  sessions: readonly AgentSession[];
  statuses: readonly AgentSessionStatus[];
  terminalTitles: Readonly<Record<string, string>>;
  // Last agent of the issue once its session was deleted.
  endedAgent: AgentSessionKanbanIssue | undefined;
  // The board copy is the source of truth for editable fields when the issue is on it.
  boardIssue: KanbanIssue | undefined;
  formatError: (error: unknown) => string;
  // Soreno projects an issue can belong to.
  kanbanProjects: readonly AgentProject[];
  // Soreno projects a project chip can open or an agent can start in, by id.
  knownProjects: ReadonlyMap<string, AgentProject>;
  // Group overview projects, where agents start without a worktree.
  overviewProjectIds: ReadonlySet<string>;
  labels: readonly KanbanLabel[];
  locale: string;
  onCreateLabel: (name: string) => Promise<KanbanLabel | null>;
  onOpenIssue: (issue: KanbanIssueSelection) => void;
  onOpenProject: (projectId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenUrl: (url: string) => void;
  onStartAgent: (request: KanbanIssueAgentRequest) => Promise<void>;
  onUpdateIssue: (issue: KanbanIssue, patch: KanbanIssuePatch) => void;
  states: readonly KanbanWorkflowState[];
};

type KanbanIssueContentProps = KanbanIssueDetailProps & {
  detail: KanbanIssueDetail;
  onAddComment: (body: string) => Promise<void>;
  onDeleteComment: (comment: KanbanComment) => void;
  onSaveDescription: (description: string) => Promise<string | null>;
};

export function KanbanIssueContent({
  agentPreset,
  agentSession,
  agentStarting,
  besideSession,
  sessions,
  statuses,
  terminalTitles,
  endedAgent,
  boardIssue,
  detail,
  formatError,
  kanbanProjects,
  knownProjects,
  labels,
  locale,
  onAddComment,
  onDeleteComment,
  onCreateLabel,
  onOpenIssue,
  onOpenProject,
  overviewProjectIds,
  onOpenSession,
  onOpenUrl,
  onSaveDescription,
  onStartAgent,
  onUpdateIssue,
  states,
}: KanbanIssueContentProps) {
  const { t } = useI18n();
  const formatDate = useMemo(() => kanbanDateFormatter(locale), [locale]);
  const issue = boardIssue ?? detail;
  const state = states.find(({ id }) => id === issue.stateId);
  const priority = kanbanPriorityName(issue.priority);
  const knownProject = issue.project
    ? knownProjects.get(issue.project.id)
    : undefined;
  const projectTargets = kanbanCommentTargets(
    agentSession,
    issue.project?.id,
    sessions,
    statuses,
    terminalTitles,
  );
  const commentTargets = besideSession
    ? projectTargets.filter(({ linkedToIssue }) => linkedToIssue)
    : projectTargets;
  const imageLinks = useMemo<MarkdownLocalLinks>(
    () => ({
      accepts: (href) => kanbanImageName(href) !== null,
      open: (href) => {
        const name = kanbanImageName(href);
        if (name)
          void openKanbanImage(name).catch((error: unknown) =>
            notifyError(formatError(error)),
          );
      },
    }),
    [formatError],
  );

  return (
    <div className="kanban-issue-body">
      <article className="kanban-issue-main">
        <KanbanIssueTitle
          onRename={
            boardIssue
              ? (title) => onUpdateIssue(boardIssue, { title })
              : undefined
          }
          title={issue.title}
        />
        <KanbanIssueDescription
          description={detail.description}
          formatError={formatError}
          issueId={detail.id}
          onSave={onSaveDescription}
        />

        {detail.children.length > 0 ? (
          <section className="kanban-issue-section">
            <h2 className="kanban-issue-heading">
              {t("kanban.issue.children")}
              <CountBadge count={detail.children.length} />
            </h2>
            <ul className="kanban-issue-children">
              {detail.children.map((child) => (
                <li key={child.id}>
                  <button
                    className="kanban-issue-child"
                    onClick={() =>
                      onOpenIssue({
                        id: child.id,
                        identifier: child.identifier,
                        source: detail.source,
                      })
                    }
                    type="button"
                  >
                    <KanbanStateIcon size={14} state={child.state} />
                    <span className="kanban-card-identifier">
                      {child.identifier}
                    </span>
                    <span className="kanban-issue-child-title">
                      {child.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {detail.pullRequests.length > 0 ? (
          <section className="kanban-issue-section">
            <h2 className="kanban-issue-heading">
              {t("kanban.issue.pullRequests")}
            </h2>
            <div className="kanban-card-chips">
              {detail.pullRequests.map((pullRequest) => (
                <button
                  aria-label={t("kanban.pullRequest", {
                    number: pullRequest.number,
                  })}
                  className="kanban-chip kanban-chip-button"
                  key={pullRequest.url}
                  onClick={() => onOpenUrl(pullRequest.url)}
                  title={t("kanban.pullRequest", {
                    number: pullRequest.number,
                  })}
                  type="button"
                >
                  <GitPullRequest aria-hidden="true" size={13} />
                  <span className="kanban-chip-label">
                    #{pullRequest.number}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="kanban-issue-section">
          <h2 className="kanban-issue-heading">{t("kanban.issue.activity")}</h2>
          <ol className="kanban-issue-activity">
            <li className="kanban-issue-event">
              <span>{t("kanban.issue.created")}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={detail.createdAt}>
                {formatDate(detail.createdAt)}
              </time>
            </li>
            {detail.comments.map((comment) => {
              const agentComment = kanbanAgentComment(comment.body);
              return (
                <li className="kanban-issue-comment" key={comment.id}>
                  <header className="kanban-issue-comment-header">
                    <span aria-hidden="true">
                      {agentComment ? (
                        <span className="kanban-issue-comment-agent-avatar">
                          <AgentProviderIcon
                            executable={agentComment.executable}
                          />
                        </span>
                      ) : (
                        <KanbanUserAvatar
                          label={comment.user?.name ?? t("kanban.issue.you")}
                        />
                      )}
                    </span>
                    <span className="kanban-issue-comment-author">
                      {agentComment?.name ??
                        comment.user?.name ??
                        t("kanban.issue.you")}
                    </span>
                    <time dateTime={comment.createdAt}>
                      {formatDate(comment.createdAt)}
                    </time>
                    <IconButton
                      aria-label={t("kanban.issue.comment.delete")}
                      className="kanban-issue-comment-delete"
                      onClick={() => onDeleteComment(comment)}
                      size="small"
                      title={t("kanban.issue.comment.delete")}
                      tone="danger"
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </header>
                  <MarkdownContent
                    className="kanban-markdown"
                    content={agentComment?.body ?? comment.body}
                    localLinks={imageLinks}
                  />
                  {agentComment ? null : (
                    <KanbanCommentToAgent
                      issue={{
                        identifier: detail.identifier,
                        title: issue.title,
                      }}
                      comment={comment}
                      targets={commentTargets}
                    />
                  )}
                </li>
              );
            })}
          </ol>
          <KanbanCommentComposer
            formatError={formatError}
            onAddComment={onAddComment}
          />
        </section>
      </article>

      <KanbanIssueSidebar>
        <section className="kanban-issue-sidebar-section">
          <h2 className="kanban-issue-sidebar-label">
            {t("kanban.issue.properties")}
          </h2>
          {boardIssue && state ? (
            <KanbanStateSelect
              onChange={(stateId) => onUpdateIssue(boardIssue, { stateId })}
              states={states}
              value={state.id}
            />
          ) : (
            <span
              className="kanban-issue-property"
              title={t("kanban.issue.state")}
            >
              {state ? (
                <>
                  <KanbanStateIcon size={14} state={state} />
                  {state.name}
                </>
              ) : (
                t("kanban.issue.unknownState")
              )}
            </span>
          )}
          {boardIssue ? (
            <KanbanPrioritySelect
              onChange={(nextPriority) =>
                onUpdateIssue(boardIssue, { priority: nextPriority })
              }
              value={boardIssue.priority}
            />
          ) : (
            <span
              className="kanban-issue-property"
              title={t("kanban.issue.priority")}
            >
              <KanbanPriorityIcon priority={priority} size={14} />
              {t(kanbanPriorityLabelKeys[priority])}
            </span>
          )}
          {detail.source === "linear" ? (
            <span
              className="kanban-issue-property"
              title={t("kanban.issue.assignee")}
            >
              <CircleUserRound aria-hidden="true" size={14} />
              {issue.assignee?.name ?? t("kanban.issue.unassigned")}
            </span>
          ) : null}
        </section>

        {boardIssue || issue.labels.length > 0 ? (
          <section className="kanban-issue-sidebar-section">
            <h2 className="kanban-issue-sidebar-label">
              {t("kanban.issue.labels")}
            </h2>
            <ul className="kanban-issue-labels">
              {issue.labels.map((label) => (
                <li className="kanban-chip" key={label.id}>
                  <KanbanLabelDot label={label} />
                  <span className="kanban-chip-label">{label.name}</span>
                </li>
              ))}
              {boardIssue ? (
                <li>
                  <KanbanLabelsMenu
                    onChange={(nextLabels) =>
                      onUpdateIssue(boardIssue, { labels: nextLabels })
                    }
                    onCreateLabel={onCreateLabel}
                    options={labels}
                    value={boardIssue.labels}
                  />
                </li>
              ) : issue.labels.length === 0 ? (
                <li className="kanban-issue-muted">
                  {t("kanban.issue.noLabels")}
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        <section className="kanban-issue-sidebar-section">
          <h2 className="kanban-issue-sidebar-label">
            {t("kanban.project.label")}
          </h2>
          {boardIssue ? (
            <div className="kanban-issue-project-row">
              <KanbanProjectSelect
                onChange={(project) => onUpdateIssue(boardIssue, { project })}
                projects={kanbanProjects}
                value={knownProject ?? boardIssue.project}
              />
              {boardIssue.project && knownProject ? (
                <IconButton
                  aria-label={t("kanban.openProject", {
                    name: knownProject.name,
                  })}
                  onClick={() => onOpenProject(knownProject.id)}
                  size="small"
                  title={t("kanban.openProject", { name: knownProject.name })}
                >
                  <FolderOpen size={14} />
                </IconButton>
              ) : null}
            </div>
          ) : issue.project && knownProject ? (
            <button
              aria-label={t("kanban.openProject", { name: knownProject.name })}
              className="kanban-issue-property kanban-issue-property-button"
              onClick={() => onOpenProject(knownProject.id)}
              title={t("kanban.openProject", { name: knownProject.name })}
              type="button"
            >
              <AgentProjectIcon project={knownProject} size={13} />
              <span className="kanban-chip-label">{knownProject.name}</span>
            </button>
          ) : issue.project ? (
            <span className="kanban-issue-property">
              <AgentProjectIcon project={undefined} size={13} />
              <span className="kanban-chip-label">{issue.project.name}</span>
            </span>
          ) : (
            <span className="kanban-issue-property kanban-issue-muted">
              {t("kanban.project.none")}
            </span>
          )}
        </section>

        {issue.linearProject ? (
          <section className="kanban-issue-sidebar-section">
            <h2 className="kanban-issue-sidebar-label">
              {t("kanban.issue.linearProject")}
            </h2>
            <span className="kanban-chip">
              <KanbanLabelDot label={issue.linearProject} />
              <span className="kanban-chip-label">
                {issue.linearProject.name}
              </span>
            </span>
          </section>
        ) : null}

        <KanbanIssueAgentSection
          agentPreset={agentPreset}
          agentSession={
            agentSession && {
              ...agentSession,
              projectName:
                knownProjects.get(agentSession.session.projectId)?.name ??
                agentSession.projectName,
            }
          }
          endedAgent={endedAgent}
          formatDate={formatDate}
          branchName={detail.branchName}
          onOpenSession={besideSession ? undefined : onOpenSession}
          onStart={(target) =>
            onStartAgent({
              ...target,
              issue: {
                id: detail.id,
                identifier: detail.identifier,
                title: issue.title,
                description: detail.description,
                branchName: detail.branchName,
                source: detail.source,
              },
            })
          }
          overview={
            issue.project !== null && overviewProjectIds.has(issue.project.id)
          }
          project={knownProject ?? issue.project}
          projectUnavailable={issue.project !== null && !knownProject}
          starting={agentStarting}
        />
      </KanbanIssueSidebar>
    </div>
  );
}
