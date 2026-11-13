// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import {
  container,
  data,
  project,
  render,
  requestAutomations,
  requestKanban,
  runtime,
  setGitPanelContainer,
  button,
  click,
  tabNames,
  type AgentProjectWorktreeGroup,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as gitApi from "../../data/projectGitApi";
import type {
  AgentProject,
  AgentSession,
  AgentSessionKanbanIssue,
} from "../../domain/agentSessions";
import type { KanbanIssueSelection } from "../../domain/kanban";
import {
  kanbanIssueLaunch,
  type KanbanIssueAgentRequest,
} from "../../domain/kanbanAgent";
import { getNotifications } from "../../notifications";

type ControllerProps = {
  enabled: boolean;
  visible: boolean;
  projects: readonly AgentProject[];
  kanbanProjects: readonly AgentProject[];
  issueSessions: readonly AgentSessionKanbanIssue[];
  sessions: readonly AgentSession[];
  closedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onIssueDeleted?: (issueId: string) => void;
  onStartIssueAgent: (request: KanbanIssueAgentRequest) => Promise<void>;
};
// `props` are the Kanban controller's, set once it is enabled.
const board = vi.hoisted(() => ({
  props: null as ControllerProps | null,
  issueRequest: undefined as { issue: KanbanIssueSelection } | undefined,
  onAutomationDeleted: null as ((sessionId: string) => void) | null,
}));
vi.mock("../automations/AutomationsBoard", () => ({
  AutomationsBoard: (props: {
    onAutomationDeleted: (sessionId: string) => void;
  }) => {
    board.onAutomationDeleted = props.onAutomationDeleted;
    return null;
  },
}));
vi.mock("../kanban/KanbanBoard", () => ({
  KanbanBoard: (props: { issueRequest?: { issue: KanbanIssueSelection } }) => {
    board.issueRequest = props.issueRequest;
    return <div data-testid="kanban-board" />;
  },
}));
vi.mock("../../hooks/useKanbanController", () => ({
  KanbanControllerProvider: ({
    children,
    ...props
  }: ControllerProps & { children: ReactNode }) => {
    if (props.enabled) board.props = props;
    return children;
  },
  useKanbanControllerContext: () => null,
}));

const issue = {
  id: "issue-1",
  identifier: "TEL-1",
  title: "Fix login",
  description: "Steps to reproduce",
  branchName: "tel-1-fix-login",
  source: "local" as const,
};
const request = (
  overrides: Partial<KanbanIssueAgentRequest> = {},
): KanbanIssueAgentRequest => ({
  issue,
  projectId: "p1",
  executable: "claude",
  presetName: "Claude Code",
  worktree: false,
  open: true,
  ...overrides,
});
const kanbanPane = () => container.querySelector<HTMLElement>(".agent-kanban")!;
const savedSession = () => vi.mocked(api.saveAgentSession).mock.calls[0][0];

async function renderBoard() {
  localStorage.setItem("soreno.agents.kanban.v1", "true");
  board.props = null;
  await render();
  expect(board.props).not.toBeNull();
}
async function startIssueAgent(value = request()) {
  await act(() => board.props!.onStartIssueAgent(value));
}
async function startIssueAgentFailure(value = request()) {
  let failure: unknown;
  await act(async () => {
    failure = await board
      .props!.onStartIssueAgent(value)
      .catch((reason: unknown) => reason);
  });
  return failure;
}

it("hands a requested issue to the board once the Kanban navigation succeeds", async () => {
  board.issueRequest = undefined;
  const gitPanel = document.createElement("div");
  setGitPanelContainer(gitPanel);
  document.body.append(gitPanel);
  await render(false, null, gitPanel);
  const first = {
    id: "issue-1",
    identifier: "TEL-1",
    source: "local" as const,
  };
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await requestKanban(true, first);
  expect(board.issueRequest).toBeUndefined();

  await requestKanban(true, first);
  expect(board.issueRequest).toEqual({ issue: first });

  const second = {
    id: "issue-2",
    identifier: "TEL-2",
    source: "linear" as const,
  };
  await requestKanban(true, second);
  expect(board.issueRequest).toEqual({ issue: second });
});

