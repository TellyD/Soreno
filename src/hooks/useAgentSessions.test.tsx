// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import * as api from "../data/agentSessionsApi";
import type {
  AgentProjectWorktreeGroup,
  AgentSession,
  AgentSessionStatus,
  AgentWorkspace,
} from "../domain/agentSessions";
import type { ProjectService } from "../domain/projectServices";
import { readBranchCache, writeBranchCache } from "./agentWorktreeTopology";
import { AgentServiceError, useAgentSessions } from "./useAgentSessions";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../data/agentSessionsApi", () => ({
  loadAgentWorkspace: vi.fn(),
  listAgentStatuses: vi.fn(),
  listAgentBranches: vi.fn(),
  listAgentWorktrees: vi.fn(),
  deleteAgentProject: vi.fn(),
  saveAgentSession: vi.fn(),
  startAgentSession: vi.fn(),
  stopAgentSession: vi.fn(),
  updateAgentProjectAppearance: vi.fn(),
}));

const service = (id: string): ProjectService => ({
  id,
  label: id.toUpperCase(),
  cwd: `/srv/${id}`,
  executable: "npm",
  args: ["run", id],
});
const session = (id: string, serviceId: string): AgentSession => ({
  id,
  projectId: "project",
  name: serviceId,
  kind: "service",
  serviceId,
  workingDirectory: `/old/${serviceId}`,
  executable: "old",
  args: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});
const status = (
  sessionId: string,
  state: AgentSessionStatus["state"],
): AgentSessionStatus => ({ sessionId, state, exitCode: null });

let root: Root;
let host: HTMLDivElement;
let data: AgentWorkspace;
let hook: ReturnType<typeof useAgentSessions>;

function Harness({
  pollProjectTopology = true,
}: {
  pollProjectTopology?: boolean;
}) {
  hook = useAgentSessions(pollProjectTopology);
  return null;
}

async function renderHook(pollProjectTopology = true) {
  await act(async () =>
    root.render(<Harness pollProjectTopology={pollProjectTopology} />),
  );
  await act(async () =>
    vi.waitFor(() => expect(hook.hasLoaded).toBe(true), { timeout: 500 }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  data = {
    projects: [],
    sessions: [],
    statuses: [],
  };
  vi.mocked(api.loadAgentWorkspace).mockImplementation(async () =>
    structuredClone(data),
  );
  vi.mocked(api.listAgentStatuses).mockImplementation(async () =>
    structuredClone(data.statuses),
  );
  vi.mocked(api.listAgentBranches).mockResolvedValue([]);
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [],
    complete: true,
    missingProjectIds: [],
  });
  vi.mocked(api.saveAgentSession).mockImplementation(async (saved) => {
    data.sessions = [
      ...data.sessions.filter((item) => item.id !== saved.id),
      structuredClone(saved),
    ];
    if (!data.statuses.some((item) => item.sessionId === saved.id))
      data.statuses.push(status(saved.id, "idle"));
  });
  vi.mocked(api.startAgentSession).mockImplementation(async (id) => {
    data.statuses = data.statuses.map((item) =>
      item.sessionId === id ? { ...item, state: "running" } : item,
    );
  });
  vi.mocked(api.stopAgentSession).mockImplementation(async (id) => {
    data.statuses = data.statuses.map((item) =>
      item.sessionId === id ? { ...item, state: "exited" } : item,
    );
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("pauses branch and worktree polling while keeping status polling active, then resumes it", async () => {
  vi.useFakeTimers();
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  await renderHook(false);

  expect(api.listAgentBranches).not.toHaveBeenCalled();
  expect(api.listAgentWorktrees).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.listAgentStatuses).toHaveBeenCalledTimes(1);
  expect(api.listAgentBranches).not.toHaveBeenCalled();
  expect(api.listAgentWorktrees).not.toHaveBeenCalled();

  await act(async () => root.render(<Harness pollProjectTopology />));
  expect(api.listAgentBranches).toHaveBeenCalledTimes(1);
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);
});

it("publishes a confirmed branch before the full topology refresh finishes", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "project", branch: "main" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.project).toBe("main")),
  );
  vi.mocked(api.listAgentBranches).mockImplementation(
    () => new Promise(() => {}),
  );

  act(() => hook.refreshBranches("project", "feature"));

  expect(hook.branches.project).toBe("feature");
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentBranches).toHaveBeenCalledTimes(2)),
  );
});

it("adopts a branch read by a Git panel without re-polling when it is already shown", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "project", branch: "main" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.project).toBe("main")),
  );

  act(() => hook.observeBranch("project", "main", Date.now()));
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);

  vi.mocked(api.listAgentBranches).mockImplementation(
    () => new Promise(() => {}),
  );
  act(() => hook.observeBranch("project", "feature", Date.now()));

  expect(hook.branches.project).toBe("feature");
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2)),
  );
});

