import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import { uploadKanbanImage } from "../../data/kanbanApi";
import {
  visibleIssueAgentPresets,
  type AgentProject,
} from "../../domain/agentSessions";
import {
  kanbanColumn,
  linearColumnState,
  type KanbanColumn,
  type KanbanIssueCreateInput,
  type KanbanLabel,
  type KanbanProjectRef,
  type KanbanSource,
  type KanbanTeam,
  type KanbanWorkflowState,
} from "../../domain/kanban";
import type { KanbanIssueAgentTarget } from "../../domain/kanbanAgent";
import { isImeComposing } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { useAppSettings } from "../../settings";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../markdown-editor/MarkdownEditor";
import {
  KanbanAgentPresetSelect,
  KanbanLabelsMenu,
  KanbanPrioritySelect,
  KanbanProjectSelect,
  KanbanStateSelect,
} from "./KanbanIssueFieldControls";
import "./KanbanIssueCreateDialog.css";

export type KanbanIssueCreateDefaults = {
  source: KanbanSource;
  // Column of the '+' that opened the dialog; null takes the destination's default state.
  column: KanbanColumn | null;
  project: KanbanProjectRef | null;
  // Set when creating a sub-issue, which stays in its parent's source.
  parentId?: string;
};

type KanbanCreateDestination = {
  team: KanbanTeam;
  states: readonly KanbanWorkflowState[];
  labels: readonly KanbanLabel[];
  projects: readonly AgentProject[];
};

function createFields(
  destination: KanbanCreateDestination,
  column: KanbanColumn | null,
  project: KanbanProjectRef | null,
  restrictProjects: boolean,
): KanbanIssueCreateFields {
  const { states, projects } = destination;
  const state =
    (column && linearColumnState(column, states)) ??
    states.find(({ type }) => type === "unstarted") ??
    states[0];
  return {
    stateId: state?.id ?? "",
    priority: 0,
    project:
      !restrictProjects || projects.some(({ id }) => id === project?.id)
        ? project
        : null,
    labels: [],
  };
}

type KanbanIssueCreateFields = {
  stateId: string;
  priority: number;
  project: KanbanProjectRef | null;
  labels: KanbanLabel[];
};

type KanbanIssueCreateAgent = {
  enabled: boolean;
  // Null follows the last preset used on an issue.
  executable: string | null;
  worktree: boolean;
};

type KanbanIssueCreateDialogProps = {
  agentPreset: string | null;
  defaults: KanbanIssueCreateDefaults;
  formatError: (error: unknown) => string;
  // Soreno projects an agent can start in, by id.
  knownProjects: ReadonlyMap<string, AgentProject>;
  // Null while Linear is not connected or loaded.
  linear: KanbanCreateDestination | null;
  local: KanbanCreateDestination;
  overviewProjectIds: ReadonlySet<string>;
  onClose: () => void;
  onCreateLabel: (
    source: KanbanSource,
    name: string,
  ) => Promise<KanbanLabel | null>;
  // Starting the agent is the caller's job once the issue exists, so a failed start never blocks the creation.
  onCreate: (
    source: KanbanSource,
    input: KanbanIssueCreateInput,
    agent: KanbanIssueAgentTarget | null,
  ) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
  // The issue is for an agent session already running: no agent start, one issue only.
  forSession?: boolean;
};

