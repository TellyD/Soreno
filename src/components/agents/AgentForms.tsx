import { FolderOpen, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { pickAgentProjectDirectory } from "../../data/agentSessionsApi";
import { hasLinearApiKey, listLinearProjects } from "../../data/kanbanApi";
import {
  agentEnvironmentKey,
  agentEnvironmentLabel,
  agentProjectNameFromPath,
  agentProjectTargetKey,
  isAbsoluteProjectPath,
  type AgentEnvironment,
  type AgentProject,
  type AgentProjectGroupRecord,
  type AgentProjectLinearLink,
  type AgentSession,
} from "../../domain/agentSessions";
import type { LinearProjectSummary } from "../../domain/kanban";
import { errorMessage } from "../../domain/errors";
import { useAgentEnvironmentDiscovery } from "../../hooks/useAgentEnvironmentDiscovery";
import { useNotification, useScopedNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import {
  AgentEnvironmentSelect,
  selectedAgentEnvironment,
} from "./AgentEnvironmentSelect";
import { useAgentStrings } from "./agentStrings";
import { AgentProjectIcon } from "./AgentProjectIcon";
import { formatOperationError } from "./operationError";
import {
  emptySshConnection,
  isValidSshPort,
  normalizedConnection,
  SshProjectFields,
} from "./SshProjectFields";
import "./AgentForms.css";

export type AgentProjectGroup = AgentProjectGroupRecord & {
  collapsed: boolean;
};

type SharedProps = {
  busy: boolean;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function FormDialog({
  title,
  busy,
  onCancel,
  children,
  onSubmit,
  pending = false,
  submitDisabled = false,
  submitLabel,
  returnFocusRef,
  interactionLockRef,
}: SharedProps & {
  title: string;
  children: ReactNode;
  onSubmit: () => void;
  pending?: boolean;
  /** Disables the submit button and Enter's submission, for an incomplete form. */
  submitDisabled?: boolean;
  submitLabel: string;
  interactionLockRef?: RefObject<boolean>;
}) {
  const s = useAgentStrings();
  const titleId = useId();
  const locked = () => busy || interactionLockRef?.current === true;
  const dismiss = () => {
    if (!locked()) onCancel();
  };
  const ref = useDismissibleLayer<HTMLElement>(true, dismiss);
  return (
    <DialogOverlay>
      <DialogSurface
        className="agent-form-dialog"
        ref={ref}
        returnFocusRef={returnFocusRef}
        aria-labelledby={titleId}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked() && !submitDisabled) onSubmit();
          }}
        >
          <h2 id={titleId}>{title}</h2>
          <fieldset disabled={busy}>{children}</fieldset>
          <footer>
            <Button disabled={busy} onClick={dismiss}>
              {s.cancel}
            </Button>
            <Button
              aria-busy={pending || undefined}
              disabled={busy || submitDisabled}
              startIcon={
                pending ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
              variant="primary"
              type="submit"
            >
              {submitLabel}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}

export function AgentProjectGroupForm({
  group,
  projects,
  environment,
  onSave,
  ...shared
}: SharedProps & {
  group?: AgentProjectGroup;
  projects: AgentProject[];
  environment?: AgentEnvironment;
  onSave: (group: AgentProjectGroup) => void;
}) {
  const s = useAgentStrings();
  const id = useId();
  const [groupId] = useState(() => group?.id ?? crypto.randomUUID());
  const [name, setName] = useState(group?.name ?? "");
  const [projectIds, setProjectIds] = useState(
    () => new Set(group?.projectIds ?? []),
  );
  const notice = useScopedNotification("agent-group-form");
  const selectedProjectCount = projects.filter((project) =>
    projectIds.has(project.id),
  ).length;
  const anchor =
    environment ??
    projects.find((project) => projectIds.has(project.id))?.environment;
  const anchorKey = anchor ? agentEnvironmentKey(anchor) : null;

  function submit() {
    const normalizedName = name.trim();
    if (!normalizedName) {
      notice.error(s.nameRequired);
      return;
    }
    if (normalizedName.length > 100) {
      notice.error(s.groupNameTooLong);
      return;
    }
    const selectedProjectIds = projects
      .filter((project) => projectIds.has(project.id))
      .map((project) => project.id);
    if (!group && selectedProjectIds.length === 0) {
      notice.error(s.groupProjectRequired);
      return;
    }
    notice.clear();
    onSave({
      id: groupId,
      name: normalizedName,
      projectIds: selectedProjectIds,
      groupProjectId: group?.groupProjectId ?? null,
      collapsed: group?.collapsed ?? false,
    });
  }

  return (
    <FormDialog
      {...shared}
      title={group ? s.editGroup : s.newGroup}
      submitLabel={s.save}
      onSubmit={submit}
    >
      <label htmlFor={`${id}-name`}>{s.groupName}</label>
      <Input
        id={`${id}-name`}
        maxLength={100}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="agent-group-projects-header">
        <span id={`${id}-projects`}>{s.groupProjects}</span>
        <span>{s.groupProjectsSelected(selectedProjectCount)}</span>
      </div>
      <div
        className="agent-group-projects"
        role="group"
        aria-labelledby={`${id}-projects`}
      >
        {projects.map((project) => {
          const otherMachine =
            anchorKey !== null &&
            agentEnvironmentKey(project.environment) !== anchorKey;
          return (
            <label
              key={project.id}
              data-selected={projectIds.has(project.id) || undefined}
            >
              <Checkbox
                checked={projectIds.has(project.id)}
                disabled={shared.busy || otherMachine}
                onCheckedChange={(checked) =>
                  setProjectIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(project.id);
                    else next.delete(project.id);
                    return next;
                  })
                }
              />
              <span className="agent-group-project-label">
                <AgentProjectIcon project={project} size={15} />
                <strong>{project.name}</strong>
                <small title={project.path}>
                  {project.environment.kind === "ssh"
                    ? s.ssh
                    : agentEnvironmentLabel(project.environment, s.local)}{" "}
                  · {project.path}
                </small>
                {otherMachine ? (
                  <span className="agent-group-project-unavailable">
                    {s.groupProjectUnavailable}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <p className="agent-form-hint">{s.groupProjectsHint}</p>
    </FormDialog>
  );
}

export function AgentSessionForm({
  session,
  currentName,
  onSave,
  ...shared
}: SharedProps & {
  session: AgentSession;
  currentName: string;
  onSave: (customName: string | null) => void;
}) {
  const s = useAgentStrings();
  const id = useId();
  const [initialName] = useState(currentName);
  const [name, setName] = useState(session.customName ?? initialName);
  function submit() {
    const normalizedName = name.trim();
    // Saving the untouched automatic name must not freeze it.
    onSave(
      !normalizedName || (!session.customName && normalizedName === initialName)
        ? null
        : normalizedName,
    );
  }
  return (
    <FormDialog
      {...shared}
      title={s.rename}
      submitLabel={s.save}
      onSubmit={submit}
    >
      <label htmlFor={`${id}-name`}>{s.name}</label>
      <Input
        id={`${id}-name`}
        maxLength={80}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <p className="agent-form-hint">{s.renameHint}</p>
    </FormDialog>
  );
}

export function AgentProjectForm({
  project,
  projects = [],
  hasSessions = false,
  groupLocked = false,
  linearLinkable = false,
  linearProjectLinks = [],
  onSave,
  onSaveMany,
  ...shared
}: SharedProps & {
  project?: AgentProject;
  projects?: AgentProject[];
  hasSessions?: boolean;
  groupLocked?: boolean;
  // Group and worktree projects cannot be linked to a Linear project.
  linearLinkable?: boolean;
  linearProjectLinks?: AgentProjectLinearLink[];
  onSave: (
    project: AgentProject,
    linearProjectId: string | null,
  ) => Promise<void>;
  onSaveMany: (
    projects: AgentProject[],
    groupName: string | null,
    groupId: string,
  ) => Promise<void>;
}) {
  const s = useAgentStrings();
  const id = useId();
  const [draft, setDraft] = useState<AgentProject>(
    () =>
      project ?? {
        id: crypto.randomUUID(),
        name: "",
        path: "",
        environment: { kind: "local", distribution: null },
      },
  );
  const [batchSelection, setBatchSelection] = useState<{
    paths: string[];
    groupName: string | null;
  } | null>(null);
  const projectIds = useRef(new Map<string, string>());
  const [batchGroupId] = useState(() => crypto.randomUUID());
  const notice = useScopedNotification("agent-project-form");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sshBusy, setSshBusy] = useState(false);
  const operationInFlight = useRef(false);
  const restorePickerFocus = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environments, wslUnavailable, discovering, discover } =
    useAgentEnvironmentDiscovery();
  useNotification(
    wslUnavailable
      ? {
          message: s.wslHint,
          tone: "warning",
          key: "agent-wsl-discovery",
          action: { label: s.refresh, onAction: () => void discover() },
        }
      : null,
  );
  useEffect(() => {
    if (!picking && restorePickerFocus.current) {
      document.getElementById(restorePickerFocus.current)?.focus();
      restorePickerFocus.current = null;
    }
  }, [picking]);
  const linkedLinearProjectId =
    linearProjectLinks.find((link) => link.projectId === draft.id)
      ?.linearProjectId ?? null;
  const [linearProjectId, setLinearProjectId] = useState(linkedLinearProjectId);
  // Hidden until a Linear key is known to exist.
  const [linearChoices, setLinearChoices] = useState<
    | { status: "hidden" | "loading" | "error" }
    | { status: "ready"; projects: LinearProjectSummary[] }
  >({ status: "hidden" });
  useEffect(() => {
    if (!linearLinkable) return;
    let active = true;
    void (async () => {
      try {
        if (!(await hasLinearApiKey()) || !active) return;
        setLinearChoices({ status: "loading" });
        const linearProjects = await listLinearProjects();
        if (active)
          setLinearChoices({ status: "ready", projects: linearProjects });
      } catch {
        if (active) setLinearChoices({ status: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [linearLinkable]);
  const busy = shared.busy || picking || saving || sshBusy;
  const linearFieldVisible =
    linearLinkable &&
    linearChoices.status !== "hidden" &&
    (batchSelection === null ||
      (batchSelection.paths.length < 2 && !batchSelection.groupName));
  const linearOwners = new Map(
    linearProjectLinks
      .filter((link) => link.projectId !== draft.id)
      .map((link) => [
        link.linearProjectId,
        projects.find((item) => item.id === link.projectId)?.name ??
          link.projectId,
      ]),
  );
  const linearOptions =
    linearChoices.status === "ready"
      ? [
          { value: "", label: s.linearProjectNone },
          ...(linearProjectId &&
          !linearChoices.projects.some((item) => item.id === linearProjectId)
            ? [{ value: linearProjectId, label: s.linearProjectUnavailable }]
            : []),
          ...linearChoices.projects.map((item) => {
            const owner = linearOwners.get(item.id);
            // shortcut: the hint never shrinks, so many long team names squeeze the project name; truncate it if multi-team projects become common.
            const hint = item.teams.join(", ") || undefined;
            return owner === undefined
              ? { value: item.id, label: item.name, hint }
              : {
                  value: item.id,
                  label: `${item.name} · ${s.linearProjectLinkedTo(owner)}`,
                  hint,
                  disabled: true,
                };
          }),
        ]
      : [
          {
            value: linearProjectId ?? "",
            label:
              linearChoices.status === "loading"
                ? s.linearProjectLoading
                : linearProjectId
                  ? s.linearProjectUnavailable
                  : s.linearProjectNone,
          },
        ];
  function changeEnvironment(value: string) {
    if (operationInFlight.current) return;
    const environment = selectedAgentEnvironment(value, draft.environment);
    const changed =
      environment.kind !== draft.environment.kind ||
      environment.distribution !== draft.environment.distribution;
    setBatchSelection(null);
    setDraft({ ...draft, environment, path: changed ? "" : draft.path });
  }
  async function pickDirectory() {
    if (
      hasSessions ||
      shared.busy ||
      operationInFlight.current ||
      draft.environment.kind === "ssh"
    )
      return;
    operationInFlight.current = true;
    setPicking(true);
    try {
      const selected = await pickAgentProjectDirectory(
        draft.environment,
        draft.path || null,
        s.pickFolderTitle,
      );
      if (mounted.current && selected) {
        setDraft((current) => ({
          ...current,
          environment: selected.environment,
          path: selected.path,
          name:
            current.name.trim() || !selected.suggestedName
              ? current.name
              : selected.suggestedName,
        }));
        notice.clear();
      }
    } catch (reason) {
      if (mounted.current)
        notice.error(
          formatOperationError(s, { message: errorMessage(reason) }),
        );
    } finally {
      operationInFlight.current = false;
      if (mounted.current) {
        restorePickerFocus.current = `${id}-pick`;
        setPicking(false);
      }
    }
  }
  async function submit() {
    if (operationInFlight.current) return;
    const paths =
      !project && batchSelection ? batchSelection.paths : [draft.path];
    const name = draft.name.trim() || agentProjectNameFromPath(paths[0]);
    if (!name) {
      notice.error(s.nameRequired);
      return;
    }
    if (paths.some((path) => !isAbsoluteProjectPath(draft.environment, path))) {
      notice.error(s.absolutePath);
      return;
    }
    if (draft.environment.kind === "wsl" && !draft.environment.distribution) {
      notice.error(s.distribution);
      return;
    }
    let environment = draft.environment;
    if (environment.kind === "ssh") {
      const ssh = environment.ssh;
      if (!ssh?.host.trim()) {
        notice.error(s.sshHostRequired);
        return;
      }
      if (!isValidSshPort(ssh.port)) {
        notice.error(s.sshPortInvalid);
        return;
      }
      environment = { ...environment, ssh: normalizedConnection(ssh) };
    }
    notice.clear();
    operationInFlight.current = true;
    setSaving(true);
    try {
      const selectedProjects = paths.map((path) => {
        const target = agentProjectTargetKey(environment, path);
        let projectId = projectIds.current.get(target);
        if (!projectId) {
          projectId =
            projectIds.current.size === 0 ? draft.id : crypto.randomUUID();
          projectIds.current.set(target, projectId);
        }
        return {
          ...draft,
          id: project ? draft.id : projectId,
          environment,
          path,
          name: paths.length === 1 ? name : agentProjectNameFromPath(path),
        };
      });
      if (selectedProjects.length === 1 && !batchSelection?.groupName)
        await onSave(
          selectedProjects[0],
          linearFieldVisible ? linearProjectId : linkedLinearProjectId,
        );
      else
        await onSaveMany(
          selectedProjects,
          batchSelection?.groupName ?? null,
          batchGroupId,
        );
    } finally {
      operationInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <FormDialog
      {...shared}
      busy={busy}
      interactionLockRef={operationInFlight}
      title={project ? s.editProject : s.openRepository}
      pending={saving}
      submitLabel={s.save}
      onSubmit={() => void submit()}
    >
      <div className="agent-project-form-details">
        {project || (batchSelection?.paths.length ?? 0) < 2 ? (
          <>
            <label htmlFor={`${id}-name`}>{s.displayName}</label>
            <Input
              id={`${id}-name`}
              placeholder={agentProjectNameFromPath(draft.path)}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </>
        ) : null}
        <AgentEnvironmentSelect
          id={id}
          environment={draft.environment}
          environments={environments}
          discovering={discovering}
          disabled={hasSessions || groupLocked || busy}
          onValueChange={changeEnvironment}
        />
        {hasSessions ? (
          <p className="agent-form-hint">{s.projectLocked}</p>
        ) : groupLocked ? (
          <p className="agent-form-hint">{s.projectGroupLocked}</p>
        ) : null}
        {draft.environment.kind !== "ssh" ? (
          <div className="agent-folder-row">
            <Button
              id={`${id}-pick`}
              startIcon={<FolderOpen />}
              disabled={hasSessions || busy}
              onClick={() => void pickDirectory()}
            >
              {picking ? s.pickingFolder : s.chooseFolder}
            </Button>
            {draft.path ? (
              <code className="agent-folder-path" title={draft.path}>
                {draft.path}
              </code>
            ) : null}
          </div>
        ) : null}
        {draft.environment.kind === "ssh" ? (
          <SshProjectFields
            id={id}
            connection={draft.environment.ssh ?? emptySshConnection()}
            path={draft.path}
            projects={projects}
            disabled={busy}
            targetLocked={hasSessions || groupLocked}
            allowMultiple={!project}
            selectedProjectCount={batchSelection?.paths.length}
            interactionLockRef={operationInFlight}
            onBusyChange={setSshBusy}
            onConnectionChange={(ssh) => {
              setBatchSelection(null);
              setDraft((current) => ({
                ...current,
                environment: { kind: "ssh", distribution: null, ssh },
              }));
            }}
            onPathChange={(path) =>
              setDraft((current) => ({ ...current, path }))
            }
            onSelectionChange={setBatchSelection}
          />
        ) : null}
        {linearFieldVisible ? (
          <section className="agent-linear-fields">
            <label htmlFor={`${id}-linear`}>{s.linearProject}</label>
            <Select
              id={`${id}-linear`}
              aria-label={s.linearProject}
              aria-describedby={`${id}-linear-hint`}
              aria-busy={linearChoices.status === "loading" || undefined}
              disabled={busy || linearChoices.status !== "ready"}
              value={linearProjectId ?? ""}
              options={linearOptions}
              onValueChange={(value) => setLinearProjectId(value || null)}
            />
            <p
              className="agent-form-hint"
              id={`${id}-linear-hint`}
              data-tone={linearChoices.status === "error" ? "error" : undefined}
            >
              {linearChoices.status === "error"
                ? s.linearProjectLoadError
                : s.linearProjectHint}
            </p>
          </section>
        ) : null}
      </div>
    </FormDialog>
  );
}