it("shows the active agent session's issue, or a way to link one, in place of Git", async () => {
  board.props = null;
  data.kanbanIssueSessions = [
    {
      source: "local",
      issueId: "issue-1",
      issueIdentifier: "TEL-1",
      issueTitle: "Fix login",
      sessionId: "s2",
      sessionName: "Codex tests",
      executable: "codex",
      projectName: "Soreno",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      mergedInto: null,
    },
  ];
  data.sessions.push({
    ...data.sessions[0],
    id: "s3",
    name: "Shell",
    executable: "",
  });
  data.sessions.push({
    ...data.sessions[0],
    id: "s4",
    name: "OMP chat",
    executable: "omp-conversation",
    kind: "conversation",
  });
  const gitPanel = document.createElement("div");
  setGitPanelContainer(gitPanel);
  document.body.append(gitPanel);
  await render(false, null, gitPanel);
  const changes = () => button("Outils du projet");
  const issueButton = () => button("Issue TEL-1");
  const gitShown = () =>
    !gitPanel.querySelector<HTMLElement>(".agent-git-panel")!.hidden;
  const linkButton = () => button("Lier une issue");
  expect(() => issueButton()).toThrow();

  await click("TEL-1 · Fix login");
  expect(issueButton().getAttribute("aria-pressed")).toBe("false");
  expect(board.props).toBeNull();

  await click("Issue TEL-1");
  expect(issueButton().getAttribute("aria-pressed")).toBe("true");
  expect(changes().getAttribute("aria-pressed")).toBe("false");
  expect(gitShown()).toBe(false);
  expect(board.props).toMatchObject({ enabled: true, visible: true });

  // The choice belongs to the session: another one keeps showing Git.
  await click("Pi notes");
  expect(() => issueButton()).toThrow();
  expect(linkButton().getAttribute("aria-pressed")).toBe("false");
  expect(gitShown()).toBe(true);
  expect(board.props!.visible).toBe(false);

  await click("Shell");
  expect(() => linkButton()).toThrow();
  expect(changes().getAttribute("aria-pressed")).toBe("true");
  expect(gitShown()).toBe(true);

  await click("OMP chat");
  await click("Lier une issue");
  expect(linkButton().getAttribute("aria-pressed")).toBe("true");
  expect(gitShown()).toBe(false);

  await click("TEL-1 · Fix login");
  expect(issueButton().getAttribute("aria-pressed")).toBe("true");
  await click("Outils du projet");
  expect(issueButton().getAttribute("aria-pressed")).toBe("false");
  expect(changes().getAttribute("aria-pressed")).toBe("true");
  expect(gitShown()).toBe(true);
  await click("OMP chat");
  expect(linkButton().getAttribute("aria-pressed")).toBe("true");
  await click("TEL-1 · Fix login");
  expect(issueButton().getAttribute("aria-pressed")).toBe("false");
  expect(gitShown()).toBe(true);

  // Ctrl+Alt+K toggles it too, but an AltGr character on that key does not.
  const press = (key: string) =>
    act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: "KeyK",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await press("ĸ");
  expect(issueButton().getAttribute("aria-pressed")).toBe("false");
  await press("k");
  expect(issueButton().getAttribute("aria-pressed")).toBe("true");
  expect(gitShown()).toBe(false);
  await press("k");
  expect(issueButton().getAttribute("aria-pressed")).toBe("false");
  expect(gitShown()).toBe(true);

  // Opening it from a Git control moves the focus off the hidden Git view.
  const gitControl = gitPanel.querySelector<HTMLElement>(
    ".agent-git-panel button",
  )!;
  gitControl.focus();
  expect(document.activeElement).toBe(gitControl);
  await press("k");
  expect(gitShown()).toBe(false);
  expect(document.activeElement).toBe(issueButton());
  await press("k");
  expect(document.activeElement).toBe(issueButton());
  // Focus outside the panel, like a terminal, stays put.
  issueButton().blur();
  await press("k");
  expect(issueButton().getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(document.body);
});

it("closes the tools with the issue only if they were closed for it since they last closed", async () => {
  data.kanbanIssueSessions = [
    {
      source: "local",
      issueId: "issue-1",
      issueIdentifier: "TEL-1",
      issueTitle: "Fix login",
      sessionId: "s2",
      sessionName: "Codex tests",
      executable: "codex",
      projectName: "Soreno",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      mergedInto: null,
    },
  ];
  const gitPanel = document.createElement("div");
  setGitPanelContainer(gitPanel);
  document.body.append(gitPanel);
  const issuePressed = () =>
    button("Issue TEL-1").getAttribute("aria-pressed") === "true";
  // Like App: the requested visibility lands in the same commit.
  const onVisibleChange = vi.fn((visible: boolean) => void show(visible));
  const show = (visible: boolean) =>
    render(false, null, gitPanel, visible, onVisibleChange);
  await show(false);
  await click("TEL-1 · Fix login");
  await click("Issue TEL-1");
  expect(issuePressed()).toBe(true);
  // Closed by the shortcut, then Git reopened before the issue.
  await show(false);
  await show(true);
  await click("Issue TEL-1");
  expect(issuePressed()).toBe(true);
  await click("Issue TEL-1");
  expect(issuePressed()).toBe(false);
  expect(onVisibleChange).not.toHaveBeenCalledWith(false);

  await show(false);
  await click("Issue TEL-1");
  expect(issuePressed()).toBe(true);
  await click("Issue TEL-1");
  expect(onVisibleChange).toHaveBeenLastCalledWith(false);

  // Closing another session's issue leaves the tools open for its Git.
  await click("Issue TEL-1");
  expect(issuePressed()).toBe(true);
  await click("Pi notes");
  await click("Lier une issue");
  onVisibleChange.mockClear();
  await click("Lier une issue");
  expect(onVisibleChange).not.toHaveBeenCalledWith(false);
  expect(gitPanel.querySelector<HTMLElement>(".agent-git-panel")!.hidden).toBe(
    false,
  );
  await click("TEL-1 · Fix login");
  expect(issuePressed()).toBe(true);
});

it("starts a linked agent on the chosen project with the issue prompt, then opens it", async () => {
  await renderBoard();
  await startIssueAgent();

  const saved = savedSession();
  expect(saved).toEqual(
    expect.objectContaining({
      projectId: "p1",
      name: "TEL-1 · Claude Code",
      executable: "claude",
      args: [],
    }),
  );
  expect(api.linkAgentSessionKanbanIssue).toHaveBeenCalledWith(saved.id, {
    source: "local",
    id: "issue-1",
    identifier: "TEL-1",
    title: "Fix login",
  });
  expect(api.startAgentSession).toHaveBeenCalledWith(
    saved.id,
    undefined,
    undefined,
    kanbanIssueLaunch(issue).prompt,
    kanbanIssueLaunch(issue).imageNames,
    kanbanIssueLaunch(issue).issueFile,
    kanbanIssueLaunch(issue).imageUrls,
    kanbanIssueLaunch(issue).imageTargets,
  );
  const order = [
    api.saveAgentSession,
    api.linkAgentSessionKanbanIssue,
    api.startAgentSession,
  ].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(gitApi.createGitWorktree).not.toHaveBeenCalled();
  expect(board.props!.issueSessions).toEqual([
    expect.objectContaining({
      sessionId: saved.id,
      issueId: "issue-1",
      issueIdentifier: "TEL-1",
    }),
  ]);
  expect(kanbanPane().hidden).toBe(true);
  // The tab names the linked issue rather than the launcher.
  expect(button("TEL-1 · Fix login").getAttribute("aria-current")).toBe("page");
});

it("starts and links a background agent on a Linear issue without leaving the Kanban", async () => {
  await renderBoard();
  await startIssueAgent(
    request({ open: false, issue: { ...issue, source: "linear" } }),
  );

  const saved = savedSession();
  expect(api.linkAgentSessionKanbanIssue).toHaveBeenCalledWith(saved.id, {
    source: "linear",
    id: "issue-1",
    identifier: "TEL-1",
    title: "Fix login",
  });
  expect(board.props!.issueSessions).toEqual([
    expect.objectContaining({ sessionId: saved.id }),
  ]);
  expect(kanbanPane().hidden).toBe(false);
  expect(button("TEL-1 · Fix login").hasAttribute("aria-current")).toBe(false);
  expect(
    container.querySelector<HTMLElement>(`[data-terminal="${saved.id}"]`)
      ?.hidden,
  ).toBe(true);
});

it("creates a new branch worktree from HEAD when the issue branch does not exist", async () => {
  await renderBoard();
  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({
      name: "Soreno · tel-1-fix-login",
      parentPath: "/projects",
      folderName: "soreno-tel-1-fix-login",
      branch: "tel-1-fix-login",
      remote: false,
      createBranch: true,
      version: "v1",
    }),
  );
  const created = vi.mocked(gitApi.createGitWorktree).mock.calls[0][1];
  expect(savedSession().projectId).toBe(created.id);
});