it("ignores a Git panel read that started before the shown branch was polled", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  const panelReadStartedAt = Date.now() - 1000;
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "project", branch: "feature" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.project).toBe("feature")),
  );

  act(() => hook.observeBranch("project", "main", panelReadStartedAt));

  expect(hook.branches.project).toBe("feature");
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);
});

it("keeps a cached dormant branch and settles an unknown one on the backend null", async () => {
  const remote = (id: string): AgentWorkspace["projects"][number] => ({
    id,
    name: id,
    path: `/srv/${id}`,
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "remote.example",
        user: null,
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  });
  data.projects.push(remote("cached"), remote("unknown"));
  data.disconnectedProjectIds = ["cached", "unknown"];
  data.dormantProjectIds = ["cached", "unknown"];
  writeBranchCache(data.projects, { cached: "main" });
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "cached", branch: null },
    { projectId: "unknown", branch: null },
  ]);
  await renderHook();

  await act(async () =>
    vi.waitFor(() => expect(hook.branches).toHaveProperty("unknown", null)),
  );
  expect(hook.branches.cached).toBe("main");
  expect(readBranchCache().cached?.branch).toBe("main");
});

it("keeps the last known worktree grouping of SSH projects relaunched dormant", async () => {
  data.projects = ["main", "feature"].map((id) => ({
    id,
    name: id,
    path: `/srv/${id}`,
    environment: {
      kind: "ssh" as const,
      distribution: null,
      ssh: {
        host: "remote.example",
        user: null,
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  }));
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "main",
      projectIds: ["main", "feature"],
      worktrees: ["main", "feature"].map((id) => ({
        path: `/srv/${id}`,
        head: "a".repeat(40),
        branch: id,
        projectIds: [id],
      })),
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual(groups)),
  );
  await act(async () => root.unmount());

  // Unreachable projects are absent from the backend snapshot.
  data.disconnectedProjectIds = ["main", "feature"];
  data.dormantProjectIds = ["main", "feature"];
  vi.mocked(api.listAgentWorktrees).mockClear().mockResolvedValue({
    groups: [],
    complete: true,
    missingProjectIds: [],
  });
  root = createRoot(host);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktreesComplete).toBe(true)),
  );

  expect(api.listAgentWorktrees).toHaveBeenCalledOnce();
  expect(hook.worktrees).toEqual(groups);
  expect(hook.worktreesLoaded).toBe(true);
});

it("keeps a same-branch Git panel read over an older in-flight branch poll", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  vi.mocked(api.listAgentBranches).mockResolvedValueOnce([
    { projectId: "project", branch: "main" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.project).toBe("main")),
  );
  await act(async () => root.unmount());

  let resolveOldPoll!: (
    entries: Awaited<ReturnType<typeof api.listAgentBranches>>,
  ) => void;
  vi.mocked(api.listAgentBranches)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldPoll = resolve;
        }),
    )
    .mockImplementation(() => new Promise(() => {}));
  root = createRoot(host);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentBranches).toHaveBeenCalledTimes(2)),
  );
  expect(hook.branches.project).toBe("main");
  const worktreeReads = vi.mocked(api.listAgentWorktrees).mock.calls.length;

  act(() => hook.observeBranch("project", "main", Date.now() + 1000));
  await act(async () => {
    resolveOldPoll([{ projectId: "project", branch: "feature" }]);
    await Promise.resolve();
  });

  expect(hook.branches.project).toBe("main");
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(worktreeReads);
  await act(async () => root.unmount());
  root = createRoot(host);
  await renderHook();
  expect(hook.branches.project).toBe("main");
});

it("keeps the newest of two Git panel reads observed before a render", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  vi.mocked(api.listAgentBranches)
    .mockResolvedValueOnce([{ projectId: "project", branch: "main" }])
    .mockImplementation(() => new Promise(() => {}));
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.project).toBe("main")),
  );

  const startedAt = Date.now();
  act(() => {
    hook.observeBranch("project", "feature", startedAt + 1000);
    hook.observeBranch("project", "main", startedAt + 2000);
  });

  expect(hook.branches.project).toBe("main");
  await act(async () => root.unmount());
  root = createRoot(host);
  await renderHook();
  expect(hook.branches.project).toBe("main");
});

