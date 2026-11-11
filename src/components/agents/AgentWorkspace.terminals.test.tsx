// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  runtime,
  container,
  gitPanelContainer,
  root,
  data,
  guard,
  project,
  terminalSplitsKey,
  session,
  setStatus,
  render,
  button,
  click,
  dialog,
  input,
  choose,
  context,
  action,
  escape,
  nextAnimationFrame,
  addProject,
  newAgent,
  splitAgent,
  detachSplit,
  terminalGeometry,
  tabGeometry,
  pointer,
  tabOrderKey,
  tabNames,
  setData,
  setGitPanelContainer,
  notificationMessages,
  retryFromNotification,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as gitApi from "../../data/projectGitApi";
import type { AgentEnvironments } from "../../domain/agentSessions";
import { getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";

const operationFailed = "L’opération a échoué. Réessayez.";

it("keeps Terminal and drops the agents hidden in settings from the launcher menu", async () => {
  runtime.settings.hiddenAgentPresets = ["pi", "claude"];
  await render();
  await click("Nouvelle session · Soreno");
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    ),
  ).toEqual(["OMP", "Codex", "Chat (OMP)", "Terminal"]);

  await click("Chat (OMP)", document.querySelector('[role="menu"]')!);
  await vi.waitFor(() =>
    expect(api.saveAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "omp-conversation",
        kind: "conversation",
        args: [],
      }),
    ),
  );
});

it("shows both panes of a split in one tab and detaches the secondary session", async () => {
  await render();
  const primary = container.querySelector<HTMLElement>('[data-terminal="s1"]')!;
  const initialTabCount = container.querySelectorAll(
    ".agent-session-tab-item",
  ).length;

  await splitAgent("Terminal");
  const saved = vi.mocked(api.saveAgentSession).mock.calls[0][0];
  const secondary = container.querySelector<HTMLElement>(
    `[data-terminal="${saved.id}"]`,
  )!;
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith(saved.id);
  expect(saved).toMatchObject({
    projectId: "p1",
    name: "Terminal",
    executable: "",
  });
  expect(button("Terminal").getAttribute("aria-current")).toBe("page");
  expect(button("Pi notes").hasAttribute("aria-current")).toBe(false);
  expect(container.querySelectorAll(".agent-session-tab-item")).toHaveLength(
    initialTabCount,
  );
  expect(primary.hidden).toBe(false);
  expect(secondary.hidden).toBe(false);
  expect(document.activeElement).toBe(secondary);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: saved.id,
  });

  await detachSplit();
  expect(primary.hidden).toBe(false);
  expect(secondary.hidden).toBe(true);
  expect(document.activeElement).toBe(primary);
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(container.querySelectorAll(".agent-session-tab-item")).toHaveLength(
    initialTabCount + 1,
  );
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({});
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
});

it("moves existing terminal tabs into right and left split panes without restarting them", async () => {
  data.statuses[1] = { sessionId: "s2", state: "running", exitCode: null };
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const primary = container.querySelector<HTMLElement>('[data-terminal="s1"]')!;
  const secondary = container.querySelector<HTMLElement>(
    '[data-terminal="s2"]',
  )!;
  tabGeometry();
  terminalGeometry();

  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 320, 200));
  const rightOverlay = container.querySelector(
    ".agent-terminal-split-drop-overlay",
  )!;
  expect(rightOverlay.getAttribute("data-active")).toBe("right");
  await act(async () => pointer(document, "pointerup", 320, 200));

  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: "s2",
  });
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-terminal]")]
      .filter((terminal) => !terminal.hidden)
      .map((terminal) => terminal.dataset.terminal),
  ).toEqual(["s1", "s2"]);
  expect(document.activeElement).toBe(secondary);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(primary);
  expect(container.querySelector('[data-terminal="s2"]')).toBe(secondary);

  await detachSplit();
  tabGeometry();
  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 80, 200));
  expect(
    container
      .querySelector(".agent-terminal-split-drop-overlay")
      ?.getAttribute("data-active"),
  ).toBe("left");
  await act(async () => pointer(document, "pointerup", 80, 200));

  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s2: "s1",
  });
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-terminal]")]
      .filter((terminal) => !terminal.hidden)
      .map((terminal) => terminal.dataset.terminal),
  ).toEqual(["s2", "s1"]);
  expect(container.querySelector('[data-terminal="s1"]')).toBe(primary);
  expect(container.querySelector('[data-terminal="s2"]')).toBe(secondary);
  expect(runtime.unmounts).not.toHaveBeenCalled();
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  await render();
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-terminal]")]
      .filter((terminal) => !terminal.hidden)
      .map((terminal) => terminal.dataset.terminal),
  ).toEqual(["s2", "s1"]);
});

it("offers keyboard split placement through the tab context menu", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const menu = await context("Codex tests", true);
  expect(button("Déplacer dans le volet gauche", menu)).not.toBeNull();
  expect(button("Déplacer dans le volet droit", menu)).not.toBeNull();

  await click("Déplacer dans le volet droit", menu);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: "s2",
  });
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("never turns the selected pinned tab into a secondary pane", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  await action("Pi notes", "Épingler l’onglet");

  const menu = await context("Codex tests", true);
  expect(() => button("Déplacer dans le volet gauche", menu)).toThrow();
  await click("Déplacer dans le volet droit", menu);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: "s2",
  });
  expect(tabNames()).toEqual([]);
  const [pinnedTab, pinnedSplit] = container.querySelectorAll<HTMLElement>(
    ".agent-session-tab-item.is-pinned .agent-session-tab",
  );
  expect(pinnedTab.hasAttribute("aria-current")).toBe(false);
  expect(pinnedSplit.getAttribute("aria-current")).toBe("page");

  await detachSplit();
  tabGeometry();
  terminalGeometry();
  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 80, 200));
  expect(
    container.querySelector(".agent-terminal-split-drop-overlay"),
  ).toBeNull();
  await act(async () => pointer(document, "pointerup", 80, 200));
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({});
  expect(tabNames()).toEqual(["Codex tests"]);
});

