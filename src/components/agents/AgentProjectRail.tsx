import { ContextMenu } from "@base-ui/react/context-menu";
import {
  ChevronRight,
  Folder,
  Folders,
  GitBranch,
  GitMerge,
  Inbox,
  LayoutGrid,
  LoaderCircle,
  Palette,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  agentEnvironmentLabel,
  agentProviderLabel,
  groupCollapseKey,
  sessionLaunchBlocked,
  type agentPresets,
  type AgentProject,
  type AgentProjectAppearance,
  type AgentProjectWorktree,
  type AgentProjectWorktreeGroup,
  type AgentSession,
  type AgentSessionStatus,
  type AgentWorkspace,
} from "../../domain/agentSessions";
import type { AgentSessionAttention } from "../../domain/agentAttention";
import {
  agentPrioritySections,
  worktreeName,
} from "../../domain/agentWorkspaceView";
import { NavItem } from "../SidebarNav";
import { IconButton } from "../ui/IconButton";
import { MenuItem } from "../ui/Menu";
import type { AgentProjectGroup } from "./AgentForms";
import {
  AgentProjectList,
  type AgentProjectGroupRenderProps,
  type AgentProjectRenderProps,
} from "./AgentProjectList";
import { AgentProjectIcon } from "./AgentProjectIcon";
import { AgentProjectAppearancePopover } from "./AgentProjectAppearancePopover";
import { AgentProviderIcon } from "./AgentProviderIcon";
import {
  NewProjectMenu,
  NewSessionMenu,
  ProjectViewControls,
  RowContextMenu,
} from "./AgentWorkspaceMenus";
import type { Confirmation } from "./agentConfirmation";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { readPriorityView, writePriorityView } from "./agentWorkspaceStorage";

type AgentProjectRailForm = (
  | { kind: "project"; project?: AgentProject }
  | { kind: "clone" }
  | { kind: "group"; group?: AgentProjectGroup }
) & { fromMenu?: boolean };

type AgentProjectRailProps = {
  hidden: boolean;
  /** Rendered in the app sidebar rather than inside the workspace. */
  embedded: boolean;
  closing: boolean;
  serviceOperating: boolean;
  savingFavorite: boolean;
  workspace: AgentWorkspace;
  /** Rail entries after the "only with agents" filter. */
  projects: AgentProject[];
  groups: AgentProjectGroup[];
  /** Every manual group, offered as move targets. */
  projectGroups: AgentProjectGroup[];
  worktreeGroups: AgentProjectWorktreeGroup[];
  orderedProjects: AgentProject[];
  railProjects: AgentProject[];
  sectionOrder: string[];
  hiddenProjectCount: number;
  visibleSessions: AgentSession[];
  /** Session shown in the terminal surface, if the rail should mark it. */
  activeSessionId: string | undefined;
  selectedProjectId: string | undefined;
  branches: Record<string, string | null>;
  branchError: string | null;
  collapsed: ReadonlySet<string>;
  onlyWithAgents: boolean;
  quickWorktreeLoadingProjectId: string | null;
  startingSessionId: string | null;
  terminalSplits: Readonly<Record<string, string>>;
  statusOf: (id: string) => AgentSessionStatus | undefined;
  isWorking: (id: string) => boolean;
  attentionOf: (id: string) => AgentSessionAttention | null;
  statusLabel: (id: string) => string;
  sessionName: (session: AgentSession) => string;
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  disabled: boolean;
  navigationDisabled: boolean;
  reorderDisabled: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  addProjectRef: RefObject<HTMLButtonElement | null>;
  onCollapsedChange: Dispatch<SetStateAction<Set<string>>>;
  onOnlyWithAgentsChange: (value: boolean) => void;
  onSelectProject: (project: AgentProject) => Promise<boolean>;
  onSelectSession: (session: AgentSession) => void;
  onCloseSession: (session: AgentSession) => void;
  pinnedSessionIds: ReadonlySet<string>;
  onOpenForm: (form: AgentProjectRailForm) => void;
  onClone: () => void;
  onAsk: (confirmation: Confirmation) => void;
  /** Menu move: restores focus to the moved row. */
  onMoveProjectToGroup: (projectId: string, groupId: string | null) => void;
  /** Drag and drop move. */
  onDropProjectInGroup: (projectId: string, groupId: string | null) => void;
  onOpenExternalWorktree: (
    repositoryProjectId: string,
    worktree: AgentProjectWorktree,
    transferNavigationFocus?: boolean,
  ) => Promise<void>;
  onRequestQuickWorktree: (project: AgentProject) => Promise<void>;
  onOpenGroupOverview: (group: AgentProjectGroup) => Promise<void>;
  onCreateGroupSession: (
    group: AgentProjectGroup,
    preset: (typeof agentPresets)[number],
  ) => Promise<void>;
  onReorderProjects: (projectIds: string[]) => void;
  onSectionOrderChange: (sectionIds: string[]) => void;
  onDeleteGroup: (group: AgentProjectGroup) => void;
  onSaveProjectAppearance: (
    projectId: string,
    change: AgentProjectAppearance,
  ) => Promise<boolean>;
  onSaveGroupAppearance: (
    groupId: string,
    change: AgentProjectAppearance,
  ) => Promise<boolean>;
};