it("rejects a Git panel read for one alias that predates another alias's branch", async () => {
  data.projects = ["p1", "p2"].map((id) => ({
    id,
    name: id,
    path: `/tmp/${id}`,
    environment: { kind: "local" as const, distribution: null },
  }));
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: "/tmp/shared",
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1", "p2"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentBranches)
    .mockResolvedValueOnce([{ projectId: "p1", branch: "main" }])
    .mockImplementation(() => new Promise(() => {}));
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual(groups)),
  );
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.p1).toBe("main")),
  );

  act(() => hook.observeBranch("p2", "feature", Date.now() - 1000));

  expect(hook.branches).toEqual({ p1: "main" });
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);
});

it("coalesces agent turn endings during a topology read into one immediate follow-up poll", async () => {
  vi.useFakeTimers();
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  data.statuses = ["a", "b", "c"].map((id) => ({
    ...status(id, "running"),
    working: true,
  }));
  let resolveTopology!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveTopology = resolve;
      }),
  );
  await renderHook();
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);

  for (const ended of ["a", "b", "c"]) {
    data.statuses = data.statuses.map((item) =>
      item.sessionId === ended ? { ...item, working: false } : item,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  }
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(1);
  expect(api.listAgentBranches).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveTopology({ groups: [], complete: true, missingProjectIds: [] });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);
  expect(api.listAgentBranches).toHaveBeenCalledTimes(2);

  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);
});

it("re-reads branches once after a turn ends during an older branch read", async () => {
  vi.useFakeTimers();
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  data.statuses = [{ ...status("agent", "running"), working: true }];
  let resolveBranches!: (
    entries: Awaited<ReturnType<typeof api.listAgentBranches>>,
  ) => void;
  vi.mocked(api.listAgentBranches)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBranches = resolve;
        }),
    )
    .mockResolvedValue([{ projectId: "project", branch: "feature" }]);
  await renderHook();

  data.statuses = [{ ...status("agent", "running"), working: false }];
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);
  expect(api.listAgentBranches).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveBranches([{ projectId: "project", branch: "main" }]);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.listAgentBranches).toHaveBeenCalledTimes(2);
  expect(hook.branches.project).toBe("feature");
});

it("does not let an older branch poll overwrite a confirmed branch", async () => {
  data.projects.push({
    id: "project",
    name: "Project",
    path: "/tmp/project",
    environment: { kind: "local", distribution: null },
  });
  let resolveOldPoll!: (
    entries: Awaited<ReturnType<typeof api.listAgentBranches>>,
  ) => void;
  vi.mocked(api.listAgentBranches)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldPoll = resolve;
        }),
    )
    .mockImplementation(() => new Promise(() => {}));
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentBranches).toHaveBeenCalledTimes(1)),
  );

  await act(async () => {
    hook.refreshBranches("project", "feature");
    resolveOldPoll([{ projectId: "project", branch: "main" }]);
    await Promise.resolve();
  });

  expect(hook.branches.project).toBe("feature");
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentBranches).toHaveBeenCalledTimes(2)),
  );
});

it("restores last known branches at launch only for unchanged project targets", async () => {
  data.projects = ["p1", "p2"].map((id) => ({
    id,
    name: id,
    path: `/tmp/${id}`,
    environment: { kind: "wsl" as const, distribution: "Ubuntu" },
  }));
  vi.mocked(api.listAgentBranches).mockResolvedValueOnce([
    { projectId: "p1", branch: "main" },
    { projectId: "p2", branch: "dev" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches).toEqual({ p1: "main", p2: "dev" })),
  );
  await act(async () => root.unmount());

  data.projects[1].path = "/tmp/moved";
  vi.mocked(api.listAgentBranches).mockImplementation(
    () => new Promise(() => {}),
  );
  root = createRoot(host);
  await renderHook();

  expect(hook.branches).toEqual({ p1: "main" });
});

it("restores a confirmed branch for every worktree alias after restart without a new poll", async () => {
  data.projects = ["p1", "p2", "other"].map((id) => ({
    id,
    name: id,
    path: `/tmp/${id}`,
    environment: { kind: "local" as const, distribution: null },
  }));
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2", "other"],
      worktrees: [
        {
          path: "/tmp/shared",
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1", "p2"],
        },
        {
          path: "/tmp/other",
          head: "b".repeat(40),
          branch: "other",
          projectIds: ["other"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentBranches)
    .mockResolvedValueOnce([
      { projectId: "p1", branch: "main" },
      { projectId: "p2", branch: "main" },
      { projectId: "other", branch: "other" },
    ])
    .mockImplementation(() => new Promise(() => {}));
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual(groups)),
  );
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.p2).toBe("main")),
  );

  act(() => hook.refreshBranches("p1", "feature"));
  expect(hook.branches).toEqual({
    p1: "feature",
    p2: "feature",
    other: "other",
  });
  await act(async () => root.unmount());

  root = createRoot(host);
  await renderHook();

  expect(hook.branches).toEqual({
    p1: "feature",
    p2: "feature",
    other: "other",
  });
});