it("protects the secondary pane of a pinned split tab", async () => {
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  await action("Pi notes", "Épingler l’onglet");
  const child = container.querySelectorAll<HTMLElement>(
    ".agent-session-tab-item.is-pinned .agent-session-tab",
  )[1];
  await act(async () =>
    child.dispatchEvent(
      new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => child.click());
  expect(child.getAttribute("aria-current")).toBe("page");
  await act(async () =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "W",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const menu = await context(child.getAttribute("aria-label")!, true);
  expect(
    button("Supprimer la session", menu).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: "s2",
  });
});

it("selects the parent tab when the selected secondary pane no longer exists", async () => {
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "gone" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "gone" }),
  );
  // Hidden: a visible terminal's auto-focus would repair the selection on its own.
  await render(true);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({});
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.selection.v1")!),
  ).toEqual({ projectId: "p1", sessionId: "s1" });
  await render();
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(
    container.querySelector<HTMLElement>('[data-terminal="s1"]')?.hidden,
  ).toBe(false);
});

it("keeps a secondary pane's tab position when its parent is pinned", async () => {
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  await action("Pi notes", "Épingler l’onglet");
  expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
    p1: ["s1", "s2", "s3"],
  });

  await detachSplit();
  expect(tabNames()).toEqual(["Codex tests", "Third"]);
});

it("rejects a third terminal when the selected split already has two panes", async () => {
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  tabGeometry();
  terminalGeometry();

  await act(async () => pointer(button("Third"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 320, 200));
  expect(
    container.querySelector(".agent-terminal-split-drop-overlay"),
  ).toBeNull();
  await act(async () => pointer(document, "pointerup", 320, 200));
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: "s2",
  });
  expect(tabNames()).toEqual(["Pi notes", "Codex tests", "Third"]);
  const menu = await context("Third", true);
  expect(
    [...menu.querySelectorAll("[role=menuitem]")].some((item) =>
      item.textContent?.includes("volet"),
    ),
  ).toBe(false);
});

it("selects and closes each pane from its half of the split tab", async () => {
  await render();
  await splitAgent("Terminal");
  const saved = vi.mocked(api.saveAgentSession).mock.calls[0][0];
  const primary = container.querySelector<HTMLElement>('[data-terminal="s1"]')!;
  const secondary = container.querySelector<HTMLElement>(
    `[data-terminal="${saved.id}"]`,
  )!;

  await click("Pi notes");
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(button("Terminal").hasAttribute("aria-current")).toBe(false);
  expect(document.activeElement).toBe(primary);
  expect(secondary.hidden).toBe(false);

  await act(async () => secondary.focus());
  expect(button("Terminal").getAttribute("aria-current")).toBe("page");
  expect(document.activeElement).toBe(secondary);

  await click("Fermer l’onglet · Terminal");
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith(saved.id);
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith(saved.id);
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({});
});

it("targets the agent of the active split pane for paths typed from Files", async () => {
  setStatus("s2", "running");
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  const activeAgent = gitPanelContainer.querySelector("[data-active-agent]")!;
  expect(activeAgent.getAttribute("data-active-agent")).toBe("s1");

  await act(async () =>
    container.querySelector<HTMLElement>('[data-terminal="s2"]')!.focus(),
  );
  expect(activeAgent.getAttribute("data-active-agent")).toBe("s2");
});

it("offers no path target when the active pane agent is stopped", async () => {
  setStatus("s1", "exited");
  setStatus("s2", "running");
  localStorage.setItem(terminalSplitsKey, JSON.stringify({ s1: "s2" }));
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  expect(
    gitPanelContainer
      .querySelector("[data-active-agent]")
      ?.getAttribute("data-active-agent"),
  ).toBe("");
});

it("keeps mounted terminal DOM nodes in session order when leaving a split tab", async () => {
  data.statuses[1] = { sessionId: "s2", state: "running", exitCode: null };
  await render();
  const existingTerminal = container.querySelector('[data-terminal="s2"]');

  await splitAgent("Terminal");
  const split = vi.mocked(api.saveAgentSession).mock.calls[0][0];
  await click("Codex tests");

  expect(
    [...container.querySelectorAll("[data-terminal]")].map((terminal) =>
      terminal.getAttribute("data-terminal"),
    ),
  ).toEqual(["s1", "s2", split.id]);
  expect(container.querySelector('[data-terminal="s2"]')).toBe(
    existingTerminal,
  );
  expect(runtime.unmounts).not.toHaveBeenCalled();
});

it("restores each tab split after project navigation and remounting", async () => {
  const otherProject = { ...project, id: "p2", name: "Other project" };
  data.projects.push(otherProject);
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  await render();
  await splitAgent("Terminal");
  const split = vi.mocked(api.saveAgentSession).mock.calls[0][0];

  await click("Other project");
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(false);
  await click("Soreno");
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(true);
  expect(
    container.querySelector<HTMLElement>(`[data-terminal="${split.id}"]`)
      ?.hidden,
  ).toBe(false);

  await act(async () => root.render(null));
  await render();
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(true);
  expect(button("Terminal").closest(".agent-session-tab-item")).toBe(
    button("Pi notes").closest(".agent-session-tab-item"),
  );
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("detaches the secondary terminal when its parent tab closes", async () => {
  await render();
  await splitAgent("Terminal");
  const split = vi.mocked(api.saveAgentSession).mock.calls[0][0];

  await click("Fermer l’onglet · Pi notes");
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(button("Terminal").getAttribute("aria-current")).toBe("page");
  expect(
    container.querySelector<HTMLElement>(`[data-terminal="${split.id}"]`)
      ?.hidden,
  ).toBe(false);
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({});
});

it("restores the split group when closing its parent tab fails", async () => {
  let failStop!: () => void;
  vi.mocked(api.stopAgentSession).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failStop = () => reject(new Error("Stop failed"));
      }),
  );
  await render();
  await splitAgent("Terminal");
  const split = vi.mocked(api.saveAgentSession).mock.calls[0][0];

  await click("Fermer l’onglet · Pi notes");
  await act(async () => failStop());
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("Stop failed");
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(true);
  expect(button("Terminal").closest(".agent-session-tab-item")).toBe(
    button("Pi notes").closest(".agent-session-tab-item"),
  );
  expect(JSON.parse(localStorage.getItem(terminalSplitsKey)!)).toEqual({
    s1: split.id,
  });
});

