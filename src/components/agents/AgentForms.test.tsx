// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import * as api from "../../data/agentSessionsApi";
import { hasLinearApiKey, listLinearProjects } from "../../data/kanbanApi";
import { clearNotifications, getNotifications } from "../../notifications";
import type {
  AgentProject,
  AgentProjectDirectory,
  AgentProjectLinearLink,
  SshConnection,
} from "../../domain/agentSessions";
import { AgentProjectForm, AgentProjectGroupForm } from "./AgentForms";
import { GitCloneForm } from "./GitCloneForm";
import { SshProjectFields } from "./SshProjectFields";
import { setInputValue } from "../ui/testInput";
import { deferred } from "../../testing/deferred";

const i18n = vi.hoisted(() => ({ language: "fr" }));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ locale: i18n.language === "fr" ? "fr-FR" : "en-US" }),
}));
vi.mock("../../data/agentSessionsApi", () => ({
  browseAgentSsh: vi.fn(),
  discoverAgentEnvironments: vi.fn(),
  pickAgentProjectDirectory: vi.fn(),
  pickAgentSshIdentity: vi.fn(),
  scanAgentSshHost: vi.fn(),
}));
vi.mock("../../data/kanbanApi", () => ({
  hasLinearApiKey: vi.fn(),
  listLinearProjects: vi.fn(),
}));
vi.mock("../ui/Select", () => ({
  Select: ({
    options,
    onValueChange,
    ...props
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    onValueChange: (value: string) => void;
    value: string;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const localProject: AgentProject = {
  id: "p1",
  name: "",
  path: "",
  environment: { kind: "local", distribution: null },
};
let container: HTMLDivElement;
let root: Root;
let onSave: Mock;
let onSaveMany: Mock;
let onClone: Mock;
let onCancel: Mock;

beforeEach(() => {
  vi.clearAllMocks();
  i18n.language = "fr";
  vi.mocked(api.discoverAgentEnvironments).mockResolvedValue({
    localLabel: "Linux",
    distributions: ["Ubuntu", "Debian"],
    wslError: null,
  });
  vi.mocked(hasLinearApiKey).mockResolvedValue(false);
  onSave = vi.fn(async () => {});
  onSaveMany = vi.fn(async () => {});
  onClone = vi.fn(async () => {});
  onCancel = vi.fn();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearNotifications();
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  project: AgentProject | null = localProject,
  hasSessions = false,
  projects: AgentProject[] = [],
  linear: { linkable: boolean; links?: AgentProjectLinearLink[] } = {
    linkable: false,
  },
) {
  await act(async () =>
    root.render(
      <AgentProjectForm
        project={project ?? undefined}
        projects={projects}
        hasSessions={hasSessions}
        linearLinkable={linear.linkable}
        linearProjectLinks={linear.links}
        busy={false}
        onCancel={onCancel}
        onSave={onSave}
        onSaveMany={onSaveMany}
      />,
    ),
  );
}
async function renderClone(projects: AgentProject[] = []) {
  await act(async () =>
    root.render(
      <GitCloneForm
        projects={projects}
        busy={false}
        recovery={null}
        onCancel={onCancel}
        onClone={onClone}
        onOpenPreserved={vi.fn(async () => {})}
      />,
    ),
  );
}
function expectNotification(message: string, tone = "error") {
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({ message, tone }),
  );
}
function button(text: string) {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.textContent === text || item.getAttribute("aria-label") === text,
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function options(text: string) {
  const summary = [...document.querySelectorAll<HTMLElement>("summary")].find(
    (item) => item.textContent === text,
  );
  if (!summary) throw new Error(`Missing options: ${text}`);
  return summary.parentElement as HTMLDetailsElement;
}
async function toggleOptions(text: string) {
  const details = options(text);
  await act(async () => details.querySelector("summary")!.click());
  return details;
}
function field(label: string) {
  const labelElement = [...document.querySelectorAll("label")].find(
    (item) => item.textContent === label,
  )!;
  return document.getElementById(labelElement.htmlFor)! as HTMLInputElement;
}
async function input(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    setInputValue(element, value);
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function choose(option: string) {
  await chooseField("Environnement", option);
}
async function chooseField(label: string, option: string) {
  const select = field(label) as unknown as HTMLSelectElement;
  const value = [...select.options].find(
    (item) => item.textContent === option,
  )!.value;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function environmentControl() {
  return document.querySelector<HTMLSelectElement>(
    '[aria-label="Environnement"]',
  )!;
}
function selectedPath() {
  return (
    document.querySelector<HTMLElement>(
      ".agent-folder-path, .agent-ssh-browser code",
    )?.textContent ?? ""
  );
}

it("disables the visible group checkboxes while busy", async () => {
  await act(async () =>
    root.render(
      <AgentProjectGroupForm
        projects={[{ ...localProject, name: "Projet", path: "/fixed" }]}
        busy
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    ),
  );
  const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");

  await act(async () => checkbox.click());

  expect(checkbox.getAttribute("aria-checked")).toBe("false");
});

it("shows the selected project count", async () => {
  const projects = [
    { ...localProject, id: "one", name: "One", path: "/one" },
    { ...localProject, id: "two", name: "Two", path: "/two" },
  ];
  await act(async () =>
    root.render(
      <AgentProjectGroupForm
        group={{
          id: "group",
          name: "Group",
          projectIds: ["one"],
          groupProjectId: null,
          collapsed: false,
        }}
        projects={projects}
        busy={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    ),
  );
  const checkboxes = container.querySelectorAll<HTMLElement>(
    '.agent-group-projects [role="checkbox"]',
  );
  expect(container.textContent).toContain("1 sélectionné");

  await act(async () => checkboxes[1].click());

  expect(container.textContent).toContain("2 sélectionnés");
});

it("selects a local folder exactly, suggests a blank name, restores focus, and never saves automatically", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/tmp/source  ",
    suggestedName: "source",
    environment: localProject.environment,
  });
  await render();
  await click("Choisir un dossier…");
  expect(api.pickAgentProjectDirectory).toHaveBeenCalledWith(
    localProject.environment,
    null,
    "Choisir un dossier de projet",
  );
  expect(selectedPath()).toBe("/tmp/source  ");
  expect(field("Nom affiché").value).toBe("source");
  expect(onSave).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button("Choisir un dossier…"));
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ name: "source", path: "/tmp/source  " }),
    null,
  );
});

it("keeps a project's appearance when renaming it", async () => {
  const appearance = {
    icon: "rocket",
    color: "#37a3a5",
    iconDataUrl: "data:image/png;base64,b2xk",
  };
  await render({
    ...localProject,
    name: "Projet",
    path: "/fixed",
    ...appearance,
  });
  await input("Nom affiché", "Renommé");
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Renommé", ...appearance }),
    null,
  );
});

it("switches a local picker result to WSL and saves its Linux path", async () => {
  const environment = { kind: "wsl" as const, distribution: "Ubuntu-24.04" };
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/home/user/Projects/Example",
    suggestedName: "Example",
    environment,
  });
  await render();
  await click("Choisir un dossier…");
  expect(environmentControl().value).toBe("wsl:Ubuntu-24.04");
  expect(selectedPath()).toBe("/home/user/Projects/Example");
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/home/user/Projects/Example",
      environment,
    }),
    null,
  );
});

