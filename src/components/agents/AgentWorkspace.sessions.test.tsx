// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  runtime,
  container,
  root,
  sidebarContainer,
  gitPanelContainer,
  data,
  project,
  terminalSplitsKey,
  session,
  setStatus,
  render,
  requestSession,
  button,
  click,
  dialog,
  action,
  newAgent,
  projectNames,
  setSidebarContainer,
  setGitPanelContainer,
  type WorkspaceData,
  notificationMessages,
  retryFromNotification,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as attentionApi from "../../data/agentAttentionApi";
import { getNotifications } from "../../notifications";

it("filters projects without agents from the rail toggle and keeps the filter visible", async () => {
  data.projects.push({
    ...project,
    id: "p2",
    name: "Sans agent",
    path: "/projects/empty",
  });
  await render();
  const onlyWithAgents = () => button("Uniquement les projets avec agents");

  expect(projectNames()).toEqual(["Soreno", "Sans agent"]);
  expect(onlyWithAgents().getAttribute("aria-pressed")).toBe("false");
  await act(async () => onlyWithAgents().click());
  expect(projectNames()).toEqual(["Soreno"]);
  expect(
    container.querySelector(".agent-rail-filter-notice span")?.textContent,
  ).toBe("1 projet masqué");

  await act(async () => root.render(null));
  await render();
  expect(projectNames()).toEqual(["Soreno"]);
  expect(onlyWithAgents().getAttribute("aria-pressed")).toBe("true");
  await act(async () => onlyWithAgents().click());
  expect(projectNames()).toEqual(["Soreno", "Sans agent"]);
  expect(container.querySelector(".agent-rail-filter-notice")).toBeNull();

  await act(async () => onlyWithAgents().click());
  await click("Tout afficher");
  expect(projectNames()).toEqual(["Soreno", "Sans agent"]);
  expect(container.querySelector(".agent-rail-filter-notice")).toBeNull();
});

it("ranks sessions from the priority toggle and remembers it", async () => {
  vi.useFakeTimers();
  data.sessions.push({ ...session, id: "s3", name: "Stopped" });
  data.statuses.push({ sessionId: "s3", state: "exited", exitCode: 0 });
  setStatus("s2", "running");
  await render();
  data.statuses[1].working = true;
  data.statuses[1].awaiting = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const toggle = () => button("Vue par priorités");
  const sections = () =>
    [...container.querySelectorAll(".agent-rail section")].map((section) => [
      section.querySelector("h3")?.textContent,
      [...section.querySelectorAll(".agent-priority-name")].map(
        (item) => item.textContent,
      ),
    ]);

  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle().click());
  expect(sections()).toEqual([
    ["À traiter", ["Codex tests"]],
    ["En cours · 1", ["Pi notes"]],
  ]);

  await act(async () => root.render(null));
  await render();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");

  // A split tab whose parent exited stays live while its secondary pane works.
  data.statuses[1].awaiting = false;
  setStatus("s1", "exited");
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  await act(async () => root.render(null));
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(sections()).toEqual([["En cours · 1", ["Pi notes"]]]);
  expect(
    container.querySelector(".agent-priority-session .app-loading-spinner"),
  ).not.toBeNull();
});

