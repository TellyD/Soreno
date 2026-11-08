// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/automationsApi";
import { listSkills } from "../../data/skillsApi";
import type { AgentProject, AgentSession } from "../../domain/agentSessions";
import { I18nProvider } from "../../i18n";
import { notifyError } from "../../notifications";
import { AutomationsBoard } from "./AutomationsBoard";

vi.mock("../../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("../../data/automationsApi", () => ({
  loadAgentAutomations: vi.fn(),
  saveAgentAutomation: vi.fn(),
  deleteAgentAutomation: vi.fn(),
  runAgentAutomation: vi.fn(),
  refreshAgentAutomations: vi.fn(),
  markAgentAutomationSeen: vi.fn(),
}));
vi.mock("../../notifications", async (original) => ({
  ...(await original<object>()),
  notifyError: vi.fn(),
}));
vi.mock("../../data/skillsApi", () => ({ listSkills: vi.fn() }));

const project: AgentProject = {
  id: "p1",
  name: "soreno",
  path: "/srv/soreno",
  environment: {
    kind: "ssh",
    distribution: null,
    ssh: {
      host: "devbox",
      user: null,
      port: null,
      identityFile: null,
      hostKey: null,
    },
  },
};
const session: AgentSession = {
  id: "new-session",
  projectId: "p1",
  name: "Revue du matin",
  customName: "Revue du matin",
  executable: "claude",
  args: [],
  createdAt: "2026-10-23T08:00:00Z",
  favorite: true,
};

let root: Root;
let host: HTMLDivElement;
const onCreateSession = vi.fn();
const onDeleteSession = vi.fn();
const onRenameSession = vi.fn();
const onServerReached = vi.fn();
const onOpenSession = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom lacks PointerEvent, which the Base UI switch dispatches on click.
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.mocked(api.loadAgentAutomations).mockResolvedValue([]);
  vi.mocked(api.refreshAgentAutomations).mockResolvedValue([]);
  vi.mocked(listSkills).mockResolvedValue({ skills: [] });
  onCreateSession.mockResolvedValue(session.id);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(sessions = [session]) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <AutomationsBoard
          visible
          projects={[project]}
          sessions={sessions}
          disconnectedProjectIds={[]}
          blockedProjectIds={[]}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
          onOpenSession={onOpenSession}
          onConnectProject={vi.fn()}
          onServerReached={onServerReached}
        />
      </I18nProvider>,
    ),
  );
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;

async function createAutomation() {
  await act(async () => button("Nouvelle automatisation").click());
  await act(async () => {
    type(
      host.querySelector("label.automations-section input")!,
      "Revue du matin",
    );
    type(host.querySelector("textarea")!, "/revue-du-matin");
  });
  await act(async () => button("Créer").click());
}

it("removes the new session when the server refuses its automation", async () => {
  vi.mocked(api.saveAgentAutomation).mockRejectedValue(
    "systemd utilisateur est indisponible pour ce compte",
  );
  await render();
  await createAutomation();

  expect(onCreateSession).toHaveBeenCalledWith(
    "p1",
    "claude",
    "Revue du matin",
  );
  expect(onDeleteSession).toHaveBeenCalledWith(session.id);
  expect(notifyError).toHaveBeenCalledWith(
    "systemd utilisateur est indisponible pour ce compte",
  );
  expect(onServerReached).not.toHaveBeenCalled();
  expect(host.querySelector(".automations-list li")).toBeNull();
});