it("links a project to a Linear project only once a Linear key exists", async () => {
  const editedProject = { ...localProject, name: "Projet", path: "/fixed" };
  const otherProject = { ...localProject, id: "p2", name: "Autre" };
  const links = [{ projectId: "p2", linearProjectId: "linear-beta" }];
  const linearLabel = () =>
    [...document.querySelectorAll("label")].some(
      (label) => label.textContent === "Projet Linear",
    );
  await render(editedProject, false, [editedProject, otherProject], {
    linkable: true,
    links,
  });
  expect(linearLabel()).toBe(false);
  expect(listLinearProjects).not.toHaveBeenCalled();

  await act(async () => root.unmount());
  root = createRoot(container);
  vi.mocked(hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(listLinearProjects).mockResolvedValue([
    { id: "linear-alpha", name: "Alpha", teams: ["Engineering"] },
    { id: "linear-beta", name: "Beta", teams: [] },
  ]);
  await render(editedProject, false, [editedProject, otherProject], {
    linkable: true,
    links,
  });
  const linearField = field("Projet Linear") as unknown as HTMLSelectElement;
  expect(
    [...linearField.options].find((option) => option.value === "linear-beta")
      ?.disabled,
  ).toBe(true);
  await chooseField("Projet Linear", "Alpha");
  await click("Enregistrer");

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ id: "p1", path: "/fixed" }),
    "linear-alpha",
  );
});

it("preserves a custom name and all fields when native selection is cancelled", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue(null);
  await render({ ...localProject, name: "  Mon nom  ", path: "/old" });
  await click("Choisir un dossier…");
  expect(api.pickAgentProjectDirectory).toHaveBeenCalledWith(
    localProject.environment,
    "/old",
    expect.any(String),
  );
  expect(field("Nom affiché").value).toBe("  Mon nom  ");
  expect(selectedPath()).toBe("/old");
  expect(document.activeElement).toBe(button("Choisir un dossier…"));
});