it("shows live work in tabs and the sidebar, including hidden sessions, without confusing it with process lifetime", async () => {
  vi.useFakeTimers();
  await render();
  const row = button("Pi notes");
  const activity = container.querySelector(".agent-activity-list li")!;
  expect(row.querySelector(".agent-status-dot.is-running")).not.toBeNull();
  expect(activity.querySelector(".app-loading-spinner")).toBeNull();

  await render(true);
  data.statuses[0].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  for (const target of [row, activity]) {
    expect(
      target.querySelector(
        '.app-loading-spinner[aria-label="Agent en cours…"]',
      ),
    ).not.toBeNull();
    expect(target.querySelector(".agent-status-dot")).toBeNull();
  }
  expect(row.getAttribute("aria-busy")).toBe("true");
  expect(
    button("Codex tests").querySelector(".app-loading-spinner"),
  ).toBeNull();

  data.statuses[0].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  for (const target of [row, activity]) {
    expect(target.querySelector(".app-loading-spinner")).toBeNull();
    expect(target.querySelector(".agent-status-dot.is-unread")).not.toBeNull();
  }
  expect(row.hasAttribute("aria-busy")).toBe(false);
  await render(false);
  await click("Pi notes");
  expect(row.querySelector(".agent-status-dot.is-running")).not.toBeNull();

  // A final busy snapshot must not keep spinning after a process exit.
  data.statuses[0].working = true;
  setStatus("s1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(row.querySelector(".app-loading-spinner")).toBeNull();
  expect(row.querySelector(".agent-status-dot.is-exited")).not.toBeNull();
  await render(false);
  vi.mocked(api.startAgentSession).mockImplementationOnce(async (id) => {
    setStatus(id, "running");
    data.statuses[0].working = null;
  });
  await click("Pi notes");
  expect(row.querySelector(".app-loading-spinner")).toBeNull();
  expect(row.querySelector(".agent-status-dot.is-running")).not.toBeNull();
});

it("keeps an agent that finished out of view unread until its terminal is shown", async () => {
  vi.useFakeTimers();
  await render();
  await click("Pi notes");
  setStatus("s2", "running");
  data.statuses[0].working = true;
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[0].working = false;
  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));

  const codexActivity = container.querySelectorAll(
    ".agent-activity-list li",
  )[1];
  expect(
    button("Pi notes").querySelector(".agent-status-dot.is-running"),
  ).not.toBeNull();
  for (const target of [button("Codex tests"), codexActivity])
    expect(target.querySelector(".agent-status-dot.is-unread")).not.toBeNull();

  // A new run supersedes the unread mark until it finishes again.
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(button("Codex tests").querySelector(".agent-status-dot")).toBeNull();
  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();

  await click("Codex tests");
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-running"),
  ).not.toBeNull();
  await click("Pi notes");
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-running"),
  ).not.toBeNull();
});

it("does not mark an out-of-view agent unread while its activity is unknown", async () => {
  vi.useFakeTimers();
  await render();
  await click("Pi notes");
  setStatus("s2", "running");
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[1].working = null;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).toBeNull();

  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();
});

it("marks only the hidden secondary pane unread in its split tab", async () => {
  vi.useFakeTimers();
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s3" }),
  );
  setStatus("s2", "running");
  await render();
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();
  expect(
    button("Pi notes").querySelector(".agent-status-dot.is-unread"),
  ).toBeNull();

  await click("Pi notes");
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).toBeNull();
});

it("notifies a session out of view or under the Git panel once, tells a wait apart, opens it on click or shortcut and forgets it once closed", async () => {
  vi.useFakeTimers();
  runtime.settings.agentNotificationsEnabled = true;
  await render();
  await click("Pi notes");
  setStatus("s2", "running");
  data.statuses[1].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[1].working = false;
  data.statuses[1].lastMessage = "Tous les tests passent.";
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(attentionApi.showAgentNotification).toHaveBeenCalledTimes(1);
  expect(attentionApi.showAgentNotification).toHaveBeenCalledWith({
    title: "Codex tests",
    body: "Soreno · Tous les tests passent.",
    sessionId: "s2",
  });
  expect(attentionApi.setAgentAttentionBadge).toHaveBeenLastCalledWith(1);

  data.statuses[1].working = true;
  data.statuses[1].awaiting = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-awaiting"),
  ).not.toBeNull();
  expect(attentionApi.showAgentNotification).toHaveBeenCalledTimes(2);

  await requestSession("s2");
  expect(runtime.showWorkspace).toHaveBeenCalledTimes(1);
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(attentionApi.showAgentNotification).toHaveBeenCalledTimes(2);

  await click("Pi notes");
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true }),
    ),
  );
  expect(runtime.showWorkspace).toHaveBeenCalledTimes(2);
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");

  // The expanded Git panel covers the selected terminal.
  const setGitExpanded = vi.fn();
  await render(false, null, null, true, undefined, true, setGitExpanded);
  data.statuses[1].awaiting = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[1].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    button("Codex tests").querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();
  await requestSession("s2");
  expect(setGitExpanded).toHaveBeenLastCalledWith(false);

  // Closing a favorite's tab keeps the session but drops its mark.
  await render();
  await action("Pi notes", "Ajouter aux favoris");
  data.statuses[0].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  data.statuses[0].working = false;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(attentionApi.setAgentAttentionBadge).toHaveBeenLastCalledWith(1);
  await click("Fermer l’onglet · Pi notes");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.setAgentSessionClosed).toHaveBeenCalledWith("s1", true);
  expect(attentionApi.setAgentAttentionBadge).toHaveBeenLastCalledWith(0);
});

