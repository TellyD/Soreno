import { Menu } from "@base-ui/react/menu";
import { Box, Check, Plus, Tag } from "lucide-react";
import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { isImeComposing } from "../../domain/keyboard";
import type {
  AgentLaunchPreset,
  AgentProject,
} from "../../domain/agentSessions";
import {
  kanbanPriorities,
  kanbanPriorityName,
  type KanbanLabel,
  type KanbanProjectRef,
  type KanbanWorkflowState,
} from "../../domain/kanban";
import { useI18n } from "../../i18n";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { Select } from "../ui/Select";
import {
  KanbanPriorityIcon,
  KanbanStateIcon,
  kanbanPriorityLabelKeys,
} from "./KanbanIssueCard";

// Ids are UUIDs, so this option value cannot collide with a real id.
const noneValue = "none";

// Keeps the current value selectable when it is missing from the options.
function withCurrent<T extends { id: string }>(
  options: readonly T[],
  current: readonly T[],
): readonly T[] {
  const missing = current.filter(
    (item) => !options.some(({ id }) => id === item.id),
  );
  return missing.length > 0 ? [...options, ...missing] : options;
}

// Chips are the compact creation-dialog look; empty chips show the field name.
type FieldControlProps<T> = {
  chip?: boolean;
  disabled?: boolean;
  onChange: (value: T) => void;
  value: T;
};

function selectClasses(chip: boolean | undefined) {
  return chip
    ? { className: "kanban-field-chip", popupClassName: "kanban-field-popup" }
    : { className: "kanban-issue-property-select" };
}

export function KanbanStateSelect({
  chip,
  disabled,
  onChange,
  states,
  value,
}: FieldControlProps<string> & {
  states: readonly KanbanWorkflowState[];
}) {
  const { t } = useI18n();
  const state = states.find(({ id }) => id === value);
  return (
    <Select
      {...selectClasses(chip)}
      aria-label={t("kanban.issue.state")}
      disabled={disabled}
      onValueChange={(stateId) => {
        if (stateId !== value) onChange(stateId);
      }}
      options={states.map((option) => ({
        icon: <KanbanStateIcon size={14} state={option} />,
        label: option.name,
        value: option.id,
      }))}
      size="small"
      startIcon={state ? <KanbanStateIcon size={14} state={state} /> : null}
      title={t("kanban.issue.state")}
      value={value}
    />
  );
}

export function KanbanPrioritySelect({
  chip,
  disabled,
  onChange,
  value,
}: FieldControlProps<number>) {
  const { t } = useI18n();
  const priority = kanbanPriorityName(value);
  return (
    <Select
      {...selectClasses(chip)}
      aria-label={t("kanban.issue.priority")}
      disabled={disabled}
      onValueChange={(option) => {
        const nextPriority = Number(option);
        if (nextPriority !== value) onChange(nextPriority);
      }}
      options={kanbanPriorities.map((name, index) => ({
        icon: <KanbanPriorityIcon priority={name} size={14} />,
        label: t(kanbanPriorityLabelKeys[name]),
        value: String(index),
      }))}
      size="small"
      startIcon={<KanbanPriorityIcon priority={priority} size={14} />}
      title={t("kanban.issue.priority")}
      value={String(value)}
      valueLabel={
        chip && priority === "none" ? t("kanban.issue.priority") : undefined
      }
    />
  );
}

// Same-named projects differ by environment (local, WSL, SSH), shown as the hint.
export function kanbanProjectOption(
  { id, name }: KanbanProjectRef,
  project: AgentProject | undefined,
  localLabel: string,
) {
  const kind = project?.environment.kind;
  return {
    hint: kind === "local" ? localLabel : kind?.toUpperCase(),
    icon: <AgentProjectIcon project={project} size={14} />,
    label: name,
    value: id,
  };
}

export function KanbanProjectSelect({
  chip,
  disabled,
  emptyLabel,
  onChange,
  projects,
  value,
}: FieldControlProps<KanbanProjectRef | null> & {
  emptyLabel?: string;
  projects: readonly AgentProject[];
}) {
  const { t } = useI18n();
  const options = withCurrent<KanbanProjectRef>(projects, value ? [value] : []);
  const icon = (id: string) => (
    <AgentProjectIcon
      project={projects.find((project) => project.id === id)}
      size={14}
    />
  );
  return (
    <Select
      {...selectClasses(chip)}
      aria-label={t("kanban.project.label")}
      disabled={disabled}
      onValueChange={(option) => {
        if (option === (value?.id ?? noneValue)) return;
        const project = options.find(({ id }) => id === option);
        onChange(project ? { id: project.id, name: project.name } : null);
      }}
      options={[
        { label: t("kanban.project.none"), value: noneValue },
        ...options.map((option) =>
          kanbanProjectOption(
            option,
            projects.find((project) => project.id === option.id),
            t("kanban.project.local"),
          ),
        ),
      ]}
      size="small"
      startIcon={value ? icon(value.id) : chip ? <Box size={14} /> : undefined}
      title={t("kanban.project.label")}
      value={value?.id ?? noneValue}
      valueLabel={
        chip && !value ? (emptyLabel ?? t("kanban.project.label")) : undefined
      }
    />
  );
}