it("keeps a restored split parent selected after its close rollback", async () => {
  const otherProject = { ...project, id: "p2", name: "Other project" };
  data.projects.push(otherProject);
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  data.statuses[1] = { sessionId: "s2", state: "running", exitCode: null };
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s2" }),
  );
  let failStop!: () => void;
  vi.mocked(api.stopAgentSession).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failStop = () => reject(new Error("Stop failed"));
      }),
  );
  await render();
  await splitAgent("Terminal");

  await click("Fermer l’onglet · Codex tests");
  await click("Other project");
  await act(async () => failStop());
  expect(button("Other project").getAttribute("aria-current")).toBe("page");

  await click("Soreno");
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(true);
});

it("does not split after a failed save", async () => {
  vi.mocked(api.saveAgentSession).mockRejectedValueOnce(
    new Error("save failed"),
  );
  await render();

  await splitAgent("Terminal");
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("save failed");
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(false);
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await click("Nouvelle session · Soreno");
  expect(document.querySelector('[role="menu"]')!.textContent).toContain(
    "Diviser le terminal",
  );
});

it("keeps a failed split launch visible and retries that secondary session", async () => {
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("split launch failed"),
  );
  await render();

  await splitAgent("Terminal");
  const saved = vi.mocked(api.saveAgentSession).mock.calls[0][0];
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(
    container
      .querySelector(".agent-terminal-stack")
      ?.classList.contains("is-split"),
  ).toBe(true);
  expect(
    container.querySelector<HTMLElement>(`[data-terminal="${saved.id}"]`)
      ?.hidden,
  ).toBe(false);

  await retryFromNotification();
  expect(api.startAgentSession).toHaveBeenNthCalledWith(2, saved.id);
  expect(button("Terminal").getAttribute("aria-current")).toBe("page");
});

it("does not retry a stale failed split launch after a later save fails", async () => {
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("split launch failed"),
  );
  await render();
  await splitAgent("Terminal");
  expect(notificationMessages()).toEqual([operationFailed]);

  vi.mocked(api.saveAgentSession).mockRejectedValueOnce(
    new Error("later save failed"),
  );
  await newAgent("Claude Code");
  expect(notificationMessages()).toEqual([operationFailed]);

  vi.mocked(api.startAgentSession).mockClear();
  await retryFromNotification();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("returns to each project's last session without activating it from project navigation", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  await render();
  await click("Pi notes");
  const tabs = container.querySelector('[aria-label="Sessions du projet"]')!;
  expect(button("Pi notes", tabs)).not.toBeNull();
  expect(button("Codex tests", tabs)).not.toBeNull();
  expect(
    [...tabs.querySelectorAll("button")].some(
      (item) => item.textContent === "Other agent",
    ),
  ).toBe(false);
  const otherActivity = container.querySelector(
    '[aria-label="Activité des sessions · Other"]',
  )!;
  expect(otherActivity.textContent).toContain("Other agent");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(
    container.querySelector('[data-terminal="s1"]')?.hasAttribute("hidden"),
  ).toBe(false);
  await click("Other");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(button("Other").getAttribute("aria-current")).toBe("page");
  expect(
    [...tabs.querySelectorAll(".agent-session-tab")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Other agent"]);
  expect(button("Other agent").getAttribute("aria-current")).toBe("page");
  await click("Other agent");
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s3");
  await click("Soreno");
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(document.activeElement?.getAttribute("data-terminal")).toBe("s1");
  expect(container.querySelector('[data-terminal="s3"]')).not.toBeNull();
  expect(runtime.unmounts).not.toHaveBeenCalled();
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("supports keyboard row menus and restores the row after cancelling rename", async () => {
  await render();
  const menu = await context("Codex tests", true);
  // Base UI moves initial menu focus in a requestAnimationFrame.
  await act(async () =>
    vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true), {
      timeout: 500,
    }),
  );
  await click("Renommer la session", menu);
  expect(dialog().contains(document.activeElement)).toBe(true);
  await escape();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button("Codex tests"));
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("keeps a manual session name over CLI titles until it is cleared", async () => {
  await render();
  await act(async () =>
    runtime.titles.get("s1")!("π - Première tâche - soreno"),
  );
  await action("Première tâche", "Renommer la session");
  expect(dialog().querySelector("input")!.value).toBe("Première tâche");
  await click("Enregistrer", dialog());
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();

  await action("Première tâche", "Renommer la session");
  await input("Nom", "  Revue manuelle ");
  await click("Enregistrer", dialog());
  expect(api.saveAgentSession).toHaveBeenCalledExactlyOnceWith({
    ...session,
    customName: "Revue manuelle",
  });
  await act(async () => runtime.titles.get("s1")!("π - Autre tâche - soreno"));
  expect(tabNames()).toContain("Revue manuelle");
  expect(tabNames()).not.toContain("Autre tâche");

  await action("Revue manuelle", "Renommer la session");
  expect(dialog().querySelector("input")!.value).toBe("Revue manuelle");
  await input("Nom", " ");
  await click("Enregistrer", dialog());
  expect(api.saveAgentSession).toHaveBeenLastCalledWith({
    ...session,
    customName: null,
  });
  expect(tabNames()).toContain("Autre tâche");
  expect(tabNames()).not.toContain("Revue manuelle");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(runtime.unmounts).not.toHaveBeenCalled();
});

it("does not freeze the automatic name when CLI titles change while renaming", async () => {
  await render();
  await act(async () =>
    runtime.titles.get("s1")!("π - Première tâche - soreno"),
  );
  await action("Première tâche", "Renommer la session");
  await act(async () => runtime.titles.get("s1")!("π - Autre tâche - soreno"));
  await click("Enregistrer", dialog());
  expect(api.saveAgentSession).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
  expect(tabNames()).toContain("Autre tâche");
});

it("explains a missing agent executable and relaunches it once installed", async () => {
  vi.useFakeTimers();
  const missing = {
    state: "exited" as const,
    exitCode: 209,
    missingExecutable: true,
  };
  let installed = false;
  vi.mocked(api.startAgentSession).mockImplementation(async (id) => {
    data.statuses = data.statuses.map((item) =>
      item.sessionId !== id
        ? item
        : installed
          ? { sessionId: id, state: "running", exitCode: null }
          : { sessionId: id, ...missing },
    );
  });
  data.statuses[0] = { sessionId: "s1", ...missing };
  await render();
  await click("Pi notes");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const terminal = container.querySelector<HTMLElement>(
    '[data-terminal="s1"]',
  )!;
  expect(terminal.textContent).toContain("Pi n’est pas installé");
  expect(terminal.textContent).toContain("introuvable sur cet ordinateur");

  installed = true;
  await click("Réessayer", terminal);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.startAgentSession).toHaveBeenLastCalledWith("s1");
  expect(terminal.textContent).toBe("");
});

it("shows the real empty workspace only after a successful empty snapshot", async () => {
  setData({ projects: [], sessions: [], statuses: [] });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  const surface = container.querySelector<HTMLElement>(".agent-surface")!;
  expect(surface.textContent).toContain("Ajoutez un dossier de projet");
  expect(
    gitPanelContainer.querySelector<HTMLElement>(".agent-git-panel")!.hidden,
  ).toBe(true);
  expect(() => button("Outils du projet")).toThrow();
  await click("Cloner un dépôt", surface);
  expect(dialog().textContent).toContain("URL du dépôt");
  await click("Annuler", dialog());
  await click("Ajouter un projet", surface);
  expect(dialog().textContent).toContain("Ajouter un projet");
});

it("saves and selects the first project from an empty workspace", async () => {
  setData({ projects: [], sessions: [], statuses: [] });
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/projects/first",
    suggestedName: "first",
    environment: project.environment,
  });
  await render();
  await addProject("Ajouter un projet");
  await input("Nom affiché", "First project");
  await click("Choisir un dossier…", dialog());
  await click("Enregistrer", dialog());

  expect(api.saveAgentProject).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    name: "First project",
    path: "/projects/first",
    environment: { kind: "local", distribution: null },
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("First project").getAttribute("aria-current")).toBe("page");
});

