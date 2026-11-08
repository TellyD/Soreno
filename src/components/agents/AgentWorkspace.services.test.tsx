// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  container,
  statusBarContainer,
  gitPanelContainer,
  data,
  root,
  render,
  button,
  click,
  dialog,
  escape,
  splitAgent,
  tabNames,
  servicesManifest,
  enableProjectServices,
  servicesToggle,
  toggleServices,
  setGitPanelContainer,
  notificationMessages,
  retryFromNotification,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as projectFilesApi from "../../data/projectFilesApi";

const serviceTerminal = () =>
  container.querySelector<HTMLElement>('[data-terminal="service-api"]');

it("docks services under the selected agent, toggled by Escape and Ctrl+Alt+J", async () => {
  enableProjectServices();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await vi.waitFor(() =>
    expect(servicesToggle().textContent).toBe("Services 1/2"),
  );
  expect(servicesToggle().getAttribute("aria-pressed")).toBe("false");
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  const activeAgent = gitPanelContainer.querySelector("[data-active-agent]")!;

  await toggleServices();
  expect(servicesToggle().getAttribute("aria-pressed")).toBe("true");
  expect(serviceTerminal()?.hidden).toBe(false);
  expect(
    container.querySelector<HTMLElement>('[data-terminal="s1"]')?.hidden,
  ).toBe(false);
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(activeAgent.getAttribute("data-active-agent")).toBe("s1");

  await click("Afficher les journaux de API");
  expect(document.activeElement).toBe(serviceTerminal());
  await act(async () => button("Afficher les journaux de API").focus());
  await escape();
  expect(servicesToggle().getAttribute("aria-pressed")).toBe("false");
  expect(serviceTerminal()).toBeNull();
  expect(document.activeElement).toBe(servicesToggle());

  const shortcut = new KeyboardEvent("keydown", {
    key: "j",
    code: "KeyJ",
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  const agentTerminal = container.querySelector<HTMLElement>(
    '[data-terminal="s1"]',
  )!;
  await act(async () => agentTerminal.focus());
  await act(async () => agentTerminal.dispatchEvent(shortcut));
  expect(shortcut.defaultPrevented).toBe(true);
  expect(servicesToggle().getAttribute("aria-pressed")).toBe("true");
  expect(serviceTerminal()?.hidden).toBe(false);
  expect(document.activeElement).toBe(agentTerminal);
  await act(async () => root.unmount());
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.service-views.v1")!),
  ).toEqual({ p1: { open: true, projectId: "p1", serviceId: "api" } });
});

it("does not show Services for an SSH project without a manifest", async () => {
  enableProjectServices(false);
  vi.mocked(projectFilesApi.readProjectFile).mockRejectedValue({
    code: "notFound",
    message: "missing",
  });

  await render();
  await vi.waitFor(() =>
    expect(projectFilesApi.readProjectFile).toHaveBeenCalled(),
  );

  expect(servicesToggle).toThrow();
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
});

it("shows a grouped project's services from any other project of its group", async () => {
  enableProjectServices();
  data.projects.push({
    ...data.projects[0],
    id: "p2",
    name: "Docs",
    path: "/projects/docs",
  });
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1", "p2"], groupProjectId: null },
  ];
  vi.mocked(projectFilesApi.readProjectFile).mockImplementation(
    async (projectId) => {
      if (projectId === "p2") throw { code: "notFound", message: "missing" };
      return {
        path: ".soreno/services.json",
        content: JSON.stringify(servicesManifest),
        version: "manifest-v1",
      };
    },
  );
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p2", sessionId: null }),
  );

  await render();
  await vi.waitFor(() =>
    expect(servicesToggle().textContent).toBe("Services 1/2"),
  );
  await toggleServices();
  expect(
    container.querySelector('section[aria-label="Soreno"]'),
  ).not.toBeNull();
  await click("Arrêter API", container);
  await vi.waitFor(() =>
    expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("service-api"),
  );
  await act(async () => root.unmount());
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.service-views.v1")!),
  ).toEqual({ "group:g1": { open: true } });
});