export function AgentProjectRail({
  hidden,
  embedded,
  closing,
  serviceOperating,
  savingFavorite,
  workspace,
  projects,
  groups,
  projectGroups,
  worktreeGroups,
  orderedProjects,
  railProjects,
  sectionOrder,
  hiddenProjectCount,
  visibleSessions,
  activeSessionId,
  selectedProjectId: railSelectedProjectId,
  branches,
  branchError,
  collapsed,
  onlyWithAgents,
  quickWorktreeLoadingProjectId,
  startingSessionId,
  terminalSplits,
  statusOf,
  isWorking,
  attentionOf,
  statusLabel,
  sessionName,
  hasLoaded,
  loading,
  refreshing,
  disabled,
  navigationDisabled,
  reorderDisabled,
  returnFocusRef,
  addProjectRef,
  onCollapsedChange: setCollapsed,
  onOnlyWithAgentsChange,
  onSelectProject: selectProject,
  onSelectSession: selectSession,
  onCloseSession: closeSession,
  pinnedSessionIds,
  onOpenForm: openForm,
  onClone,
  onAsk: ask,
  onMoveProjectToGroup: moveProjectToGroup,
  onDropProjectInGroup,
  onOpenExternalWorktree: openExternalWorktree,
  onRequestQuickWorktree: requestQuickWorktree,
  onOpenGroupOverview: openGroupOverview,
  onCreateGroupSession: createGroupSession,
  onReorderProjects,
  onSectionOrderChange,
  onDeleteGroup,
  onSaveProjectAppearance,
  onSaveGroupAppearance,
}: AgentProjectRailProps) {
  const s = useAgentStrings();
  const gitStrings = useGitStrings();
  const groupSessionRefs = useRef(
    new Map<string, { current: HTMLButtonElement | null }>(),
  );
  const [appearanceTarget, setAppearanceTarget] = useState<{
    kind: "project" | "group";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [priorityView, setPriorityView] = useState(readPriorityView);
  const busy = (id: string) => startingSessionId === id || isWorking(id);
  // A split tab is live while either pane is: the secondary pane can outlive the parent.
  const tabPanes = (id: string) =>
    terminalSplits[id] ? [id, terminalSplits[id]] : [id];
  const priority = agentPrioritySections(visibleSessions, attentionOf, (id) =>
    tabPanes(id).some(
      (paneId) => busy(paneId) || statusOf(paneId)?.state === "running",
    ),
  );
  const appearanceItem =
    appearanceTarget?.kind === "group"
      ? projectGroups.find((group) => group.id === appearanceTarget.id)
      : appearanceTarget &&
        workspace.projects.find(
          (project) => project.id === appearanceTarget.id,
        );
  function openAppearance(kind: "project" | "group", id: string) {
    const row = returnFocusRef.current?.getBoundingClientRect();
    setAppearanceTarget({
      kind,
      id,
      x: (row?.left ?? 0) + 18,
      y: (row?.bottom ?? 0) + 4,
    });
  }
  const allProjectsCollapsed =
    orderedProjects.length > 0 &&
    orderedProjects.every((project) => collapsed.has(project.id)) &&
    projectGroups.every((group) => group.collapsed);
  const activeSessionProjectId = workspace.sessions.find(
    (session) => session.id === activeSessionId,
  )?.projectId;
  const projectRunning = (id: string) =>
    workspace.sessions.some(
      (session) =>
        session.projectId === id && statusOf(session.id)?.state === "running",
    );
  const projectActions = (
    project: AgentProject,
    manualGroup?: AgentProjectGroup,
    railProject = false,
    reorderActions?: ReactNode,
  ) => (
    <>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Pencil />} />}
        onClick={() => openForm({ kind: "project", project, fromMenu: true })}
      >
        {s.editProject}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Palette />} />}
        onClick={() => openAppearance("project", project.id)}
      >
        {s.customizeProject}
      </ContextMenu.Item>
      {railProject ? (
        <>
          {manualGroup ? (
            <ContextMenu.Item
              nativeButton
              render={<MenuItem leading={<X />} />}
              onClick={() => moveProjectToGroup(project.id, null)}
            >
              {s.removeFromGroup}
            </ContextMenu.Item>
          ) : null}
          {projectGroups
            .filter((group) => group.id !== manualGroup?.id)
            .map((group) => (
              <ContextMenu.Item
                key={group.id}
                nativeButton
                render={<MenuItem leading={<Folder />} />}
                onClick={() => moveProjectToGroup(project.id, group.id)}
              >
                {s.moveToGroup(group.name)}
              </ContextMenu.Item>
            ))}
        </>
      ) : null}
      {reorderActions}
      <ContextMenu.Item
        nativeButton
        disabled={projectRunning(project.id)}
        render={
          <MenuItem
            danger
            leading={<Trash2 />}
            title={projectRunning(project.id) ? s.stopFirst : undefined}
          />
        }
        onClick={() => ask({ kind: "project", project, fromMenu: true })}
      >
        {s.removeProject}
      </ContextMenu.Item>
    </>
  );
  const worktreeActions = (
    group: AgentProjectWorktreeGroup,
    worktree: AgentProjectWorktree,
    registered = false,
  ) => {
    const repositoryProjectId = group.repositoryProjectId;
    const projects = worktree.projectIds.flatMap(
      (id) => orderedProjects.find((item) => item.id === id) ?? [],
    );
    const base = group.worktrees[0]?.branch;
    const branch = worktree.branch;
    return (
      <>
        {registered ? null : (
          <ContextMenu.Item
            nativeButton
            render={<MenuItem leading={<Folder />} />}
            onClick={() =>
              void openExternalWorktree(repositoryProjectId, worktree, true)
            }
          >
            {s.openWorktree}
          </ContextMenu.Item>
        )}
        {branch && base && branch !== base ? (
          <ContextMenu.Item
            nativeButton
            render={<MenuItem leading={<GitMerge />} />}
            onClick={() =>
              ask({
                kind: "worktree",
                repositoryProjectId,
                worktree,
                projects,
                merge: { branch, base },
                fromMenu: true,
              })
            }
          >
            {s.mergeWorktree(base)}
          </ContextMenu.Item>
        ) : null}
        <ContextMenu.Item
          nativeButton
          render={<MenuItem danger leading={<Trash2 />} />}
          onClick={() =>
            ask({
              kind: "worktree",
              repositoryProjectId,
              worktree,
              projects,
              fromMenu: true,
            })
          }
        >
          {s.removeWorktree}
        </ContextMenu.Item>
      </>
    );
  };
  const activityList = (project: AgentProject) => {
    const sessions = visibleSessions.filter(
      (session) => session.projectId === project.id,
    );
    return sessions.length > 0 ? (
      <ul
        className="agent-activity-list"
        aria-label={`${s.activity} · ${project.name}`}
      >
        {sessions.map((session) => (
          <li
            key={session.id}
            className="agent-activity-item"
            data-session-id={session.id}
          >
            <button
              type="button"
              className="agent-activity-session"
              title={agentProviderLabel(session.executable)}
              aria-current={activeSessionId === session.id ? "page" : undefined}
              disabled={navigationDisabled}
              onClick={() => selectSession(session)}
            >
              {startingSessionId === session.id || isWorking(session.id) ? (
                <LoaderCircle
                  size={12}
                  className="app-loading-spinner"
                  role="status"
                  aria-label={statusLabel(session.id)}
                />
              ) : (
                <span
                  className={`agent-status-dot is-${attentionOf(session.id) ?? statusOf(session.id)?.state ?? "idle"}`}
                  aria-hidden="true"
                />
              )}
              <AgentProviderIcon executable={session.executable} />
              <span className="agent-activity-name">
                {sessionName(session)}
              </span>
              <span className="sr-only">
                {startingSessionId === session.id
                  ? s.startingShort
                  : statusLabel(session.id)}
              </span>
            </button>
            {pinnedSessionIds.has(session.id) ? null : (
              <IconButton
                size="small"
                className="agent-activity-close"
                aria-label={`${s.closeSession} · ${sessionName(session)}`}
                title={s.closeSession}
                disabled={disabled}
                onClick={() => closeSession(session)}
              >
                <X aria-hidden="true" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    ) : null;
  };
  const collapsedActivity = (projectIds: readonly string[]) => {
    const sessions = visibleSessions.filter((session) =>
      projectIds.includes(session.projectId),
    );
    const activeSessions = sessions.filter(
      (session) =>
        startingSessionId === session.id ||
        statusOf(session.id)?.state === "running",
    );
    const busySession = activeSessions.find(
      (session) => startingSessionId === session.id || isWorking(session.id),
    );
    const marks = sessions.map((session) => attentionOf(session.id));
    const attention = marks.includes("awaiting")
      ? "awaiting"
      : marks.includes("unread")
        ? "unread"
        : null;
    const count = activeSessions.length;
    if (count === 0 && !attention) return null;
    const label = [
      count > 0 ? s.groupActiveAgents(count) : null,
      busySession
        ? statusLabel(busySession.id)
        : attention
          ? s[attention]
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      label,
      badge: (
        <span
          className={`agent-project-activity${busySession ? " is-working" : ""}`}
          role="status"
          aria-label={label}
        >
          {busySession ? (
            <LoaderCircle
              size={11}
              className="app-loading-spinner"
              aria-hidden="true"
            />
          ) : (
            <span
              className={`agent-status-dot is-${attention ?? "running"}`}
              aria-hidden="true"
            />
          )}
          {count > 0 ? <span aria-hidden="true">{count}</span> : null}
        </span>
      ),
    };
  };
  const renderProject = ({
    project,
    manualGroup,
    worktreeGroup: group,
    reorderActions,
  }: AgentProjectRenderProps) => {
    const groupProjectIds = group?.projectIds ?? [project.id];
    const expanded = !groupProjectIds.some((id) => collapsed.has(id));
    const activity = expanded ? null : collapsedActivity(groupProjectIds);
    const branch = branches[project.id];
    const environmentTitle = agentEnvironmentLabel(
      project.environment,
      s.local,
    );
    const environment =
      project.environment.kind === "ssh" ? s.ssh : environmentTitle;
    const showBranch = !group || !expanded;
    let branchTitle: string | null | undefined = showBranch ? branch : null;
    let branchStatus: ReactNode = null;
    if (showBranch && branch === null) {
      branchTitle = s.branchUnavailable;
      branchStatus = (
        <>
          <GitBranch size={12} aria-hidden="true" />
          <span>{s.branchUnavailable}</span>
        </>
      );
    } else if (showBranch && branch) {
      branchStatus = (
        <>
          <GitBranch size={12} aria-hidden="true" />
          <span>{branch}</span>
        </>
      );
    } else if (showBranch && branch === undefined && !branchError) {
      branchStatus = (
        <LoaderCircle
          size={12}
          className="app-loading-spinner"
          role="status"
          aria-label={s.branchLoading}
        />
      );
    }
    return (
      <>
        <RowContextMenu
          disabled={disabled}
          returnFocusRef={returnFocusRef}
          actions={() =>
            projectActions(project, manualGroup, true, reorderActions)
          }
        >
          <div className="agent-project-row">
            <NavItem
              className="agent-project-select"
              title={[
                group ? null : project.path,
                environmentTitle,
                branchTitle,
                activity?.label,
              ]
                .filter(Boolean)
                .join(" · ")}
              icon={<AgentProjectIcon project={project} size={15} />}
              isSelected={!group && railSelectedProjectId === project.id}
              label={
                <>
                  <span className="agent-project-heading">
                    <span className="agent-project-name">{project.name}</span>
                    {activity?.badge}
                  </span>
                  <span className="agent-project-details">
                    <span>{environment}</span>
                    {branchStatus}
                  </span>
                </>
              }
              onSelect={() =>
                void (async () => {
                  if (!(await selectProject(project))) return;
                  setCollapsed((values) => {
                    const next = new Set(values);
                    groupProjectIds.forEach((id) =>
                      expanded ? next.add(id) : next.delete(id),
                    );
                    return next;
                  });
                })()
              }
            />
            <IconButton
              className="agent-project-worktree-add"
              size="small"
              aria-label={`${gitStrings.createWorktree} · ${project.name}`}
              title={gitStrings.createWorktree}
              aria-busy={
                quickWorktreeLoadingProjectId === project.id || undefined
              }
              disabled={
                disabled ||
                branches[project.id] == null ||
                (workspace.disconnectedProjectIds ?? []).includes(project.id)
              }
              onClick={(event) => {
                returnFocusRef.current = event.currentTarget;
                void requestQuickWorktree(project);
              }}
            >
              {quickWorktreeLoadingProjectId === project.id ? (
                <LoaderCircle
                  className="app-loading-spinner"
                  aria-hidden="true"
                />
              ) : (
                <Plus aria-hidden="true" />
              )}
            </IconButton>
            <IconButton
              className="agent-project-toggle"
              size="small"
              aria-label={`${expanded ? s.collapse : s.expand} · ${project.name}`}
              aria-expanded={expanded}
              onClick={() =>
                setCollapsed((values) => {
                  const next = new Set(values);
                  groupProjectIds.forEach((id) =>
                    expanded ? next.add(id) : next.delete(id),
                  );
                  return next;
                })
              }
            >
              <ChevronRight aria-hidden="true" />
            </IconButton>
          </div>
        </RowContextMenu>
        {expanded && group ? (
          <div className="agent-worktree-list">
            {group.worktrees.flatMap((worktree, worktreeIndex) =>
              worktree.projectIds.length > 0 ? (
                worktree.projectIds.map((projectId) => {
                  const worktreeProject = orderedProjects.find(
                    (item) => item.id === projectId,
                  );
                  if (!worktreeProject) return [];
                  const row = (
                    <div className="agent-worktree-row">
                      <NavItem
                        className="agent-worktree-select"
                        title={worktree.path}
                        icon={
                          <span
                            className={`agent-worktree-node${activeSessionProjectId === projectId ? " is-active" : ""}`}
                          />
                        }
                        isSelected={railSelectedProjectId === projectId}
                        label={
                          <span className="agent-worktree-name">
                            {worktreeName(worktree, branches[projectId])}
                          </span>
                        }
                        onSelect={() => selectProject(worktreeProject)}
                      />
                    </div>
                  );
                  return (
                    <div className="agent-worktree" key={projectId}>
                      {/* The project row above already carries this project's actions. */}
                      {worktreeIndex === 0 && projectId === project.id ? (
                        row
                      ) : (
                        <RowContextMenu
                          disabled={disabled}
                          returnFocusRef={returnFocusRef}
                          actions={() =>
                            worktreeIndex === 0
                              ? projectActions(
                                  worktreeProject,
                                  projectGroups.find((manualGroup) =>
                                    manualGroup.projectIds.includes(projectId),
                                  ),
                                  railProjects.some(
                                    (railProject) =>
                                      railProject.id === worktreeProject.id,
                                  ),
                                )
                              : worktreeActions(group, worktree, true)
                          }
                        >
                          {row}
                        </RowContextMenu>
                      )}
                      {activityList(worktreeProject)}
                    </div>
                  );
                })
              ) : (
                <div className="agent-worktree" key={worktree.path}>
                  <RowContextMenu
                    disabled={disabled}
                    returnFocusRef={returnFocusRef}
                    actions={() =>
                      worktreeIndex === 0 ? (
                        <ContextMenu.Item
                          nativeButton
                          render={<MenuItem leading={<Folder />} />}
                          onClick={() =>
                            void openExternalWorktree(
                              group.repositoryProjectId,
                              worktree,
                              true,
                            )
                          }
                        >
                          {s.openWorktree}
                        </ContextMenu.Item>
                      ) : (
                        worktreeActions(group, worktree)
                      )
                    }
                  >
                    <div className="agent-worktree-row">
                      <NavItem
                        className="agent-worktree-select"
                        title={worktree.path}
                        icon={<span className="agent-worktree-node" />}
                        isSelected={false}
                        label={
                          <>
                            <span className="agent-worktree-name">
                              {worktreeName(worktree)}
                            </span>
                            <span className="agent-worktree-detail">
                              {s.externalWorktree}
                            </span>
                          </>
                        }
                        onSelect={() =>
                          void openExternalWorktree(
                            group.repositoryProjectId,
                            worktree,
                          )
                        }
                      />
                    </div>
                  </RowContextMenu>
                </div>
              ),
            )}
          </div>
        ) : expanded ? (
          activityList(project)
        ) : null}
      </>
    );
  };
  const toggleGroup = (group: AgentProjectGroup) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const key = groupCollapseKey(group.id);
      if (next.has(key)) {
        next.delete(key);
        // Expanding a group always reveals its overview sessions, even after "collapse all".
        if (group.groupProjectId) next.delete(group.groupProjectId);
      } else next.add(key);
      return next;
    });
  const renderGroup = ({
    group,
    count,
    actions,
  }: AgentProjectGroupRenderProps) => {
    const groupProject = workspace.projects.find(
      (project) => project.id === group.groupProjectId,
    );
    const hasOverview =
      !!groupProject || group.projectIds.length > 0 || count > 0;
    const anchor =
      groupProject ??
      workspace.projects.find((project) => project.id === group.projectIds[0]);
    const environmentTitle = anchor
      ? agentEnvironmentLabel(anchor.environment, s.local)
      : null;
    const environment =
      anchor?.environment.kind === "ssh" ? s.ssh : environmentTitle;
    // Worktree projects hide under their repository row, which is the only one stored in the group.
    // shortcut: with incomplete worktree topology, a worktree still saved in another group also counts there; mirror AgentProjectList's repository filter if it shows up.
    const memberIds = group.projectIds.flatMap(
      (id) =>
        worktreeGroups.find((worktree) => worktree.projectIds.includes(id))
          ?.projectIds ?? [id],
    );
    const activeAgents = workspace.sessions.filter(
      (session) =>
        (session.projectId === groupProject?.id ||
          memberIds.includes(session.projectId)) &&
        isWorking(session.id),
    ).length;
    // Hidden sessions: the whole group when collapsed, else only the overview's own list.
    const activity = collapsedActivity(
      group.collapsed
        ? [...(groupProject ? [groupProject.id] : []), ...memberIds]
        : groupProject && collapsed.has(groupProject.id)
          ? [groupProject.id]
          : [],
    );
    const details = [
      hasOverview ? s.groupOverview : null,
      environment,
      s.groupProjectCount(count),
      activeAgents > 0 ? s.groupActiveAgents(activeAgents) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const overviewName = `${s.groupOverview} · ${group.name}`;
    let sessionTrigger = groupSessionRefs.current.get(group.id);
    if (!sessionTrigger) {
      sessionTrigger = { current: null };
      groupSessionRefs.current.set(group.id, sessionTrigger);
    }
    return (
      <>
        <RowContextMenu
          disabled={disabled || loading}
          returnFocusRef={returnFocusRef}
          actions={() => actions}
        >
          <div className="agent-project-row">
            <NavItem
              className="agent-project-select"
              title={
                [environmentTitle, activity?.label]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              icon={
                <AgentProjectIcon
                  project={group}
                  size={15}
                  fallback={Folders}
                />
              }
              isSelected={
                !!groupProject && railSelectedProjectId === groupProject.id
              }
              label={
                <>
                  <span className="agent-project-heading">
                    <span className="agent-project-name">{group.name}</span>
                    {activity?.badge}
                  </span>
                  <span className="agent-project-details">
                    <span>{details}</span>
                  </span>
                </>
              }
              onSelect={() => toggleGroup(group)}
            />
            <IconButton
              size="small"
              aria-label={`${s.openGroupOverview} · ${group.name}`}
              title={s.openGroupOverview}
              disabled={disabled || !hasOverview}
              onClick={() => void openGroupOverview(group)}
            >
              <LayoutGrid aria-hidden="true" />
            </IconButton>
            <NewSessionMenu
              projectName={overviewName}
              size="small"
              disabled={
                disabled ||
                group.projectIds.length === 0 ||
                (!!groupProject &&
                  sessionLaunchBlocked(workspace, groupProject.id))
              }
              returnFocusRef={returnFocusRef}
              triggerRef={sessionTrigger}
              onPreset={(preset) => void createGroupSession(group, preset)}
            />
            <IconButton
              className="agent-project-group-toggle"
              data-group-id={group.id}
              size="small"
              aria-label={`${group.collapsed ? s.expandGroup : s.collapseGroup} · ${group.name}`}
              aria-expanded={!group.collapsed}
              onClick={() => toggleGroup(group)}
            >
              <ChevronRight aria-hidden="true" />
            </IconButton>
          </div>
        </RowContextMenu>
        {group.collapsed ? null : !hasOverview ? (
          <button
            className="agent-group-empty-action"
            type="button"
            disabled={disabled}
            onClick={() => openForm({ kind: "group", group })}
          >
            {s.addProject}
          </button>
        ) : groupProject && !collapsed.has(groupProject.id) ? (
          activityList(groupProject)
        ) : null}
      </>
    );
  };
  const prioritySession = (session: AgentSession) => {
    const project = workspace.projects.find(
      (item) => item.id === session.projectId,
    );
    const overviewGroup = projectGroups.find(
      (group) => group.groupProjectId === session.projectId,
    );
    const mark = attentionOf(session.id);
    const branch = branches[session.projectId];
    return (
      <li key={session.id}>
        <button
          type="button"
          className="agent-priority-session"
          title={agentProviderLabel(session.executable)}
          aria-current={activeSessionId === session.id ? "page" : undefined}
          disabled={navigationDisabled}
          onClick={() => selectSession(session)}
        >
          {mark ? (
            <span
              className={`agent-status-dot is-${mark}`}
              aria-hidden="true"
            />
          ) : tabPanes(session.id).some(busy) ? (
            <LoaderCircle
              size={12}
              className="app-loading-spinner"
              aria-hidden="true"
            />
          ) : (
            <span className="agent-status-dot is-running" aria-hidden="true" />
          )}
          <AgentProviderIcon executable={session.executable} />
          <span className="agent-priority-name">{sessionName(session)}</span>
          {mark ? (
            <span className="agent-priority-reason" data-attention={mark}>
              {mark === "awaiting"
                ? s.notificationAwaiting
                : s.notificationFinished}
            </span>
          ) : null}
          {/* shortcut: the spoken status reads the tab's parent only, so a working split pane under an exited parent is announced stopped; aggregate both panes if split screen-reader use shows up. */}
          <span className="sr-only">
            {startingSessionId === session.id
              ? s.startingShort
              : statusLabel(session.id)}
          </span>
          <span className="agent-priority-context">
            <span>{project?.name}</span>
            <span>
              {[
                overviewGroup ? s.groupOverview : null,
                project &&
                  (project.environment.kind === "ssh"
                    ? s.ssh
                    : agentEnvironmentLabel(project.environment, s.local)),
                overviewGroup
                  ? s.groupProjectCount(overviewGroup.projectIds.length)
                  : null,
                branch ? "" : null,
              ]
                .filter((part) => part != null)
                .map((part) => `· ${part}`.trim())
                .join(" ")}
            </span>
            {branch ? (
              <>
                <GitBranch size={10} aria-hidden="true" />
                <span>{branch}</span>
              </>
            ) : null}
          </span>
        </button>
      </li>
    );
  };
  const priorityList = (
    <div className="agent-priority-list">
      {priority.toHandle.length > 0 ? (
        <section aria-labelledby="agent-priority-to-handle">
          <h3 id="agent-priority-to-handle" className="agent-priority-heading">
            {s.toHandle}
          </h3>
          <ul className="agent-priority-sessions">
            {priority.toHandle.map(prioritySession)}
          </ul>
        </section>
      ) : null}
      {priority.live.length > 0 ? (
        <section aria-labelledby="agent-priority-live">
          <h3 id="agent-priority-live" className="agent-priority-heading">
            {s.inProgress(priority.live.length)}
          </h3>
          <ul className="agent-priority-sessions">
            {priority.live.map(prioritySession)}
          </ul>
        </section>
      ) : null}
      {priority.toHandle.length + priority.live.length === 0 ? (
        <p className="agent-priority-empty">{s.priorityEmpty}</p>
      ) : null}
    </div>
  );
  return (
    <aside
      className={`agent-rail${embedded ? " agent-rail-embedded" : ""}`}
      data-launching={startingSessionId !== null || undefined}
      data-closing={closing || undefined}
      data-saving-favorite={savingFavorite || undefined}
      data-service-operating={serviceOperating || undefined}
      hidden={hidden}
      aria-label={s.projects}
    >
      <header className="agent-rail-header section-title">
        <h2>{embedded ? s.projects : s.title}</h2>
        <div className="agent-rail-actions">
          <IconButton
            className="agent-priority-toggle"
            aria-label={s.priorityView(priority.toHandle.length)}
            aria-pressed={priorityView}
            title={s.priorityView(priority.toHandle.length)}
            selected={priorityView}
            onClick={() => {
              setPriorityView(!priorityView);
              writePriorityView(!priorityView);
            }}
          >
            <Inbox aria-hidden="true" />
            {priority.toHandle.length > 0 ? (
              <span className="agent-priority-badge" aria-hidden="true">
                {priority.toHandle.length}
              </span>
            ) : null}
          </IconButton>
          {priorityView ||
          (hasLoaded && orderedProjects.length === 0) ? null : (
            <ProjectViewControls
              filterDisabled={loading || orderedProjects.length === 0}
              collapseDisabled={
                disabled || loading || orderedProjects.length === 0
              }
              allCollapsed={allProjectsCollapsed}
              onlyWithAgents={onlyWithAgents}
              onOnlyWithAgentsChange={onOnlyWithAgentsChange}
              onToggleCollapseAll={() =>
                setCollapsed(
                  new Set(
                    allProjectsCollapsed
                      ? []
                      : [
                          ...projectGroups.map((group) =>
                            groupCollapseKey(group.id),
                          ),
                          ...orderedProjects.map((project) => project.id),
                        ],
                  ),
                )
              }
            />
          )}
          <NewProjectMenu
            disabled={disabled || loading}
            hasProjects={railProjects.length > 0}
            returnFocusRef={returnFocusRef}
            triggerRef={addProjectRef}
            onOpen={() => openForm({ kind: "project", fromMenu: true })}
            onGroup={() => openForm({ kind: "group", fromMenu: true })}
            onClone={onClone}
          />
        </div>
      </header>
      {priorityView && hasLoaded ? (
        priorityList
      ) : (
        <AgentProjectList
          projects={projects}
          groups={groups}
          worktreeGroups={worktreeGroups}
          hasLoaded={hasLoaded}
          loading={loading}
          refreshing={refreshing}
          reorderDisabled={reorderDisabled || onlyWithAgents}
          sectionOrder={sectionOrder}
          renderProject={renderProject}
          renderGroup={renderGroup}
          onOpenGroupOverview={(group) => void openGroupOverview(group)}
          onReorder={onReorderProjects}
          onSectionOrderChange={onSectionOrderChange}
          onEditGroup={(group) =>
            openForm({ kind: "group", group, fromMenu: true })
          }
          onCustomizeGroup={(group) => openAppearance("group", group.id)}
          onDeleteGroup={onDeleteGroup}
          onMoveProjectToGroup={onDropProjectInGroup}
        />
      )}
      {onlyWithAgents && !loading && !priorityView ? (
        <footer className="agent-rail-filter-notice" role="status">
          <span>{s.hiddenProjects(hiddenProjectCount)}</span>
          <button
            type="button"
            className="agent-rail-filter-reset"
            onClick={() => onOnlyWithAgentsChange(false)}
          >
            {s.showAllProjects}
          </button>
        </footer>
      ) : null}
      {appearanceTarget && appearanceItem && !hidden ? (
        <AgentProjectAppearancePopover
          key={`${appearanceTarget.kind}:${appearanceTarget.id}`}
          project={appearanceItem}
          x={appearanceTarget.x}
          y={appearanceTarget.y}
          disabled={disabled}
          onSave={
            appearanceTarget.kind === "group"
              ? onSaveGroupAppearance
              : onSaveProjectAppearance
          }
          onClose={() => {
            setAppearanceTarget(null);
            returnFocusRef.current?.focus();
          }}
        />
      ) : null}
    </aside>
  );
}
