// @vitest-environment jsdom
import { act, useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import * as api from "../../data/agentSessionsApi";
import * as designApi from "../../data/designApi";
import * as gitApi from "../../data/projectGitApi";
import * as projectFilesApi from "../../data/projectFilesApi";
import type {
  AgentProjectWorktreeGroup,
  AgentProvider,
  AgentWorkspace as WorkspaceData,
  SshMobileStatus,
} from "../../domain/agentSessions";
import type { KanbanIssueSelection } from "../../domain/kanban";
import type { GitWorktree } from "../../domain/projectGit";
import { clearNotifications, getNotifications } from "../../notifications";
import {
  AgentWorkspace,
  type AgentBoardRequest,
  type AgentSessionRequest,
  type AgentTransitionGuard,
} from "./AgentWorkspace";
import { stubModalSelector } from "../ui/testTopLayer";
import { setInputValue } from "../ui/testInput";

const runtime = vi.hoisted(() => ({
  desktop: true,
  mounts: vi.fn(),
  unmounts: vi.fn(),
  projectNavigationPrepare: vi.fn(async () => true),
  worktreeRemovalRestore: null as (() => Promise<void>) | null,
  titles: new Map<string, (title: string) => void>(),
  settings: {
    hiddenAgentPresets: [] as AgentProvider[],
    agentPresetArgs: {} as Partial<Record<AgentProvider, string[]>>,
    agentNotificationsEnabled: false,
  },
  showWorkspace: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => runtime.desktop }));
vi.mock("../../data/agentAttentionApi", () => ({
  showAgentNotification: vi.fn(async () => {}),
  setAgentAttentionBadge: vi.fn(async () => {}),
  isWindowFocused: vi.fn(async () => false),
  listenWindowFocus: vi.fn(async () => () => {}),
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ locale: "fr-FR", t: (key: string) => key }),
}));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({
    settings: runtime.settings,
    updateSettings: vi.fn(),
  }),
}));
vi.mock("../../data/projectGitApi", () => ({
  cloneGitRepository: vi.fn(),
  createGitWorktree: vi.fn(),
  readGitBranches: vi.fn(),
  readGitRepository: vi.fn(),
  readGitWorktrees: vi.fn(),
  mergeGitWorktree: vi.fn(),
  removeGitWorktree: vi.fn(),
}));
vi.mock("../../data/projectFilesApi", () => ({
  readProjectFile: vi.fn(),
}));
vi.mock("../../data/agentSessionsApi", () => ({
  loadAgentWorkspace: vi.fn(),
  listAgentStatuses: vi.fn(),
  listAgentBranches: vi.fn(),
  listAgentServiceBranches: vi.fn(),
  listAgentWorktrees: vi.fn(),
  discoverAgentEnvironments: vi.fn(),
  pickAgentProjectDirectory: vi.fn(),
  browseAgentSsh: vi.fn(),
  scanAgentSshHost: vi.fn(),
  pickAgentSshIdentity: vi.fn(),
  saveAgentProject: vi.fn(),
  updateAgentProjectAppearance: vi.fn(),
  updateAgentProjectGroupAppearance: vi.fn(),
  deleteAgentProject: vi.fn(),
  saveAgentProjectGroup: vi.fn(),
  importAgentProjectGroups: vi.fn(),
  prepareAgentGroupProject: vi.fn(),
  deleteAgentProjectGroup: vi.fn(),
  setAgentProjectConnected: vi.fn(),
  linkAgentSessionKanbanIssue: vi.fn(),
  setAgentProjectLinearLink: vi.fn(),
  setAgentSessionClosed: vi.fn(),
  listAgentSshPortForwards: vi.fn(),
  startAgentSshPortForward: vi.fn(),
  stopAgentSshPortForward: vi.fn(),
  loadAgentSshMobileStatus: vi.fn(),
  enableAgentSshMobile: vi.fn(),
  pairAgentSshMobile: vi.fn(),
  revokeAgentSshMobile: vi.fn(),
  disableAgentSshMobile: vi.fn(),
  saveAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
  startAgentSession: vi.fn(),
  stopAgentSession: vi.fn(),
  sendAgentSessionMessage: vi.fn(),
  listAgentSessionMessages: vi.fn(),
  listenAgentSessionMessages: vi.fn(),
  setAgentRemoteLabel: vi.fn(),
}));
vi.mock("../../data/designApi", () => ({
  loadDesignBoards: vi.fn(),
  createDesignBoard: vi.fn(),
  renameDesignBoard: vi.fn(),
  deleteDesignBoard: vi.fn(),
  loadDesignFrames: vi.fn(),
  updateDesignFrame: vi.fn(),
  duplicateDesignFrame: vi.fn(),
  deleteDesignFrame: vi.fn(),
  listenDesignFramesChanged: vi.fn(),
  linkDesignSession: vi.fn(),
  unlinkDesignSession: vi.fn(),
  sendDesignToSession: vi.fn(),
  restoreDesignFrame: vi.fn(),
}));
vi.mock("./AgentTerminal", () => ({
  AgentTerminal: ({
    sessionId,
    visible,
    runRevision,
    focusRequest,
    state,
    onTitleChange,
    onFocus,
    notice,
  }: {
    sessionId: string;
    visible: boolean;
    runRevision: number;
    focusRequest: number | null;
    state: "idle" | "running" | "exited";
    onTitleChange: (id: string, title: string) => void;
    onFocus?: (id: string) => void;
    notice?: ReactNode;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      runtime.mounts(sessionId);
      return () => {
        runtime.unmounts(sessionId);
      };
    }, [sessionId]);
    useEffect(() => {
      runtime.titles.set(sessionId, (title) => onTitleChange(sessionId, title));
      return () => {
        runtime.titles.delete(sessionId);
      };
    }, [sessionId, runRevision, onTitleChange]);
    useEffect(() => {
      if (
        focusRequest !== null &&
        visible &&
        !document.querySelector('[aria-modal="true"]')
      )
        ref.current?.focus();
    }, [visible, runRevision, focusRequest]);
    return (
      <div
        ref={ref}
        tabIndex={-1}
        data-terminal={sessionId}
        data-revision={runRevision}
        data-state={state}
        hidden={!visible}
        onFocus={() => onFocus?.(sessionId)}
      >
        {notice}
      </div>
    );
  },
}));
vi.mock("./GitPanel", () => ({
  GitPanel: ({
    project,
    disconnected,
    projectsLoading,
    projectsError,
    visible,
    expanded,
    onClose,
    onExpandedChange,
    onOpenExternalWorktree,
    onWorktreeCreated,
    onPrepareWorktreeRemoval,
    registerProjectNavigationGuard,
    activeAgentTarget,
  }: {
    project?: { name: string };
    disconnected?: boolean;
    projectsLoading?: boolean;
    projectsError?: string | null;
    visible: boolean;
    expanded?: boolean;
    onClose: () => void;
    onExpandedChange?: (expanded: boolean) => void;
    onOpenExternalWorktree?: (worktree: {
      path: string;
      head: string;
      branch: string;
    }) => void;
    onWorktreeCreated?: (
      project: {
        id: string;
        name: string;
        path: string;
        environment: { kind: "local"; distribution: null };
      },
      worktree: { path: string; head: string; branch: string },
    ) => void;
    onPrepareWorktreeRemoval?: (
      worktree: GitWorktree,
    ) => Promise<() => Promise<void>>;
    registerProjectNavigationGuard?: (
      guard: AgentTransitionGuard,
    ) => () => void;
    activeAgentTarget?: { sessionId: string } | null;
  }) => {
    useEffect(
      () =>
        registerProjectNavigationGuard?.({
          cancel: () => {},
          hasPendingWork: () => true,
          prepare: runtime.projectNavigationPrepare,
        }),
      [registerProjectNavigationGuard],
    );
    return (
      <section
        className="agent-git-panel"
        data-expanded={expanded}
        data-disconnected={disconnected || undefined}
        hidden={!visible}
      >
        <h2>Git</h2>
        <p>{project?.name}</p>
        <p data-active-agent={activeAgentTarget?.sessionId ?? ""} />
        {projectsLoading ? (
          <p role="status" aria-label="Chargement des projets…" />
        ) : projectsError ? (
          <p data-projects-error="" />
        ) : project ? (
          <>
            <button
              onClick={() =>
                onOpenExternalWorktree?.({
                  path: "/actual/feature",
                  head: "abc",
                  branch: "feature",
                })
              }
            >
              Ouvrir le worktree Git
            </button>
            <button
              onClick={() =>
                onWorktreeCreated?.(
                  {
                    id: "created-worktree",
                    name: "Created worktree",
                    path: "/worktrees/created",
                    environment: { kind: "local", distribution: null },
                  },
                  {
                    path: "/worktrees/created",
                    head: "b".repeat(40),
                    branch: "created",
                  },
                )
              }
            >
              Signaler le worktree créé
            </button>
            <button
              onClick={async () => {
                runtime.worktreeRemovalRestore =
                  (await onPrepareWorktreeRemoval?.({
                    path: "/worktrees/feature",
                    head: "b".repeat(40),
                    branch: "feature",
                  })) ?? null;
              }}
            >
              Préparer la suppression du worktree feature
            </button>
          </>
        ) : null}
        <button
          aria-label={
            expanded ? "Réduire le panneau Git" : "Agrandir le panneau Git"
          }
          onClick={() => onExpandedChange?.(!expanded)}
        />
        <button aria-label="Fermer le panneau Git" onClick={onClose} />
      </section>
    );
  },
}));