it("keeps the empty state for a project without an open agent until Services is opened", async () => {
  enableProjectServices();
  await render();
  await vi.waitFor(servicesToggle);

  expect(serviceTerminal()).toBeNull();
  expect(container.querySelector(".agent-terminal-stack")).toHaveProperty(
    "hidden",
    true,
  );
  expect(
    [...container.querySelectorAll(".agent-activity-name")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Pi notes", "Codex tests"]);

  await toggleServices();
  expect(serviceTerminal()?.hidden).toBe(false);
  expect(
    container.querySelector('[aria-label="Journaux du service · API"]'),
  ).not.toBeNull();
  await vi.waitFor(() =>
    expect(
      container.querySelector(".project-services-list")?.textContent,
    ).toContain("feature/api"),
  );
});

it("resizes the services panel from the keyboard and remembers its height", async () => {
  enableProjectServices();
  await render();
  await toggleServices();
  const separator = () =>
    container.querySelector<HTMLElement>('[role="separator"]')!;
  const height = separator().getAttribute("aria-valuenow");

  await act(async () =>
    separator().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    ),
  );
  const raised = String(Number(height) + 12);
  expect(separator().getAttribute("aria-valuenow")).toBe(raised);

  await toggleServices();
  await toggleServices();
  expect(separator().getAttribute("aria-valuenow")).toBe(raised);
  expect(localStorage.getItem("soreno.agents.services-panel-height.v1")).toBe(
    raised,
  );
});

it("keeps persisted service logs and stop access when the manifest drops that service", async () => {
  enableProjectServices();
  vi.mocked(projectFilesApi.readProjectFile).mockResolvedValue({
    path: ".soreno/services.json",
    content: JSON.stringify({
      version: 1,
      profiles: [{ id: "main", label: "Principal", services: ["web"] }],
      services: [servicesManifest.services[1]],
    }),
    version: "manifest-v2",
  });

  await render();
  await toggleServices();
  await click("Afficher les journaux de API", container);

  expect(serviceTerminal()?.hidden).toBe(false);
  expect(button("Arrêter API", container).disabled).toBe(false);
  expect(button("Redémarrer API", container).disabled).toBe(true);
  expect(button("Démarrer Web", container).disabled).toBe(false);

  await click("Arrêter API", container);
  await vi.waitFor(() =>
    expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("service-api"),
  );
});

it("does not retry a stale failed split launch after a later service stop fails", async () => {
  enableProjectServices();
  data.statuses[1] = { sessionId: "s2", state: "running", exitCode: null };
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("split launch failed"),
  );
  await render();
  await vi.waitFor(servicesToggle);
  await splitAgent("Terminal");
  expect(notificationMessages()).toEqual(["L’opération a échoué. Réessayez."]);
  expect(container.textContent).not.toContain("split launch failed");

  await toggleServices();
  vi.mocked(api.stopAgentSession).mockRejectedValueOnce(
    new Error("service stop failed"),
  );
  await click("Arrêter API", container);
  await vi.waitFor(() =>
    expect(notificationMessages()).toEqual([
      "L’opération a échoué. Réessayez.",
    ]),
  );
  expect(container.textContent).not.toContain("service stop failed");

  await click("Codex tests");
  const reloadCount = vi.mocked(api.loadAgentWorkspace).mock.calls.length;
  vi.mocked(api.startAgentSession).mockClear();
  await retryFromNotification();
  await vi.waitFor(() =>
    expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(reloadCount + 1),
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("never auto-starts services and requires trust before the first service start", async () => {
  enableProjectServices(false);
  await render();
  await toggleServices();
  await vi.waitFor(() =>
    expect(button("Démarrer API", container).disabled).toBe(false),
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(api.saveAgentSession).not.toHaveBeenCalled();

  await click("Démarrer API", container);
  expect(dialog().textContent).toContain("/srv/api");
  expect(dialog().textContent).toContain('["npm","run","api"]');
  expect(dialog().textContent).toContain("/srv/web");
  expect(dialog().textContent).toContain('["npm","run","web"]');
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  await click("Annuler", dialog());
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(api.saveAgentSession).not.toHaveBeenCalled();

  await click("Démarrer API", container);
  await click("Faire confiance et démarrer", dialog());
  await vi.waitFor(() =>
    expect(api.startAgentSession).toHaveBeenCalledTimes(1),
  );

  const approvals = JSON.parse(
    localStorage.getItem("soreno.services.trust.v1")!,
  );
  expect(JSON.parse(approvals[0])).toEqual([
    "p1",
    "remote.example",
    "dev",
    2222,
    "/projects/soreno",
    "manifest-v1",
  ]);
});

it("names the service that failed to start without exposing the backend reason", async () => {
  enableProjectServices(false);
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("port 3012 already bound"),
  );
  await render();
  await toggleServices();
  await vi.waitFor(() =>
    expect(button("Démarrer API", container).disabled).toBe(false),
  );
  await click("Démarrer API", container);
  await click("Faire confiance et démarrer", dialog());

  await vi.waitFor(() =>
    expect(notificationMessages()).toEqual([
      "Impossible de démarrer le service « API ».",
    ]),
  );
  expect(container.textContent).not.toContain("already bound");
});

it("keeps service logs visible and disables commands while disconnected", async () => {
  enableProjectServices();
  await render();
  await toggleServices();
  await click("Déconnecter · Soreno", statusBarContainer);
  await click("Déconnecter", dialog());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("derniers états et journaux"),
  );

  expect(container.querySelector('[aria-label="Démarrer API"]')).toBeNull();
  expect(button("Arrêter API", container).disabled).toBe(true);
  expect(button("Redémarrer API", container).disabled).toBe(true);
  expect(button("Afficher les journaux de API", container).disabled).toBe(
    false,
  );
  expect(serviceTerminal()?.hidden).toBe(false);
});

it("surfaces manifest errors with retry without replacing the selected terminal", async () => {
  enableProjectServices();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  vi.mocked(projectFilesApi.readProjectFile).mockResolvedValueOnce({
    path: ".soreno/services.json",
    content: "{invalid",
    version: "invalid-manifest",
  });
  await render();
  await vi.waitFor(() =>
    expect(notificationMessages()).toEqual([
      "Chargement du manifeste de services impossible.",
    ]),
  );
  expect(container.textContent).not.toContain(
    "Chargement du manifeste de services impossible",
  );

  expect(
    container.querySelector<HTMLElement>('[data-terminal="s1"]')?.hidden,
  ).toBe(false);
  await toggleServices();
  expect(serviceTerminal()?.hidden).toBe(false);
  expect(button("Arrêter API", container).disabled).toBe(false);
  expect(button("Redémarrer API", container).disabled).toBe(true);
  await click("Codex tests");
  await click("Pi notes");
  await retryFromNotification();
  await vi.waitFor(() =>
    expect(servicesToggle().textContent).toBe("Services 1/2"),
  );
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(notificationMessages()).toEqual([]);
  expect(
    container.querySelector<HTMLElement>('[data-terminal="s1"]')?.hidden,
  ).toBe(false);
  expect(serviceTerminal()?.hidden).toBe(false);
});