it("reuses batch IDs after reload failure and closes when navigation is refused", async () => {
  setData({ projects: [project], sessions: [], statuses: [], groups: [] });
  vi.mocked(api.browseAgentSsh).mockResolvedValue({
    path: "/workspaces",
    parentPath: "/",
    directories: [
      { name: "crawler", path: "/workspaces/crawler" },
      { name: "api", path: "/workspaces/api" },
    ],
  });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await addProject("Ajouter un projet");
  await choose("Environnement", "SSH");
  await input("Hôte ou alias OpenSSH", "server.example");
  await click("Choisir un dossier…", dialog());
  await act(async () =>
    [...dialog().querySelectorAll("label")]
      .find((label) => label.textContent === "Sélectionner plusieurs projets")!
      .click(),
  );
  await act(async () => {
    dialog()
      .querySelector<HTMLElement>('[aria-label="Sélectionner crawler"]')!
      .closest<HTMLElement>("label")!
      .click();
    dialog()
      .querySelector<HTMLElement>('[aria-label="Sélectionner api"]')!
      .closest<HTMLElement>("label")!
      .click();
  });
  await act(async () =>
    [...dialog().querySelectorAll("label")]
      .find(
        (label) => label.textContent === "Regrouper les projets sélectionnés",
      )!
      .querySelector<HTMLElement>('[role="checkbox"]')!
      .click(),
  );
  await input("Nom du groupe", "Services");
  await click("Sélectionner 2 projets", dialog());
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Workspace refresh failed"),
  );
  await click("Enregistrer", dialog());

  expect(dialog()).not.toBeNull();
  expect(api.saveAgentProject).toHaveBeenCalledTimes(2);
  expect(api.saveAgentProjectGroup).toHaveBeenCalledTimes(1);
  const firstProjects = vi
    .mocked(api.saveAgentProject)
    .mock.calls.map(([value]) => value);
  const firstGroup = vi.mocked(api.saveAgentProjectGroup).mock.calls[0][0];

  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await click("Enregistrer", dialog());

  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(api.saveAgentProject).toHaveBeenCalledTimes(4);
  const retriedProjects = vi
    .mocked(api.saveAgentProject)
    .mock.calls.slice(2)
    .map(([value]) => value);
  expect(
    firstProjects.map(({ id, name, path }) => ({ id, name, path })),
  ).toEqual(retriedProjects.map(({ id, name, path }) => ({ id, name, path })));
  expect(firstProjects.map(({ name, path }) => ({ name, path }))).toEqual([
    { name: "crawler", path: "/workspaces/crawler" },
    { name: "api", path: "/workspaces/api" },
  ]);
  expect(api.saveAgentProjectGroup).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveAgentProjectGroup).mock.calls[1][0]).toEqual(
    firstGroup,
  );
  expect(data.projects).toHaveLength(3);
  expect(data.groups).toHaveLength(1);
  expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(3);
  expect(runtime.projectNavigationPrepare).toHaveBeenCalledOnce();
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
});