it("creates service sessions and updates a matching session without changing its identity", async () => {
  const existing = session("existing", "api");
  data.sessions.push(existing);
  data.statuses.push(status(existing.id, "idle"));
  await renderHook();

  const created = service("web");
  const updated = { ...service("api"), label: "API server" };
  await act(async () => {
    expect(
      await hook.synchronizeServiceSessions("project", [created, updated]),
    ).toBe(true);
  });

  const [newSession, updatedSession] = vi
    .mocked(api.saveAgentSession)
    .mock.calls.map(([saved]) => saved);
  expect(newSession).toMatchObject({
    projectId: "project",
    name: "WEB",
    kind: "service",
    serviceId: "web",
    workingDirectory: "/srv/web",
    executable: "npm",
    args: ["run", "web"],
  });
  expect(newSession.id).toEqual(expect.any(String));
  expect(new Date(newSession.createdAt).toISOString()).toBe(
    newSession.createdAt,
  );
  expect(updatedSession).toMatchObject({
    id: "existing",
    createdAt: existing.createdAt,
    name: "API server",
    workingDirectory: "/srv/api",
    executable: "npm",
    args: ["run", "api"],
  });
});

it("starts a service group even when other sessions are already running", async () => {
  data.sessions = [
    session("api-session", "api"),
    session("web-session", "web"),
  ];
  data.statuses = [status("terminal", "running")];
  await renderHook();

  await act(async () => {
    expect(
      await hook.startServices("project", [service("api"), service("web")]),
    ).toBe(true);
  });

  expect(api.startAgentSession).toHaveBeenCalledTimes(2);
});

it("keeps the same session across start, stop, and start without duplicating it", async () => {
  const target = service("api");
  await renderHook();

  await act(async () => {
    expect(await hook.startServices("project", target)).toBe(true);
  });
  const firstSessionId = vi.mocked(api.saveAgentSession).mock.calls[0][0].id;

  await act(async () => {
    expect(await hook.stopServices("project", target.id)).toBe(true);
  });
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith(firstSessionId);

  await act(async () => {
    expect(await hook.startServices("project", target)).toBe(true);
  });

  expect(api.startAgentSession).toHaveBeenNthCalledWith(1, firstSessionId);
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, firstSessionId);
  expect(data.sessions).toHaveLength(1);
  expect(data.sessions[0].id).toBe(firstSessionId);
});

it("keeps a saved service identity when the reload after starting fails", async () => {
  const target = service("api");
  await renderHook();
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("reload failed"),
  );

  await act(async () => {
    expect(await hook.startServices("project", target)).toBe(false);
  });
  const firstSessionId = vi.mocked(api.saveAgentSession).mock.calls[0][0].id;

  await act(async () => {
    expect(await hook.startServices("project", target)).toBe(true);
  });

  expect(api.saveAgentSession).toHaveBeenCalledTimes(1);
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith(firstSessionId);
  expect(data.sessions).toHaveLength(1);
  expect(data.sessions[0].id).toBe(firstSessionId);
});

it("starts sequentially, keeps an earlier launch running, and reports a later failure", async () => {
  vi.mocked(api.startAgentSession)
    .mockImplementationOnce(async (id) => {
      data.statuses = data.statuses.map((item) =>
        item.sessionId === id ? { ...item, state: "running" } : item,
      );
    })
    .mockRejectedValueOnce(new Error("port unavailable"));
  await renderHook();

  await act(async () => {
    expect(
      await hook.startServices("project", [service("api"), service("web")]),
    ).toBe(false);
  });

  const saved = vi
    .mocked(api.saveAgentSession)
    .mock.calls.map(([item]) => item);
  expect(api.startAgentSession).toHaveBeenNthCalledWith(1, saved[0].id);
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, saved[1].id);
  expect(
    Math.max(...vi.mocked(api.saveAgentSession).mock.invocationCallOrder),
  ).toBeLessThan(
    Math.min(...vi.mocked(api.startAgentSession).mock.invocationCallOrder),
  );
  expect(
    data.statuses.find((item) => item.sessionId === saved[0].id)?.state,
  ).toBe("running");
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(hook.error).toBeInstanceOf(AgentServiceError);
  expect(hook.error).toMatchObject({ failure: "start", serviceLabel: "WEB" });
});