export function KanbanIssueCreateDialog({
  agentPreset,
  defaults,
  formatError,
  knownProjects,
  linear,
  local,
  overviewProjectIds,
  onClose,
  onCreateLabel,
  onCreate,
  returnFocusRef,
  forSession = false,
}: KanbanIssueCreateDialogProps) {
  const { t } = useI18n();
  const { settings } = useAppSettings();
  const headingId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // A fresh editor per draft, so undo cannot bring back the previous issue's text.
  const [draft, setDraft] = useState(0);
  const [source, setSource] = useState(defaults.source);
  // Linear can disconnect while the dialog is open; the issue then goes local.
  const destinationSource: KanbanSource =
    source === "linear" && linear ? "linear" : "local";
  const destination = destinationSource === "linear" && linear ? linear : local;
  const { labels, projects: kanbanProjects, states, team } = destination;
  const [fields, setFields] = useState<KanbanIssueCreateFields>(() =>
    createFields(
      destination,
      defaults.column,
      defaults.project,
      destinationSource === "linear",
    ),
  );
  const [createMore, setCreateMore] = useState(false);
  const [agent, setAgent] = useState<KanbanIssueCreateAgent>({
    enabled: false,
    executable: null,
    worktree: true,
  });
  const [creating, setCreating] = useState(false);
  const [labelCreations, setLabelCreations] = useState(0);
  const [uploads, setUploads] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, () => {
    if (!creating) onClose();
  });
  const blank = title.trim() === "";
  // Submitting meanwhile would drop the image or the label still being created.
  const pending = uploads > 0 || labelCreations > 0;
  const agentPresets = visibleIssueAgentPresets(settings.hiddenAgentPresets);
  const agentLaunchPreset =
    agentPresets.find(
      ({ executable }) => executable === (agent.executable ?? agentPreset),
    ) ?? agentPresets[0];
  const agentUnavailable = kanbanProjects.length === 0;
  const agentProjectUnavailable =
    agent.enabled &&
    fields.project !== null &&
    !knownProjects.has(fields.project.id);
  const agentBlocked =
    (agent.enabled && !fields.project) || agentProjectUnavailable;
  const agentWorktree =
    !fields.project || !overviewProjectIds.has(fields.project.id);

  async function uploadImage(file: File) {
    setUploads((count) => count + 1);
    try {
      return await uploadKanbanImage(file);
    } finally {
      setUploads((count) => count - 1);
    }
  }

  function changeFields(patch: Partial<KanbanIssueCreateFields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  function changeAgent(patch: Partial<KanbanIssueCreateAgent>) {
    setAgent((current) => ({ ...current, ...patch }));
  }

  // States and labels belong to the destination: the state keeps its column, labels start over.
  function changeDestination(next: KanbanSource) {
    // Select reports reselecting the current option too.
    if (next === destinationSource) return;
    const state = states.find(({ id }) => id === fields.stateId);
    setSource(next);
    setFields((current) => ({
      ...createFields(
        next === "linear" && linear ? linear : local,
        state ? kanbanColumn(state) : null,
        current.project,
        next === "linear",
      ),
      priority: current.priority,
    }));
  }

  async function createLabel(name: string) {
    setLabelCreations((count) => count + 1);
    try {
      return await onCreateLabel(destinationSource, name);
    } finally {
      setLabelCreations((count) => count - 1);
    }
  }

  async function submit() {
    if (blank || creating || pending || agentBlocked) return;
    const input: KanbanIssueCreateInput = {
      teamId: team.id,
      title: title.trim(),
      stateId: fields.stateId,
    };
    if (description.trim()) input.description = description;
    if (fields.priority !== 0) input.priority = fields.priority;
    if (fields.project) input.projectId = fields.project.id;
    if (fields.labels.length > 0) {
      input.labelIds = fields.labels.map(({ id }) => id);
    }
    if (defaults.parentId) input.parentId = defaults.parentId;
    setCreating(true);
    try {
      await onCreate(
        destinationSource,
        input,
        agent.enabled && fields.project
          ? {
              projectId: fields.project.id,
              executable: agentLaunchPreset.executable,
              presetName: agentLaunchPreset.name,
              worktree: agentWorktree && agent.worktree,
              open: false,
            }
          : null,
      );
    } catch (error) {
      notifyError(formatError(error));
      setCreating(false);
      return;
    }
    setCreating(false);
    if (!createMore) {
      onClose();
      return;
    }
    setTitle("");
    setDescription("");
    setDraft((count) => count + 1);
    titleRef.current?.focus();
  }

  return (
    <DialogOverlay className="kanban-create-overlay">
      <DialogSurface
        aria-labelledby={headingId}
        className="kanban-create-dialog"
        ref={surfaceRef}
        returnFocusRef={returnFocusRef}
      >
        <form
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !isImeComposing(event.nativeEvent)
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header className="kanban-create-header">
            {linear && !defaults.parentId ? (
              <Select
                aria-label={t("kanban.create.destination")}
                className="kanban-field-chip"
                disabled={creating || pending}
                onValueChange={(next) =>
                  changeDestination(next === "linear" ? "linear" : "local")
                }
                options={[
                  { label: t("kanban.source.local"), value: "local" },
                  { label: linear.team.name, value: "linear" },
                ]}
                popupClassName="kanban-field-popup"
                size="small"
                title={t("kanban.create.destination")}
                value={destinationSource}
              />
            ) : (
              <span className="kanban-chip kanban-create-team">{team.key}</span>
            )}
            <span aria-hidden="true" className="kanban-board-separator">
              ›
            </span>
            <h2 id={headingId}>{t("kanban.create.title")}</h2>
            <IconButton
              aria-label={t("kanban.create.close")}
              className="kanban-create-close"
              disabled={creating}
              onClick={onClose}
              size="small"
              title={t("kanban.create.close")}
            >
              <X size={14} />
            </IconButton>
          </header>

          <div className="kanban-create-body">
            <Input
              aria-label={t("kanban.issue.title")}
              autoFocus
              className="kanban-create-title"
              onChange={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.ctrlKey ||
                  event.metaKey ||
                  isImeComposing(event.nativeEvent)
                ) {
                  return;
                }
                // Enter continues into the description instead of submitting the form.
                event.preventDefault();
                editorRef.current?.focus();
              }}
              placeholder={t("kanban.create.titlePlaceholder")}
              readOnly={creating}
              ref={titleRef}
              value={title}
            />
            <div
              className="kanban-create-description"
              // Capture phase: CodeMirror binds Mod-Enter to insert a blank line.
              onKeyDownCapture={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey) &&
                  !isImeComposing(event.nativeEvent)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  void submit();
                }
              }}
            >
              <MarkdownEditor
                ariaLabel={t("kanban.create.description")}
                content={description}
                documentId={`${headingId}-${draft}`}
                formatImageError={formatError}
                inline
                mode="preview"
                onContentChange={setDescription}
                placeholder={t("kanban.create.descriptionPlaceholder")}
                readOnly={creating}
                ref={editorRef}
                uploadImage={uploadImage}
              />
            </div>
          </div>

          <div
            aria-label={t("kanban.issue.properties")}
            className="kanban-create-fields"
            role="group"
          >
            <KanbanStateSelect
              chip
              disabled={creating}
              onChange={(stateId) => changeFields({ stateId })}
              states={states}
              value={fields.stateId}
            />
            <KanbanPrioritySelect
              chip
              disabled={creating}
              onChange={(priority) => changeFields({ priority })}
              value={fields.priority}
            />
            <KanbanProjectSelect
              chip
              disabled={creating}
              emptyLabel={
                agent.enabled ? t("kanban.agent.chooseProject") : undefined
              }
              onChange={(project) => changeFields({ project })}
              projects={kanbanProjects}
              value={fields.project}
            />
            <KanbanLabelsMenu
              chip
              disabled={creating}
              onChange={(nextLabels) => changeFields({ labels: nextLabels })}
              onCreateLabel={createLabel}
              options={labels}
              value={fields.labels}
            />
          </div>

          {agent.enabled ? (
            <div
              aria-label={t("kanban.agent.title")}
              className="kanban-create-fields kanban-create-agent"
              role="group"
            >
              <KanbanAgentPresetSelect
                chip
                disabled={creating}
                onChange={(executable) => changeAgent({ executable })}
                preset={agentLaunchPreset}
                presets={agentPresets}
              />
              {agentWorktree ? (
                <label className="kanban-create-option">
                  <Checkbox
                    checked={agent.worktree}
                    disabled={creating}
                    onCheckedChange={(worktree) => changeAgent({ worktree })}
                  />
                  {t("kanban.agent.worktree")}
                </label>
              ) : null}
              {agentProjectUnavailable ? (
                <span className="kanban-issue-muted">
                  {t("kanban.agent.projectUnavailable")}
                </span>
              ) : null}
            </div>
          ) : null}

          <footer className="kanban-create-footer">
            <IconButton
              aria-label={t("kanban.create.addImage")}
              // Without the agent toggle, the image button keeps the footer's start.
              className={forSession ? "kanban-create-footer-start" : undefined}
              disabled={creating}
              onClick={() => editorRef.current?.requestImage()}
              size="small"
              title={t("kanban.create.addImage")}
            >
              <ImagePlus size={14} />
            </IconButton>
            {forSession ? null : (
              <>
                <label
                  className="kanban-create-option kanban-create-agent-toggle"
                  title={
                    agentUnavailable
                      ? t("kanban.create.agentUnavailable")
                      : undefined
                  }
                >
                  <Checkbox
                    checked={agent.enabled}
                    disabled={creating || (agentUnavailable && !agent.enabled)}
                    onCheckedChange={(enabled) => changeAgent({ enabled })}
                  />
                  {t("kanban.create.agent")}
                </label>
                <label className="kanban-create-option">
                  <Checkbox
                    checked={createMore}
                    disabled={creating}
                    onCheckedChange={setCreateMore}
                  />
                  {t("kanban.create.more")}
                </label>
              </>
            )}
            <Button
              aria-busy={creating || pending || undefined}
              disabled={blank || creating || pending || agentBlocked}
              size="small"
              startIcon={
                creating || pending ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
              type="submit"
              variant="primary"
            >
              {agent.enabled
                ? t("kanban.create.submitWithAgent")
                : t("kanban.create.submit")}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