it("clones the exact request selected by the picker, registers it once, and selects it without launching", async () => {
  setData({ projects: [], sessions: [], statuses: [] });
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/home/me/Projects",
    suggestedName: "Projects",
    environment: { kind: "wsl", distribution: "Ubuntu" },
  });
  await render();
  await addProject("Cloner un dépôt");
  await input("URL du dépôt", " ssh://host/repo.git ");
  await click("Choisir un dossier…", dialog());
  expect(api.pickAgentProjectDirectory).toHaveBeenCalledWith(
    { kind: "local", distribution: null },
    null,
    "Choisir un dossier",
  );
  await click("Cloner un dépôt", dialog());
  const request = vi.mocked(gitApi.cloneGitRepository).mock.calls[0][0];
  expect(request).toEqual({
    id: expect.any(String),
    name: "repo",
    environment: { kind: "wsl", distribution: "Ubuntu" },
    parentPath: "/home/me/Projects",
    folderName: "repo",
    url: "ssh://host/repo.git",
  });
  expect(api.saveAgentProject).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(button("repo").getAttribute("aria-current")).toBe("page");
});

it("keeps the previous selection when a cloned project cannot be reloaded", async () => {
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/tmp",
    suggestedName: "tmp",
    environment: project.environment,
  });
  await render();
  await click("Pi notes");
  await addProject("Cloner un dépôt");
  await input("URL du dépôt", "ssh://host/repo.git");
  await click("Choisir un dossier…", dialog());
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Workspace refresh failed"),
  );
  await click("Cloner un dépôt", dialog());

  expect(gitApi.cloneGitRepository).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("Workspace refresh failed");
});

it("keeps the previous selection when a created worktree cannot be reloaded", async () => {
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await click("Pi notes");
  data.projects.push({
    id: "created-worktree",
    name: "Created worktree",
    path: "/worktrees/created",
    environment: { kind: "local", distribution: null },
  });
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Workspace refresh failed"),
  );

  await click("Signaler le worktree créé", gitPanelContainer);

  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(notificationMessages()).toEqual([
    "Chargement des projets agents impossible.",
  ]);
  expect(document.body.textContent).not.toContain("Workspace refresh failed");
  expect(api.saveAgentProject).not.toHaveBeenCalled();
});

it("shows clone progress and synchronously blocks duplicate submit and close", async () => {
  setData({ projects: [], sessions: [], statuses: [] });
  let finish!: () => void;
  vi.mocked(gitApi.cloneGitRepository).mockImplementationOnce(
    (request) =>
      new Promise((resolve) => {
        finish = () => {
          const cloned = {
            id: request.id,
            name: request.name,
            path: `${request.parentPath}/${request.folderName}`,
            environment: request.environment,
          };
          data.projects.push(cloned);
          resolve(cloned);
        };
      }),
  );
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/tmp",
    suggestedName: "tmp",
    environment: project.environment,
  });
  await render();
  await addProject("Cloner un dépôt");
  await input("URL du dépôt", "ssh://host/repo.git");
  await click("Choisir un dossier…", dialog());
  vi.useFakeTimers();
  await act(async () => {
    const submit = button("Cloner un dépôt", dialog());
    submit.click();
    submit.click();
  });
  expect(gitApi.cloneGitRepository).toHaveBeenCalledTimes(1);
  expect(button("Annuler", dialog()).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(dialog().textContent).toContain("Clonage… 1 s");
  await act(async () => button("Annuler", dialog()).click());
  expect(dialog()).not.toBeNull();
  await act(async () => finish());
  expect(dialog()).toBeNull();
});

it("keeps a clone failure path and opens it as a project without cloning again", async () => {
  setData({ projects: [], sessions: [], statuses: [] });
  vi.mocked(gitApi.cloneGitRepository).mockRejectedValueOnce({
    code: "clone",
    message: "Authentication failed",
    path: "/tmp/kept",
  });
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/tmp",
    suggestedName: "tmp",
    environment: project.environment,
  });
  await render();
  await addProject("Cloner un dépôt");
  await input("URL du dépôt", "ssh://host/repo.git");
  await click("Choisir un dossier…", dialog());
  await click("Cloner un dépôt", dialog());
  const kept = getNotifications().find((item) => item.tone === "warning")!;
  expect(kept.message).toContain("/tmp/kept");
  expect(document.body.textContent).not.toContain("Authentication failed");
  await act(async () => kept.action!.onAction());
  expect(gitApi.cloneGitRepository).toHaveBeenCalledTimes(1);
  expect(api.saveAgentProject).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    name: "repo",
    path: "/tmp/kept",
    environment: { kind: "local", distribution: null },
  });
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(button("repo").getAttribute("aria-current")).toBe("page");
});

it("keeps the environment label stable and usable during discovery", async () => {
  const discovery = deferred<AgentEnvironments>();
  vi.mocked(api.discoverAgentEnvironments).mockReturnValueOnce(
    discovery.promise,
  );
  await render();
  await addProject("Ajouter un projet");
  const environment = button("Environnement", dialog());
  expect(environment.textContent).toBe("Local");
  expect(environment.getAttribute("aria-busy")).toBe("true");
  expect(environment.disabled).toBe(false);
  await act(async () =>
    discovery.resolve({
      localLabel: "Windows",
      distributions: ["Ubuntu"],
      wslError: null,
    }),
  );
  expect(environment.textContent).toBe("Local");
  expect(environment.getAttribute("aria-busy")).toBe("false");
  await choose("Environnement", "WSL · Ubuntu");
  expect(environment.textContent).toBe("WSL · Ubuntu");
});