it("leaves an already-running requested service untouched and starts only the idle one", async () => {
  data.sessions = [
    session("api-session", "api"),
    session("web-session", "web"),
  ];
  data.statuses = [
    status("api-session", "running"),
    status("web-session", "idle"),
  ];
  await renderHook();

  await act(async () => {
    expect(
      await hook.startServices("project", [service("api"), service("web")]),
    ).toBe(true);
  });

  expect(api.saveAgentSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "web-session", serviceId: "web" }),
  );
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("web-session");
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("stops only matching service sessions, treats missing services as a no-op, and restarts from the latest definition", async () => {
  const target = session("service-session", "api");
  const terminal: AgentSession = {
    ...target,
    id: "terminal-session",
    kind: "terminal",
    serviceId: null,
    workingDirectory: null,
  };
  data.sessions = [target, terminal];
  data.statuses = [
    status(target.id, "running"),
    status(terminal.id, "running"),
  ];
  await renderHook();

  await act(async () => {
    expect(await hook.stopServices("project", ["missing", "api"])).toBe(true);
  });
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith(target.id);

  vi.mocked(api.stopAgentSession).mockClear();
  data.statuses = data.statuses.map((item) =>
    item.sessionId === target.id ? { ...item, state: "running" } : item,
  );
  const definition = { ...service("api"), executable: "pnpm" };
  await act(async () => {
    expect(await hook.restartService("project", definition)).toBe(true);
  });
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith(target.id);
  expect(api.saveAgentSession).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: target.id,
      executable: "pnpm",
      workingDirectory: definition.cwd,
    }),
  );
  expect(api.startAgentSession).toHaveBeenLastCalledWith(target.id);

  vi.mocked(api.stopAgentSession).mockClear();
  await act(async () => {
    expect(await hook.stopServices("project", "missing")).toBe(true);
  });
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("exposes pending service keys until a launch finishes", async () => {
  const target = session("service-session", "api");
  data.sessions = [target];
  data.statuses = [status(target.id, "idle")];
  let finish!: () => void;
  vi.mocked(api.startAgentSession).mockImplementationOnce(
    (id) =>
      new Promise<void>((resolve) => {
        finish = () => {
          data.statuses = data.statuses.map((item) =>
            item.sessionId === id ? { ...item, state: "running" } : item,
          );
          resolve();
        };
      }),
  );
  await renderHook();

  let launch!: Promise<boolean>;
  act(() => {
    launch = hook.startServices("project", service("api"));
  });
  await act(async () =>
    vi.waitFor(() =>
      expect([...hook.pendingServiceKeys]).toEqual(["project\napi"]),
    ),
  );
  await act(async () => finish());
  await act(async () => expect(await launch).toBe(true));
  expect(hook.pendingServiceKeys.size).toBe(0);
});

it("reveals an incomplete initial topology while retrying it quickly", async () => {
  vi.useFakeTimers();
  data.projects = [
    {
      id: "project",
      name: "Project",
      path: "/projects/project",
      environment: { kind: "local", distribution: null },
    },
  ];
  vi.mocked(api.listAgentBranches).mockImplementation(
    () => new Promise(() => {}),
  );
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [],
      complete: false,
      missingProjectIds: [],
    })
    .mockResolvedValueOnce({
      groups: [],
      complete: true,
      missingProjectIds: [],
    });

  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentWorktrees).toHaveBeenCalledOnce()),
  );
  expect(hook.worktreesLoaded).toBe(true);
  expect(hook.worktreesComplete).toBe(false);

  await act(async () => vi.advanceTimersByTimeAsync(500));

  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);
  expect(api.listAgentBranches).toHaveBeenCalledOnce();
  expect(hook.worktreesLoaded).toBe(true);
  expect(hook.worktreesComplete).toBe(true);
});

it("ignores worktree responses invalidated by optimistic additions and removals", async () => {
  vi.useFakeTimers();
  const project = {
    id: "project",
    name: "Project",
    path: "/projects/project",
    environment: { kind: "local" as const, distribution: null },
  };
  const baseWorktree = {
    path: project.path,
    head: "a".repeat(40),
    branch: "main",
    projectIds: [project.id],
  };
  const createdWorktree = {
    path: "/projects/created",
    head: "b".repeat(40),
    branch: "created",
  };
  const group: AgentProjectWorktreeGroup = {
    repositoryProjectId: project.id,
    projectIds: [project.id],
    worktrees: [baseWorktree],
  };
  const finishes: Array<
    (snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>) => void
  > = [];
  data.projects = [project];
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [group],
      complete: true,
      missingProjectIds: [],
    })
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual([group])),
  );

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  act(() =>
    hook.rememberWorktreeProject(
      project.id,
      "created-project",
      createdWorktree,
    ),
  );
  await act(async () =>
    finishes[0]({ groups: [group], complete: true, missingProjectIds: [] }),
  );

  expect(hook.worktrees[0].worktrees).toContainEqual({
    ...createdWorktree,
    projectIds: ["created-project"],
  });

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  act(() => hook.forgetWorktree(project.id, createdWorktree.path));
  await act(async () =>
    finishes[1]({
      groups: [
        {
          ...group,
          projectIds: [project.id, "created-project"],
          worktrees: [
            baseWorktree,
            { ...createdWorktree, projectIds: ["created-project"] },
          ],
        },
      ],
      complete: true,
      missingProjectIds: [],
    }),
  );

  expect(hook.worktrees[0].worktrees).toEqual([baseWorktree]);
});

