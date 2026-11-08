import { useId, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  agentLaunchPresets,
  type AgentProject,
} from "../../domain/agentSessions";
import type { DesignBoard } from "../../domain/design";
import { useI18n } from "../../i18n";
import { useAppSettings } from "../../settings";
import { FormDialog } from "../agents/AgentForms";
import { AgentProjectIcon } from "../agents/AgentProjectIcon";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { kanbanProjectOption } from "../kanban/KanbanIssueFieldControls";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

// Terminal CLIs only: the Chat OMP is a conversation view.
const designPresets = agentLaunchPresets.filter(({ executable }) =>
  ["claude", "codex", "omp", "pi"].includes(executable),
);

export type DesignBoardFormValues = {
  name: string;
  projectId: string | null;
  executable: string;
};

/** New board or rename, portalled above the board's stacked toolbar, drawer and prompt bar. */
export function DesignBoardForm({
  board,
  projects,
  fixedProject,
  pending,
  returnFocusRef,
  onCancel,
  onSubmit,
}: {
  /** Renames this board; creates one when absent. */
  board?: DesignBoard;
  /** Projects a new board can pick, besides none. */
  projects: readonly AgentProject[];
  /** A new board's project, shown instead of the picker. */
  fixedProject?: AgentProject;
  pending: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onSubmit: (values: DesignBoardFormValues) => void;
}) {
  const { t } = useI18n();
  const { settings } = useAppSettings();
  const id = useId();
  const shown = designPresets.filter(
    ({ executable }) => !settings.hiddenAgentPresets.includes(executable),
  );
  const presets = shown.length ? shown : designPresets;
  const [name, setName] = useState(board?.name ?? "");
  // The picker's choice only: a fixed project is read at submit, as it may change while open.
  const [projectId, setProjectId] = useState("");
  const [executable, setExecutable] = useState<string>(presets[0].executable);

  return createPortal(
    <FormDialog
      title={board ? t("design.renameTitle") : t("design.newBoard")}
      submitLabel={board ? t("design.save") : t("design.create")}
      busy={pending}
      pending={pending}
      submitDisabled={!name.trim()}
      returnFocusRef={returnFocusRef}
      onCancel={onCancel}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          projectId: fixedProject?.id ?? (projectId || null),
          executable,
        })
      }
    >
      {board ? null : (
        <p className="agent-form-hint">{t("design.newBoardDescription")}</p>
      )}
      <label htmlFor={`${id}-name`}>{t("design.field.name")}</label>
      <Input
        id={`${id}-name`}
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      {board ? null : (
        <>
          {fixedProject ? (
            <>
              <span className="design-dialog-label">
                {t("design.field.project")}
              </span>
              <span className="design-dialog-value">
                <AgentProjectIcon project={fixedProject} size={14} />
                {fixedProject.name}
              </span>
            </>
          ) : (
            <>
              <label htmlFor={`${id}-project`}>
                {t("design.field.project")}
              </label>
              <Select
                id={`${id}-project`}
                value={projectId}
                options={[
                  { value: "", label: t("design.noProject") },
                  ...projects.map((project) =>
                    kanbanProjectOption(
                      project,
                      project,
                      t("kanban.project.local"),
                    ),
                  ),
                ]}
                onValueChange={setProjectId}
              />
            </>
          )}
          <label htmlFor={`${id}-agent`}>{t("design.field.agent")}</label>
          <Select
            id={`${id}-agent`}
            value={executable}
            options={presets.map((preset) => ({
              value: preset.executable,
              label: preset.name,
              icon: (
                <AgentProviderIcon executable={preset.executable} size={14} />
              ),
            }))}
            onValueChange={setExecutable}
          />
        </>
      )}
    </FormDialog>,
    document.body,
  );
}