const worktreeProject = {
  ...project,
  id: "p2",
  name: "Soreno · tel-1",
  path: "/projects/soreno-tel-1",
};
async function renderIssueWorktree(confirmedBranch: string) {
  data.projects.push(worktreeProject);
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: worktreeProject.path,
          head: "b".repeat(40),
          branch: issue.branchName,
          projectIds: ["p2"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "p1", branch: "main" },
    { projectId: "p2", branch: confirmedBranch },
  ]);
  await renderBoard();
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll(".agent-worktree-name")].map(
        (name) => name.textContent,
      ),
    ).toContain(confirmedBranch),
  );
}
function mockCurrentBranches(current: Record<string, string>) {
  const read = vi.mocked(gitApi.readGitRepository);
  const repository = read.getMockImplementation()!;
  read.mockClear().mockImplementation(async (projectId) => ({
    ...(await repository(projectId)),
    branch: current[projectId] ?? "main",
  }));
}

it("refuses to start an issue agent in a project whose folder disappeared", async () => {
  data.projects.push(worktreeProject);
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [],
    complete: true,
    missingProjectIds: ["p2"],
  });
  await renderBoard();
  await vi.waitFor(() =>
    expect(board.props!.projects.map(({ id }) => id)).toEqual(["p1"]),
  );

  expect(
    await startIssueAgentFailure(request({ projectId: "p2" })),
  ).toMatchObject({
    message: "Ce projet ne peut pas démarrer d’agent sur une issue.",
  });
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(api.linkAgentSessionKanbanIssue).not.toHaveBeenCalled();
});