it("keeps refreshed fallback worktrees after an incomplete scope response", async () => {
  const project = {
    id: "one",
    name: "One",
    path: "/projects/one",
    environment: { kind: "local" as const, distribution: null },
  };
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: project.id,
      projectIds: [project.id],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: [project.id],
        },
      ],
    },
  ];
  data.projects = [project];
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({ groups, complete: true, missingProjectIds: [] })
    .mockResolvedValueOnce({
      groups: [],
      complete: false,
      missingProjectIds: [],
    });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual(groups)),
  );

  data.projects.push({
    ...project,
    id: "two",
    name: "Two",
    path: "/projects/two",
  });
  await act(async () => expect(await hook.execute(async () => {})).toBe(true));
  await act(async () =>
    vi.waitFor(() => expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2)),
  );

  expect(hook.worktrees).toEqual(groups);
  expect(hook.worktreesLoaded).toBe(true);
});

it("reconciles successive disjoint partial groups from the same repository", async () => {
  vi.useFakeTimers();
  const projects = ["one", "two", "three"].map((id, index) => ({
    id,
    name: id,
    path: `/projects/${id}`,
    environment: {
      kind: "wsl" as const,
      distribution: index % 2 ? "ubuntu-24.04" : "Ubuntu-24.04",
    },
  }));
  const group = (projectId: string): AgentProjectWorktreeGroup => ({
    repositoryProjectId: projectId,
    projectIds: [projectId],
    worktrees: [
      {
        path: "/projects/repository",
        head: projectId.repeat(40).slice(0, 40),
        branch: "main",
        projectIds: [projectId],
      },
    ],
  });
  data.projects = projects;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [group("one")],
      complete: false,
      missingProjectIds: [],
    })
    .mockResolvedValueOnce({
      groups: [group("two")],
      complete: false,
      missingProjectIds: [],
    })
    .mockResolvedValueOnce({
      groups: [group("three")],
      complete: false,
      missingProjectIds: [],
    });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual([group("one")])),
  );

  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => vi.advanceTimersByTimeAsync(5000));

  expect(hook.worktrees).toEqual([
    {
      ...group("three"),
      projectIds: ["three", "two", "one"],
      worktrees: [
        {
          ...group("three").worktrees[0],
          projectIds: ["three", "two", "one"],
        },
      ],
    },
  ]);
});

it("keeps worktree groups for unchanged targets during a scoped refresh", async () => {
  const one = {
    id: "one",
    name: "One",
    path: "/projects/one",
    environment: { kind: "local" as const, distribution: null },
  };
  const two = { ...one, id: "two", name: "Two", path: "/projects/two" };
  const groups: AgentProjectWorktreeGroup[] = [one, two].map((project) => ({
    repositoryProjectId: project.id,
    projectIds: [project.id],
    worktrees: [
      {
        path: project.path,
        head: project.id.repeat(20),
        branch: "main",
        projectIds: [project.id],
      },
    ],
  }));
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  data.projects = [one, two];
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({ groups, complete: true, missingProjectIds: [] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toEqual(groups)),
  );

  data.projects = [{ ...one, path: "/projects/one-moved" }, two];
  await act(async () => expect(await hook.execute(async () => {})).toBe(true));

  expect(hook.worktrees).toEqual([groups[1]]);
  expect(hook.worktreesLoaded).toBe(false);
  await act(async () =>
    finish({ groups: [groups[1]], complete: true, missingProjectIds: [] }),
  );
});

it("drops branches only for deleted or retargeted projects during reload", async () => {
  const one = {
    id: "one",
    name: "One",
    path: "/projects/one",
    environment: { kind: "local" as const, distribution: null },
  };
  const two = { ...one, id: "two", name: "Two", path: "/projects/two" };
  data.projects = [one, two];
  vi.mocked(api.listAgentBranches).mockResolvedValueOnce([
    { projectId: one.id, branch: "one-main" },
    { projectId: two.id, branch: "two-main" },
  ]);
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.branches.two).toBe("two-main")),
  );

  vi.mocked(api.listAgentBranches).mockRejectedValueOnce(
    new Error("branch refresh failed"),
  );
  data.projects = [{ ...one, path: "/projects/one-moved" }, two];
  await act(async () => expect(await hook.execute(async () => {})).toBe(true));
  await act(async () =>
    vi.waitFor(() => expect(hook.branchError).toBe("branch refresh failed")),
  );

  expect(hook.branches).toEqual({ two: "two-main" });
});