it("clears path validation after a successful selection and preserves the exact custom name", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/valid",
    suggestedName: "valid",
    environment: localProject.environment,
  });
  await render({ ...localProject, name: "  Mon nom  ", path: "relative" });
  await click("Enregistrer");
  expectNotification(
    "Saisissez un chemin absolu pour l’environnement sélectionné.",
  );
  await click("Choisir un dossier…");
  expect(getNotifications()).toEqual([]);
  expect(field("Nom affiché").value).toBe("  Mon nom  ");
});

it("leaves a root selection unnamed when no name is suggested", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/",
    suggestedName: null,
    environment: localProject.environment,
  });
  await render();
  await click("Choisir un dossier…");
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expectNotification("Saisissez un nom.");
  expect(onSave).not.toHaveBeenCalled();
});

it("uses the selected WSL environment for folder selection", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/home/me/work",
    suggestedName: "work",
    environment: { kind: "wsl", distribution: "Ubuntu" },
  });
  await render({ ...localProject, name: "Projet", path: "/old" });
  await choose("WSL · Ubuntu");
  expect(selectedPath()).toBe("");
  await click("Choisir un dossier…");
  expect(api.pickAgentProjectDirectory).toHaveBeenCalledWith(
    { kind: "wsl", distribution: "Ubuntu" },
    null,
    expect.any(String),
  );
});

it("clears a selected path only when environment or WSL distribution really changes", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/ubuntu",
    suggestedName: "ubuntu",
    environment: { kind: "wsl", distribution: "Ubuntu" },
  });
  await render({ ...localProject, name: "Projet", path: "/keep" });
  await choose("Local");
  expect(selectedPath()).toBe("/keep");
  await choose("WSL · Ubuntu");
  expect(selectedPath()).toBe("");
  await click("Choisir un dossier…");
  expect(selectedPath()).toBe("/ubuntu");
  await choose("WSL · Debian");
  expect(selectedPath()).toBe("");
  expect(field("Nom affiché").value).toBe("Projet");
});

it("notifies picker errors without backend text, keeps the draft, and retries successfully", async () => {
  vi.mocked(api.pickAgentProjectDirectory)
    .mockRejectedValueOnce(new Error("Sélection impossible"))
    .mockResolvedValueOnce({
      path: "/new",
      suggestedName: "new",
      environment: localProject.environment,
    });
  await render({ ...localProject, path: "/old" });
  await click("Choisir un dossier…");
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message: "L’opération a échoué. Réessayez.",
      tone: "error",
    }),
  ]);
  expect(selectedPath()).toBe("/old");
  expect(document.activeElement).toBe(button("Choisir un dossier…"));
  await click("Choisir un dossier…");
  expect(getNotifications()).toEqual([]);
  expect(selectedPath()).toBe("/new");
});

it("replaces a picker error with path validation and clears it once valid", async () => {
  vi.mocked(api.pickAgentProjectDirectory)
    .mockRejectedValueOnce(new Error("Sélection impossible"))
    .mockResolvedValueOnce({
      path: "/valid",
      suggestedName: "valid",
      environment: localProject.environment,
    });
  await render({ ...localProject, name: "Projet", path: "relative" });
  await click("Choisir un dossier…");
  expectNotification("L’opération a échoué. Réessayez.");
  await click("Enregistrer");
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message: "Saisissez un chemin absolu pour l’environnement sélectionné.",
      tone: "error",
    }),
  ]);
  await click("Choisir un dossier…");
  await click("Enregistrer");
  expect(getNotifications()).toEqual([]);
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/valid" }),
    null,
  );
});

it("synchronously blocks duplicate picking, submit, close, Escape, outside click and environment changes", async () => {
  const pending = deferred<AgentProjectDirectory | null>();
  vi.mocked(api.pickAgentProjectDirectory).mockReturnValue(pending.promise);
  await render({ ...localProject, name: "Projet", path: "/old" });
  await act(async () => {
    button("Choisir un dossier…").click();
    button("Choisir un dossier…").click();
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    button("Annuler").click();
    const environment = environmentControl();
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(environment, "wsl:Ubuntu");
    environment.dispatchEvent(new Event("change", { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
  });
  expect(api.pickAgentProjectDirectory).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(environmentControl().disabled).toBe(true);
  expect(button("Enregistrer").disabled).toBe(true);
  expect(environmentControl().value).toBe("local");
  expect(button("Sélection du dossier…").disabled).toBe(true);
  await act(async () =>
    pending.resolve({
      path: "/new",
      suggestedName: "new",
      environment: localProject.environment,
    }),
  );
  expect(selectedPath()).toBe("/new");
  expect(document.activeElement).toBe(button("Choisir un dossier…"));
});

it("ignores a picker resolution after unmount", async () => {
  const pending = deferred<AgentProjectDirectory | null>();
  vi.mocked(api.pickAgentProjectDirectory).mockReturnValue(pending.promise);
  await render();
  await click("Choisir un dossier…");
  await act(async () => root.unmount());
  await act(async () =>
    pending.resolve({
      path: "/late",
      suggestedName: "late",
      environment: localProject.environment,
    }),
  );
  expect(onSave).not.toHaveBeenCalled();
});

it("locks environment and folder for projects with sessions but still permits renaming", async () => {
  await render({ ...localProject, name: "Old", path: "/fixed" }, true);
  expect(environmentControl().disabled).toBe(true);
  expect(button("Choisir un dossier…").disabled).toBe(true);
  expect(selectedPath()).toBe("/fixed");
  await input("Nom affiché", "  New  ");
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ name: "New", path: "/fixed" }),
    null,
  );
  expect(api.pickAgentProjectDirectory).not.toHaveBeenCalled();
});