it("offers a prepared group overview as an issue project and starts its agent there", async () => {
  data.projects.push({ ...project, id: "group-g1", name: "Suite" });
  data.groups = [
    {
      id: "g1",
      name: "Suite",
      projectIds: ["p1"],
      groupProjectId: "group-g1",
      color: "blue",
    },
  ];
  await renderBoard();

  expect(board.props!.kanbanProjects).toEqual([
    expect.objectContaining({ id: "p1" }),
    expect.objectContaining({ id: "group-g1", color: "blue" }),
  ]);
  await startIssueAgent(request({ projectId: "group-g1", worktree: true }));
  expect(gitApi.createGitWorktree).not.toHaveBeenCalled();
  expect(savedSession().projectId).toBe("group-g1");
});

it("reuses the Soreno worktree project already on the issue branch", async () => {
  await renderIssueWorktree(issue.branchName);
  // Issues belong to the repository project, not to its worktree members.
  expect(board.props!.kanbanProjects.map(({ id }) => id)).toEqual(["p1"]);
  mockCurrentBranches({ p2: issue.branchName });

  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).not.toHaveBeenCalled();
  expect(savedSession().projectId).toBe("p2");
});

it("creates a worktree when the confirmed branch left the issue branch before the snapshot refreshed", async () => {
  await renderIssueWorktree("other");

  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ branch: issue.branchName }),
  );
  expect(savedSession().projectId).not.toBe("p2");
});

