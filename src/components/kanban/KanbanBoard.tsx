import {
  Plug,
  RefreshCw,
  SquarePen,
  SquareKanban,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  allKanbanProjectsFilter,
  defaultCreateSource,
  filterIssuesByProject,
  filterIssuesBySource,
  kanbanBoardTabs,
  kanbanColumn,
  kanbanIssueProjects,
  kanbanSourceFilters,
  noKanbanProjectFilter,
  type KanbanBoardTab,
  type KanbanIssue,
  type KanbanIssueSelection,
  type KanbanSourceFilter,
} from "../../domain/kanban";
import {
  readPreference,
  useKanbanControllerContext,
  writePreference,
  type KanbanController,
} from "../../hooks/useKanbanController";
import { useI18n, type TranslationKey } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { LoadingState } from "../ui/LoadingState";
import { SegmentedControl, SegmentedControlItem } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { KanbanColumns } from "./KanbanColumns";
import {
  KanbanIssueCreateDialog,
  type KanbanIssueCreateDefaults,
} from "./KanbanIssueCreateDialog";
import { kanbanProjectOption } from "./KanbanIssueFieldControls";
import { KanbanIssueView } from "./KanbanIssueView";
import { KanbanLinearConnectDialog } from "./KanbanLinearConnectDialog";
import "./KanbanBoard.css";

const tabLabelKeys: Record<KanbanBoardTab, TranslationKey> = {
  active: "kanban.tabs.active",
  all: "kanban.tabs.all",
  backlog: "kanban.tabs.backlog",
};

const sourceLabelKeys: Record<KanbanSourceFilter, TranslationKey> = {
  all: "kanban.source.all",
  linear: "kanban.source.linear",
  local: "kanban.source.local",
};

const projectFilterKey = "soreno.kanban.projectFilter.v1";
const sourceFilterKey = "soreno.kanban.sourceFilter.v1";

function readSourceFilter(): KanbanSourceFilter {
  const saved = readPreference(sourceFilterKey);
  return kanbanSourceFilters.find((filter) => filter === saved) ?? "all";
}

type KanbanBoardProps = {
  // Each new request object opens its issue once.
  issueRequest?: { issue: KanbanIssueSelection };
  // The workspace's right panel, where an opened issue shows as beside an agent session.
  panel: {
    container: HTMLElement | null;
    // False while the board itself is hidden.
    visible: boolean;
    // Hidden by the panel shortcut, the issue staying selected; opening an issue shows it again.
    hidden: boolean;
    onShow: () => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    // Lets the workspace show its right panel while an issue is open.
    onIssueOpenChange?: (open: boolean) => void;
  };
};

/** Renders once a `KanbanControllerProvider` above it is enabled. */
export function KanbanBoard(props: KanbanBoardProps) {
  const kanban = useKanbanControllerContext();
  return kanban ? <KanbanBoardContent {...props} kanban={kanban} /> : null;
}