it("keeps local folder selection available when WSL discovery fails", async () => {
  vi.mocked(api.discoverAgentEnvironments).mockRejectedValueOnce(
    new Error("WSL indisponible"),
  );
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/local",
    suggestedName: "local",
    environment: localProject.environment,
  });
  await render();
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message:
        "La découverte WSL est indisponible. Les projets locaux restent utilisables.",
      tone: "warning",
      action: expect.objectContaining({
        label: "Actualiser les environnements",
      }),
    }),
  ]);
  await click("Choisir un dossier…");
  expect(selectedPath()).toBe("/local");
  vi.mocked(api.discoverAgentEnvironments).mockClear();
  await act(async () => getNotifications()[0].action!.onAction());
  expect(api.discoverAgentEnvironments).toHaveBeenCalledOnce();
  expect(getNotifications()).toEqual([]);
});

it("saves visible SSH settings", async () => {
  const sshProject: AgentProject = {
    id: "ssh",
    name: "Remote",
    path: "/srv/app",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "server.example",
        user: "dev",
        port: 2222,
        identityFile: "/keys/old",
        hostKey: null,
      },
    },
  };
  await render(sshProject);
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ environment: sshProject.environment }),
    null,
  );

  expect(field("Utilisateur (facultatif)").value).toBe("dev");
  expect(field("Port (facultatif)").value).toBe("2222");
});

it("keeps invalid SSH ports visible and prevents saving", async () => {
  const sshProject: AgentProject = {
    id: "ssh",
    name: "Remote",
    path: "/srv/app",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "server.example",
        user: null,
        port: 70000,
        identityFile: null,
        hostKey: null,
      },
    },
  };
  await render(sshProject);
  expect(field("Port (facultatif)").closest("details")).toBeNull();
  await click("Enregistrer");
  expect(field("Port (facultatif)").validity.rangeOverflow).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});

it("locks SSH fields while choosing an identity and restores focus", async () => {
  const pending = deferred<string | null>();
  vi.mocked(api.pickAgentSshIdentity).mockReturnValue(pending.promise);
  const sshProject: AgentProject = {
    id: "ssh",
    name: "Remote",
    path: "/srv/app",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "server.example",
        user: null,
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  };
  await render(sshProject);
  await click("Choisir la clé…");
  expect(field("Port (facultatif)").disabled).toBe(true);
  expect(field("Utilisateur (facultatif)").disabled).toBe(true);
  expect(button("Choisir un dossier…").disabled).toBe(true);
  await act(async () => pending.resolve("/keys/new"));
  expect(field("Clé privée (facultative)").value).toBe("/keys/new");
  expect(document.activeElement).toBe(button("Choisir la clé…"));
});

it("derives a new SSH project name from its selected folder", async () => {
  vi.mocked(api.browseAgentSsh).mockResolvedValue({
    path: "/home/mode",
    parentPath: "/home",
    directories: [],
  });
  await render(null);
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir un dossier…");
  expect(button("Retour")).toBeTruthy();

  await click("Retour");
  expect(document.querySelector(".agent-ssh-browser")).toBeNull();
  expect(selectedPath()).toBe("");
  expect(document.activeElement).toBe(button("Choisir un dossier…"));

  await click("Choisir un dossier…");
  await click("Sélectionner ce dossier");
  expect(document.querySelector(".agent-ssh-browser")).toBeNull();
  expect(selectedPath()).toBe("/home/mode");
  await click("Enregistrer");

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ name: "mode", path: "/home/mode" }),
    null,
  );
});

