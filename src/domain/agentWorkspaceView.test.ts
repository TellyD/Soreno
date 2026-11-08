import { expect, it } from "vitest";
import {
  agentEnvironmentKey,
  designProjectId,
  type AgentEnvironment,
  type AgentProject,
  type AgentProjectWorktreeGroup,
  type AgentSession,
  type AgentSessionStatus,
} from "./agentSessions";
import {
  agentLaunchProjects,
  agentServiceCatalog,
  agentsSpaceWorkspace,
  findWorktreeProject,
  issueWorktreeCandidates,
  projectIdsWithAgents,
  railWorktreeGroups,
  sshConnectionState,
  uniqueAgentSessionName,
  servicesScope,
  visibleAgentSessions,
} from "./agentWorkspaceView";

const local: AgentEnvironment = { kind: "local", distribution: null };
const wsl: AgentEnvironment = { kind: "wsl", distribution: "Ubuntu" };
const project = (
  id: string,
  environment = local,
  path = `/${id}`,
): AgentProject => ({ id, name: id, path, environment });
const session = (
  id: string,
  projectId: string,
  extra: Partial<AgentSession> = {},
): AgentSession => ({
  id,
  projectId,
  name: id,
  executable: "pi",
  args: [],
  createdAt: "",
  ...extra,
});
const status = (
  sessionId: string,
  state: AgentSessionStatus["state"],
  exitCode: number | null = null,
): AgentSessionStatus => ({ sessionId, state, exitCode });
const group = (
  repositoryProjectId: string,
  projectIds: string[],
  worktrees: AgentProjectWorktreeGroup["worktrees"] = [],
): AgentProjectWorktreeGroup => ({
  repositoryProjectId,
  projectIds,
  worktrees,
});

it("drops unknown worktree members and elects a surviving repository", () => {
  expect(
    railWorktreeGroups(
      [group("gone", ["gone", "b", "c"]), group("x", ["x"])],
      [project("b"), project("c")],
    ),
  ).toEqual([group("b", ["b", "c"])]);
});

it("counts agents of a worktree for its repository, not services or closed sessions", () => {
  const ids = projectIdsWithAgents(
    [
      session("agent", "worktree"),
      session("service", "services", { kind: "service", serviceId: "web" }),
      session("closed", "closed"),
    ],
    new Set(["closed"]),
    [group("repository", ["repository", "worktree"])],
  );

  expect([...ids].sort()).toEqual(["repository", "worktree"]);
});

it("launches agents in repositories and overviews, never in a worktree or a missing project", () => {
  const repository = group("repository", ["repository", "worktree"]);
  expect(
    agentLaunchProjects(
      [project("repository"), project("worktree"), project("missing")],
      ["missing"],
      new Map([
        ["repository", repository],
        ["worktree", repository],
      ]),
      [project("overview")],
    ).map(({ id }) => id),
  ).toEqual(["repository", "overview"]);
});

it("orders tabs per project with pins first and hides split children", () => {
  const sessions = [
    session("a1", "a"),
    session("a2", "a"),
    session("a3", "a"),
    session("b1", "b"),
    session("hidden", "b"),
    session("closed", "b"),
    session("svc", "b", { kind: "service", serviceId: "web" }),
  ];

  expect(
    visibleAgentSessions({
      projects: [project("b"), project("a")],
      sessions,
      tabOrder: { a: ["a3", "a1", "a2"] },
      pinnedIds: new Set(["a2"]),
      hiddenIds: new Set(["hidden"]),
      closedIds: new Set(["closed"]),
      terminalSplits: { a3: "a1" },
    }).map((value) => value.id),
  ).toEqual(["b1", "a2", "a3"]);
});

it("keeps Design boards' sessions and project out of the agents space", () => {
  const view = agentsSpaceWorkspace({
    projects: [project("a"), project(designProjectId)],
    sessions: [
      session("agent", "a"),
      session("board-in-project", "a", { design: true }),
      session("board", designProjectId, { design: true }),
    ],
    statuses: [status("board", "running")],
  });

  expect(view.projects.map(({ id }) => id)).toEqual(["a"]);
  expect(view.sessions.map(({ id }) => id)).toEqual(["agent"]);
  expect(view.statuses).toEqual([status("board", "running")]);
});

it("keeps orphan service sessions listed but not launchable", () => {
  const manifest = [
    { id: "web", label: "Web", cwd: "/app", executable: "npm", args: [] },
  ];
  const { services, launchableServiceIds } = agentServiceCatalog(
    manifest,
    [
      session("web-session", "p", { kind: "service", serviceId: "web" }),
      session("old", "p", {
        kind: "service",
        serviceId: "worker",
        executable: "node",
        args: ["worker.js"],
      }),
    ],
    "/project",
  );

  expect(services).toEqual([
    manifest[0],
    {
      id: "worker",
      label: "old",
      cwd: "/project",
      executable: "node",
      args: ["worker.js"],
    },
  ]);
  expect([...launchableServiceIds]).toEqual(["web"]);
});