function KanbanBoardContent({
  issueRequest,
  kanban,
  panel,
}: KanbanBoardProps & { kanban: KanbanController }) {
  const { locale, t } = useI18n();
  const {
    board,
    formatError,
    issueAgents,
    knownProjects,
    linear,
    linearAvailable,
    linearConnected,
    releaseLinearTeam,
  } = kanban;
  const [tab, setTab] = useState<KanbanBoardTab>("all");
  const [savedSourceFilter, setSavedSourceFilter] = useState(readSourceFilter);
  // Without Linear the board is the local Kanban alone, whatever filter was remembered.
  const sourceFilter = linearConnected ? savedSourceFilter : "all";
  const [savedProjectFilter, setSavedProjectFilter] = useState(
    () => readPreference(projectFilterKey) ?? allKanbanProjectsFilter,
  );
  const [selectedIssue, setSelectedIssue] =
    useState<KanbanIssueSelection | null>(null);
  // A deletion or a transfer made in another view replaces the shown issue too.
  const replacement =
    selectedIssue && kanban.replacedIssues.get(selectedIssue.id);
  if (replacement !== undefined && replacement !== selectedIssue)
    setSelectedIssue(replacement);
  // Card to focus again when the detail opened from it closes; the selected tab
  // takes focus when that card has since left the visible board.
  const returnFocusRef = useRef<string | null>(null);
  const boardRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [createDefaults, setCreateDefaults] =
    useState<KanbanIssueCreateDefaults | null>(null);
  const createReturnFocusRef = useRef<HTMLElement | null>(null);
  const [connectingLinear, setConnectingLinear] = useState(false);
  // Connecting swaps the connect button for the disconnect one and back: focus returns to whichever is shown.
  const linearActionRef = useRef<HTMLButtonElement | null>(null);
  const [disconnectingLinear, setDisconnectingLinear] = useState<
    "confirm" | "pending" | null
  >(null);

  const sourceIssues = useMemo(
    () => filterIssuesBySource(kanban.issues, sourceFilter),
    [kanban.issues, sourceFilter],
  );
  const issueProjects = useMemo(
    () => kanbanIssueProjects(sourceIssues, knownProjects),
    [sourceIssues, knownProjects],
  );
  // Falls back without forgetting the choice while its project has no issue on the board.
  const projectFilter =
    issueProjects.projects.length > 0 &&
    (savedProjectFilter === noKanbanProjectFilter
      ? issueProjects.hasIssueWithoutProject
      : issueProjects.projects.some(({ id }) => id === savedProjectFilter))
      ? savedProjectFilter
      : allKanbanProjectsFilter;
  const selectProjectFilter = (value: string) => {
    setSavedProjectFilter(value);
    writePreference(
      projectFilterKey,
      value === allKanbanProjectsFilter ? null : value,
    );
  };
  const selectSourceFilter = (value: KanbanSourceFilter) => {
    setSavedSourceFilter(value);
    writePreference(sourceFilterKey, value === "all" ? null : value);
  };
  const filteredIssues = useMemo(
    () => filterIssuesByProject(sourceIssues, projectFilter),
    [sourceIssues, projectFilter],
  );

  const { agentPrompt } = kanban;
  // The prompt may open from a state option that is gone once it closes.
  const agentPromptReturnFocusRef = useRef<HTMLElement | null>(null);
  // A dragged card remounts in its new column, so focus targets are found once it renders.
  useLayoutEffect(() => {
    if (!agentPrompt) return;
    const boardElement = boardRef.current;
    const issueId = agentPrompt.issue.id;
    agentPromptReturnFocusRef.current =
      panelRef.current?.querySelector<HTMLElement>(".kanban-issue-view") ??
      [
        ...(boardElement?.querySelectorAll<HTMLElement>(
          "[data-kanban-issue]",
        ) ?? []),
      ].find((element) => element.dataset.kanbanIssue === issueId) ??
      null;
  }, [agentPrompt]);

  // The view focuses itself before the workspace shows its still inert panel.
  const focusViewRef = useRef(false);
  const openBoardIssue = (issue: KanbanIssueSelection) => {
    returnFocusRef.current = issue.id;
    focusViewRef.current = true;
    panel.onShow();
    setSelectedIssue({
      id: issue.id,
      identifier: issue.identifier,
      source: issue.source,
    });
  };

  const handledIssueRequestRef = useRef<typeof issueRequest>(undefined);
  useEffect(() => {
    if (!issueRequest || handledIssueRequestRef.current === issueRequest)
      return;
    handledIssueRequestRef.current = issueRequest;
    // Dismissed like an outside click.
    if (!kanban.isCreating()) setCreateDefaults(null);
    openBoardIssue(issueRequest.issue);
  }, [issueRequest]);

  const openCreate = (stateId: string | undefined, trigger: HTMLElement) => {
    if (!board) return;
    const state = board.states.find(({ id }) => id === stateId);
    createReturnFocusRef.current = trigger;
    setCreateDefaults({
      source: defaultCreateSource(
        sourceFilter,
        kanban.rememberedCreateSource,
        linearAvailable,
      ),
      column: state ? kanbanColumn(state) : null,
      project:
        sourceIssues.find(({ project }) => project?.id === projectFilter)
          ?.project ?? null,
    });
  };
  const openCreateSubIssue = (parent: KanbanIssue, trigger: HTMLElement) => {
    createReturnFocusRef.current = trigger;
    setCreateDefaults({
      source: parent.source,
      column: null,
      project: parent.project,
      parentId: parent.id,
    });
  };
  // A creation resolving after a newer dialog opened must close only its own dialog.
  const closeCreate = () =>
    setCreateDefaults((current) =>
      current === createDefaults ? null : current,
    );

  // Runs after the closed dialog returned focus to its trigger, under an issue opened meanwhile.
  useEffect(() => {
    if (createDefaults) return;
    const view =
      panelRef.current?.querySelector<HTMLElement>(".kanban-issue-view");
    // The sub-issue button stays focused when the dialog was opened from it.
    if (view && !view.contains(document.activeElement))
      view.focus({ preventScroll: true });
  }, [createDefaults]);

  useEffect(() => {
    if (!createDefaults) releaseLinearTeam();
  }, [createDefaults, releaseLinearTeam]);

  // Closing the issue, or hiding its panel, returns focus to the card it opened from.
  useEffect(() => {
    const issueId = returnFocusRef.current;
    if (!issueId) return;
    if (selectedIssue) {
      if (!panel.hidden || boardRef.current?.contains(document.activeElement))
        return;
    } else {
      returnFocusRef.current = null;
    }
    const boardElement = boardRef.current;
    const card = [
      ...(boardElement?.querySelectorAll<HTMLElement>("[data-kanban-issue]") ??
        []),
    ].find((element) => element.dataset.kanbanIssue === issueId);
    (
      card ??
      boardElement?.querySelector<HTMLElement>(
        ".kanban-board-tabs [aria-pressed='true']",
      )
    )?.focus({ preventScroll: true });
  }, [selectedIssue, panel.hidden]);

  // No dependencies: the workspace re-renders the board once its panel is shown.
  useEffect(() => {
    // An issue request opens the issue after this effect's first run.
    if (!focusViewRef.current || createDefaults || !selectedIssue) return;
    const view =
      panelRef.current?.querySelector<HTMLElement>(".kanban-issue-view");
    if (!view) return;
    if (!view.contains(document.activeElement))
      view.focus({ preventScroll: true });
    if (view.contains(document.activeElement)) focusViewRef.current = false;
  });

  const issueOpen = selectedIssue !== null;
  const { onIssueOpenChange } = panel;
  useEffect(() => {
    onIssueOpenChange?.(issueOpen);
    return () => onIssueOpenChange?.(false);
  }, [issueOpen, onIssueOpenChange]);
  const closeIssue = () => {
    focusViewRef.current = false;
    setSelectedIssue(null);
    if (panel.expanded) panel.onExpandedChange(false);
  };

  const disconnectLinear = async () => {
    setDisconnectingLinear("pending");
    try {
      await kanban.disconnectLinear();
      setSelectedIssue((current) => {
        if (current?.source !== "linear") return current;
        focusViewRef.current = false;
        return null;
      });
    } catch (error) {
      notifyError(formatError(error));
    } finally {
      setDisconnectingLinear(null);
    }
  };

  const { createDialog, preset } = kanban;

  return (
    <section
      aria-label={t("kanban.ariaLabel")}
      className="kanban-board"
      ref={boardRef}
    >
      <div className="kanban-board-pane" inert={createDefaults !== null}>
        <header className="kanban-board-header">
          <div className="kanban-board-title">
            <SquareKanban size={15} aria-hidden="true" />
            <span className="kanban-board-team">{t("kanban.title")}</span>
            <span className="kanban-board-separator" aria-hidden="true">
              ›
            </span>
            <h1>{t("kanban.issues")}</h1>
          </div>

          <SegmentedControl
            aria-label={t("kanban.tabs.label")}
            className="kanban-board-tabs"
          >
            {kanbanBoardTabs.map((boardTab) => (
              <SegmentedControlItem
                key={boardTab}
                onClick={() => setTab(boardTab)}
                selected={tab === boardTab}
              >
                {t(tabLabelKeys[boardTab])}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>

          {linearConnected ? (
            <SegmentedControl
              aria-label={t("kanban.source.label")}
              className="kanban-board-tabs"
            >
              {kanbanSourceFilters.map((filter) => (
                <SegmentedControlItem
                  key={filter}
                  onClick={() => selectSourceFilter(filter)}
                  selected={sourceFilter === filter}
                >
                  {t(sourceLabelKeys[filter])}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          ) : null}

          {linearConnected && linear ? (
            <Select
              aria-label={t("kanban.linear.team")}
              className="kanban-project-select"
              onValueChange={(teamId) => {
                // Another team's issue loses its states and labels: close it, leaving the focus on the select.
                if (
                  teamId !== linear.team.id &&
                  selectedIssue?.source === "linear"
                ) {
                  returnFocusRef.current = null;
                  closeIssue();
                }
                kanban.selectLinearTeam(teamId);
              }}
              options={linear.teams.map((team) => ({
                label: team.name,
                value: team.id,
              }))}
              size="small"
              value={linear.team.id}
              valueLabel={t("kanban.linear.teamValue", {
                team: linear.team.name,
              })}
            />
          ) : null}

          {issueProjects.projects.length > 0 ? (
            <Select
              aria-label={t("kanban.project.label")}
              className="kanban-project-select"
              onValueChange={selectProjectFilter}
              options={[
                {
                  label: t("kanban.project.all"),
                  value: allKanbanProjectsFilter,
                },
                ...issueProjects.projects.map((project) =>
                  kanbanProjectOption(
                    project,
                    knownProjects.get(project.id),
                    t("kanban.project.local"),
                  ),
                ),
                ...(issueProjects.hasIssueWithoutProject
                  ? [
                      {
                        label: t("kanban.project.none"),
                        value: noKanbanProjectFilter,
                      },
                    ]
                  : []),
              ]}
              size="small"
              value={projectFilter}
            />
          ) : null}

          <div className="kanban-board-actions">
            {linearConnected ? null : (
              <Button
                onClick={() => setConnectingLinear(true)}
                ref={linearActionRef}
                size="small"
                startIcon={<Plug />}
              >
                {t("kanban.linear.connect")}
              </Button>
            )}
            <IconButton
              aria-label={t("kanban.create.title")}
              disabled={!board}
              onClick={(event) => openCreate(undefined, event.currentTarget)}
              size="small"
              title={t("kanban.create.title")}
            >
              <SquarePen size={14} />
            </IconButton>
            <IconButton
              aria-label={t("kanban.refresh")}
              disabled={kanban.loading}
              onClick={() => kanban.reload()}
              size="small"
              title={t("kanban.refresh")}
            >
              <RefreshCw
                className={
                  kanban.loading ? "kanban-refresh-spinning" : undefined
                }
                size={14}
              />
            </IconButton>
          </div>
          {linearConnected ? (
            <IconButton
              aria-label={t("kanban.linear.disconnect")}
              className="kanban-board-disconnect"
              onClick={() => setDisconnectingLinear("confirm")}
              ref={linearActionRef}
              size="small"
              title={t("kanban.linear.disconnect")}
            >
              <Unplug size={14} />
            </IconButton>
          ) : null}
        </header>

        {kanban.linearError && !kanban.error ? (
          <div className="kanban-board-notice" role="alert">
            <TriangleAlert aria-hidden="true" size={14} />
            <span className="kanban-board-notice-text">
              {t("kanban.linear.error", {
                detail: formatError(kanban.linearError),
              })}
            </span>
            <Button onClick={() => kanban.reload()} size="small">
              {t("kanban.retry")}
            </Button>
          </div>
        ) : linear?.truncated && sourceFilter !== "local" ? (
          <p className="kanban-board-notice">
            <span className="kanban-board-notice-text">
              {t("kanban.linear.truncated")}
            </span>
          </p>
        ) : null}

        {kanban.error ? (
          <EmptyState
            fill
            icon={<TriangleAlert />}
            title={t("kanban.error.title")}
            description={formatError(kanban.error)}
            actions={
              <Button onClick={() => kanban.reload()} variant="primary">
                {t("kanban.retry")}
              </Button>
            }
          />
        ) : board ? (
          <KanbanColumns
            agentSessions={issueAgents.live}
            board={board}
            issues={filteredIssues}
            knownProjects={knownProjects}
            linearStates={linear?.states ?? []}
            locale={locale}
            onCreateIssue={openCreate}
            onOpenIssue={openBoardIssue}
            onOpenProject={kanban.onOpenProject}
            onOpenUrl={kanban.openExternal}
            onUpdateIssue={kanban.moveBoardIssue}
            tab={tab}
          />
        ) : (
          <LoadingState className="kanban-board-status">
            {t("kanban.loading")}
          </LoadingState>
        )}
      </div>

      {selectedIssue && panel.container
        ? createPortal(
            <div
              className="kanban-issue-panel"
              hidden={!panel.visible || panel.hidden}
              ref={panelRef}
            >
              <KanbanIssueView
                kanban={kanban}
                onBack={closeIssue}
                onCreateSubIssue={openCreateSubIssue}
                onOpenIssue={setSelectedIssue}
                panel={{
                  expanded: panel.expanded,
                  onExpandedChange: panel.onExpandedChange,
                }}
                selection={selectedIssue}
              />
            </div>,
            panel.container,
          )
        : null}

      {/* The board pane is inert and hidden while the issue panel is expanded. */}
      {createPortal(
        <>
          {createDefaults &&
          createDialog &&
          (createDefaults.source !== "linear" || linear) ? (
            <KanbanIssueCreateDialog
              {...createDialog}
              defaults={createDefaults}
              onClose={closeCreate}
              returnFocusRef={createReturnFocusRef}
            />
          ) : null}

          {connectingLinear ? (
            <KanbanLinearConnectDialog
              formatError={formatError}
              onClose={() => setConnectingLinear(false)}
              onConnect={async (apiKey) => {
                await kanban.connectLinear(apiKey);
                setConnectingLinear(false);
              }}
              onOpenUrl={kanban.openExternal}
              returnFocusRef={linearActionRef}
            />
          ) : null}

          {disconnectingLinear ? (
            <ConfirmationDialog
              cancelDisabled={disconnectingLinear === "pending"}
              cancelLabel={t("kanban.linear.disconnectDialog.cancel")}
              closeLabel={t("confirmationDialog.close")}
              confirmDisabled={disconnectingLinear === "pending"}
              confirmLabel={t("kanban.linear.disconnectDialog.confirm")}
              confirmPending={disconnectingLinear === "pending"}
              description={t("kanban.linear.disconnectDialog.description")}
              onCancel={() => setDisconnectingLinear(null)}
              onConfirm={() => void disconnectLinear()}
              returnFocusRef={linearActionRef}
              title={t("kanban.linear.disconnectDialog.title")}
            />
          ) : null}

          {agentPrompt ? (
            <ConfirmationDialog
              cancelLabel={t("kanban.agentPrompt.cancel")}
              closeLabel={t("confirmationDialog.close")}
              confirmLabel={t("kanban.agent.start")}
              confirmVariant="primary"
              description={t(
                kanban.overviewProjectIds.has(agentPrompt.project.id)
                  ? "kanban.agentPrompt.descriptionInProject"
                  : "kanban.agentPrompt.description",
                {
                  identifier: agentPrompt.issue.identifier,
                  state: agentPrompt.stateName,
                  agent: preset.name,
                  project: agentPrompt.project.name,
                },
              )}
              onCancel={kanban.dismissAgentPrompt}
              onConfirm={kanban.confirmAgentPrompt}
              returnFocusRef={agentPromptReturnFocusRef}
              title={t("kanban.agentPrompt.title", {
                identifier: agentPrompt.issue.identifier,
              })}
            />
          ) : null}
        </>,
        document.body,
      )}
    </section>
  );
}