it("blocks Enter on SSH batch checkboxes while preserving Space", async () => {
  vi.mocked(api.browseAgentSsh).mockResolvedValue({
    path: "/workspaces",
    parentPath: "/",
    directories: [{ name: "crawler", path: "/workspaces/crawler" }],
  });
  await render(null);
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir un dossier…");
  const form = document.querySelector("form")!;
  const submitted = vi.fn((event: Event) => event.preventDefault());
  form.addEventListener("submit", submitted);
  const multiple = [...document.querySelectorAll("label")]
    .find((label) => label.textContent === "Sélectionner plusieurs projets")!
    .querySelector<HTMLElement>('[role="checkbox"]')!;

  await act(async () => {
    multiple.focus();
    multiple.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
  });
  expect(submitted).not.toHaveBeenCalled();
  expect(multiple.getAttribute("aria-checked")).toBe("false");

  await act(async () => {
    multiple.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    multiple.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(multiple.getAttribute("aria-checked")).toBe("true");
  await act(async () =>
    document
      .querySelector<HTMLElement>('[aria-label="Sélectionner crawler"]')!
      .click(),
  );
  const group = [...document.querySelectorAll("label")]
    .find(
      (label) => label.textContent === "Regrouper les projets sélectionnés",
    )!
    .querySelector<HTMLElement>('[role="checkbox"]')!;

  await act(async () => {
    group.focus();
    group.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
  });
  expect(submitted).not.toHaveBeenCalled();
  expect(group.getAttribute("aria-checked")).toBe("false");
});

it("keeps batch project and group IDs stable across selections", async () => {
  vi.mocked(api.browseAgentSsh).mockResolvedValue({
    path: "/workspaces",
    parentPath: "/",
    directories: [
      { name: "crawler", path: "/workspaces/crawler" },
      { name: "api", path: "/workspaces/api" },
    ],
  });
  await render(null);
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir un dossier…");
  await act(async () =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent === "Sélectionner plusieurs projets")!
      .click(),
  );
  await act(async () => {
    document
      .querySelector<HTMLElement>('[aria-label="Sélectionner crawler"]')!
      .closest<HTMLElement>("label")!
      .click();
    document
      .querySelector<HTMLElement>('[aria-label="Sélectionner api"]')!
      .closest<HTMLElement>("label")!
      .click();
  });
  await act(async () =>
    [...document.querySelectorAll("label")]
      .find(
        (label) => label.textContent === "Regrouper les projets sélectionnés",
      )!
      .querySelector<HTMLElement>('[role="checkbox"]')!
      .click(),
  );
  await input("Nom du groupe", "Services");
  await click("Sélectionner 2 projets");
  expect(selectedPath()).toBe("2 projets");
  await click("Enregistrer");

  await click("Choisir un dossier…");
  await act(async () =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent === "Sélectionner plusieurs projets")!
      .click(),
  );
  await act(async () => {
    document
      .querySelector<HTMLElement>('[aria-label="Sélectionner api"]')!
      .closest<HTMLElement>("label")!
      .click();
    document
      .querySelector<HTMLElement>('[aria-label="Sélectionner crawler"]')!
      .closest<HTMLElement>("label")!
      .click();
  });
  await act(async () =>
    [...document.querySelectorAll("label")]
      .find(
        (label) => label.textContent === "Regrouper les projets sélectionnés",
      )!
      .querySelector<HTMLElement>('[role="checkbox"]')!
      .click(),
  );
  await input("Nom du groupe", "Backends");
  await click("Sélectionner 2 projets");
  await click("Enregistrer");

  expect(onSave).not.toHaveBeenCalled();
  expect(onSaveMany).toHaveBeenCalledTimes(2);
  const [firstProjects, firstName, firstGroupId] = onSaveMany.mock.calls[0] as [
    AgentProject[],
    string | null,
    string,
  ];
  const [secondProjects, secondName, secondGroupId] = onSaveMany.mock
    .calls[1] as [AgentProject[], string | null, string];
  expect(firstProjects).toEqual([
    expect.objectContaining({
      id: expect.any(String),
      name: "crawler",
      path: "/workspaces/crawler",
      environment: expect.objectContaining({
        kind: "ssh",
        ssh: expect.objectContaining({ host: "server.example" }),
      }),
    }),
    expect.objectContaining({
      id: expect.any(String),
      name: "api",
      path: "/workspaces/api",
    }),
  ]);
  expect(
    Object.fromEntries(firstProjects.map(({ id, path }) => [path, id])),
  ).toEqual(
    Object.fromEntries(secondProjects.map(({ id, path }) => [path, id])),
  );
  expect([firstName, secondName]).toEqual(["Services", "Backends"]);
  expect(secondGroupId).toBe(firstGroupId);
});

