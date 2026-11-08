// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import * as agents from "../data/agentSessionsApi";
import * as files from "../data/projectFilesApi";
import type { AgentProject } from "../domain/agentSessions";
import {
  useProjectServices,
  type ProjectServicesState,
} from "./useProjectServices";

vi.mock("../data/agentSessionsApi", () => ({
  listAgentServiceBranches: vi.fn(),
}));
vi.mock("../data/projectFilesApi", () => ({ readProjectFile: vi.fn() }));

const sshProject = (
  id: string,
  path = "/workspaces/gitpod-flex-front",
): AgentProject => ({
  id,
  name: id,
  path,
  environment: {
    kind: "ssh",
    distribution: null,
    ssh: {
      host: "example.test",
      user: "dev",
      port: 22,
      identityFile: null,
      hostKey: "ssh-ed25519 key",
    },
  },
});
const content = JSON.stringify({
  version: 1,
  profiles: [{ id: "main", label: "Main", services: ["tsapi"] }],
  services: [
    {
      id: "tsapi",
      label: "Tsapi",
      cwd: "/workspaces/tsapi",
      executable: "bash",
      args: ["/workspace/start.sh"],
      port: 3012,
    },
  ],
});
let root: Root;
let host: HTMLDivElement;
let state: ProjectServicesState;
let stateOf: (project: AgentProject) => ProjectServicesState;
function Harness({
  project,
  projects = project ? [project] : [],
  disconnected,
}: {
  project?: AgentProject;
  projects?: AgentProject[];
  disconnected?: boolean;
}) {
  const services = useProjectServices(
    projects,
    disconnected ? projects.map(({ id }) => id) : [],
  );
  stateOf = services.stateOf;
  if (project) state = services.stateOf(project);
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.mocked(agents.listAgentServiceBranches).mockResolvedValue([
    { serviceId: "tsapi", branch: "feature/api" },
  ]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("loads and parses the SSH project's manifest", async () => {
  vi.mocked(files.readProjectFile).mockResolvedValue({
    path: ".soreno/services.json",
    content,
    version: "v1",
  });
  await act(async () => root.render(<Harness project={sshProject("one")} />));
  expect(files.readProjectFile).toHaveBeenCalledWith(
    "one",
    ".soreno/services.json",
  );
  expect(state.loading).toBe(false);
  expect(state.version).toBe("v1");
  expect(state.manifest?.services[0].id).toBe("tsapi");
  expect(agents.listAgentServiceBranches).toHaveBeenCalledWith("one", [
    { serviceId: "tsapi", cwd: "/workspaces/tsapi" },
  ]);
  expect(state.serviceBranches).toEqual({ tsapi: "feature/api" });
});

it("does not read local projects and distinguishes a missing manifest", async () => {
  const local: AgentProject = {
    ...sshProject("local"),
    environment: { kind: "local", distribution: null },
  };
  await act(async () => root.render(<Harness project={local} />));
  expect(files.readProjectFile).not.toHaveBeenCalled();
  expect(state.loading).toBe(false);

  vi.mocked(files.readProjectFile).mockRejectedValue({
    code: "notFound",
    message: "missing",
  });
  await act(async () => root.render(<Harness project={sshProject("ssh")} />));
  expect(state.missing).toBe(true);
  expect(state.error).toBeNull();
});

it("loads each grouped project's manifest independently", async () => {
  const api = sshProject("api", "/srv/api");
  const docs = sshProject("docs", "/srv/docs");
  vi.mocked(files.readProjectFile).mockImplementation(async (projectId) => {
    if (projectId === "docs") throw { code: "notFound", message: "missing" };
    return { path: ".soreno/services.json", content, version: "v1" };
  });
  await act(async () => root.render(<Harness projects={[api, docs]} />));

  expect(stateOf(api).manifest?.services[0].id).toBe("tsapi");
  expect(stateOf(docs).missing).toBe(true);
  expect(agents.listAgentServiceBranches).toHaveBeenCalledExactlyOnceWith(
    "api",
    [{ serviceId: "tsapi", cwd: "/workspaces/tsapi" }],
  );
});

it("reuses the last manifest for a disconnected project without reading it again", async () => {
  vi.mocked(files.readProjectFile).mockResolvedValue({
    path: ".soreno/services.json",
    content,
    version: "v1",
  });
  const project = sshProject("one");
  await act(async () => root.render(<Harness project={project} />));
  await act(async () => root.render(<Harness />));
  await act(async () =>
    root.render(<Harness project={project} disconnected />),
  );

  expect(files.readProjectFile).toHaveBeenCalledTimes(1);
  expect(state.loading).toBe(false);
  expect(state.version).toBe("v1");
  expect(state.manifest?.services[0].id).toBe("tsapi");
});

it("keeps a project's services visible while refreshing them again", async () => {
  vi.mocked(files.readProjectFile)
    .mockResolvedValueOnce({
      path: ".soreno/services.json",
      content,
      version: "v1",
    })
    .mockResolvedValueOnce({
      path: ".soreno/services.json",
      content,
      version: "v2",
    })
    .mockImplementationOnce(() => new Promise<never>(() => {}));

  await act(async () => root.render(<Harness project={sshProject("one")} />));
  await act(async () => root.render(<Harness project={sshProject("two")} />));
  await act(async () => root.render(<Harness project={sshProject("one")} />));

  expect(files.readProjectFile).toHaveBeenCalledTimes(3);
  expect(state.loading).toBe(true);
  expect(state.version).toBe("v1");
  expect(state.manifest?.services[0].id).toBe("tsapi");
  expect(state.serviceBranches).toEqual({ tsapi: "feature/api" });
});

it("retries one transient SSH failure while reconnecting", async () => {
  vi.useFakeTimers();
  vi.mocked(files.readProjectFile)
    .mockRejectedValueOnce({ code: "ssh", message: "reconnecting" })
    .mockResolvedValueOnce({
      path: ".soreno/services.json",
      content,
      version: "v2",
    });

  await act(async () => root.render(<Harness project={sshProject("one")} />));
  expect(files.readProjectFile).toHaveBeenCalledTimes(1);
  expect(state.loading).toBe(true);
  expect(state.error).toBeNull();

  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(files.readProjectFile).toHaveBeenCalledTimes(2);
  expect(state.loading).toBe(false);
  expect(state.version).toBe("v2");
  expect(state.error).toBeNull();
});

it("keeps cached services when reconnect retries fail", async () => {
  vi.useFakeTimers();
  vi.mocked(files.readProjectFile)
    .mockResolvedValueOnce({
      path: ".soreno/services.json",
      content,
      version: "v1",
    })
    .mockRejectedValueOnce({ code: "ssh", message: "reconnecting" })
    .mockRejectedValueOnce({ code: "project", message: "still offline" });
  const project = sshProject("one");

  await act(async () => root.render(<Harness project={project} />));
  await act(async () =>
    root.render(<Harness project={project} disconnected />),
  );
  await act(async () => root.render(<Harness project={project} />));

  expect(state.loading).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(500));

  expect(files.readProjectFile).toHaveBeenCalledTimes(3);
  expect(state.loading).toBe(false);
  expect(state.error).toBe("still offline");
  expect(state.version).toBe("v1");
  expect(state.manifest?.services[0].id).toBe("tsapi");
  expect(state.serviceBranches).toEqual({ tsapi: "feature/api" });
});

it("ignores stale responses after the selected project changes", async () => {
  const first = deferred<{
    path: string;
    content: string;
    version: string;
  }>();
  vi.mocked(files.readProjectFile)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({
      path: ".soreno/services.json",
      content,
      version: "v2",
    });
  await act(async () => root.render(<Harness project={sshProject("one")} />));
  await act(async () => root.render(<Harness project={sshProject("two")} />));
  expect(state.version).toBe("v2");
  await act(async () =>
    first.resolve({ path: ".soreno/services.json", content, version: "v1" }),
  );
  expect(state.version).toBe("v2");
});