it("lists a created automation with its schedule in this computer's zone", async () => {
  vi.mocked(api.saveAgentAutomation).mockImplementation(async (input) => ({
    ...input,
    lastRun: null,
    seenRunAt: null,
  }));
  await render();
  await createAutomation();

  expect(api.saveAgentAutomation).toHaveBeenCalledWith({
    sessionId: session.id,
    prompt: "/revue-du-matin",
    frequency: "weekdays",
    weekday: 1,
    time: "08:00",
    enabled: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  expect(onDeleteSession).not.toHaveBeenCalled();
  const row = host.querySelector(".automations-list li")!;
  expect(row.textContent).toContain("Revue du matin");
  expect(row.textContent).toContain("08:00");
});

it("keeps another automation open when a creation finishes behind it", async () => {
  const other: AgentSession = {
    ...session,
    id: "other-session",
    name: "Rapport",
    customName: "Rapport",
  };
  const automation = {
    sessionId: other.id,
    prompt: "/rapport",
    frequency: "daily" as const,
    weekday: 1,
    time: "08:00",
    timeZone: "Europe/Paris",
    enabled: true,
    lastRun: null,
    seenRunAt: null,
  };
  vi.mocked(api.loadAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.refreshAgentAutomations).mockResolvedValue([automation]);
  let finish!: () => void;
  vi.mocked(api.saveAgentAutomation).mockImplementation(
    (input) =>
      new Promise((resolve) => {
        finish = () => resolve({ ...input, lastRun: null, seenRunAt: null });
      }),
  );
  await render([session, other]);
  await createAutomation();
  expect(api.saveAgentAutomation).toHaveBeenCalledTimes(1);

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".automations-list li button")!
      .click(),
  );
  await act(async () => type(host.querySelector("textarea")!, "/autre"));
  await act(async () => finish());

  expect(onServerReached).toHaveBeenCalled();
  expect(host.querySelector("textarea")!.value).toBe("/autre");
});

it.each([
  [true, 1],
  [false, 0],
])(
  "marks an unread run seen only once its session opened (%s)",
  async (opened, calls) => {
    const automations = [
      {
        sessionId: session.id,
        prompt: "/revue-du-matin",
        frequency: "daily" as const,
        weekday: 1,
        time: "08:00",
        timeZone: "Europe/Paris",
        enabled: true,
        lastRun: {
          at: 200,
          outcome: "started" as const,
          exitCode: null,
          running: true,
        },
        seenRunAt: 100,
      },
    ];
    vi.mocked(api.loadAgentAutomations).mockResolvedValue(automations);
    vi.mocked(api.refreshAgentAutomations).mockResolvedValue(automations);
    vi.mocked(api.markAgentAutomationSeen).mockReturnValue(
      new Promise(() => undefined),
    );
    onOpenSession.mockResolvedValue(opened);
    await render();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(".automations-list li button")!
        .click(),
    );
    await act(async () => button("Ouvrir la session").click());

    expect(onOpenSession).toHaveBeenCalledWith(session.id);
    expect(api.markAgentAutomationSeen).toHaveBeenCalledTimes(calls);
  },
);

it("pauses at once from the saved schedule, leaving a pending edit unsaved", async () => {
  const automation = {
    sessionId: session.id,
    prompt: "/revue-du-matin",
    frequency: "daily" as const,
    weekday: 1,
    time: "08:00",
    timeZone: "Europe/Paris",
    enabled: true,
    lastRun: null,
    seenRunAt: null,
  };
  vi.mocked(api.loadAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.refreshAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.saveAgentAutomation).mockImplementation(async (input) => ({
    ...input,
    lastRun: null,
    seenRunAt: null,
  }));
  await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".automations-list li button")!
      .click(),
  );
  await act(async () => type(host.querySelector("textarea")!, "/autre"));
  const active = host.querySelector<HTMLElement>(
    '.automations-active [role="switch"]',
  )!;
  await act(async () => active.click());

  expect(api.saveAgentAutomation).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prompt: "/revue-du-matin", enabled: false }),
  );
  expect(active.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("textarea")!.value).toBe("/autre");
  expect(button("Enregistrer").disabled).toBe(false);
});

it("renames an automation without reaching its server", async () => {
  const automation = {
    sessionId: session.id,
    prompt: "/revue-du-matin",
    frequency: "daily" as const,
    weekday: 1,
    time: "08:00",
    timeZone: "Europe/Paris",
    enabled: true,
    lastRun: null,
    seenRunAt: null,
  };
  vi.mocked(api.loadAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.refreshAgentAutomations).mockResolvedValue([automation]);
  onRenameSession.mockResolvedValue(true);
  await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".automations-list li button")!
      .click(),
  );
  await act(async () =>
    type(
      host.querySelector("label.automations-section input")!,
      "  Revue du soir ",
    ),
  );
  await act(async () => button("Enregistrer").click());

  expect(onRenameSession).toHaveBeenCalledExactlyOnceWith(
    session.id,
    "Revue du soir",
  );
  expect(api.saveAgentAutomation).not.toHaveBeenCalled();
});