it("retries the exact pinned browse after unknown-host confirmation fails", async () => {
  const key = "ssh-ed25519 AAAATEST";
  vi.mocked(api.scanAgentSshHost).mockResolvedValue([
    { key, fingerprint: "SHA256:verified" },
  ]);
  vi.mocked(api.browseAgentSsh)
    .mockRejectedValueOnce(
      new Error(
        "Connexion SSH interrompue.\nNo ED25519 host key is known for server.example and you have requested strict checking.\nHost key verification failed.",
      ),
    )
    .mockRejectedValueOnce(new Error("Permission denied (publickey)"))
    .mockResolvedValueOnce({
      path: "/home/dev",
      parentPath: "/home",
      directories: [{ name: "repo", path: "/home/dev/repo" }],
    })
    .mockResolvedValueOnce({
      path: "/home/dev/repo",
      parentPath: "/home/dev",
      directories: [],
    });
  await render({
    id: "ssh",
    name: "Remote",
    path: "/srv/requested",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: " server.example ",
        user: " dev ",
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  });
  await click("Choisir un dossier…");

  expect(api.browseAgentSsh).toHaveBeenNthCalledWith(
    1,
    {
      host: "server.example",
      user: "dev",
      port: null,
      identityFile: null,
      hostKey: null,
    },
    "/srv/requested",
  );
  expect(api.scanAgentSshHost).toHaveBeenCalledWith({
    host: "server.example",
    user: "dev",
    port: null,
    identityFile: null,
    hostKey: null,
  });
  expect(getNotifications()).toEqual([]);
  expect(container.textContent).toContain("Serveur : dev@server.example");
  expect(container.textContent).toContain("SHA256:verified");
  expect(api.browseAgentSsh).toHaveBeenCalledTimes(1);
  expect(button("Choisir un dossier…").disabled).toBe(true);
  expect(document.activeElement).toBe(button("Faire confiance et continuer"));

  await click("Faire confiance et continuer");

  const trustedConnection = {
    host: "server.example",
    user: "dev",
    port: null,
    identityFile: null,
    hostKey: key,
  };
  expect(api.browseAgentSsh).toHaveBeenLastCalledWith(
    trustedConnection,
    "/srv/requested",
  );
  expectNotification(
    "L’authentification SSH a été refusée. Vérifiez l’utilisateur et la clé privée, ou déverrouillez une clé chiffrée dans ssh-agent, puis réessayez.",
  );
  await act(async () => getNotifications()[0].action!.onAction());
  expect(api.browseAgentSsh).toHaveBeenCalledTimes(3);
  expect(api.browseAgentSsh).toHaveBeenLastCalledWith(
    trustedConnection,
    "/srv/requested",
  );
  expect(selectedPath()).toBe("/home/dev");
  expect(container.textContent).toContain("Identité du serveur confirmée");
  expect(container.textContent).not.toContain("AAAATEST");
  await click("repo");
  expect(api.browseAgentSsh).toHaveBeenLastCalledWith(
    expect.objectContaining({ hostKey: key }),
    "/home/dev/repo",
  );
  expect(selectedPath()).toBe("/home/dev/repo");
});

it("cancels unknown-host trust without pinning or retrying", async () => {
  vi.mocked(api.browseAgentSsh).mockRejectedValue(
    new Error(
      "No ED25519 host key is known for cancel.example and you have requested strict checking.\nHost key verification failed.",
    ),
  );
  vi.mocked(api.scanAgentSshHost).mockResolvedValue([
    { key: "ssh-ed25519 CANCEL", fingerprint: "SHA256:cancel" },
  ]);
  await render();
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "cancel.example");
  await click("Choisir un dossier…");
  await click("Annuler");

  expect(api.browseAgentSsh).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("SHA256:cancel");
  expect(container.textContent).not.toContain("Identité du serveur confirmée");
  expect(document.activeElement).toBe(button("Choisir un dossier…"));
});

it.each([
  [
    "[SSH/keyRequiresAgent]\nConnexion SSH interrompue.\nubuntu@server: Permission denied (publickey).",
    "La clé privée sélectionnée est protégée par une phrase secrète, mais aucune clé déverrouillée n’est disponible via ssh-agent. Démarrez l’agent si nécessaire, chargez votre clé avec ssh-add, puis réessayez. Soreno ne peut pas demander la phrase secrète.",
  ],
  [
    "Délai SSH dépassé",
    "La connexion SSH a expiré. Vérifiez l’hôte, le port, le réseau, le VPN ou le pare-feu, puis réessayez.",
  ],
  [
    "OpenSSH indisponible",
    "OpenSSH est indisponible. Installez ou activez la commande ssh sur cet ordinateur, puis réessayez.",
  ],
])("shows actionable SSH guidance for %s", async (backendMessage, expected) => {
  vi.mocked(api.browseAgentSsh).mockRejectedValue(new Error(backendMessage));
  await render();
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir un dossier…");

  expectNotification(expected);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
  expect(api.scanAgentSshHost).not.toHaveBeenCalled();
});

