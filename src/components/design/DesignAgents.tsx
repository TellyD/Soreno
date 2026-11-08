import { Menu } from "@base-ui/react/menu";
import { Bot, ChevronDown, GitBranch, Hammer } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  agentSessionActivity,
  visibleIssueAgentPresets,
  type AgentProject,
  type AgentSession,
  type AgentSessionDesignBoard,
  type AgentSessionStatus,
} from "../../domain/agentSessions";
import {
  designBranchName,
  designInstructionsAccepted,
  type DesignAgentRequest,
  type DesignBoard,
  type DesignFrame,
  type DesignTarget,
} from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { useLastAgentPreset } from "../../hooks/useKanbanController";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { useAppSettings } from "../../settings";
import { FormDialog } from "../agents/AgentForms";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { useAgentStrings } from "../agents/agentStrings";
import { kanbanProjectOption } from "../kanban/KanbanIssueFieldControls";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { Select } from "../ui/Select";

export type DesignImplementOptions = {
  /** Connected repositories and group overviews, as the Kanban offers them. */
  projects: readonly AgentProject[];
  /** A board's own project, worktrees included; undefined when missing or disconnected. */
  boardProject: (projectId: string) => AgentProject | undefined;
  overviewProjectIds: ReadonlySet<string>;
  onStart: (request: DesignAgentRequest) => Promise<void>;
};