export function KanbanAgentPresetSelect({
  chip,
  disabled,
  onChange,
  preset,
  presets,
  ref,
}: {
  chip?: boolean;
  disabled?: boolean;
  onChange: (executable: string) => void;
  preset: AgentLaunchPreset;
  presets: readonly AgentLaunchPreset[];
  ref?: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  return (
    <Select
      {...selectClasses(chip)}
      aria-label={t("kanban.agent.preset")}
      disabled={disabled}
      onValueChange={onChange}
      options={presets.map(({ executable, name }) => ({
        icon: <AgentProviderIcon executable={executable} />,
        label: name,
        value: executable,
      }))}
      ref={ref}
      size="small"
      startIcon={<AgentProviderIcon executable={preset.executable} />}
      title={t("kanban.agent.preset")}
      value={preset.executable}
    />
  );
}

export function KanbanLabelDot({ label }: { label: KanbanLabel }) {
  return (
    <span
      aria-hidden="true"
      className="kanban-issue-label-dot"
      style={{ background: label.color }}
    />
  );
}

export function KanbanLabelsMenu({
  chip,
  disabled,
  onChange,
  onCreateLabel,
  options,
  value,
}: Omit<FieldControlProps<readonly KanbanLabel[]>, "onChange"> & {
  onChange: (labels: KanbanLabel[]) => void;
  // Resolves to null when the creation failed and was already reported.
  onCreateLabel: (name: string) => Promise<KanbanLabel | null>;
  options: readonly KanbanLabel[];
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Opening from the keyboard focuses the first label; the input must take the focus instead.
  const focusInputOnOpenRef = useRef(false);
  const names = value.map(({ name }) => name).join(", ");
  // Labels ticked while a creation is pending must survive its resolution.
  const latestRef = useRef({ onChange, value });
  useLayoutEffect(() => {
    latestRef.current = { onChange, value };
  }, [onChange, value]);

  async function addLabel() {
    const name = draft.trim();
    if (!name || creating) return;
    const select = (label: KanbanLabel) => {
      setDraft("");
      const latest = latestRef.current;
      if (!latest.value.some(({ id }) => id === label.id)) {
        latest.onChange([...latest.value, label]);
      }
    };
    // Same rule as the backend: case-insensitive, accent-sensitive.
    const folded = name.toLowerCase();
    const existing = options.find(
      (label) => label.name.toLowerCase() === folded,
    );
    if (existing) {
      select(existing);
      return;
    }
    setCreating(true);
    try {
      const created = await onCreateLabel(name);
      if (created) select(created);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Menu.Root
      disabled={disabled}
      modal={false}
      onOpenChange={(open) => {
        focusInputOnOpenRef.current = open;
      }}
    >
      {chip ? (
        <Menu.Trigger
          aria-label={
            names
              ? `${t("kanban.issue.labels")}: ${names}`
              : t("kanban.issue.labels")
          }
          className="kanban-field-chip"
          title={names || t("kanban.issue.labels")}
        >
          {value.length > 0 ? (
            <span aria-hidden="true" className="kanban-field-chip-dots">
              {value.map((label) => (
                <KanbanLabelDot key={label.id} label={label} />
              ))}
            </span>
          ) : (
            <Tag aria-hidden="true" size={13} />
          )}
          <span className="kanban-chip-label">
            {names || t("kanban.issue.labels")}
          </span>
        </Menu.Trigger>
      ) : (
        <Menu.Trigger
          render={
            <IconButton
              aria-label={t("kanban.issue.editLabels")}
              size="small"
              title={t("kanban.issue.editLabels")}
            >
              <Plus size={14} />
            </IconButton>
          }
        />
      )}
      <Menu.Portal>
        <Menu.Positioner
          align="start"
          className="kanban-issue-menu-positioner"
          collisionPadding={8}
          // Keeps dismissible layers open; Menu.Portal props miss events in a body portal.
          onPointerDown={(event) => event.stopPropagation()}
          sideOffset={4}
        >
          <Menu.Popup
            onFocus={(event) => {
              if (!focusInputOnOpenRef.current) return;
              focusInputOnOpenRef.current = false;
              if (event.target !== inputRef.current) inputRef.current?.focus();
            }}
            render={<MenuSurface className="kanban-issue-labels-menu" />}
          >
            <Input
              aria-label={t("kanban.issue.newLabel")}
              className="kanban-issue-labels-input"
              onChange={(event) => setDraft(event.currentTarget.value)}
              // The menu would treat typed keys as item navigation and typeahead.
              onKeyDown={(event) => {
                if (event.key === "Escape") return;
                event.stopPropagation();
                if (isImeComposing(event.nativeEvent)) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget
                    .closest('[role="menu"]')
                    ?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
                    ?.focus();
                  return;
                }
                if (event.key !== "Enter") return;
                event.preventDefault();
                void addLabel();
              }}
              placeholder={t("kanban.issue.newLabelPlaceholder")}
              // Disabling would blur it, so a following Escape would leave the issue instead.
              readOnly={creating}
              ref={inputRef}
              size="small"
              value={draft}
            />
            {withCurrent(options, value).map((label, index) => {
              const checked = value.some(({ id }) => id === label.id);
              return (
                <Menu.CheckboxItem
                  checked={checked}
                  closeOnClick={false}
                  key={label.id}
                  nativeButton
                  onKeyDown={(event) => {
                    if (index > 0 || event.key !== "ArrowUp") return;
                    event.preventDefault();
                    event.stopPropagation();
                    inputRef.current?.focus();
                  }}
                  onCheckedChange={(nextChecked) =>
                    onChange(
                      nextChecked
                        ? [...value, label]
                        : value.filter(({ id }) => id !== label.id),
                    )
                  }
                  render={
                    <MenuItem
                      leading={<KanbanLabelDot label={label} />}
                      selected={checked}
                      trailing={checked ? <Check aria-hidden="true" /> : null}
                    />
                  }
                >
                  {label.name}
                </Menu.CheckboxItem>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