it("cycles the project's session tabs with Ctrl+Tab and Ctrl+Shift+Tab without launching them", async () => {
  await render();
  await click("Pi notes");
  const current = () =>
    ["Pi notes", "Codex tests"].find(
      (name) => button(name).getAttribute("aria-current") === "page",
    );
  const press = async (shiftKey = false) => {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      shiftKey,
      cancelable: true,
    });
    await act(async () => document.dispatchEvent(event));
    return event.defaultPrevented;
  };

  expect(await press()).toBe(true);
  expect(current()).toBe("Codex tests");
  expect(await press()).toBe(true);
  expect(current()).toBe("Pi notes");
  await press(true);
  expect(current()).toBe("Codex tests");
  expect(api.startAgentSession).not.toHaveBeenCalledWith("s2");
});

it("opens a notification clicked before the workspace has loaded", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await requestSession("s2");
  await act(async () => finish(structuredClone(data)));
  await vi.waitFor(() =>
    expect(button("Codex tests").getAttribute("aria-current")).toBe("page"),
  );
});

it("scrolls the selected session into the horizontal navigation", async () => {
  const original = Element.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  try {
    await render();
    await click("Codex tests");
    expect(
      scrollIntoView.mock.instances[scrollIntoView.mock.instances.length - 1],
    ).toBe(button("Codex tests"));
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  } finally {
    if (original)
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: original,
      });
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

it("keeps session updates active while hidden and resumes Git polling when shown", async () => {
  vi.useFakeTimers();
  await render();
  await click("Pi notes");
  const row = button("Pi notes");
  await act(async () =>
    runtime.titles.get("s1")!("π - Première tâche - soreno"),
  );
  expect(button("Première tâche")).toBe(row);
  expect(row.getAttribute("aria-current")).toBe("page");
  const branchReads = vi.mocked(api.listAgentBranches).mock.calls.length;
  await render(true);
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "p1", branch: "feature/agents" },
  ]);
  await act(async () => {
    runtime.titles.get("s1")!("π - Nom actualisé - soreno");
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(button("Nom actualisé")).toBe(row);
  expect(api.listAgentBranches).toHaveBeenCalledTimes(branchReads);
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("main");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(runtime.unmounts).not.toHaveBeenCalled();
  await render(false);
  expect(api.listAgentBranches).toHaveBeenCalledTimes(branchReads + 1);
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("feature/agents");
  await action("Nom actualisé", "Redémarrer");
  await click("Redémarrer", dialog());
  expect(button("Nom actualisé")).toBe(row);
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
});

it("keeps the selected terminal mounted during a delayed post-mutation workspace refresh", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const terminal = container.querySelector('[data-terminal="s1"]');
  await action("Soreno", "Modifier le projet");
  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Enregistrer", dialog());
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(container.textContent).not.toContain("Chargement des projets…");
  expect(runtime.unmounts).not.toHaveBeenCalled();
  await act(async () => finish(structuredClone(data)));
  expect(dialog()).toBeNull();
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
});

