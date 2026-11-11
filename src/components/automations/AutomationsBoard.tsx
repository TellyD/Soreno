import {
  CalendarClock,
  ExternalLink,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import {
  agentLaunchPresets,
  ompConversationExecutable,
  type AgentProject,
  type AgentSession,
} from "../../domain/agentSessions";
import {
  automationRunState,
  automationUnread,
  nextAutomationRun,
  type AgentAutomation,
  type AgentAutomationInput,
  type AgentAutomationRun,
  type AutomationFrequency,
} from "../../domain/automations";
import { formatShortDateTime } from "../../domain/dateTime";
import { errorMessage } from "../../domain/errors";
import { useAgentAutomations } from "../../hooks/useAgentAutomations";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { CountBadge } from "../ui/CountBadge";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { SegmentedControl, SegmentedControlItem } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { AutomationPromptField } from "./AutomationPromptField";
import "./AutomationsBoard.css";

// House selects instead of `type="time"`, whose native picker the webview cannot style.
const twoDigitOptions = (count: number) =>
  Array.from({ length: count }, (_, value) => {
    const label = String(value).padStart(2, "0");
    return { value: label, label };
  });
const hourOptions = twoDigitOptions(24);
const minuteOptions = twoDigitOptions(60);
const frequencies: AutomationFrequency[] = ["daily", "weekdays", "weekly"];
// Pi, OMP, Codex, Claude Code: the CLIs a scheduled run can start with a first message.
const presets = agentLaunchPresets.filter(
  (preset) => preset.executable !== ompConversationExecutable,
);

type AutomationsBoardProps = {
  visible: boolean;
  projects: AgentProject[];
  sessions: AgentSession[];
  /** Projects without automatic SSH access, dormant ones included. */
  disconnectedProjectIds: readonly string[];
  /** Explicitly disconnected: nothing reaches their server until reconnected. */
  blockedProjectIds: readonly string[];
  /** Creates the run's session, a favorite kept without a tab when closed; null on failure. */
  onCreateSession: (
    projectId: string,
    executable: string,
    name: string,
  ) => Promise<string | null>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  /** Renames the automation's session; false when the workspace refused it. */
  onRenameSession: (sessionId: string, name: string) => Promise<boolean>;
  /** Resolves true when the session is shown and its project may launch. */
  onOpenSession: (sessionId: string) => Promise<boolean>;
  onConnectProject: (projectId: string) => void;
  /** Saving reaches a dormant server, which the workspace then shows connected. */
  onServerReached: () => void;
  /** The deleted automation no longer keeps its session closed. */
  onAutomationDeleted: (sessionId: string) => void;
};

type Draft = Omit<AgentAutomationInput, "sessionId" | "timeZone"> & {
  name: string;
  projectId: string;
  executable: string;
};

type Selection = { kind: "new" } | { kind: "edit"; sessionId: string } | null;

const sessionName = (session: AgentSession | undefined) =>
  session?.customName ?? session?.name ?? "";

export function AutomationsBoard({
  visible,
  projects,
  sessions,
  disconnectedProjectIds,
  blockedProjectIds,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onOpenSession,
  onConnectProject,
  onServerReached,
  onAutomationDeleted,
}: AutomationsBoardProps) {
  const { t, locale } = useI18n();
  const sshProjects = projects.filter(
    (project) => project.environment.kind === "ssh",
  );
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const connectedProjectIds = sshProjects
    .map((project) => project.id)
    .filter((id) => !disconnectedProjectIds.includes(id));
  const { automations, loaded, save, remove, run, markSeen } =
    useAgentAutomations(visible, connectedProjectIds);
  const rows = automations.flatMap((automation) => {
    const session = sessionById.get(automation.sessionId);
    const project = session && projectById.get(session.projectId);
    return session && project ? [{ automation, session, project }] : [];
  });
  const [selection, setSelection] = useState<Selection>(null);
  const selected =
    selection?.kind === "edit"
      ? rows.find((row) => row.session.id === selection.sessionId)
      : undefined;
  const now = new Date();
  const weekdayLabel = (weekday: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "long" }).format(
      new Date(2024, 0, weekday),
    );
  const scheduleLabel = (automation: AgentAutomationInput) =>
    `${
      automation.frequency === "weekly"
        ? weekdayLabel(automation.weekday)
        : t(`automations.frequency.${automation.frequency}`)
    } · ${automation.time}`;
  const dateLabel = (date: Date) =>
    formatShortDateTime(date.toISOString(), locale);
  const runLabel = (run: AgentAutomationRun | null) => {
    const state = automationRunState(run);
    const date = run ? dateLabel(new Date(run.at * 1000)) : "";
    return {
      state,
      label: t(`automations.run.${state}`, { date }),
    };
  };

  return (
    <section aria-label={t("automations.title")} className="automations-board">
      <header className="automations-header">
        <div className="automations-title">
          <CalendarClock size={15} aria-hidden="true" />
          <h1>{t("automations.title")}</h1>
          {rows.length > 0 ? <CountBadge count={rows.length} /> : null}
        </div>
        <div className="automations-actions">
          <Button
            size="small"
            variant="primary"
            startIcon={<Plus />}
            disabled={sshProjects.length === 0}
            title={
              sshProjects.length === 0
                ? t("automations.noSshProject")
                : undefined
            }
            onClick={() => setSelection({ kind: "new" })}
          >
            {t("automations.new")}
          </Button>
        </div>
      </header>
      <div className="automations-body">
        {loaded && rows.length === 0 && selection?.kind !== "new" ? (
          <EmptyState
            fill
            actions={
              sshProjects.length > 0 ? (
                <Button
                  variant="primary"
                  startIcon={<Plus />}
                  onClick={() => setSelection({ kind: "new" })}
                >
                  {t("automations.new")}
                </Button>
              ) : undefined
            }
            icon={<CalendarClock />}
            title={t("automations.emptyTitle")}
            description={
              sshProjects.length === 0
                ? t("automations.noSshProject")
                : t("automations.emptyBody")
            }
          />
        ) : (
          <div className="automations-list">
            <div className="automations-row is-head" aria-hidden="true">
              <span>{t("automations.column.name")}</span>
              <span className="automations-column-project">
                {t("automations.column.project")}
              </span>
              <span className="automations-column-schedule">
                {t("automations.column.schedule")}
              </span>
              <span className="automations-column-next">
                {t("automations.column.next")}
              </span>
              <span>{t("automations.column.last")}</span>
            </div>
            <ul aria-label={t("automations.title")}>
              {rows.map(({ automation, session, project }) => {
                const disconnected = disconnectedProjectIds.includes(
                  project.id,
                );
                const next = nextAutomationRun(automation, now);
                const last = runLabel(automation.lastRun);
                const unread = automationUnread(automation);
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={`automations-row${automation.enabled ? "" : " is-paused"}`}
                      aria-current={
                        selected?.session.id === session.id ? "true" : undefined
                      }
                      onClick={() =>
                        setSelection({ kind: "edit", sessionId: session.id })
                      }
                    >
                      <span className="automations-name">
                        {unread ? (
                          <span
                            className="agent-status-dot is-unread"
                            role="img"
                            aria-label={t("automations.unread")}
                          />
                        ) : null}
                        <AgentProviderIcon
                          executable={session.executable}
                          size={14}
                        />
                        <span className="automations-ellipsis">
                          {sessionName(session)}
                        </span>
                        {automation.enabled ? null : (
                          <span className="automations-paused">
                            {t("automations.paused")}
                          </span>
                        )}
                      </span>
                      <span className="automations-where automations-column-project">
                        <AgentProjectIcon project={project} size={13} />
                        <span className="automations-ellipsis">
                          {project.name}
                        </span>
                      </span>
                      <span className="automations-column-schedule">
                        {scheduleLabel(automation)}
                      </span>
                      <span className="automations-column-next automations-muted">
                        {next ? dateLabel(next) : "—"}
                      </span>
                      <span
                        className={`automations-last is-${disconnected ? "disconnected" : last.state}`}
                      >
                        {disconnected && !automation.lastRun
                          ? t("automations.notConnected")
                          : last.label}
                      </span>
                    </button>
                    {disconnected ? (
                      <button
                        type="button"
                        className="automations-connect"
                        onClick={() => onConnectProject(project.id)}
                      >
                        {t("automations.connect")}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {selection?.kind === "new" || selected ? (
          <AutomationDetail
            key={selected?.session.id ?? "new"}
            automation={selected?.automation}
            session={selected?.session}
            project={selected?.project}
            sshProjects={sshProjects.filter(
              (project) => !blockedProjectIds.includes(project.id),
            )}
            connectedProjectIds={connectedProjectIds}
            scheduleNext={(automation) => {
              const next = nextAutomationRun(automation, now);
              return next ? dateLabel(next) : t("automations.paused");
            }}
            lastRun={
              selected ? runLabel(selected.automation.lastRun).label : ""
            }
            weekdayLabel={weekdayLabel}
            onClose={() => setSelection(null)}
            onSave={async (draft) => {
              const input = {
                prompt: draft.prompt,
                frequency: draft.frequency,
                weekday: draft.weekday,
                time: draft.time,
                enabled: draft.enabled,
                // shortcut: every save, a pause included, takes this computer's zone, so pausing after a
                // zone change moves the schedule; keep the saved zone for pauses if users travel with Soreno.
                timeZone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              };
              if (selected) {
                const name = draft.name.trim();
                if (
                  name !== sessionName(selected.session) &&
                  !(await onRenameSession(selected.session.id, name))
                )
                  return;
                // shortcut: a rename alone stays local, so the server's unit description and run label keep
                // the old name until the schedule or prompt is next saved; resave there if those names matter.
                const saved = selected.automation;
                if (
                  input.prompt !== saved.prompt ||
                  input.frequency !== saved.frequency ||
                  input.weekday !== saved.weekday ||
                  input.time !== saved.time ||
                  input.enabled !== saved.enabled
                ) {
                  await save({ ...input, sessionId: selected.session.id });
                  onServerReached();
                }
                return;
              }
              const sessionId = await onCreateSession(
                draft.projectId,
                draft.executable,
                draft.name.trim(),
              );
              if (!sessionId) return;
              try {
                await save({ ...input, sessionId });
              } catch (reason) {
                await onDeleteSession(sessionId);
                throw reason;
              }
              onServerReached();
              // The user may have opened another automation while this one installed.
              // shortcut: a second creation form opened meanwhile is also `new`, so it is replaced; key the
              // form per creation if users start two creations back to back.
              setSelection((current) =>
                current?.kind === "new" ? { kind: "edit", sessionId } : current,
              );
            }}
            onOpenSession={async () => {
              if (!selected) return;
              const { automation, session } = selected;
              if (
                (await onOpenSession(session.id)) &&
                automationUnread(automation)
              )
                void markSeen(session.id).catch(() => undefined);
            }}
            onRun={async () => {
              if (!selected) return;
              await run(selected.session.id);
              onServerReached();
            }}
            onDelete={async () => {
              if (!selected) return;
              await remove(selected.session.id);
              onAutomationDeleted(selected.session.id);
              setSelection(null);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

type AutomationDetailProps = {
  automation?: AgentAutomation;
  session?: AgentSession;
  project?: AgentProject;
  sshProjects: AgentProject[];
  /** Projects whose server may be reached to list skills. */
  connectedProjectIds: readonly string[];
  scheduleNext: (automation: AgentAutomationInput) => string;
  lastRun: string;
  weekdayLabel: (weekday: number) => string;
  onClose: () => void;
  onSave: (draft: Draft) => Promise<void>;
  onOpenSession: () => void;
  onRun: () => Promise<void>;
  onDelete: () => Promise<void>;
};

function AutomationDetail({
  automation,
  session,
  project,
  sshProjects,
  connectedProjectIds,
  scheduleNext,
  lastRun,
  weekdayLabel,
  onClose,
  onSave,
  onOpenSession,
  onRun,
  onDelete,
}: AutomationDetailProps) {
  const { t } = useI18n();
  const id = useId();
  const initial: Draft = {
    name: sessionName(session),
    projectId: project?.id ?? sshProjects[0]?.id ?? "",
    executable: session?.executable ?? "claude",
    prompt: automation?.prompt ?? "",
    frequency: automation?.frequency ?? "weekdays",
    weekday: automation?.weekday ?? 1,
    time: automation?.time ?? "08:00",
    enabled: automation?.enabled ?? true,
  };
  // shortcut: a name saved from this panel stays the draft's, so a later rename elsewhere is undone by
  // the next save here; reset the name to null once its save is confirmed if that sequence shows up.
  // null name follows the session's, which a rename elsewhere may change while the panel stays mounted.
  const [edits, setEdits] = useState<
    Omit<Draft, "name"> & { name: string | null }
  >({ ...initial, name: null });
  const draft: Draft = { ...edits, name: edits.name ?? initial.name };
  const [pending, setPending] = useState<"save" | "run" | "delete" | null>(
    null,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const editing = !!automation;
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const valid =
    draft.prompt.trim() !== "" &&
    /^\d{2}:\d{2}$/.test(draft.time) &&
    draft.name.trim() !== "" &&
    (editing || draft.projectId !== "");
  const update = (changes: Partial<Draft>) =>
    setEdits((current) => ({ ...current, ...changes }));
  const perform = async (
    action: "save" | "run" | "delete",
    work: () => Promise<void>,
  ) => {
    setPending(action);
    try {
      await work();
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  };
  const busy = pending !== null;

  return (
    <aside className="automations-detail" aria-labelledby={`${id}-title`}>
      <form
        className="automations-detail-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && valid && (changed || !editing))
            void perform("save", () => onSave(draft));
        }}
      >
        <div className="automations-detail-head">
          <h2 id={`${id}-title`}>
            {editing ? initial.name : t("automations.new")}
          </h2>
          {editing ? (
            // Applies at once, from the saved schedule: pausing never saves pending edits.
            <span className="automations-active">
              <span id={`${id}-active`}>{t("automations.field.active")}</span>
              <Switch
                aria-labelledby={`${id}-active`}
                checked={initial.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void perform("save", async () => {
                    await onSave({ ...initial, enabled });
                    update({ enabled });
                  })
                }
              />
            </span>
          ) : null}
          <IconButton
            size="small"
            aria-label={t("automations.close")}
            title={t("automations.close")}
            onClick={onClose}
          >
            <X />
          </IconButton>
        </div>
        <fieldset disabled={busy}>
          <label className="automations-section">
            <span className="automations-label">
              {t("automations.field.name")}
            </span>
            <Input
              size="small"
              value={draft.name}
              maxLength={120}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          {editing ? (
            <>
              <div className="automations-section">
                <p className="automations-label">
                  {t("automations.field.project")}
                </p>
                <div className="automations-property">
                  <AgentProjectIcon project={project} size={13} />
                  <span className="automations-ellipsis">{project?.name}</span>
                </div>
              </div>
              <div className="automations-section">
                <p className="automations-label">
                  {t("automations.field.agent")}
                </p>
                <div className="automations-property">
                  <AgentProviderIcon executable={draft.executable} size={14} />
                  {presets.find(
                    (preset) => preset.executable === draft.executable,
                  )?.name ?? draft.executable}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="automations-section">
                <span className="automations-label" id={`${id}-project`}>
                  {t("automations.field.project")}
                </span>
                <Select
                  size="small"
                  aria-labelledby={`${id}-project`}
                  value={draft.projectId}
                  options={sshProjects.map((item) => ({
                    value: item.id,
                    label: item.name,
                    description: item.environment.ssh?.host,
                    icon: <AgentProjectIcon project={item} size={14} />,
                  }))}
                  startIcon={
                    <AgentProjectIcon
                      project={sshProjects.find(
                        (item) => item.id === draft.projectId,
                      )}
                      size={14}
                    />
                  }
                  onValueChange={(projectId) => update({ projectId })}
                />
              </div>
              <div className="automations-section">
                <span className="automations-label" id={`${id}-agent`}>
                  {t("automations.field.agent")}
                </span>
                <Select
                  size="small"
                  aria-labelledby={`${id}-agent`}
                  value={draft.executable}
                  options={presets.map((preset) => ({
                    value: preset.executable,
                    label: preset.name,
                    icon: (
                      <AgentProviderIcon
                        executable={preset.executable}
                        size={14}
                      />
                    ),
                  }))}
                  onValueChange={(executable) => update({ executable })}
                />
              </div>
            </>
          )}
          <div className="automations-section">
            <span className="automations-label" id={`${id}-prompt`}>
              {t("automations.field.prompt")}
            </span>
            <AutomationPromptField
              value={draft.prompt}
              onChange={(prompt) => update({ prompt })}
              executable={draft.executable}
              projectId={
                connectedProjectIds.includes(draft.projectId)
                  ? draft.projectId
                  : null
              }
              labelId={`${id}-prompt`}
              hintId={`${id}-prompt-hint`}
            />
            <span className="automations-hint" id={`${id}-prompt-hint`}>
              {t("automations.field.promptHint")}
            </span>
          </div>
          <div className="automations-section">
            <span className="automations-label">
              {t("automations.field.schedule")}
            </span>
            <SegmentedControl
              aria-label={t("automations.field.schedule")}
              className="automations-frequency"
            >
              {frequencies.map((frequency) => (
                <SegmentedControlItem
                  key={frequency}
                  selected={draft.frequency === frequency}
                  onClick={() => update({ frequency })}
                >
                  {t(`automations.frequency.${frequency}`)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <div className="automations-time-row">
              {draft.frequency === "weekly" ? (
                <Select
                  size="small"
                  aria-label={t("automations.field.weekday")}
                  className="automations-weekday"
                  value={String(draft.weekday)}
                  options={[1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                    value: String(weekday),
                    label: weekdayLabel(weekday),
                  }))}
                  onValueChange={(weekday) =>
                    update({ weekday: Number(weekday) })
                  }
                />
              ) : null}
              <span className="automations-time">
                <Select
                  size="small"
                  aria-label={t("automations.field.time")}
                  value={draft.time.slice(0, 2)}
                  options={hourOptions}
                  popupClassName="automations-time-popup"
                  onValueChange={(hour) =>
                    update({ time: `${hour}:${draft.time.slice(3)}` })
                  }
                />
                <span aria-hidden="true">:</span>
                <Select
                  size="small"
                  aria-label={t("automations.field.minutes")}
                  value={draft.time.slice(3)}
                  options={minuteOptions}
                  popupClassName="automations-time-popup"
                  onValueChange={(minute) =>
                    update({ time: `${draft.time.slice(0, 2)}:${minute}` })
                  }
                />
              </span>
              <span className="automations-hint">
                {t("automations.field.timeZone", {
                  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                })}
              </span>
            </div>
          </div>
          {editing ? null : (
            <div className="automations-switch-row">
              <span id={`${id}-active`}>{t("automations.field.active")}</span>
              <Switch
                aria-labelledby={`${id}-active`}
                checked={draft.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
          )}
          <p className="automations-hint">{t("automations.serverHint")}</p>
          <div className="automations-form-actions">
            {editing ? (
              changed ? (
                <Button
                  size="small"
                  onClick={() => setEdits({ ...initial, name: null })}
                >
                  {t("automations.cancel")}
                </Button>
              ) : null
            ) : (
              <Button size="small" onClick={onClose}>
                {t("automations.cancel")}
              </Button>
            )}
            <Button
              size="small"
              type="submit"
              variant="primary"
              disabled={!valid || (editing && !changed)}
              aria-busy={pending === "save" || undefined}
            >
              {editing ? t("automations.save") : t("automations.create")}
            </Button>
          </div>
        </fieldset>
      </form>
      {automation ? (
        <>
          <div className="automations-section">
            <p className="automations-label">{t("automations.runs")}</p>
            <dl className="automations-runs">
              <dt>{t("automations.nextRun")}</dt>
              <dd>{scheduleNext(automation)}</dd>
              <dt>{t("automations.lastRun")}</dt>
              <dd>{lastRun}</dd>
            </dl>
          </div>
          <div className="automations-run-actions">
            <Button
              size="small"
              variant="primary"
              startIcon={<ExternalLink />}
              disabled={busy}
              onClick={onOpenSession}
            >
              {t("automations.openSession")}
            </Button>
            <Button
              size="small"
              startIcon={<Play />}
              disabled={busy}
              aria-busy={pending === "run" || undefined}
              onClick={() => void perform("run", onRun)}
            >
              {t("automations.runNow")}
            </Button>
          </div>
          <div className="automations-danger">
            <Button
              size="small"
              variant="secondary"
              className="automations-delete"
              startIcon={<Trash2 />}
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              {t("automations.delete")}
            </Button>
          </div>
        </>
      ) : null}
      {confirmingDelete ? (
        <ConfirmationDialog
          title={t("automations.deleteTitle", { name: draft.name })}
          description={t("automations.deleteDescription")}
          cancelLabel={t("automations.cancel")}
          closeLabel={t("automations.close")}
          confirmLabel={t("automations.delete")}
          confirmVariant="danger"
          confirmPending={pending === "delete"}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() =>
            void perform("delete", async () => {
              await onDelete();
              setConfirmingDelete(false);
            })
          }
        />
      ) : null}
    </aside>
  );
}