it.each([
  "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
  "WARNING: REVOKED HOST KEY DETECTED!",
  "No ED25519 host key is known for pinned.example and you have requested strict checking.\nHost key verification failed.",
  "Banner says: No ED25519 host key is known for quoted.example and you have requested strict checking.",
  "Host key verification failed.",
])(
  "never auto-discovers an unsafe or ambiguous host error: %s",
  async (message) => {
    vi.mocked(api.browseAgentSsh).mockRejectedValue(new Error(message));
    const pinned = message.includes("pinned.example")
      ? "ssh-ed25519 PINNED"
      : null;
    await act(async () =>
      root.render(
        <SshProjectFields
          id="unsafe"
          connection={{
            host: "server.example",
            user: null,
            port: null,
            identityFile: null,
            hostKey: pinned,
          }}
          path=""
          disabled={false}
          interactionLockRef={{ current: false }}
          onBusyChange={vi.fn()}
          onConnectionChange={vi.fn()}
          onPathChange={vi.fn()}
        />,
      ),
    );
    await click("Choisir un dossier…");

    expect(api.scanAgentSshHost).not.toHaveBeenCalled();
    if (/CHANGED|REVOKED/.test(message))
      expectNotification(
        "Alerte de sécurité : la clé d’hôte du serveur a changé ou a été révoquée. Ne continuez pas avant confirmation de la nouvelle empreinte par l’administrateur.",
      );
  },
);

it("rejects a selected or typed .pub identity before any SSH network call", async () => {
  vi.mocked(api.pickAgentSshIdentity).mockResolvedValue(
    "/keys/selected_ed25519.pub",
  );
  await render();
  await choose("SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir la clé…");
  expect(container.textContent).toContain(
    "Le fichier .pub ne peut pas vous authentifier.",
  );
  await input("Clé privée (facultative)", "/keys/typed_ed25519.pub");
  expect(container.textContent).toContain(
    "Le fichier .pub ne peut pas vous authentifier.",
  );
  await click("Choisir un dossier…");
  expect(api.browseAgentSsh).not.toHaveBeenCalled();
  expect(api.scanAgentSshHost).not.toHaveBeenCalled();
});

it("derives clone names", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/projects",
    suggestedName: "projects",
    environment: localProject.environment,
  });
  await renderClone();
  await input("URL du dépôt", "https://example.test/repo.git");
  await click("Choisir un dossier…");
  expect(selectedPath()).toBe("/projects");
  await click("Cloner un dépôt");
  expect(onClone).toHaveBeenCalledWith(
    expect.objectContaining({ name: "repo", folderName: "repo" }),
  );
});

it("reuses a project SSH connection to browse known_hosts and clone without mandatory pinning", async () => {
  const connection: SshConnection = {
    host: "build.example",
    user: "builder",
    port: 2222,
    identityFile: "/keys/build",
    hostKey: null,
  };
  const remote = {
    id: "remote",
    name: "Build server",
    path: "/srv/current",
    environment: { kind: "ssh" as const, distribution: null, ssh: connection },
  };
  vi.mocked(api.browseAgentSsh)
    .mockResolvedValueOnce({
      path: "/srv",
      parentPath: "/",
      directories: [{ name: "repos", path: "/srv/repos" }],
    })
    .mockResolvedValueOnce({
      path: "/srv/repos",
      parentPath: "/srv",
      directories: [],
    });
  await renderClone([remote]);
  await choose("SSH");
  await chooseField(
    "Connexion SSH",
    "Build server · builder@build.example:2222",
  );
  await click("Choisir un dossier…");
  expect(api.scanAgentSshHost).not.toHaveBeenCalled();
  expect(api.browseAgentSsh).toHaveBeenCalledWith(connection, null);
  await click("repos");
  await input("URL du dépôt", " ssh://git.example/app.git ");
  await toggleOptions("Personnalisation");
  await input("Nom affiché", " Remote clone ");
  await input("Nom du nouveau dossier", "app");
  await click("Cloner un dépôt");
  expect(onClone).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    name: "Remote clone",
    environment: remote.environment,
    parentPath: "/srv/repos",
    folderName: "app",
    url: "ssh://git.example/app.git",
  });
});

it("unpins trust when the SSH target changes and blocks save or environment races during a request", async () => {
  const pending = deferred<{
    path: string;
    parentPath: string | null;
    directories: [];
  }>();
  vi.mocked(api.browseAgentSsh).mockReturnValue(pending.promise);
  const sshProject: AgentProject = {
    id: "ssh",
    name: "Remote",
    path: "/srv/app",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "old.example",
        user: "dev",
        port: null,
        identityFile: null,
        hostKey: "ssh-ed25519 PINNED",
      },
    },
  };
  await render(sshProject);
  await input("Utilisateur (facultatif)", "other");
  expect(container.textContent).not.toContain("Identité du serveur confirmée");
  await click("Choisir un dossier…");
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const environment = environmentControl();
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(environment, "local");
    environment.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onSave).not.toHaveBeenCalled();
  expect(environmentControl().value).toBe("ssh");
  await act(async () =>
    pending.resolve({
      path: "/srv/app",
      parentPath: "/srv",
      directories: [],
    }),
  );
  expect(selectedPath()).toBe("/srv/app");
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      environment: expect.objectContaining({
        ssh: expect.objectContaining({ user: "other", hostKey: null }),
      }),
    }),
    null,
  );
});