it("stops hiding a missing project once its target is edited, before the next poll", async () => {
  const project = {
    id: "one",
    name: "One",
    path: "/projects/gone",
    environment: { kind: "local" as const, distribution: null },
  };
  data.projects = [project];
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [],
      complete: true,
      missingProjectIds: [project.id],
    })
    .mockImplementation(() => new Promise(() => {}));
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.missingProjectIds).toEqual([project.id])),
  );

  data.projects = [{ ...project, path: "/projects/one" }];
  await act(async () => expect(await hook.execute(async () => {})).toBe(true));

  expect(hook.missingProjectIds).toEqual([]);
});

it("deletes worktree projects a reachable repository no longer lists, retrying failures", async () => {
  vi.useFakeTimers();
  const [main, feature, solo, lost] = ["main", "feature", "solo", "lost"].map(
    (id) => ({
      id,
      name: id,
      path: `/projects/${id}`,
      environment: { kind: "local" as const, distribution: null },
    }),
  );
  data.projects = [main, feature, solo, lost];
  const worktree = (project: typeof main) => ({
    path: project.path,
    head: "a".repeat(40),
    branch: project.id,
    projectIds: [project.id],
  });
  const group = (...projects: (typeof main)[]) => ({
    repositoryProjectId: projects[0].id,
    projectIds: projects.map(({ id }) => id),
    worktrees: projects.map(worktree),
  });
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [group(main, feature), group(solo, lost)],
      complete: true,
      missingProjectIds: [],
    })
    // The solo repository is unreachable (unmounted volume): no proof of removal.
    .mockResolvedValue({
      groups: [group(main)],
      complete: true,
      missingProjectIds: [feature.id, solo.id, lost.id],
    });
  vi.mocked(api.deleteAgentProject)
    .mockImplementation(async (id) => {
      data.projects = data.projects.filter((project) => project.id !== id);
    })
    .mockRejectedValueOnce(new Error("Git busy"));
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees).toHaveLength(2)),
  );

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.deleteAgentProject).toHaveBeenCalledExactlyOnceWith(feature.id);
  expect(hook.workspace.projects).toHaveLength(4);

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(vi.mocked(api.deleteAgentProject).mock.calls).toEqual([
    [feature.id],
    [feature.id],
  ]);
  expect(hook.workspace.projects.map(({ id }) => id)).toEqual([
    main.id,
    solo.id,
    lost.id,
  ]);
});

it("deletes a worktree project whose removal was seen in an incomplete snapshot", async () => {
  vi.useFakeTimers();
  const [main, feature] = ["main", "feature"].map((id) => ({
    id,
    name: id,
    path: `/projects/${id}`,
    environment: { kind: "local" as const, distribution: null },
  }));
  data.projects = [main, feature];
  const group = (...projects: (typeof main)[]) => ({
    repositoryProjectId: main.id,
    projectIds: projects.map(({ id }) => id),
    worktrees: projects.map((project) => ({
      path: project.path,
      head: "a".repeat(40),
      branch: project.id,
      projectIds: [project.id],
    })),
  });
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [group(main, feature)],
      complete: true,
      missingProjectIds: [],
    })
    // An unrelated repository probe failed; the merge forgets feature's old path.
    .mockResolvedValueOnce({
      groups: [group(main)],
      complete: false,
      missingProjectIds: [feature.id],
    })
    .mockResolvedValue({
      groups: [group(main)],
      complete: true,
      missingProjectIds: [feature.id],
    });
  vi.mocked(api.deleteAgentProject).mockImplementation(async (id) => {
    data.projects = data.projects.filter((project) => project.id !== id);
  });
  await renderHook();
  await act(async () =>
    vi.waitFor(() => expect(hook.worktrees[0]?.worktrees).toHaveLength(2)),
  );

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.deleteAgentProject).not.toHaveBeenCalled();
  expect(hook.worktrees[0].worktrees).toHaveLength(1);

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.deleteAgentProject).toHaveBeenCalledExactlyOnceWith(feature.id);
});

const appearanceProject = {
  id: "one",
  name: "One",
  path: "/projects/one",
  environment: { kind: "local" as const, distribution: null },
};