let container: HTMLDivElement;
let sidebarContainer: HTMLDivElement = null!;
let gitPanelContainer: HTMLDivElement = null!;
let statusBarContainer: HTMLDivElement = null!;
let root: Root;
let data: WorkspaceData;
let guard: AgentTransitionGuard;
let boardRequest: AgentBoardRequest | undefined;
let sessionRequest: AgentSessionRequest | undefined;
let renderArgs: Parameters<typeof render> = [];
const register = (value: AgentTransitionGuard) => {
  guard = value;
  return () => {};
};
const project = {
  id: "p1",
  name: "Soreno",
  path: "/projects/soreno",
  environment: { kind: "local" as const, distribution: null },
};
const worktreeCacheKey = "soreno.agents.worktree-groups.v1";
const terminalSplitsKey = "soreno.agents.terminal-splits.v1";
const worktreeScope = (workspace: WorkspaceData) =>
  JSON.stringify({
    projects: workspace.projects.map(({ id, path, environment }) => [
      id,
      path,
      environment,
    ]),
    disconnectedProjectIds: workspace.disconnectedProjectIds ?? [],
  });
function cacheWorktrees(
  workspace: WorkspaceData,
  groups: AgentProjectWorktreeGroup[],
) {
  localStorage.setItem(
    worktreeCacheKey,
    JSON.stringify({ scope: worktreeScope(workspace), groups }),
  );
}
const session = {
  id: "s1",
  projectId: "p1",
  name: "Pi notes",
  executable: "pi",
  args: [],
  createdAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  runtime.desktop = true;
  runtime.titles.clear();
  runtime.worktreeRemovalRestore = null;
  vi.mocked(designApi.loadDesignBoards).mockResolvedValue([]);
  vi.mocked(designApi.loadDesignFrames).mockResolvedValue([]);
  vi.mocked(designApi.listenDesignFramesChanged).mockResolvedValue(() => {});
  vi.mocked(api.listAgentSessionMessages).mockResolvedValue([]);
  vi.mocked(api.listenAgentSessionMessages).mockResolvedValue(() => {});
  runtime.settings.hiddenAgentPresets = [];
  runtime.settings.agentPresetArgs = {};
  runtime.settings.agentNotificationsEnabled = false;
  localStorage.clear();
  data = {
    projects: [project],
    sessions: [
      session,
      { ...session, id: "s2", name: "Codex tests", executable: "codex" },
    ],
    statuses: [
      { sessionId: "s1", state: "running", exitCode: null },
      { sessionId: "s2", state: "idle", exitCode: null },
    ],
    groups: [],
  };
  vi.mocked(api.loadAgentWorkspace).mockImplementation(async () =>
    structuredClone(data),
  );
  vi.mocked(api.listAgentStatuses).mockImplementation(async () =>
    structuredClone(data.statuses),
  );
  vi.mocked(api.listAgentBranches)
    .mockReset()
    .mockResolvedValue([{ projectId: "p1", branch: "main" }]);
  vi.mocked(api.listAgentServiceBranches).mockResolvedValue([]);
  vi.mocked(api.listAgentSshPortForwards).mockResolvedValue([]);
  vi.mocked(api.startAgentSshPortForward).mockResolvedValue({
    forwards: [],
    ignoredPorts: [],
  });
  vi.mocked(api.stopAgentSshPortForward).mockResolvedValue();
  vi.mocked(api.setAgentRemoteLabel).mockResolvedValue();
  const mobileOff = mobileStatus({});
  vi.mocked(api.loadAgentSshMobileStatus).mockResolvedValue(mobileOff);
  vi.mocked(api.enableAgentSshMobile).mockResolvedValue(mobileOff);
  vi.mocked(api.pairAgentSshMobile).mockResolvedValue({
    id: "0123456789abcdef",
    url: "https://relay.example/#p=server.secret",
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    expiresAt: Date.now() + 600_000,
  });
  vi.mocked(api.revokeAgentSshMobile).mockResolvedValue(mobileOff);
  vi.mocked(api.disableAgentSshMobile).mockResolvedValue(mobileOff);
  vi.mocked(api.listAgentWorktrees)
    .mockReset()
    .mockResolvedValue({ groups: [], complete: true, missingProjectIds: [] });
  vi.mocked(projectFilesApi.readProjectFile).mockRejectedValue({
    code: "notFound",
    message: "missing",
  });
  vi.mocked(api.discoverAgentEnvironments).mockResolvedValue({
    localLabel: "Windows",
    distributions: ["Ubuntu"],
    wslError: null,
  });
  vi.mocked(api.saveAgentProject).mockImplementation(async (value) => {
    data.projects = [
      ...data.projects.filter((item) => item.id !== value.id),
      value,
    ];
  });
  vi.mocked(api.updateAgentProjectAppearance).mockImplementation(
    async (id, appearance) => {
      const stored = data.projects.find((item) => item.id === id);
      if (!stored) throw new Error("missing project");
      // Round-trips like IPC: undefined fields are dropped, so the stored values are kept.
      const updated = {
        ...stored,
        ...(JSON.parse(JSON.stringify(appearance)) as typeof appearance),
      };
      data.projects = data.projects.map((item) =>
        item.id === id ? updated : item,
      );
      return updated;
    },
  );
  vi.mocked(api.updateAgentProjectGroupAppearance).mockImplementation(
    async (id, appearance) => {
      const stored = data.groups?.find((item) => item.id === id);
      if (!stored) throw new Error("missing group");
      const updated = {
        ...stored,
        ...(JSON.parse(JSON.stringify(appearance)) as typeof appearance),
      };
      data.groups = data.groups!.map((item) =>
        item.id === id ? updated : item,
      );
      return updated;
    },
  );
  vi.mocked(api.setAgentProjectConnected).mockImplementation(
    async (id, connected) => {
      const connection = data.projects.find((project) => project.id === id)
        ?.environment.ssh;
      const connectionProjectIds = data.projects
        .filter((project) => {
          const ssh = project.environment.ssh;
          return (
            project.environment.kind === "ssh" &&
            !!connection &&
            !!ssh &&
            ssh.host === connection.host &&
            ssh.user === connection.user &&
            ssh.port === connection.port &&
            ssh.identityFile === connection.identityFile &&
            ssh.hostKey === connection.hostKey
          );
        })
        .map((project) => project.id);
      data.disconnectedProjectIds = connected
        ? (data.disconnectedProjectIds ?? []).filter(
            (projectId) => !connectionProjectIds.includes(projectId),
          )
        : [
            ...new Set([
              ...(data.disconnectedProjectIds ?? []),
              ...connectionProjectIds,
            ]),
          ];
      data.dormantProjectIds = (data.dormantProjectIds ?? []).filter(
        (projectId) => !connectionProjectIds.includes(projectId),
      );
    },
  );
  vi.mocked(gitApi.readGitRepository).mockResolvedValue({
    availability: "ready",
    identity: {
      root: project.path,
      gitDir: `${project.path}/.git`,
      commonDir: `${project.path}/.git`,
    },
    version: "v1",
    head: "a".repeat(40),
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: null,
    mergeMessage: null,
    files: [],
    limited: false,
    truncated: false,
  });
  vi.mocked(gitApi.createGitWorktree).mockImplementation(
    async (_projectId, request) => {
      const created = {
        id: request.id,
        name: request.name,
        path: `${request.parentPath}/${request.folderName}`,
        environment: project.environment,
      };
      data.projects.push(created);
      return created;
    },
  );
  vi.mocked(gitApi.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "a".repeat(40),
      remote: false,
      current: true,
      upstream: null,
    },
  ]);
  vi.mocked(api.linkAgentSessionKanbanIssue).mockImplementation(
    async (sessionId, issue) => {
      const linked = data.sessions.find((item) => item.id === sessionId)!;
      data.kanbanIssueSessions = [
        ...(data.kanbanIssueSessions ?? []),
        {
          source: issue.source,
          sessionId,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          sessionName: linked.name,
          executable: linked.executable,
          projectName: project.name,
          startedAt: linked.createdAt,
          endedAt: null,
          endReason: null,
          mergedInto: null,
        },
      ];
    },
  );
  vi.mocked(api.setAgentSessionClosed).mockImplementation(
    async (sessionId, closed) => {
      const others = (data.closedSessionIds ?? []).filter(
        (id) => id !== sessionId,
      );
      data.closedSessionIds = closed ? [...others, sessionId] : others;
    },
  );
  vi.mocked(gitApi.cloneGitRepository).mockImplementation(async (request) => {
    const cloned = {
      id: request.id,
      name: request.name,
      path: `${request.parentPath}/${request.folderName}`,
      environment: request.environment,
    };
    data.projects.push(cloned);
    return cloned;
  });
  vi.mocked(gitApi.readGitWorktrees).mockResolvedValue([]);
  vi.mocked(gitApi.removeGitWorktree).mockImplementation(
    async (_repositoryProjectId, worktree) => {
      const removedIds = data.projects
        .filter((item) => item.path === worktree.path)
        .map((item) => item.id);
      data.projects = data.projects.filter(
        (item) => !removedIds.includes(item.id),
      );
      data.sessions = data.sessions.filter(
        (item) => !removedIds.includes(item.projectId),
      );
      data.groups = (data.groups ?? []).map((group) => ({
        ...group,
        projectIds: group.projectIds.filter((id) => !removedIds.includes(id)),
      }));
      return { oid: null, message: "Worktree supprimé.", warning: null };
    },
  );
  vi.mocked(api.saveAgentSession).mockImplementation(async (value) => {
    data.sessions = [
      ...data.sessions.filter((item) => item.id !== value.id),
      value,
    ];
    if (!data.statuses.some((item) => item.sessionId === value.id))
      data.statuses.push({
        sessionId: value.id,
        state: "idle",
        exitCode: null,
      });
  });
  vi.mocked(api.startAgentSession).mockImplementation(async (id) =>
    setStatus(id, "running"),
  );
  vi.mocked(api.stopAgentSession).mockImplementation(async (id) =>
    setStatus(id, "exited"),
  );
  vi.mocked(api.deleteAgentSession).mockImplementation(async (id) => {
    data.sessions = data.sessions.filter((item) => item.id !== id);
    data.statuses = data.statuses.filter((item) => item.sessionId !== id);
  });
  vi.mocked(api.deleteAgentProject).mockImplementation(async (id) => {
    data.projects = data.projects.filter((item) => item.id !== id);
    data.sessions = data.sessions.filter((item) => item.projectId !== id);
    data.groups = (data.groups ?? []).map((group) => ({
      ...group,
      projectIds: group.projectIds.filter((projectId) => projectId !== id),
    }));
  });
  vi.mocked(api.saveAgentProjectGroup).mockImplementation(async (value) => {
    const groups = (data.groups ?? []).map((group) => ({
      ...group,
      projectIds: group.projectIds.filter(
        (id) => !value.projectIds.includes(id),
      ),
    }));
    const existing = groups.find((group) => group.id === value.id);
    const saved = {
      ...existing,
      ...value,
      groupProjectId: existing?.groupProjectId ?? null,
    };
    data.groups = existing
      ? groups.map((group) => (group.id === value.id ? saved : group))
      : [...groups, saved];
    data.projects = data.projects.map((item) =>
      item.id === saved.groupProjectId ? { ...item, name: value.name } : item,
    );
  });
  vi.mocked(api.importAgentProjectGroups).mockImplementation(async (values) => {
    for (const value of values)
      if (!(data.groups ?? []).some((group) => group.id === value.id))
        data.groups = [
          ...(data.groups ?? []),
          { ...value, groupProjectId: null },
        ];
    return {
      ungroupedProjectIds: [],
      groupIds: values.map((value) => value.id),
    };
  });
  vi.mocked(api.prepareAgentGroupProject).mockImplementation(async (id) => {
    const group = data.groups!.find((item) => item.id === id)!;
    const existing = data.projects.find(
      (item) => item.id === group.groupProjectId,
    );
    if (existing) return existing;
    const member = data.projects.find(
      (item) => item.id === group.projectIds[0],
    )!;
    const prepared = {
      id: `group-${id}`,
      name: group.name,
      path: `/home/dev/.soreno/groups/${id}`,
      environment: member.environment,
    };
    data.projects.push(prepared);
    group.groupProjectId = prepared.id;
    return prepared;
  });
  vi.mocked(api.deleteAgentProjectGroup).mockImplementation(
    async (id, deleteProjects) => {
      const group = data.groups!.find((item) => item.id === id);
      const removed = [
        group?.groupProjectId,
        ...(deleteProjects ? (group?.projectIds ?? []) : []),
      ];
      data.groups = data.groups!.filter((item) => item.id !== id);
      data.projects = data.projects.filter(
        (item) => !removed.includes(item.id),
      );
      data.sessions = data.sessions.filter(
        (item) => !removed.includes(item.projectId),
      );
      return { retainedFolder: null };
    },
  );
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sidebarContainer = null!;
  gitPanelContainer = null!;
  statusBarContainer = null!;
  boardRequest = undefined;
  sessionRequest = undefined;
  renderArgs = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  sidebarContainer?.remove();
  gitPanelContainer?.remove();
  statusBarContainer?.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setStatus(id: string, state: "running" | "exited" | "idle") {
  data.statuses = data.statuses.map((item) =>
    item.sessionId === id ? { ...item, state } : item,
  );
}
async function render(
  ...args: [
    hidden?: boolean,
    sidebar?: HTMLElement | null,
    gitPanel?: HTMLElement | null,
    gitPanelVisible?: boolean,
    onGitPanelVisibleChange?: (visible: boolean) => void,
    gitPanelExpanded?: boolean,
    onGitPanelExpandedChange?: (expanded: boolean) => void,
  ]
) {
  renderArgs = args;
  const [
    hidden = false,
    sidebar,
    gitPanel,
    gitPanelVisible = true,
    onGitPanelVisibleChange,
    gitPanelExpanded = false,
    onGitPanelExpandedChange,
  ] = args;
  await act(async () =>
    root.render(
      <AgentWorkspace
        gitPanelContainer={gitPanel}
        gitPanelExpanded={gitPanelExpanded}
        gitPanelVisible={gitPanelVisible}
        hidden={hidden}
        boardRequest={boardRequest}
        onGitPanelExpandedChange={onGitPanelExpandedChange}
        onGitPanelVisibleChange={onGitPanelVisibleChange}
        sidebarContainer={sidebar}
        statusBarContainer={statusBarContainer}
        registerTransitionGuard={register}
        sessionRequest={sessionRequest}
        onShowWorkspace={runtime.showWorkspace}
      />,
    ),
  );
}
async function requestKanban(selected: boolean, issue?: KanbanIssueSelection) {
  boardRequest = {
    board: selected ? "kanban" : null,
    id: (boardRequest?.id ?? 0) + 1,
    issue,
  };
  await render(...renderArgs);
}
async function requestAutomations() {
  boardRequest = { board: "automations", id: (boardRequest?.id ?? 0) + 1 };
  await render(...renderArgs);
}
async function requestDesign() {
  boardRequest = { board: "design", id: (boardRequest?.id ?? 0) + 1 };
  await render(...renderArgs);
}
/** A notification click, as App forwards it. */
async function requestSession(sessionId: string) {
  sessionRequest = { sessionId, id: (sessionRequest?.id ?? 0) + 1 };
  await render(...renderArgs);
}
function button(text: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === text ||
      item.textContent === text ||
      item.querySelector(
        ".agent-session-name, .agent-project-name, .agent-worktree-name",
      )?.textContent === text,
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function click(text: string, scope?: ParentNode) {
  await act(async () => button(text, scope).click());
}
function dialog() {
  return document.querySelector<HTMLElement>(
    '[role="dialog"], [role="alertdialog"]',
  )!;
}
function field(label: string) {
  const labelElement = [...document.querySelectorAll("label")].find(
    (item) => item.textContent === label,
  )!;
  return document.getElementById(labelElement.htmlFor)! as
    HTMLInputElement | HTMLTextAreaElement;
}
async function input(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    setInputValue(element, value);
  });
}
async function check(label: string) {
  const checkbox = [
    ...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find(
    (input) => input.labels?.[0].querySelector("strong")?.textContent === label,
  );
  if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
  await act(async () => checkbox.click());
}
async function choose(label: string, option: string) {
  await click(label);
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent === option)!;
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    element.click();
  });
}
async function context(name: string, keyboard = false) {
  const target = button(name, container);
  await act(async () => {
    if (keyboard) {
      target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 200,
        }),
      );
  });
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}
async function action(row: string, label: string) {
  await context(row);
  await click(label, document.querySelector('[role="menu"]')!);
}
async function escape() {
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
}
async function nextAnimationFrame() {
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}
async function addProject(action: "Ajouter un projet" | "Cloner un dépôt") {
  await click("Ajouter un projet");
  await click(action, document.querySelector('[role="menu"]')!);
}
async function newAgent(name: string, projectName = "Soreno") {
  await click(`Nouvelle session · ${projectName}`);
  await click(name, document.querySelector('[role="menu"]')!);
}
async function splitAgent(name: string, projectName = "Soreno") {
  const label = `Nouvelle session · ${projectName}`;
  // Splitting needs a selected session.
  if (!container.querySelector(".agent-session-tab-item.is-selected"))
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".agent-session-tab")!.click(),
    );
  await click(label);
  await click("Diviser le terminal", document.querySelector('[role="menu"]')!);
  const menus = document.querySelectorAll('[role="menu"]');
  await click(name, menus[menus.length - 1]);
}
/** Detaches the secondary pane from the new-session menu, as the toolbar offers it. */
async function detachSplit(projectName = "Soreno") {
  const trigger = button(`Nouvelle session · ${projectName}`);
  await act(async () => trigger.click());
  // A tab drag just before swallows the next click, as after a real drag.
  if (trigger.getAttribute("aria-expanded") !== "true")
    await act(async () => trigger.click());
  await click(
    "Détacher le volet secondaire",
    document.querySelector('[role="menu"]')!,
  );
}