it("keeps a delayed retry transparent without hiding projects or the selected terminal", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const terminal = container.querySelector('[data-terminal="s1"]');
  vi.mocked(api.listAgentStatuses).mockRejectedValueOnce(
    new Error("Status refresh failed"),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(notificationMessages()).toEqual([
    "Lecture de l’état des sessions impossible.",
  ]);
  await retryFromNotification();
  expect(
    container.querySelector(".agent-rail-header .app-loading-spinner"),
  ).toBeNull();
  expect(container.textContent).not.toContain("Chargement des projets…");
  expect(projectNames()).toEqual(["Soreno"]);
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(button("Ajouter un projet").disabled).toBe(true);
  expect(button("Nouvelle session · Soreno").disabled).toBe(true);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(terminal?.hasAttribute("hidden")).toBe(false);
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  await act(async () => finish(structuredClone(data)));
  expect(button("Ajouter un projet").disabled).toBe(false);
  expect(
    container.querySelector(".agent-rail-header .app-loading-spinner"),
  ).toBeNull();
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(runtime.unmounts).not.toHaveBeenCalled();
});

it("notifies a failed post-save workspace reload and keeps retry available after cancel", async () => {
  await render();
  await action("Soreno", "Modifier le projet");
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Workspace refresh failed"),
  );
  await click("Enregistrer", dialog());
  const failure = expect.objectContaining({
    message: "L’opération a échoué. Réessayez.",
    tone: "error",
    action: expect.objectContaining({ label: "Réessayer" }),
  });
  expect(getNotifications()).toEqual([failure]);
  expect(dialog().textContent).not.toContain("Workspace refresh failed");
  await click("Annuler", dialog());
  expect(getNotifications()).toEqual([failure]);
  expect(container.textContent).not.toContain("Workspace refresh failed");

  await act(async () => getNotifications()[0].action!.onAction());
  await vi.waitFor(() => expect(getNotifications()).toEqual([]));
});