it("keeps a confirmed appearance over a workspace reload that started before it", async () => {
  data.projects = [appearanceProject];
  await renderHook();
  const stale = deferred<AgentWorkspace>();
  vi.mocked(api.loadAgentWorkspace).mockReturnValueOnce(stale.promise);
  const staleSnapshot = structuredClone(data);
  vi.mocked(api.updateAgentProjectAppearance).mockImplementation(
    async (id, change) => {
      data.projects = data.projects.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      );
      return structuredClone(data.projects[0]);
    },
  );
  let reloaded!: Promise<boolean>;
  await act(async () => {
    reloaded = hook.execute(async () => {});
  });
  await act(async () =>
    expect(await hook.saveProjectAppearance("one", { icon: "rocket" })).toBe(
      true,
    ),
  );
  await act(async () => {
    stale.resolve(staleSnapshot);
    expect(await reloaded).toBe(true);
  });
  expect(hook.workspace.projects[0].icon).toBe("rocket");

  data.projects = [{ ...data.projects[0], name: "Renamed" }];
  await act(async () => expect(await hook.execute(async () => {})).toBe(true));
  expect(hook.workspace.projects[0]).toMatchObject({
    name: "Renamed",
    icon: "rocket",
  });
});

it("reloads once more when a retry is requested during an in-flight reload", async () => {
  data.projects = [appearanceProject];
  await renderHook();
  const stale = deferred<AgentWorkspace>();
  const staleSnapshot = structuredClone(data);
  vi.mocked(api.loadAgentWorkspace)
    .mockClear()
    .mockReturnValueOnce(stale.promise);
  let reloaded!: Promise<boolean>;
  await act(async () => {
    reloaded = hook.retry();
  });
  data.projects = [{ ...appearanceProject, name: "Renamed" }];
  await act(async () => expect(await hook.retry()).toBe(false));

  await act(async () => {
    stale.resolve(staleSnapshot);
    expect(await reloaded).toBe(true);
  });
  expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(2);
  expect(hook.workspace.projects[0].name).toBe("Renamed");
});

it("keeps a failed mutation's error and resolves only after the queued workspace reload", async () => {
  data.projects = [appearanceProject];
  await renderHook();
  const work = deferred<void>();
  const followUp = deferred<AgentWorkspace>();
  data.projects = [{ ...appearanceProject, name: "Renamed" }];
  vi.mocked(api.loadAgentWorkspace)
    .mockClear()
    .mockResolvedValueOnce(structuredClone(data))
    .mockReturnValueOnce(followUp.promise);
  let settled = false;
  let executed!: Promise<boolean>;
  await act(async () => {
    executed = hook.execute(() => work.promise);
    void executed.then(() => (settled = true));
  });
  await act(async () => expect(await hook.retry()).toBe(false));

  await act(async () => work.reject(new Error("launch failed")));
  expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);

  await act(async () => {
    followUp.resolve(structuredClone(data));
    expect(await executed).toBe(false);
  });
  expect(hook.workspace.projects[0].name).toBe("Renamed");
  expect(hook.error?.message).toBe("launch failed");
  const next = vi.fn(async () => {});
  await act(async () => expect(await hook.execute(next)).toBe(true));
  expect(next).toHaveBeenCalledOnce();
});

it("keeps the workspace error while a background refresh disables the workspace", async () => {
  data.projects = [appearanceProject];
  await renderHook();
  await act(async () =>
    expect(
      await hook.execute(async () => {
        throw new Error("merge conflict");
      }),
    ).toBe(false),
  );
  const pending = deferred<AgentWorkspace>();
  vi.mocked(api.loadAgentWorkspace).mockReturnValueOnce(pending.promise);
  let refreshed!: Promise<boolean>;
  await act(async () => {
    refreshed = hook.refresh();
  });

  expect(hook.loading).toBe(true);
  expect(hook.error?.message).toBe("merge conflict");
  await act(async () => {
    pending.resolve(structuredClone(data));
    expect(await refreshed).toBe(true);
  });
  expect(hook.loading).toBe(false);
  expect(hook.error?.message).toBe("merge conflict");
});

it("keeps reporting a failed appearance save while a later queued one succeeds", async () => {
  data.projects = [appearanceProject];
  await renderHook();
  const first = deferred<never>();
  vi.mocked(api.updateAgentProjectAppearance)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...appearanceProject, icon: "rocket" });
  let color!: Promise<boolean>;
  let icon!: Promise<boolean>;
  await act(async () => {
    color = hook.saveProjectAppearance("one", { color: "#608ef8" });
    icon = hook.saveProjectAppearance("one", { icon: "rocket" });
  });
  await act(async () => {
    first.reject(new Error("disk full"));
    expect(await color).toBe(false);
    expect(await icon).toBe(true);
  });
  expect(hook.error?.message).toBe("disk full");
  expect(hook.workspace.projects[0]).toMatchObject({ icon: "rocket" });
  expect(hook.workspace.projects[0].color).toBeUndefined();
});