/** Hands the board, or its targeted frame, to a coding agent, like an issue launch. */
export function DesignImplement({
  board,
  frames,
  target,
  options: { projects, boardProject, overviewProjectIds, onStart },
}: {
  board: DesignBoard;
  frames: readonly DesignFrame[];
  target: DesignTarget;
  options: DesignImplementOptions;
}) {
  const { t } = useI18n();
  const { settings } = useAppSettings();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const targetFrame =
    target.kind === "board"
      ? undefined
      : frames.find((frame) => frame.id === target.frameId);
  const [form, setForm] = useState<{
    scope: "board" | "frame";
    projectId: string;
    executable: string | null;
    worktree: boolean;
    open: boolean;
    instructions: string;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [lastPreset, setLastPreset] = useLastAgentPreset();
  const presets = visibleIssueAgentPresets(settings.hiddenAgentPresets);
  const preset =
    presets.find(
      ({ executable }) => executable === (form?.executable ?? lastPreset),
    ) ?? presets[0];
  const project = board.projectId
    ? boardProject(board.projectId)
    : projects.find(({ id }) => id === form?.projectId);
  const overview = !!project && overviewProjectIds.has(project.id);
  // Reading order on the board: left to right, then top to bottom.
  const shown =
    form?.scope === "frame" && targetFrame
      ? [targetFrame]
      : [...frames].sort((left, right) => left.x - right.x || left.y - right.y);
  const instructionsAccepted =
    !form || designInstructionsAccepted(form.instructions);
  async function start() {
    if (!form || !project || starting || !shown.length || !instructionsAccepted)
      return;
    setStarting(true);
    try {
      await onStart({
        board: { id: board.id, name: board.name },
        frames: shown,
        instructions: form.instructions,
        projectId: project.id,
        executable: preset.executable,
        presetName: preset.name,
        worktree: !overview && form.worktree,
        open: form.open,
      });
      setLastPreset(preset.executable);
      setForm(null);
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <Button
        ref={triggerRef}
        size="small"
        startIcon={<Hammer />}
        disabled={!frames.length}
        title={frames.length ? undefined : t("design.implement.noFrames")}
        onClick={() =>
          setForm({
            scope: targetFrame ? "frame" : "board",
            projectId: board.projectId ?? projects[0]?.id ?? "",
            executable: null,
            worktree: true,
            open: false,
            instructions: "",
          })
        }
      >
        {t("design.implement.button")}
      </Button>
      {/* Portalled: the toolbar's stacking context sits under the Logs drawer and prompt bar. */}
      {form
        ? createPortal(
            <FormDialog
              title={t("design.implement.title", { name: board.name })}
              submitLabel={t("design.implement.start")}
              busy={starting}
              pending={starting}
              submitDisabled={
                !project || !shown.length || !instructionsAccepted
              }
              returnFocusRef={triggerRef}
              onCancel={() => setForm(null)}
              onSubmit={() => void start()}
            >
              <p className="agent-form-hint">
                {t("design.implement.description")}
              </p>
              <label htmlFor={`${id}-scope`}>
                {t("design.implement.scope")}
              </label>
              <Select
                id={`${id}-scope`}
                value={form.scope}
                options={[
                  { value: "board", label: t("design.implement.scopeBoard") },
                  {
                    value: "frame",
                    label: targetFrame
                      ? t("design.implement.scopeFrame", {
                          title: targetFrame.title,
                        })
                      : t("design.implement.scopeFrameNone"),
                    disabled: !targetFrame,
                  },
                ]}
                onValueChange={(scope) =>
                  setForm({ ...form, scope: scope as "board" | "frame" })
                }
              />
              {board.projectId || !projects.length ? (
                <>
                  <span className="design-dialog-label">
                    {t("design.field.project")}
                  </span>
                  <span className="design-dialog-value">
                    {project ? (
                      <>
                        <AgentProjectIcon project={project} size={14} />
                        {project.name}
                      </>
                    ) : board.projectId ? (
                      t("kanban.agent.projectUnavailable")
                    ) : (
                      t("design.implement.noProject")
                    )}
                  </span>
                </>
              ) : (
                <>
                  <label htmlFor={`${id}-project`}>
                    {t("design.field.project")}
                  </label>
                  <Select
                    id={`${id}-project`}
                    value={form.projectId}
                    options={projects.map((item) =>
                      kanbanProjectOption(
                        item,
                        item,
                        t("kanban.project.local"),
                      ),
                    )}
                    onValueChange={(projectId) =>
                      setForm({ ...form, projectId })
                    }
                  />
                </>
              )}
              <label htmlFor={`${id}-agent`}>{t("design.field.agent")}</label>
              <Select
                id={`${id}-agent`}
                value={preset.executable}
                options={presets.map((item) => ({
                  value: item.executable,
                  label: item.name,
                  icon: (
                    <AgentProviderIcon executable={item.executable} size={14} />
                  ),
                }))}
                onValueChange={(executable) => setForm({ ...form, executable })}
              />
              <label htmlFor={`${id}-instructions`}>
                {t("design.implement.instructions")}
              </label>
              <textarea
                id={`${id}-instructions`}
                className="design-dialog-textarea"
                rows={3}
                // The byte cap is checked below: this only stops typing far beyond it.
                maxLength={16 * 1024}
                placeholder={t("design.implement.instructionsPlaceholder")}
                value={form.instructions}
                aria-invalid={!instructionsAccepted || undefined}
                aria-describedby={
                  instructionsAccepted ? undefined : `${id}-instructions-error`
                }
                onChange={(event) =>
                  setForm({ ...form, instructions: event.currentTarget.value })
                }
              />
              {instructionsAccepted ? null : (
                <p
                  id={`${id}-instructions-error`}
                  className="agent-form-hint"
                  data-tone="error"
                >
                  {t("design.implement.instructionsRejected")}
                </p>
              )}
              {overview ? null : (
                <label className="design-dialog-check">
                  <Checkbox
                    checked={form.worktree}
                    onCheckedChange={(worktree) =>
                      setForm({ ...form, worktree })
                    }
                  />
                  <span>{t("kanban.agent.worktree")}</span>
                  {form.worktree ? (
                    <span className="design-dialog-branch">
                      <GitBranch size={13} aria-hidden="true" />
                      {designBranchName(board.name)}
                    </span>
                  ) : null}
                </label>
              )}
              <label className="design-dialog-check">
                <Checkbox
                  checked={form.open}
                  onCheckedChange={(open) => setForm({ ...form, open })}
                />
                <span>{t("kanban.agent.openAfterStart")}</span>
              </label>
            </FormDialog>,
            document.body,
          )
        : null}
    </>
  );
}

/** Coding agents working from the board; one opens in the agents space. */
export function DesignLinkedAgents({
  boardId,
  links,
  sessions,
  statusOf,
  sessionName,
  onOpenSession,
}: {
  boardId: string;
  links: readonly AgentSessionDesignBoard[];
  sessions: readonly AgentSession[];
  statusOf: (sessionId: string) => AgentSessionStatus | undefined;
  sessionName: (session: AgentSession) => string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const s = useAgentStrings();
  const linked = links.flatMap((link) => {
    const session =
      link.boardId === boardId &&
      sessions.find((item) => item.id === link.sessionId);
    return session ? [session] : [];
  });
  if (!linked.length) return null;
  const activityLabel = (session: AgentSession) => {
    const activity = agentSessionActivity(statusOf(session.id));
    return activity === "working"
      ? s.working
      : activity === "awaiting"
        ? s.awaiting
        : activity === "stopped"
          ? s.stopped
          : s.running;
  };
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        render={
          <Button size="small" startIcon={<Bot />} endIcon={<ChevronDown />}>
            {linked.length === 1
              ? t("design.agents.one")
              : t("design.agents.many", { count: linked.length })}
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          className="agent-menu-positioner"
          sideOffset={6}
          align="start"
          collisionPadding={8}
        >
          <Menu.Popup render={<MenuSurface className="design-switcher-menu" />}>
            {linked.map((session) => (
              <Menu.Item
                key={session.id}
                nativeButton
                render={
                  <MenuItem
                    leading={
                      <AgentProviderIcon
                        executable={session.executable}
                        size={14}
                      />
                    }
                  />
                }
                onClick={() => onOpenSession(session.id)}
              >
                {sessionName(session)}
                <span className="design-switcher-detail">
                  {activityLabel(session)}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