it("uses persisted conversation identity for sidecar renames and internal switches without resetting the terminal", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  data.statuses[0] = {
    ...data.statuses[0],
    state: "idle",
    resume: "linked",
    conversation: {
      provider: "pi",
      sessionId: "pi-1",
      sessionFile: "/sessions/pi-1.jsonl",
      name: "Première conversation",
    },
  };
  await render();
  const row = button("Première conversation");
  const terminal = container.querySelector('[data-terminal="s1"]');
  expect(container.textContent).toContain(
    "Cliquez sur cette session pour reprendre sa conversation liée.",
  );
  await act(async () => runtime.titles.get("s1")!("π - Ancien titre - soreno"));
  expect(button("Première conversation")).toBe(row);
  data.statuses[0] = {
    ...data.statuses[0],
    conversation: {
      provider: "pi",
      sessionId: "pi-2",
      sessionFile: "/sessions/pi-2.jsonl",
      name: "Conversation interne",
    },
  };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(button("Conversation interne")).toBe(row);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(terminal?.getAttribute("data-revision")).toBe("0");
  expect(runtime.unmounts).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("keeps the terminal title for unnamed linked conversations and prioritizes a conversation name", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  localStorage.setItem(
    "soreno.agents.terminal-titles.v1",
    JSON.stringify({ s1: "Titre du terminal" }),
  );
  data.sessions[0] = { ...data.sessions[0], executable: "claude" };
  data.statuses[0] = {
    ...data.statuses[0],
    state: "idle",
    resume: "linked",
    conversation: {
      provider: "claude",
      sessionId: "claude-1",
      sessionFile: null,
      name: null,
    },
  };
  await render();
  const row = button("Titre du terminal");
  const terminal = container.querySelector('[data-terminal="s1"]');
  data.statuses[0] = {
    ...data.statuses[0],
    conversation: {
      provider: "claude",
      sessionId: "claude-2",
      sessionFile: null,
      name: "Conversation nommée",
    },
  };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(button("Conversation nommée")).toBe(row);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(terminal?.getAttribute("data-revision")).toBe("0");
  expect(runtime.unmounts).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("explains the one-time CLI selector for an old integrated session without launching it", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  data.statuses[0] = {
    ...data.statuses[0],
    state: "idle",
    resume: "select",
    conversation: null,
  };
  await render();
  expect(container.textContent).toContain(
    "Choisissez une fois la conversation dans le sélecteur CLI.",
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("explains the one-time Codex hook approval without launching it", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s2" }),
  );
  data.statuses[1] = {
    ...data.statuses[1],
    resume: "approval",
    conversationError: "Le lancement précédent n’a publié aucune liaison.",
  };
  await render();
  expect(container.textContent).toContain(
    "Approuvez les hooks Soreno dans l’écran de démarrage de Codex ou avec /hooks, puis relancez cette session.",
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("marks unsupported CLIs, shows their conversation error, and launches them normally only on click", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s2" }),
  );
  data.sessions[1] = {
    ...data.sessions[1],
    executable: "custom-agent",
  };
  data.statuses[1] = {
    ...data.statuses[1],
    resume: "unsupported",
    conversationError: "Métadonnées illisibles",
  };
  await render();
  expect(container.textContent).toContain(
    "Reprise native non intégrée pour ce CLI ; il sera lancé normalement.",
  );
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Impossible de relier cette session à sa conversation.",
      tone: "error",
    }),
  );
  expect(container.textContent).not.toContain("Métadonnées illisibles");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it("ignores WSL startup titles and preserves the last real OMP session name", async () => {
  data.sessions[0] = { ...session, name: "OMP", executable: "omp" };
  await render();
  const row = button("OMP", container);
  await act(async () =>
    runtime.titles.get("s1")!("C:\\Windows\\system32\\wsl.exe"),
  );
  expect(button("OMP", container)).toBe(row);
  expect(container.textContent).not.toContain("system32");
  await act(async () =>
    runtime.titles.get("s1")!("π > Corriger le chargement"),
  );
  expect(button("Corriger le chargement", container)).toBe(row);
  await act(async () => runtime.titles.get("s1")!("user@host: ~/project"));
  expect(button("Corriger le chargement", container)).toBe(row);
  await act(async () => runtime.titles.get("s1")!("π ⠋ Nom mis à jour"));
  expect(button("Nom mis à jour", container)).toBe(row);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("keeps status polling independent and preserves the last branch after an IPC failure", async () => {
  vi.useFakeTimers();
  let finish!: (
    value: Awaited<ReturnType<typeof api.listAgentBranches>>,
  ) => void;
  vi.mocked(api.listAgentBranches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  expect(
    button("Soreno").querySelector(
      '[role="status"][aria-label="Lecture de la branche Git…"]',
    ),
  ).not.toBeNull();
  expect(container.textContent).not.toContain("Branche Git indisponible");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.listAgentBranches).toHaveBeenCalledTimes(1);
  expect(api.listAgentStatuses).toHaveBeenCalledTimes(5);
  await act(async () => finish([{ projectId: "p1", branch: "main" }]));
  expect(button("Soreno").querySelector(".app-loading-spinner")).toBeNull();
  vi.mocked(api.listAgentBranches).mockRejectedValueOnce(
    new Error("Git unavailable"),
  );
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("main");
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Lecture des branches Git impossible.",
      tone: "error",
    }),
  );
  expect(container.textContent).not.toContain("Git unavailable");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(getNotifications()).toEqual([]);
});

it("keeps a known Git branch visible without spinning during background refresh", async () => {
  vi.useFakeTimers();
  await render();
  let finish!: (
    value: Awaited<ReturnType<typeof api.listAgentBranches>>,
  ) => void;
  vi.mocked(api.listAgentBranches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("main");
  expect(button("Soreno").querySelector(".app-loading-spinner")).toBeNull();
  await act(async () =>
    finish([{ projectId: "p1", branch: "feature/loading" }]),
  );
  expect(button("Soreno").title).toContain("feature/loading");
});

it("reports a missing backend command instead of silently hiding the Git failure", async () => {
  vi.useFakeTimers();
  vi.mocked(api.listAgentBranches).mockRejectedValueOnce(
    "Command agent_branches not found",
  );
  await render();
  expect(notificationMessages()).toEqual([
    "Lecture des branches Git impossible.",
  ]);
  expect(container.textContent).not.toContain("agent_branches");
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toBe("Local");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(getNotifications()).toEqual([]);
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("main");
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("portals the rail and Git panel independently while keeping terminals mounted", async () => {
  setSidebarContainer(document.createElement("div"));
  setGitPanelContainer(document.createElement("div"));
  document.body.append(sidebarContainer, gitPanelContainer);
  const setGitVisible = vi.fn();
  await render(
    false,
    sidebarContainer,
    gitPanelContainer,
    true,
    setGitVisible,
    true,
  );
  await click("Pi notes", container);
  const terminal = container.querySelector('[data-terminal="s1"]');
  const gitPanel =
    gitPanelContainer.querySelector<HTMLElement>(".agent-git-panel")!;
  expect(container.querySelector(".agent-rail, .agent-git-panel")).toBeNull();
  expect(sidebarContainer.querySelector(".agent-rail-embedded")).not.toBeNull();
  expect(gitPanel.textContent).toContain("Soreno");
  expect(gitPanel.hidden).toBe(false);
  expect(terminal).not.toBeNull();
  expect(gitPanel.dataset.expanded).toBe("true");
  await click("Fermer le panneau Git", gitPanel);
  expect(setGitVisible).toHaveBeenLastCalledWith(false);

  await render(true, sidebarContainer, gitPanelContainer, false, setGitVisible);
  expect(
    sidebarContainer.querySelector(".agent-rail")?.hasAttribute("hidden"),
  ).toBe(true);
  expect(gitPanelContainer.querySelector(".agent-git-panel")).toBe(gitPanel);
  expect(gitPanel.hidden).toBe(true);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(runtime.unmounts).not.toHaveBeenCalled();

  await render(
    false,
    sidebarContainer,
    gitPanelContainer,
    false,
    setGitVisible,
  );
  await click("Outils du projet");
  expect(setGitVisible).toHaveBeenLastCalledWith(true);
  await click("Codex tests", container);
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  await act(async () =>
    vi.waitFor(
      () =>
        expect(document.activeElement?.getAttribute("data-terminal")).toBe(
          "s2",
        ),
      { timeout: 500 },
    ),
  );
});

it("wires Git panel expansion and keeps focus on its control when reduced", async () => {
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  const setExpanded = vi.fn();
  await render(
    false,
    null,
    gitPanelContainer,
    true,
    undefined,
    true,
    setExpanded,
  );
  const reduce = button("Réduire le panneau Git", gitPanelContainer);
  reduce.focus();
  await click("Réduire le panneau Git", gitPanelContainer);
  expect(setExpanded).toHaveBeenLastCalledWith(false);

  await render(
    false,
    null,
    gitPanelContainer,
    true,
    undefined,
    false,
    setExpanded,
  );
  expect(button("Agrandir le panneau Git", gitPanelContainer)).toBe(reduce);
  expect(document.activeElement).toBe(reduce);
});

it("restores selection and cached CLI name passively, then starts that exact inactive session once on click", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s2" }),
  );
  localStorage.setItem(
    "soreno.agents.terminal-titles.v1",
    JSON.stringify({ s2: "Cached conversation" }),
  );
  setStatus("s2", "exited");
  await render(true);
  await render(false);
  expect(button("Cached conversation").getAttribute("aria-current")).toBe(
    "page",
  );
  expect(document.activeElement?.getAttribute("data-terminal")).toBe("s2");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await click("Cached conversation");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  await click("Cached conversation");
  expect(api.startAgentSession).toHaveBeenCalledTimes(1);
});

it("does not mount unvisited idle terminals; clicking one starts only that agent", async () => {
  data.sessions = Array.from({ length: 8 }, (_, index) => ({
    ...session,
    id: `idle-${index}`,
    name: `Idle ${index}`,
  }));
  data.statuses = data.sessions.map((item) => ({
    sessionId: item.id,
    state: "idle",
    exitCode: null,
  }));
  await render();
  expect(runtime.mounts).not.toHaveBeenCalled();
  await click("Idle 7");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("idle-7");
  expect(runtime.mounts).toHaveBeenCalledExactlyOnceWith("idle-7");
  await click("Idle 7");
  expect(api.startAgentSession).toHaveBeenCalledTimes(1);
});

it("blocks selection launches while busy and never defers them to visibility changes", async () => {
  setStatus("s1", "idle");
  let finish!: () => void;
  vi.mocked(api.startAgentSession).mockImplementationOnce(
    (id) =>
      new Promise<void>((resolve) => {
        finish = () => {
          setStatus(id, "running");
          resolve();
        };
      }),
  );
  await render();
  await click("Pi notes");
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  await render(true);
  await render(false);
  expect(api.startAgentSession).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await click("Codex tests");
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, "s2");
  expect(document.activeElement?.getAttribute("data-terminal")).toBe("s2");
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("reports one failed launch without a retry loop and retries the same session on request", async () => {
  vi.useFakeTimers();
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("executable not found"),
  );
  await render();
  await click("Codex tests");
  expect(notificationMessages()).toEqual(["L’opération a échoué. Réessayez."]);
  expect(container.textContent).not.toContain("executable not found");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.startAgentSession).toHaveBeenCalledTimes(1);
  await retryFromNotification();
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, "s2");
  expect(getNotifications()).toEqual([]);
  expect(api.saveAgentSession).not.toHaveBeenCalled();
});

