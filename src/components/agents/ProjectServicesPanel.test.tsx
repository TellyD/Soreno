// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../../domain/agentSessions";
import type { ProjectServicesManifest } from "../../domain/projectServices";
import {
  ProjectServicesPanel,
  type ProjectServicesPanelProps,
  type ProjectServicesSection,
} from "./ProjectServicesPanel";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "en-US" }) }));

const manifest: ProjectServicesManifest = {
  version: 1,
  profiles: [{ id: "main", label: "Main", services: ["api", "web"] }],
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
const sessions: AgentSession[] = manifest.services.map((service) => ({
  id: `${service.id}-session`,
  projectId: "project",
  name: service.label,
  kind: "service",
  serviceId: service.id,
  workingDirectory: service.cwd,
  executable: service.executable,
  args: service.args,
  createdAt: "2026-01-01T00:00:00.000Z",
}));

let root: Root;
let host: HTMLDivElement;
const actions = {
  onServiceChange: vi.fn(),
  onStartServices: vi.fn(),
  onStopServices: vi.fn(),
  onRestartService: vi.fn(),
};

function render(
  section: Partial<ProjectServicesSection> = {},
  props: Partial<ProjectServicesPanelProps> = {},
) {
  act(() => {
    root.render(
      <ProjectServicesPanel
        sections={[
          {
            projectId: "project",
            projectName: "Project",
            services: manifest.services,
            launchableServiceIds: new Set(
              manifest.services.map((service) => service.id),
            ),
            sessions,
            serviceBranches: { api: "feature/api", web: "main" },
            disconnected: false,
            ...section,
          },
        ]}
        statuses={[
          { sessionId: "api-session", state: "running", exitCode: null },
          { sessionId: "web-session", state: "exited", exitCode: 7 },
        ]}
        pendingServiceKeys={new Set()}
        selectedServiceKey={"project\napi"}
        terminal={<div data-testid="service-terminal">output</div>}
        {...actions}
        {...props}
      />,
    );
  });
}

function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders services alphabetically with their branch, state, port, and selected terminal", () => {
  render({ services: [...manifest.services].reverse() });

  expect(
    [...host.querySelectorAll(".project-services-service-name")].map(
      (element) => element.textContent,
    ),
  ).toEqual(["API", "Web"]);
  expect(host.textContent).toContain("feature/api");
  expect(host.textContent).toContain("main");
  expect(host.textContent).toContain("Running");
  expect(host.textContent).toContain("Stopped");
  expect(host.textContent).toContain("Exit code 7");
  expect(host.textContent).toContain("Port 3012");
  expect(host.querySelector('[data-testid="service-terminal"]')).not.toBeNull();
  expect(button("Show logs for API").getAttribute("aria-pressed")).toBe("true");
});

it("runs each row command on its own service", () => {
  render();

  act(() => button("Start Web").click());
  act(() => button("Stop API").click());
  act(() => button("Restart Web").click());
  act(() => button("Show logs for Web").click());

  expect(actions.onStartServices).toHaveBeenCalledWith("project", [
    manifest.services[1],
  ]);
  expect(actions.onStopServices).toHaveBeenCalledWith("project", [
    manifest.services[0],
  ]);
  expect(actions.onRestartService).toHaveBeenCalledWith(
    "project",
    manifest.services[1],
  );
  expect(actions.onServiceChange).toHaveBeenCalledWith("project", "web");
});

it("starts every stopped launchable service, then stops every running one once all run", () => {
  render({ services: [...manifest.services].reverse() });
  act(() => button("Start all").click());
  expect(actions.onStartServices).toHaveBeenCalledExactlyOnceWith("project", [
    manifest.services[1],
  ]);

  render(
    {},
    {
      statuses: [
        { sessionId: "api-session", state: "running", exitCode: null },
        { sessionId: "web-session", state: "running", exitCode: null },
      ],
    },
  );
  act(() => button("Stop all").click());
  expect(actions.onStopServices).toHaveBeenCalledExactlyOnceWith(
    "project",
    manifest.services,
  );

  render({ launchableServiceIds: new Set(["api"]) });
  expect(button("Stop all").disabled).toBe(false);

  render({}, { statuses: [], pendingServiceKeys: new Set(["project\nweb"]) });
  expect(button("Start all").disabled).toBe(true);

  render({ disconnected: true }, { statuses: [] });
  expect(button("Start all").disabled).toBe(true);
});

it("disables start and restart, but not stop, for persisted services missing from the manifest", () => {
  render({ launchableServiceIds: new Set(["web"]) });

  expect(button("Stop API").disabled).toBe(false);
  expect(button("Restart API").disabled).toBe(true);
  expect(button("Start Web").disabled).toBe(false);
  expect(button("Show logs for API").disabled).toBe(false);

  render(
    { launchableServiceIds: new Set(["web"]) },
    {
      statuses: [
        { sessionId: "api-session", state: "exited", exitCode: 0 },
        { sessionId: "web-session", state: "exited", exitCode: 7 },
      ],
    },
  );
  expect(button("Start API").disabled).toBe(true);
});

it("keeps logs available but disables commands while disconnected or pending", () => {
  render(
    { disconnected: true },
    { pendingServiceKeys: new Set(["project\nweb"]) },
  );

  expect(host.querySelector('[aria-label="Start API"]')).toBeNull();
  expect(button("Stop API").disabled).toBe(true);
  expect(button("Restart API").disabled).toBe(true);
  expect(button("Show logs for API").disabled).toBe(false);
  expect(button("Start Web").disabled).toBe(true);
  expect(host.querySelector('[data-testid="service-terminal"]')).not.toBeNull();
});

it("keeps grouped projects' services apart, even with the same service id", () => {
  const other = (service: (typeof manifest.services)[number]) => ({
    ...service,
    label: `Docs ${service.label}`,
  });
  act(() => {
    root.render(
      <ProjectServicesPanel
        sections={[
          {
            projectId: "app",
            projectName: "App",
            services: manifest.services,
            launchableServiceIds: new Set(["api", "web"]),
            sessions,
            serviceBranches: {},
            disconnected: false,
          },
          {
            projectId: "docs",
            projectName: "Docs",
            services: manifest.services.map(other),
            launchableServiceIds: new Set(["api", "web"]),
            sessions: [],
            serviceBranches: {},
            disconnected: true,
          },
        ]}
        statuses={[
          { sessionId: "api-session", state: "running", exitCode: null },
        ]}
        pendingServiceKeys={new Set()}
        selectedServiceKey={"docs\napi"}
        grouped
        {...actions}
      />,
    );
  });
  const section = (name: string) =>
    host.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;

  expect(button("Show logs for Docs API").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(button("Show logs for API").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(button("Stop API").disabled).toBe(false);
  expect(button("Start Docs API").disabled).toBe(true);
  act(() => section("App").querySelector("button")!.click());
  expect(actions.onStartServices).toHaveBeenCalledExactlyOnceWith("app", [
    manifest.services[1],
  ]);
  expect(
    section("Docs").querySelector<HTMLButtonElement>("header button")!.disabled,
  ).toBe(true);
});