it("scopes services to the selected project's group, a worktree joining after its repository", () => {
  const ssh: AgentEnvironment = {
    kind: "ssh",
    distribution: null,
    ssh: {
      host: "h",
      user: "u",
      port: 22,
      identityFile: null,
      hostKey: null,
    },
  };
  const projects = [
    project("api", ssh),
    project("api-wt", ssh),
    project("docs", ssh),
    project("notes"),
    project("overview", ssh),
    project("alone", ssh),
  ];
  const byId = (id: string) => projects.find((item) => item.id === id);
  const groups = [
    {
      id: "g",
      name: "G",
      projectIds: ["api", "docs", "notes"],
      groupProjectId: "overview",
    },
  ];
  const worktrees = [group("api", ["api", "api-wt"])];
  const scope = (id: string) => {
    const result = servicesScope(byId(id), groups, worktrees, projects);
    return result && [result.key, result.projects.map(({ id }) => id)];
  };

  expect(scope("docs")).toEqual(["group:g", ["api", "docs"]]);
  expect(scope("api-wt")).toEqual(["group:g", ["api", "api-wt", "docs"]]);
  expect(scope("overview")).toEqual(["group:g", ["api", "docs"]]);
  expect(scope("alone")).toEqual(["alone", ["alone"]]);
  expect(servicesScope(undefined, groups, worktrees, projects)).toBeNull();
});

it.each([
  ["offline", { disconnected: true }],
  ["starting", { startingSessionId: "a" }],
  ["dormant", { dormant: true }],
  ["starting", { dormant: true, startingSessionId: "a" }],
  ["offline", { disconnected: true, dormant: true }],
  ["unknown", { statusesUnreadable: true }],
  ["unknown", { statuses: [status("a", "idle")] }],
  ["active", { failedSessionId: "b" }],
  ["error", { statuses: [status("a", "idle"), status("b", "exited", 1)] }],
  [
    "error",
    {
      failedSessionId: "a",
      statuses: [status("a", "idle"), status("b", "idle")],
    },
  ],
  ["idle", { statuses: [status("a", "exited", 0), status("b", "idle")] }],
] as const)("classifies the SSH connection as %s", (expected, input) => {
  const statuses: readonly AgentSessionStatus[] =
    "statuses" in input
      ? input.statuses
      : [status("a", "running"), status("b", "idle")];
  const { state } = sshConnectionState({
    disconnected: false,
    dormant: false,
    startingSessionId: null,
    failedSessionId: null,
    statusesUnreadable: false,
    ...input,
    sessions: [session("a", "p"), session("b", "p")],
    statusOf: (id) => statuses.find((value) => value.sessionId === id),
  });

  expect(state).toBe(expected);
});

it("numbers session names within the project only", () => {
  const sessions = [
    session("1", "p", { name: "Codex" }),
    session("2", "p", { name: "Codex 2" }),
    session("3", "other", { name: "Codex 3" }),
  ];

  expect(uniqueAgentSessionName(sessions, "p", "Codex")).toBe("Codex 3");
  expect(uniqueAgentSessionName(sessions, "other", "Codex")).toBe("Codex");
});

it("prefers the project associated with a worktree on the same machine", () => {
  const worktrees = group(
    "repo",
    ["repo", "linked", "linux"],
    [{ path: "/wt", head: "h", branch: "b", projectIds: ["linux", "linked"] }],
  );
  const projects = [
    project("path-match", local, "/wt"),
    project("linux", wsl, "/wt"),
    project("linked", local, "/elsewhere"),
  ];

  const find = (
    environment: AgentEnvironment,
    worktreeGroup: AgentProjectWorktreeGroup | undefined,
  ) =>
    findWorktreeProject(
      projects,
      worktreeGroup,
      "/wt",
      agentEnvironmentKey(environment),
    )?.id;

  expect(find(local, worktrees)).toBe("linked");
  expect(find(wsl, worktrees)).toBe("linux");
  expect(find(local, undefined)).toBe("path-match");
});

it("ranks issue worktree candidates by cached branch before worktree metadata", () => {
  const source = project("repo");
  const worktrees = group(
    "repo",
    ["repo", "cached-other", "meta", "remote"],
    [
      { path: "/meta", head: "h", branch: "fix", projectIds: ["meta"] },
      {
        path: "/cached",
        head: "h",
        branch: "fix",
        projectIds: ["cached-other"],
      },
    ],
  );
  const projects = [
    source,
    project("cached-other"),
    project("meta"),
    project("remote", wsl),
    project("stranger"),
  ];

  expect(
    issueWorktreeCandidates(
      projects,
      source,
      worktrees,
      { repo: "main", "cached-other": "main" },
      "fix",
    ).map((value) => value.id),
  ).toEqual(["meta", "repo", "cached-other"]);
});