it("updates SSH authentication for an existing project while its sessions lock the target", async () => {
  const oldKey = "ssh-ed25519 OLD";
  const newKey = "ssh-ed25519 NEW";
  vi.mocked(api.scanAgentSshHost).mockResolvedValue([
    { key: newKey, fingerprint: "SHA256:new" },
  ]);
  const sshProject: AgentProject = {
    id: "ssh",
    name: "Remote",
    path: "/srv/app",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "server.example",
        user: "dev",
        port: 22,
        identityFile: "/keys/old",
        hostKey: oldKey,
      },
    },
  };
  await render(sshProject, true);
  expect(field("Hôte ou alias OpenSSH").disabled).toBe(true);
  expect(field("Utilisateur (facultatif)").disabled).toBe(true);
  expect(field("Port (facultatif)").disabled).toBe(true);
  expect(field("Clé privée (facultative)").disabled).toBe(false);
  expect(button("Choisir un dossier…").disabled).toBe(true);
  expect(button("Revérifier l’identité du serveur").disabled).toBe(false);
  await input("Clé privée (facultative)", "/keys/new");
  expect(container.textContent).toContain("Identité du serveur confirmée");
  await click("Revérifier l’identité du serveur");
  await click("Annuler");
  expect(document.activeElement).toBe(
    button("Revérifier l’identité du serveur"),
  );
  await click("Revérifier l’identité du serveur");
  await click("Faire confiance à cette clé");
  await click("Enregistrer");
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/srv/app",
      environment: {
        kind: "ssh",
        distribution: null,
        ssh: {
          host: "server.example",
          user: "dev",
          port: 22,
          identityFile: "/keys/new",
          hostKey: newKey,
        },
      },
    }),
    null,
  );
});

it("ignores unknown-host discovery after only the external pin changes", async () => {
  vi.mocked(api.browseAgentSsh).mockRejectedValue(
    new Error(
      "No ED25519 host key is known for stale.example and you have requested strict checking.\nHost key verification failed.",
    ),
  );
  const pending = deferred<{ key: string; fingerprint: string }[]>();
  vi.mocked(api.scanAgentSshHost).mockReturnValue(pending.promise);
  const first: SshConnection = {
    host: "stale.example",
    user: null,
    port: null,
    identityFile: null,
    hostKey: null,
  };
  const second = { ...first, hostKey: "ssh-ed25519 EXTERNAL" };
  const interactionLockRef = { current: false };
  const onConnectionChange = vi.fn();
  const props = {
    id: "stale-pin",
    path: "",
    projects: [],
    disabled: false,
    interactionLockRef,
    onBusyChange: vi.fn(),
    onConnectionChange,
    onPathChange: vi.fn(),
  };
  await act(async () =>
    root.render(<SshProjectFields {...props} connection={first} />),
  );
  await act(async () => button("Choisir un dossier…").click());
  await act(async () =>
    root.render(<SshProjectFields {...props} connection={second} />),
  );
  await act(async () =>
    pending.resolve([
      { key: "ssh-ed25519 STALE", fingerprint: "SHA256:stale" },
    ]),
  );

  expect(container.textContent).not.toContain("SHA256:stale");
  expect(onConnectionChange).not.toHaveBeenCalled();
});

it("ignores a stale SSH browse response after the connection target changes", async () => {
  const pending = deferred<{
    path: string;
    parentPath: string | null;
    directories: [];
  }>();
  vi.mocked(api.browseAgentSsh).mockReturnValue(pending.promise);
  const first: SshConnection = {
    host: "old.example",
    user: null,
    port: null,
    identityFile: null,
    hostKey: null,
  };
  const second: SshConnection = { ...first, host: "new.example" };
  const interactionLockRef = { current: false };
  const onPathChange = vi.fn();
  const props = {
    id: "stale",
    path: "",
    projects: [],
    disabled: false,
    interactionLockRef,
    onBusyChange: vi.fn(),
    onConnectionChange: vi.fn(),
    onPathChange,
  };
  await act(async () =>
    root.render(<SshProjectFields {...props} connection={first} />),
  );
  await act(async () => button("Choisir un dossier…").click());
  await act(async () =>
    root.render(<SshProjectFields {...props} connection={second} />),
  );
  await act(async () =>
    pending.resolve({ path: "/old", parentPath: "/", directories: [] }),
  );
  expect(onPathChange).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("/old");
});