it("reuses a Soreno worktree project that switched onto the issue branch since the last poll", async () => {
  await renderIssueWorktree("other");
  mockCurrentBranches({ p2: issue.branchName });

  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).not.toHaveBeenCalled();
  expect(savedSession().projectId).toBe("p2");
});

it("creates a worktree when the reused project switched branch since the last poll", async () => {
  await renderIssueWorktree(issue.branchName);
  mockCurrentBranches({ p2: "other" });

  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ branch: issue.branchName }),
  );
  expect(savedSession().projectId).not.toBe("p2");
});

it("creates a worktree when the reused project's current branch cannot be read", async () => {
  await renderIssueWorktree(issue.branchName);
  mockCurrentBranches({ p2: issue.branchName });
  vi.mocked(gitApi.readGitRepository).mockRejectedValueOnce(
    new Error("offline"),
  );

  await startIssueAgent(request({ worktree: true }));

  expect(gitApi.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ branch: issue.branchName }),
  );
  expect(savedSession().projectId).not.toBe("p2");
});

it("reuses the issue worktree of a dormant SSH project once connecting reveals it", async () => {
  const environment = {
    kind: "ssh" as const,
    distribution: null,
    ssh: {
      host: "remote.example",
      user: "dev",
      port: 2222,
      identityFile: null,
      hostKey: null,
    },
  };
  data.projects = [
    { ...project, environment },
    { ...worktreeProject, environment },
  ];
  data.disconnectedProjectIds = ["p1", "p2"];
  data.dormantProjectIds = ["p1", "p2"];
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: worktreeProject.path,
          head: "b".repeat(40),
          branch: issue.branchName,
          projectIds: ["p2"],
        },
      ],
    },
  ];
  // Topology discovery skips dormant projects.
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => ({
    groups: data.dormantProjectIds?.includes("p1") ? [] : groups,
    complete: true,
    missingProjectIds: [],
  }));
  await renderBoard();
  mockCurrentBranches({ p2: issue.branchName });

  await startIssueAgent(request({ worktree: true }));

  expect(api.setAgentProjectConnected).toHaveBeenCalledWith("p1", true);
  expect(gitApi.createGitWorktree).not.toHaveBeenCalled();
  expect(savedSession().projectId).toBe("p2");
});

it("rejects when the workspace cannot reload after the agent started", async () => {
  await renderBoard();
  vi.mocked(api.startAgentSession).mockImplementationOnce(async () => {
    vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(new Error("boom"));
  });

  expect(await startIssueAgentFailure()).toMatchObject({
    message: "Chargement des projets agents impossible.",
  });

  expect(api.linkAgentSessionKanbanIssue).toHaveBeenCalledWith(
    savedSession().id,
    { source: "local", id: "issue-1", identifier: "TEL-1", title: "Fix login" },
  );
  expect(kanbanPane().hidden).toBe(false);
});

it("rejects with a localized error and keeps the linked session when starting fails", async () => {
  await renderBoard();
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(new Error("boom"));

  expect(await startIssueAgentFailure()).toMatchObject({
    message: "L’opération a échoué. Réessayez.",
  });

  const saved = savedSession();
  expect(board.props!.sessions.map((session) => session.id)).toContain(
    saved.id,
  );
  expect(board.props!.issueSessions).toEqual([
    expect.objectContaining({ sessionId: saved.id, issueId: "issue-1" }),
  ]);
  expect(kanbanPane().hidden).toBe(false);
  expect(getNotifications()).toEqual([]);
});