function projectGeometry() {
  const nav = container.querySelector<HTMLElement>(".agent-project-list")!;
  Object.defineProperty(nav, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(nav, "scrollHeight", {
    configurable: true,
    value: Math.max(
      300,
      container.querySelectorAll(projectRowSelector).length * 100,
    ),
  });
  vi.spyOn(nav, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left: 0,
        right: 240,
        top: 0,
        bottom: 300,
        width: 240,
        height: 300,
      }) as DOMRect,
  );
  const projectSections = [
    ...container.querySelectorAll<HTMLElement>(".agent-project-section"),
  ];
  for (const item of projectSections) {
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
      const top = projectSections.indexOf(item) * 100 - nav.scrollTop;
      return {
        left: 0,
        right: 240,
        top,
        bottom: top + 100,
        width: 240,
        height: 100,
      } as DOMRect;
    });
  }
  for (const item of container.querySelectorAll<HTMLElement>(
    ".agent-project-group",
  )) {
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
      const section = item.closest<HTMLElement>(".agent-project-section")!;
      const top = projectSections.indexOf(section) * 100 - nav.scrollTop;
      return {
        left: 0,
        right: 240,
        top,
        bottom: top + 30,
        width: 240,
        height: 30,
      } as DOMRect;
    });
  }
  for (const item of container.querySelectorAll<HTMLElement>(
    projectRowSelector,
  )) {
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
      const top =
        [...container.querySelectorAll(projectRowSelector)].indexOf(item) *
          100 -
        nav.scrollTop;
      return {
        left: 0,
        right: 240,
        top,
        bottom: top + 100,
        width: 240,
        height: 100,
      } as DOMRect;
    });
  }
}
function terminalGeometry() {
  const stack = container.querySelector<HTMLElement>(".agent-terminal-stack")!;
  vi.spyOn(stack, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left: 0,
        right: 400,
        top: 40,
        bottom: 440,
        width: 400,
        height: 400,
      }) as DOMRect,
  );
}
function tabGeometry() {
  const nav = container.querySelector<HTMLElement>(".agent-session-tabs")!;
  vi.spyOn(nav, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left: 0,
        right: 400,
        top: 0,
        bottom: 40,
        width: 400,
        height: 40,
      }) as DOMRect,
  );
  for (const item of container.querySelectorAll<HTMLElement>(
    ".agent-session-tab-item",
  )) {
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
      const left =
        [...container.querySelectorAll(".agent-session-tab-item")].indexOf(
          item,
        ) * 100;
      return {
        left,
        right: left + 100,
        top: 0,
        bottom: 40,
        width: 100,
        height: 40,
      } as DOMRect;
    });
  }
}
function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y = 20,
  button = 0,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}
