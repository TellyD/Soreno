import { GitBranch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  visibleIssueAgentPresets,
  type AgentSessionEndReason,
  type AgentSessionKanbanIssue,
} from "../../domain/agentSessions";
import type { KanbanProjectRef } from "../../domain/kanban";
import {
  type KanbanIssueAgentSession,
  type KanbanIssueAgentTarget,
} from "../../domain/kanbanAgent";
import { useKanbanErrorFormatter } from "../../hooks/useKanbanErrorFormatter";
import { useI18n, type TranslationKey } from "../../i18n";
import { useAppSettings } from "../../settings";
import { notifyError } from "../../notifications";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { kanbanAgentStateLabelKey } from "./KanbanIssueCard";
import { KanbanAgentPresetSelect } from "./KanbanIssueFieldControls";

const endReasonLabelKeys: Record<AgentSessionEndReason, TranslationKey> = {
  merged: "kanban.agent.ended.merged",
  project: "kanban.agent.ended.project",
  session: "kanban.agent.ended.session",
  worktree: "kanban.agent.ended.worktree",
};

function KanbanIssueAgentRow({
  date,
  executable,
  name,
  projectName,
  state,
}: {
  date?: string;
  executable: string;
  name: string;
  projectName: string;
  state: string;
}) {
  return (
    <>
      <span className="kanban-issue-property">
        <AgentProviderIcon executable={executable} size={14} />
        <span className="kanban-chip-label">{name}</span>
        <span className="kanban-issue-agent-activity" title={state}>
          {state}
        </span>
      </span>
      {projectName ? (
        <span
          className="kanban-issue-property kanban-issue-agent-detail"
          title={projectName}
        >
          <span className="kanban-chip-label">{projectName}</span>
          {date ? (
            <span className="kanban-issue-agent-activity">{date}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export function KanbanIssueAgentSection({
  agentPreset,
  agentSession,
  branchName,
  endedAgent,
  formatDate,
  onOpenSession,
  onStart,
  overview,
  project,
  projectUnavailable,
  starting,
}: {
  agentPreset: string | null;
  agentSession: KanbanIssueAgentSession | undefined;
  branchName: string;
  endedAgent: AgentSessionKanbanIssue | undefined;
  // The project is a group overview: the agent starts in its folder, never in a worktree.
  overview: boolean;
  formatDate: (value: string) => string;
  // Unset where the session is already on screen: no button to open it.
  onOpenSession?: (sessionId: string) => void;
  onStart: (target: KanbanIssueAgentTarget) => Promise<void>;
  // The agent starts in the issue's project, chosen in the issue properties.
  project: KanbanProjectRef | null;
  // The issue's project is gone or not agent-eligible: the user must pick another.
  projectUnavailable: boolean;
  // The board's start is in flight for this issue, whichever control launched it.
  starting: boolean;
}) {
  const { t } = useI18n();
  const formatError = useKanbanErrorFormatter();
  const { settings } = useAppSettings();
  const [chosenPreset, setChosenPreset] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(true);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const focusPresetSelectRef = useRef(false);
  const presetSelectRef = useRef<HTMLButtonElement>(null);
  const presets = visibleIssueAgentPresets(settings.hiddenAgentPresets);
  const preset =
    presets.find(
      ({ executable }) => executable === (chosenPreset ?? agentPreset),
    ) ?? presets[0];
  const showSettings = settingsOpen || !project || projectUnavailable;
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setSettingsOpen(true);
      set(value);
    };

  useEffect(() => {
    if (!settingsOpen || !focusPresetSelectRef.current) return;
    focusPresetSelectRef.current = false;
    presetSelectRef.current?.focus();
  }, [settingsOpen]);

  async function start() {
    if (!project || projectUnavailable || starting) return;
    try {
      await onStart({
        projectId: project.id,
        executable: preset.executable,
        presetName: preset.name,
        worktree: !overview && worktree,
        open,
      });
    } catch (error) {
      notifyError(formatError(error));
    }
  }

  const branchLine = (
    <span
      className="kanban-issue-property kanban-issue-agent-detail"
      title={branchName}
    >
      <GitBranch aria-hidden="true" size={14} />
      <span className="kanban-chip-label">{branchName}</span>
    </span>
  );

  return (
    <section className="kanban-issue-sidebar-section kanban-issue-agent">
      <h2 className="kanban-issue-sidebar-label">{t("kanban.agent.title")}</h2>
      {agentSession ? (
        <>
          <KanbanIssueAgentRow
            executable={agentSession.session.executable}
            name={agentSession.name}
            projectName={agentSession.projectName}
            state={t(kanbanAgentStateLabelKey(agentSession))}
          />
          {onOpenSession ? (
            <div className="kanban-issue-agent-actions">
              <Button
                onClick={() => onOpenSession(agentSession.session.id)}
                size="small"
              >
                {agentSession.closed
                  ? t("kanban.agent.reopenSession")
                  : t("kanban.agent.openSession")}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {endedAgent?.endedAt && endedAgent.endReason ? (
            <KanbanIssueAgentRow
              date={formatDate(endedAgent.endedAt)}
              executable={endedAgent.executable}
              name={endedAgent.sessionName}
              projectName={endedAgent.projectName}
              state={t(endReasonLabelKeys[endedAgent.endReason], {
                branch: endedAgent.mergedInto ?? "",
              })}
            />
          ) : null}
          <div className="kanban-issue-agent-form">
            {showSettings ? (
              <>
                {project ? null : (
                  <p className="kanban-issue-muted">
                    {t("kanban.agent.projectRequired")}
                  </p>
                )}
                {projectUnavailable ? (
                  <p className="kanban-issue-muted">
                    {t("kanban.agent.projectUnavailable")}
                  </p>
                ) : null}
                <KanbanAgentPresetSelect
                  disabled={starting}
                  onChange={edit(setChosenPreset)}
                  preset={preset}
                  presets={presets}
                  ref={presetSelectRef}
                />
                {overview ? null : (
                  <>
                    <label className="kanban-issue-property kanban-issue-agent-option">
                      <Checkbox
                        checked={worktree}
                        disabled={starting}
                        onCheckedChange={edit(setWorktree)}
                      />
                      <span>{t("kanban.agent.worktree")}</span>
                    </label>
                    {worktree ? branchLine : null}
                  </>
                )}
                <label className="kanban-issue-property kanban-issue-agent-option">
                  <Checkbox
                    checked={open}
                    disabled={starting}
                    onCheckedChange={edit(setOpen)}
                  />
                  <span>{t("kanban.agent.openAfterStart")}</span>
                </label>
              </>
            ) : project ? (
              <>
                <span className="kanban-issue-property">
                  <AgentProviderIcon executable={preset.executable} size={14} />
                  <span className="kanban-chip-label">
                    {t(
                      overview
                        ? "kanban.agent.summaryInProject"
                        : "kanban.agent.summary",
                      { agent: preset.name, project: project.name },
                    )}
                  </span>
                </span>
                {overview ? null : branchLine}
              </>
            ) : null}
            <div className="kanban-issue-agent-actions">
              <Button
                disabled={!project || projectUnavailable || starting}
                onClick={() => void start()}
                size="small"
                variant="primary"
              >
                {starting
                  ? t("kanban.agent.starting")
                  : t("kanban.agent.start")}
              </Button>
              {showSettings ? null : (
                <Button
                  disabled={starting}
                  onClick={() => {
                    focusPresetSelectRef.current = true;
                    setSettingsOpen(true);
                  }}
                  size="small"
                >
                  {t("kanban.agent.change")}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