it("customizes the sidebar icon from the row menu: reset to the folder, then catalog picks", async () => {
  const iconDataUrl = "data:image/png;base64,aWNvbg==";
  data.projects = [{ ...project, iconDataUrl }];
  await render();
  expect(
    button("Soreno").querySelector(".nav-icon img")?.getAttribute("src"),
  ).toBe(iconDataUrl);
  expect(button("Soreno").querySelector(".nav-icon svg")).toBeNull();
  await action("Soreno", "Personnaliser l’icône et la couleur");
  const popover = () =>
    document.querySelector<HTMLElement>(
      '[aria-label="Personnaliser l’icône et la couleur · Soreno"]',
    );
  await click("Réinitialiser", popover()!);
  expect(api.updateAgentProjectAppearance).toHaveBeenCalledExactlyOnceWith(
    project.id,
    { iconDataUrl: null, icon: null, color: null },
  );
  expect(button("Soreno").querySelector(".nav-icon img")).toBeNull();
  expect(button("Soreno").querySelector(".nav-icon svg")).not.toBeNull();

  const save = deferred<void>();
  const persist = vi
    .mocked(api.updateAgentProjectAppearance)
    .getMockImplementation()!;
  vi.mocked(api.updateAgentProjectAppearance).mockImplementationOnce(
    async (id, appearance) => {
      await save.promise;
      return persist(id, appearance);
    },
  );
  await click("Lancement", popover()!);
  // Neither the workspace nor the popover goes busy while the pick is saved.
  expect(button("Ajouter un projet").disabled).toBe(false);
  expect(button("Objectif", popover()!).disabled).toBe(false);
  await click("Objectif", popover()!);
  await click("Réussite", popover()!);
  expect(button("Réussite", popover()!).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await act(async () => save.resolve());
  // Picks made while a save is pending are merged into the next delta.
  expect(
    vi
      .mocked(api.updateAgentProjectAppearance)
      .mock.calls.slice(1)
      .map(([, appearance]) => appearance),
  ).toEqual([
    { icon: "rocket", iconDataUrl: null },
    { icon: "trophy", iconDataUrl: null },
  ]);
  expect(api.saveAgentProject).not.toHaveBeenCalled();
  expect(button("Réussite", popover()!).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  expect(popover()).toBeNull();
});

it("persists a pick from a reopened popover after a pending save, and a later rename keeps it", async () => {
  await render();
  const popover = (name = "Soreno") =>
    document.querySelector<HTMLElement>(
      `[aria-label="Personnaliser l’icône et la couleur · ${name}"]`,
    );
  const save = deferred<void>();
  const persist = vi
    .mocked(api.updateAgentProjectAppearance)
    .getMockImplementation()!;
  vi.mocked(api.updateAgentProjectAppearance).mockImplementationOnce(
    async (id, appearance) => {
      await save.promise;
      return persist(id, appearance);
    },
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("Lancement", popover()!);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("Objectif", popover()!);
  await click("Réussite", popover()!);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  // The edit form opens while the appearance saves are still pending.
  await action("Soreno", "Modifier le projet");
  await act(async () => save.resolve());
  await input("Nom affiché", "Renamed");
  await click("Enregistrer", dialog());
  expect(
    vi
      .mocked(api.updateAgentProjectAppearance)
      .mock.calls.map(([, appearance]) => appearance.icon),
  ).toEqual(["rocket", "trophy"]);
  // The rename waits for the queued picks, then saves the whole project with the latest appearance.
  expect(api.saveAgentProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "Renamed", icon: "trophy" }),
  );
  expect(data.projects.find((item) => item.id === project.id)).toEqual(
    expect.objectContaining({ name: "Renamed", icon: "trophy" }),
  );
  await action("Renamed", "Personnaliser l’icône et la couleur");
  expect(
    button("Réussite", popover("Renamed")!).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("persists the latest pick when a reopened popover picks while an earlier save is pending", async () => {
  await render();
  const popover = () =>
    document.querySelector<HTMLElement>(
      '[aria-label="Personnaliser l’icône et la couleur · Soreno"]',
    );
  const save = deferred<void>();
  const persist = vi
    .mocked(api.updateAgentProjectAppearance)
    .getMockImplementation()!;
  vi.mocked(api.updateAgentProjectAppearance).mockImplementationOnce(
    async (id, appearance) => {
      await save.promise;
      return persist(id, appearance);
    },
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("Lancement", popover()!);
  await click("Objectif", popover()!);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("Réussite", popover()!);
  await act(async () => save.resolve());
  expect(
    vi
      .mocked(api.updateAgentProjectAppearance)
      .mock.calls.map(([, appearance]) => appearance.icon),
  ).toEqual(["rocket", "trophy"]);
  expect(data.projects.find((item) => item.id === project.id)?.icon).toBe(
    "trophy",
  );
  expect(button("Réussite", popover()!).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("keeps a color picked in a closed popover when a reopened one picks an icon before it is saved", async () => {
  await render();
  const popover = () =>
    document.querySelector<HTMLElement>(
      '[aria-label="Personnaliser l’icône et la couleur · Soreno"]',
    );
  const save = deferred<void>();
  const persist = vi
    .mocked(api.updateAgentProjectAppearance)
    .getMockImplementation()!;
  vi.mocked(api.updateAgentProjectAppearance).mockImplementationOnce(
    async (id, appearance) => {
      await save.promise;
      return persist(id, appearance);
    },
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("palette.blue", popover()!);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  await click("Objectif", popover()!);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  await act(async () => save.resolve());
  expect(
    vi
      .mocked(api.updateAgentProjectAppearance)
      .mock.calls.map(([, appearance]) => appearance),
  ).toEqual([{ color: "#608ef8" }, { icon: "target", iconDataUrl: null }]);
  expect(data.projects.find((item) => item.id === project.id)).toEqual(
    expect.objectContaining({ color: "#608ef8", icon: "target" }),
  );
  await action("Soreno", "Personnaliser l’icône et la couleur");
  expect(button("palette.blue", popover()!).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(button("Objectif", popover()!).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("creates a WSL project with the small plus and locks existing project paths without losing selection", async () => {
  await render();
  await click("Pi notes");
  await action("Soreno", "Modifier le projet");
  expect(button("Environnement", dialog()).disabled).toBe(true);
  expect(button("Choisir un dossier…", dialog()).disabled).toBe(true);
  await input("Nom affiché", "Renamed");
  await click("Enregistrer", dialog());
  expect(
    container.querySelector('[data-terminal="s1"]')?.hasAttribute("hidden"),
  ).toBe(false);
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/home/dev/sandbox",
    suggestedName: "sandbox",
    environment: { kind: "wsl", distribution: "Ubuntu" },
  });
  await addProject("Ajouter un projet");
  await input("Nom affiché", "Sandbox");
  await choose("Environnement", "WSL · Ubuntu");
  await click("Choisir un dossier…", dialog());
  await click("Enregistrer", dialog());
  expect(api.saveAgentProject).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "Sandbox",
      environment: { kind: "wsl", distribution: "Ubuntu" },
    }),
  );
});

it("does not immediately restart an explicitly stopped process and purges only deleted sessions' cached titles", async () => {
  localStorage.setItem(
    "soreno.agents.terminal-titles.v1",
    JSON.stringify({ s1: "Pi notes", s2: "Codex tests", orphan: "Orphan" }),
  );
  await render();
  await click("Pi notes");
  let menu = await context("Pi notes");
  expect(
    button("Supprimer la session", menu).getAttribute("aria-disabled"),
  ).toBe("true");
  await click("Supprimer la session", menu);
  expect(dialog()).toBeNull();
  await click("Arrêter", menu);
  await click("Arrêter", dialog());
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await action("Pi notes", "Supprimer la session");
  await click("Supprimer la session", dialog());
  expect(api.deleteAgentSession).toHaveBeenCalledWith("s1");
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.terminal-titles.v1")!),
  ).toEqual({ s2: "Codex tests", orphan: "Orphan" });
  await act(async () =>
    vi.waitFor(
      () => expect(document.activeElement).toBe(button("Codex tests")),
      { timeout: 500 },
    ),
  );
  await action("Soreno", "Supprimer le projet");
  await click("Supprimer le projet", dialog());
  expect(api.deleteAgentProject).toHaveBeenCalledWith("p1");
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.terminal-titles.v1")!),
  ).toEqual({ orphan: "Orphan" });
});

it("hides a closing tab immediately while keeping navigation passive until the serialized backend work finishes", async () => {
  const otherProject = { ...project, id: "p2", name: "Other project" };
  data.projects.push(otherProject);
  data.sessions.push(
    { ...session, id: "s3", name: "Other tab" },
    { ...session, id: "s4", projectId: "p2", name: "Other project tab" },
  );
  data.statuses.push(
    { sessionId: "s3", state: "idle", exitCode: null },
    { sessionId: "s4", state: "idle", exitCode: null },
  );
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  let finishStatuses!: () => void;
  vi.mocked(api.listAgentStatuses).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStatuses = () => resolve(structuredClone(data.statuses));
      }),
  );
  await render();
  const closingTerminal = container.querySelector('[data-terminal="s1"]');

  await click("Fermer l’onglet · Pi notes");
  expect(container.textContent).not.toContain("Pi notes");
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  await act(async () =>
    vi.waitFor(
      () => expect(document.activeElement).toBe(button("Codex tests")),
      { timeout: 500 },
    ),
  );
  expect(container.querySelector('[data-terminal="s1"]')).toBe(closingTerminal);
  expect(button("Codex tests").disabled).toBe(false);
  expect(button("Nouvelle session · Soreno").disabled).toBe(true);
  expect(button("Fermer l’onglet · Codex tests").disabled).toBe(true);

  await click("Other tab");
  await click("Other project");
  const projectButton = button("Other project");
  projectButton.focus();
  expect(button("Other project tab").getAttribute("aria-current")).toBe("page");
  expect(api.startAgentSession).not.toHaveBeenCalled();

  await act(async () => finishStatuses());
  await act(async () =>
    vi.waitFor(() =>
      expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s1"),
    ),
  );
  expect(button("Other project").getAttribute("aria-current")).toBe("page");
  expect(button("Other project tab").getAttribute("aria-current")).toBe("page");
  expect(document.activeElement).toBe(projectButton);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it.each(["button", "middle-click", "shortcut"])(
  "closes a running tab via %s without confirmation, stops before deleting and selects a sibling passively",
  async (gesture) => {
    data.sessions.push({ ...session, id: "s3", name: "Other running" });
    data.statuses.push({ sessionId: "s3", state: "running", exitCode: null });
    localStorage.setItem(
      "soreno.agents.selection.v1",
      JSON.stringify({ projectId: "p1", sessionId: "s1" }),
    );
    await render();
    if (gesture === "button") await click("Fermer l’onglet · Pi notes");
    else if (gesture === "shortcut")
      await act(async () =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "W",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    else
      await act(async () =>
        button("Pi notes").dispatchEvent(
          new MouseEvent("auxclick", {
            button: 1,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    expect(dialog()).toBeNull();
    expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(
      vi.mocked(api.listAgentStatuses).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(api.stopAgentSession).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(api.stopAgentSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(api.deleteAgentSession).mock.invocationCallOrder[0],
    );
    expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
    expect(api.startAgentSession).not.toHaveBeenCalled();
    await act(async () =>
      vi.waitFor(
        () => expect(document.activeElement).toBe(button("Codex tests")),
        { timeout: 500 },
      ),
    );

    await click("Other running");
    await nextAnimationFrame();
    expect(document.activeElement?.getAttribute("data-terminal")).toBe("s3");
    expect(api.startAgentSession).not.toHaveBeenCalled();
  },
);

it("middle-click closes a non-selected tab without activating, starting it, or stealing terminal focus", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const terminal = container.querySelector<HTMLElement>(
    '[data-terminal="s1"]',
  )!;
  terminal.focus();
  await act(async () =>
    button("Codex tests").dispatchEvent(
      new MouseEvent("auxclick", {
        button: 2,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  const down = new MouseEvent("mousedown", {
    button: 1,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => button("Codex tests").dispatchEvent(down));
  expect(down.defaultPrevented).toBe(true);
  const up = new MouseEvent("mouseup", {
    button: 1,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => button("Codex tests").dispatchEvent(up));
  expect(up.defaultPrevented).toBe(true);
  await act(async () =>
    button("Codex tests").dispatchEvent(
      new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(dialog()).toBeNull();
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  expect(terminal.hasAttribute("hidden")).toBe(false);
  await nextAnimationFrame();
  expect(document.activeElement).toBe(terminal);
});

it("moves focus from a closed non-selected tab to the current tab", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  const closingTab = button("Codex tests");
  closingTab.focus();
  await act(async () =>
    closingTab.dispatchEvent(
      new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  await nextAnimationFrame();
  expect(document.activeElement).toBe(button("Pi notes"));
});

it("keeps the project selected when its last tab is closed", async () => {
  data.sessions = [session];
  data.statuses = [{ sessionId: "s1", state: "idle", exitCode: null }];
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  await click("Fermer l’onglet · Pi notes");
  expect(dialog()).toBeNull();
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(container.querySelectorAll(".agent-session-tab")).toHaveLength(0);
  expect(container.textContent).toContain("Sélectionnez une session");
  await act(async () =>
    vi.waitFor(
      () =>
        expect(document.activeElement).toBe(
          button("Nouvelle session · Soreno"),
        ),
      { timeout: 500 },
    ),
  );
});

it("restores a hidden tab without forcing navigation when stopping it fails", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  let failStop!: () => void;
  vi.mocked(api.stopAgentSession).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failStop = () => reject(new Error("Stop failed"));
      }),
  );
  await render();
  await click("Fermer l’onglet · Pi notes");
  expect(container.textContent).not.toContain("Pi notes");
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");

  await act(async () => failStop());
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("Stop failed");
  expect(button("Pi notes")).not.toBeNull();
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("does not delete a tab when its fresh status cannot be read", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  vi.mocked(api.listAgentStatuses).mockRejectedValueOnce(
    new Error("Fresh status failed"),
  );
  await click("Fermer l’onglet · Pi notes");
  expect(dialog()).toBeNull();
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("Fresh status failed");
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(button("Pi notes")).not.toBeNull();
});

it("keeps a deleted tab hidden when reload fails, then clears its tombstone on retry", async () => {
  setStatus("s1", "idle");
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Reload failed"),
  );

  await click("Fermer l’onglet · Pi notes");
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(notificationMessages()).toEqual([operationFailed]);
  expect(container.textContent).not.toContain("Reload failed");
  expect(container.textContent).not.toContain("Pi notes");

  await retryFromNotification();
  expect(getNotifications()).toEqual([]);
  expect(container.textContent).not.toContain("Pi notes");
  expect(button("Codex tests").getAttribute("aria-current")).toBe("page");

  data.sessions.push(session);
  data.statuses.push({ sessionId: "s1", state: "idle", exitCode: null });
  await action("Soreno", "Modifier le projet");
  await click("Enregistrer", dialog());
  expect(button("Pi notes")).not.toBeNull();
});

it("does not relaunch the selected session when retrying a later tab-close failure", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("Launch failed"),
  );
  await render();
  await click("Codex tests");
  expect(notificationMessages()).toEqual([operationFailed]);

  vi.mocked(api.listAgentStatuses).mockRejectedValueOnce(
    new Error("Fresh status failed"),
  );
  await click("Fermer l’onglet · Pi notes");
  expect(notificationMessages()).toEqual([operationFailed]);
  vi.mocked(api.startAgentSession).mockClear();
  await retryFromNotification();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("does not delete a running tab when exit is not confirmed before timeout", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  vi.mocked(api.stopAgentSession).mockResolvedValueOnce(undefined);
  await render();
  await click("Fermer l’onglet · Pi notes");
  await act(async () => vi.advanceTimersByTimeAsync(5100));
  expect(dialog()).toBeNull();
  expect(notificationMessages()).toEqual([
    "Le processus n’est pas encore arrêté. Patientez puis réessayez.",
  ]);
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(button("Pi notes")).not.toBeNull();
});

it("waits for actual exit on explicit restart and focuses the terminal afterwards", async () => {
  vi.useFakeTimers();
  vi.mocked(api.stopAgentSession).mockResolvedValueOnce(undefined);
  await render();
  await click("Pi notes");
  await action("Pi notes", "Redémarrer");
  await click("Redémarrer", dialog());
  expect(api.startAgentSession).not.toHaveBeenCalled();
  setStatus("s1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s1");
  expect(document.activeElement?.getAttribute("data-terminal")).toBe("s1");
});

it("closes directly with running agents and unlocks launches when another guard cancels", async () => {
  await render(true);
  expect(guard.hasPendingWork()).toBe(false);
  await act(async () => {
    expect(await guard.prepare()).toBe(true);
  });
  expect(dialog()).toBeNull();
  expect(button("Ajouter un projet").disabled).toBe(true);
  await act(async () => guard.cancel?.());
  expect(button("Ajouter un projet").disabled).toBe(false);
  expect(api.stopAgentSession).not.toHaveBeenCalled();
});

it("refuses close during an explicit launch, then closes without confirmation", async () => {
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
  await click("Codex tests");
  expect(guard.hasPendingWork()).toBe(true);
  expect(await guard.prepare()).toBe(false);
  await act(async () => finish());
  expect(guard.hasPendingWork()).toBe(false);
  await act(async () => {
    expect(await guard.prepare()).toBe(true);
  });
  expect(dialog()).toBeNull();
});

it("does not invoke terminal APIs or purge saved terminal layout in browser mode", async () => {
  const saved = JSON.stringify({ p1: ["s2", "s1"] });
  const savedSplits = JSON.stringify({ s1: "s2" });
  localStorage.setItem(tabOrderKey, saved);
  localStorage.setItem(terminalSplitsKey, savedSplits);
  runtime.desktop = false;
  await render();
  expect(localStorage.getItem(tabOrderKey)).toBe(saved);
  expect(localStorage.getItem(terminalSplitsKey)).toBe(savedSplits);
  expect(container.textContent).toContain("application de bureau Soreno");
  expect(api.loadAgentWorkspace).not.toHaveBeenCalled();
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(runtime.mounts).not.toHaveBeenCalled();
});