async function mouseClick(target: HTMLElement) {
  await act(async () => {
    pointer(target, "pointerdown", 50);
    target.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await act(async () => {
    pointer(target, "pointerup", 50);
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
}
async function dragProject(
  name: string,
  from: number,
  to: number,
  clickTarget?: HTMLElement,
) {
  await act(async () => pointer(button(name), "pointerdown", 20, from));
  await act(async () => pointer(document, "pointermove", 20, to));
  await act(async () => {
    pointer(document, "pointerup", 20, to);
    clickTarget?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
}
async function dragProjectGroup(name: string, from: number, to: number) {
  const target = button(`Replier le groupe · ${name}`);
  await act(async () => pointer(target, "pointerdown", 20, from));
  await act(async () => pointer(document, "pointermove", 20, to));
  await act(async () => {
    pointer(document, "pointerup", 20, to);
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
}
async function dragTab(
  name: string,
  from: number,
  to: number,
  clickTarget?: HTMLElement,
) {
  await act(async () => pointer(button(name), "pointerdown", from));
  await act(async () => pointer(document, "pointermove", to));
  await act(async () => {
    pointer(document, "pointerup", to);
    clickTarget?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
}

const tabOrderKey = "soreno.agents.tab-order.v1";
const projectOrderKey = "soreno.agents.project-order.v1";
const projectGroupsKey = "soreno.agents.project-groups.v1";
const collapsedProjectsKey = "soreno.agents.collapsed-projects.v1";
const tabNames = () =>
  [...container.querySelectorAll(".agent-session-name")].map(
    (item) => item.textContent,
  );
const projectRowSelector = ".agent-project";
const projectNames = () =>
  [
    ...container.querySelectorAll(`${projectRowSelector} .agent-project-name`),
  ].map((item) => item.textContent);
function sshStatusHost() {
  statusBarContainer = document.createElement("div");
  document.body.append(statusBarContainer);
  data.projects[0] = {
    ...project,
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "remote.example",
        user: "dev",
        port: 2222,
        identityFile: null,
        hostKey: null,
      },
    },
  };
  return statusBarContainer;
}
const servicesManifest = {
  version: 1,
  profiles: [
    { id: "main", label: "Principal", services: ["api"] },
    { id: "all", label: "Tous", services: ["api", "web"] },
  ],
  services: [
    {
      id: "api",
      label: "API",
      cwd: "/srv/api",
      executable: "npm",
      args: ["run", "api"],
      port: 3012,
    },
    {
      id: "web",
      label: "Web",
      cwd: "/srv/web",
      executable: "npm",
      args: ["run", "web"],
    },
  ],
};

function enableProjectServices(existingSession = true) {
  statusBarContainer = document.createElement("div");
  document.body.append(statusBarContainer);
  data.projects[0] = {
    ...project,
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "remote.example",
        user: "dev",
        port: 2222,
        identityFile: null,
        hostKey: null,
      },
    },
  };
  if (existingSession) {
    data.sessions.push({
      id: "service-api",
      projectId: "p1",
      name: "API",
      kind: "service",
      serviceId: "api",
      workingDirectory: "/srv/api",
      executable: "npm",
      args: ["run", "api"],
      createdAt: "2026-01-01T00:00:00Z",
    });
    data.statuses.push({
      sessionId: "service-api",
      state: "running",
      exitCode: null,
    });
  }
  vi.mocked(projectFilesApi.readProjectFile).mockResolvedValue({
    path: ".soreno/services.json",
    content: JSON.stringify(servicesManifest),
    version: "manifest-v1",
  });
  vi.mocked(api.listAgentServiceBranches).mockResolvedValue([
    { serviceId: "api", branch: "feature/api" },
    { serviceId: "web", branch: "main" },
  ]);
}
function servicesToggle() {
  const toggle = [...statusBarContainer.querySelectorAll("button")].find(
    (item) => item.textContent?.startsWith("Services "),
  );
  if (!toggle) throw new Error("Missing services toggle");
  return toggle;
}
async function toggleServices() {
  await vi.waitFor(servicesToggle);
  await act(async () => servicesToggle().click());
}

function setData(value: WorkspaceData) {
  data = value;
}
function setSidebarContainer(value: HTMLDivElement) {
  sidebarContainer = value;
}
function setGitPanelContainer(value: HTMLDivElement) {
  gitPanelContainer = value;
}
function notificationMessages() {
  return getNotifications().map((item) => item.message);
}
async function retryFromNotification() {
  const retry = getNotifications().find(
    (item) => item.action?.label === "Réessayer",
  );
  if (!retry) throw new Error("Missing retry notification");
  await act(async () => retry.action!.onAction());
}

function mobileStatus(patch: Partial<SshMobileStatus>): SshMobileStatus {
  return {
    platform: "Linux/x86_64",
    supported: true,
    installed: false,
    upToDate: false,
    active: false,
    legacy: false,
    connected: false,
    stateFresh: false,
    host: null,
    server: null,
    devices: [],
    pairings: [],
    pairingsUsed: [],
    ...patch,
  };
}

export {
  runtime,
  container,
  sidebarContainer,
  gitPanelContainer,
  statusBarContainer,
  root,
  data,
  guard,
  project,
  worktreeCacheKey,
  terminalSplitsKey,
  cacheWorktrees,
  session,
  setStatus,
  render,
  requestKanban,
  requestAutomations,
  requestDesign,
  requestSession,
  button,
  click,
  dialog,
  field,
  input,
  check,
  choose,
  context,
  action,
  escape,
  nextAnimationFrame,
  addProject,
  newAgent,
  splitAgent,
  detachSplit,
  projectGeometry,
  terminalGeometry,
  tabGeometry,
  pointer,
  mouseClick,
  dragProject,
  dragProjectGroup,
  dragTab,
  tabOrderKey,
  projectOrderKey,
  projectGroupsKey,
  collapsedProjectsKey,
  tabNames,
  projectNames,
  sshStatusHost,
  mobileStatus,
  servicesManifest,
  enableProjectServices,
  servicesToggle,
  toggleServices,
  setData,
  setSidebarContainer,
  setGitPanelContainer,
  notificationMessages,
  retryFromNotification,
};
export type { AgentProjectWorktreeGroup, WorkspaceData };