it("keeps both terminal states running after launching an idle split", async () => {
  data.statuses = [
    { sessionId: "s1", state: "idle", exitCode: null },
    { sessionId: "s2", state: "idle", exitCode: null },
  ];
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );

  await render();
  await click("Pi notes");

  expect(api.startAgentSession).toHaveBeenNthCalledWith(1, "s1");
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, "s2");
  await vi.waitFor(() => {
    expect(
      container
        .querySelector('[data-terminal="s1"]')
        ?.getAttribute("data-state"),
    ).toBe("running");
    expect(
      container
        .querySelector('[data-terminal="s2"]')
        ?.getAttribute("data-state"),
    ).toBe("running");
  });
});

it("starts a persisted idle split sequentially and retries only its failed child", async () => {
  data.statuses = [
    { sessionId: "s1", state: "idle", exitCode: null },
    { sessionId: "s2", state: "idle", exitCode: null },
  ];
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  let finishParent!: () => void;
  vi.mocked(api.startAgentSession)
    .mockImplementationOnce(
      (id) =>
        new Promise<void>((resolve) => {
          finishParent = () => {
            setStatus(id, "running");
            resolve();
          };
        }),
    )
    .mockRejectedValueOnce(new Error("child launch failed"));

  await render();
  await click("Pi notes");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s1");

  await act(async () => finishParent());
  await vi.waitFor(() =>
    expect(notificationMessages()).toEqual([
      "L’opération a échoué. Réessayez.",
    ]),
  );
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, "s2");

  await retryFromNotification();
  expect(api.startAgentSession).toHaveBeenNthCalledWith(3, "s2");
});

it("starts only an inactive split child when its parent is already running", async () => {
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );

  await render();
  await click("Pi notes");

  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it.each([
  ["Codex", "codex"],
  ["Terminal", ""],
])(
  "creates %s directly, names duplicates distinctly, and retains all running terminals",
  async (name, executable) => {
    await render();
    await newAgent(name);
    expect(dialog()).toBeNull();
    const saved = vi.mocked(api.saveAgentSession).mock.calls[0][0];
    expect(saved).toMatchObject({
      name,
      executable,
      args: [],
      projectId: "p1",
    });
    expect(api.startAgentSession).toHaveBeenCalledWith(saved.id);
    expect(
      vi.mocked(api.saveAgentSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(api.startAgentSession).mock.invocationCallOrder[0],
    );
    expect(document.activeElement?.getAttribute("data-terminal")).toBe(
      saved.id,
    );
    await newAgent(name);
    expect(vi.mocked(api.saveAgentSession).mock.calls[1][0].name).toBe(
      `${name} 2`,
    );
    await render(true);
    await render(false);
    expect(api.stopAgentSession).not.toHaveBeenCalled();
    expect(runtime.unmounts).not.toHaveBeenCalled();
  },
);