it("keeps a rename made elsewhere when saving another change", async () => {
  const automation = {
    sessionId: session.id,
    prompt: "/revue-du-matin",
    frequency: "daily" as const,
    weekday: 1,
    time: "08:00",
    timeZone: "Europe/Paris",
    enabled: true,
    lastRun: null,
    seenRunAt: null,
  };
  vi.mocked(api.loadAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.refreshAgentAutomations).mockResolvedValue([automation]);
  vi.mocked(api.saveAgentAutomation).mockImplementation(async (input) => ({
    ...input,
    lastRun: null,
    seenRunAt: null,
  }));
  await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".automations-list li button")!
      .click(),
  );
  await render([
    { ...session, name: "Revue du soir", customName: "Revue du soir" },
  ]);
  await act(async () => type(host.querySelector("textarea")!, "/autre"));
  await act(async () => button("Enregistrer").click());

  expect(onRenameSession).not.toHaveBeenCalled();
  expect(api.saveAgentAutomation).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prompt: "/autre" }),
  );
});

it("completes `/` with the project's and server's skills in the agent's syntax", async () => {
  const skill = (name: string, description: string) => ({
    name,
    title: name,
    description,
    source: null,
  });
  vi.mocked(listSkills).mockImplementation(async ({ scope }) => ({
    skills:
      scope === "project"
        ? [skill("revue-du-matin", "Projet")]
        : [skill("revue-du-matin", "Serveur"), skill("rapport", "Hebdo")],
  }));
  await render();
  await act(async () => button("Nouvelle automatisation").click());
  const prompt = host.querySelector("textarea")!;
  await act(async () => type(prompt, "/rev"));

  expect(listSkills).toHaveBeenCalledWith({
    scope: "project",
    projectId: "p1",
  });
  expect(listSkills).toHaveBeenCalledWith({ scope: "global", projectId: "p1" });
  // The project's copy wins over the server's, and only matching skills are offered.
  const options = [...host.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toContain("Projet");

  await act(async () =>
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(prompt.value).toBe("/revue-du-matin ");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
});

it("leaves an IME composition's Enter to the input method", async () => {
  vi.mocked(listSkills).mockResolvedValue({
    skills: [
      {
        name: "revue-du-matin",
        title: "revue-du-matin",
        description: "Projet",
        source: null,
      },
    ],
  });
  await render();
  await act(async () => button("Nouvelle automatisation").click());
  const prompt = host.querySelector("textarea")!;
  await act(async () => type(prompt, "/rev"));
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);

  // WebKit commits a composition with keyCode 229 and isComposing false.
  await act(async () =>
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
      }),
    ),
  );
  expect(prompt.value).toBe("/rev");
});

it("scrolls the option ↑ wraps to into view", async () => {
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  try {
    vi.mocked(listSkills).mockResolvedValue({
      skills: ["a", "b", "c"].map((name) => ({
        name,
        title: name,
        description: null,
        source: null,
      })),
    });
    await render();
    await act(async () => button("Nouvelle automatisation").click());
    const prompt = host.querySelector("textarea")!;
    await act(async () => type(prompt, "/"));
    scrollIntoView.mockClear();
    await act(async () =>
      prompt.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );

    const options = host.querySelectorAll('[role="option"]');
    expect(
      scrollIntoView.mock.instances[scrollIntoView.mock.instances.length - 1],
    ).toBe(options[2]);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  } finally {
    if (original)
      Object.defineProperty(Element.prototype, "scrollIntoView", original);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

it("shows a run the server starts while the view stays open", async () => {
  vi.useFakeTimers();
  try {
    const automation = {
      sessionId: session.id,
      prompt: "/revue-du-matin",
      frequency: "daily" as const,
      weekday: 1,
      time: "08:00",
      timeZone: "Europe/Paris",
      enabled: true,
      lastRun: null,
      seenRunAt: null,
    };
    vi.mocked(api.loadAgentAutomations).mockResolvedValue([automation]);
    vi.mocked(api.refreshAgentAutomations).mockResolvedValue([automation]);
    await render();
    const unread = () => host.querySelector('.automations-list [role="img"]');
    expect(unread()).toBeNull();

    vi.mocked(api.refreshAgentAutomations).mockResolvedValue([
      {
        ...automation,
        lastRun: { at: 200, outcome: "started", exitCode: null, running: true },
      },
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));

    expect(api.refreshAgentAutomations).toHaveBeenCalledTimes(2);
    expect(unread()).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