it("passes a coded Kanban error through for the board to translate", async () => {
  await renderBoard();
  const error =
    "[Kanban/issueHasSession] Cette issue a déjà une session d’agent.";
  vi.mocked(api.linkAgentSessionKanbanIssue).mockRejectedValueOnce(error);

  expect(await startIssueAgentFailure()).toBe(error);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("rejects Git failures before saving anything", async () => {
  await renderBoard();
  vi.mocked(gitApi.createGitWorktree).mockRejectedValueOnce({
    code: "stale",
    message: "raw git output",
  });

  expect(
    await startIssueAgentFailure(request({ worktree: true })),
  ).toMatchObject({
    message:
      "Le dépôt a changé. Actualisez-le, vérifiez son état actuel, puis confirmez à nouveau.",
  });
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(api.linkAgentSessionKanbanIssue).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("keeps a closed issue session linked, then reopens and relaunches it from the issue", async () => {
  await renderBoard();
  await startIssueAgent();
  const saved = savedSession();

  await click("Fermer l’onglet · TEL-1 · Fix login");

  expect(api.stopAgentSession).toHaveBeenCalledWith(saved.id);
  expect(api.setAgentSessionClosed).toHaveBeenCalledWith(saved.id, true);
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(tabNames()).not.toContain("TEL-1 · Fix login");
  expect(board.props!.sessions.map((session) => session.id)).toContain(
    saved.id,
  );
  expect(board.props!.closedSessionIds).toEqual(new Set([saved.id]));

  vi.mocked(api.startAgentSession).mockClear();
  await act(async () => board.props!.onOpenSession(saved.id));

  expect(api.setAgentSessionClosed).toHaveBeenLastCalledWith(saved.id, false);
  expect(api.startAgentSession).toHaveBeenCalledWith(saved.id);
  expect(kanbanPane().hidden).toBe(true);
  expect(button("TEL-1 · Fix login").getAttribute("aria-current")).toBe("page");
});

it("does not reopen a closed issue session while its project is disconnected", async () => {
  await renderBoard();
  await startIssueAgent();
  const saved = savedSession();
  data.disconnectedProjectIds = ["p1"];
  await click("Fermer l’onglet · TEL-1 · Fix login");

  vi.mocked(api.startAgentSession).mockClear();
  vi.mocked(api.setAgentSessionClosed).mockClear();
  await act(async () => board.props!.onOpenSession(saved.id));

  expect(api.setAgentSessionClosed).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(tabNames()).not.toContain("TEL-1 · Fix login");
  expect(board.props!.closedSessionIds).toEqual(new Set([saved.id]));
});

async function deleteIssue() {
  data.kanbanIssueSessions = [];
  await act(async () => board.props!.onIssueDeleted!("issue-1"));
}

it("shows a closed issue session again once its issue is deleted", async () => {
  await renderBoard();
  await startIssueAgent();
  await click("Fermer l’onglet · TEL-1 · Fix login");
  expect(tabNames()).not.toContain("TEL-1 · Fix login");

  await deleteIssue();

  // Without its issue, the tab falls back to its launcher name.
  expect(tabNames()).toContain("TEL-1 · Claude Code");
  expect(board.props!.issueSessions).toEqual([]);
});

it("deletes the session of a deleted issue when its tab closes", async () => {
  await renderBoard();
  await startIssueAgent();
  const saved = savedSession();

  await deleteIssue();
  await click("Fermer l’onglet · TEL-1 · Claude Code");

  expect(api.setAgentSessionClosed).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).toHaveBeenCalledWith(saved.id);
  expect(tabNames()).not.toContain("TEL-1 · Claude Code");
});

it("keeps an automation's session closed until the automation is deleted", async () => {
  data.automationSessionIds = ["s2"];
  await render();
  await click("Fermer l’onglet · Codex tests");

  expect(api.setAgentSessionClosed).toHaveBeenCalledExactlyOnceWith("s2", true);
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(tabNames()).toEqual(["Pi notes"]);

  await requestAutomations();
  data.automationSessionIds = [];
  data.closedSessionIds = [];
  await act(async () => board.onAutomationDeleted!("s2"));

  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
});
