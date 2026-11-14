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
  session,
  setStatus,
  render,
  button,
  click,
  dialog,
  input,
  check,
  context,
  action,
  escape,
  nextAnimationFrame,
  newAgent,
  projectGeometry,
  tabGeometry,
  pointer,
  mouseClick,
  dragProject,
  dragProjectGroup,
  dragTab,
  tabOrderKey,
  projectOrderKey,
  projectGroupsKey,
  collapsedProjectsKey,
  tabNames,
  projectNames,
  sshStatusHost,
  setGitPanelContainer,
  type AgentProjectWorktreeGroup,
  type WorkspaceData,
  notificationMessages,
  retryFromNotification,
} from "./AgentWorkspaceTestHarness";
import { localTestProject as project } from "./testProject";
import * as api from "../../data/agentSessionsApi";
import * as gitApi from "../../data/projectGitApi";
import { pinnedTabsKey, projectSectionOrderKey } from "./agentWorkspaceStorage";

it("opens quick file navigation with Ctrl+P for the selected project", async () => {
  await render();

  const terminal = container.querySelector<HTMLElement>("[data-terminal]")!;
  terminal.addEventListener("keydown", (event) => event.stopPropagation());
  const shortcut = new KeyboardEvent("keydown", {
    key: "p",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => terminal.dispatchEvent(shortcut));

  expect(shortcut.defaultPrevented).toBe(true);
  expect(
    document.querySelector('[role="dialog"][aria-label="Ouverture rapide"]'),
  ).not.toBeNull();
  expect(document.activeElement?.getAttribute("role")).toBe("combobox");

  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(
    document.querySelector('[role="dialog"][aria-label="Ouverture rapide"]'),
  ).toBeNull();
});

it("opens the project text search with Ctrl+Shift+F for the selected project", async () => {
  await render();

  const terminal = container.querySelector<HTMLElement>("[data-terminal]")!;
  terminal.addEventListener("keydown", (event) => event.stopPropagation());
  const shortcut = new KeyboardEvent("keydown", {
    key: "F",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => terminal.dispatchEvent(shortcut));

  expect(shortcut.defaultPrevented).toBe(true);
  const searchDialog =
    '[role="dialog"][aria-label="Rechercher dans le projet"]';
  expect(document.querySelector(searchDialog)).not.toBeNull();
  expect(
    document.querySelector('[role="dialog"][aria-label="Ouverture rapide"]'),
  ).toBeNull();
  expect(document.activeElement?.getAttribute("role")).toBe("combobox");

  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.querySelector(searchDialog)).toBeNull();
});

it("reorders projects in both directions without selecting or collapsing them", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Other" },
    { ...project, id: "p3", name: "Third" },
  );
  await render();
  projectGeometry();
  const selected = button("Soreno");
  expect(
    button("Replier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("true");

  await act(async () => pointer(selected, "pointerdown", 20, 50));
  await act(async () => pointer(document, "pointermove", 20, 280));
  await act(async () => {
    pointer(document, "pointerup", 20, 280);
    selected.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });

  expect(projectNames()).toEqual(["Other", "Third", "Soreno"]);
  expect(selected.getAttribute("aria-current")).toBe("page");
  expect(
    button("Replier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p2",
    "p3",
    "p1",
  ]);
  expect(api.startAgentSession).not.toHaveBeenCalled();

  await dragProject("Soreno", 250, 10);
  expect(projectNames()).toEqual(["Soreno", "Other", "Third"]);
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p1",
    "p2",
    "p3",
  ]);

  // Past the next project's header, not the middle of its whole block.
  await dragProject("Soreno", 10, 120);
  expect(projectNames()).toEqual(["Other", "Soreno", "Third"]);
});

it("reorders projects through the keyboard context menu", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  await render();
  let menu = await context("Other", true);
  expect(
    button("Déplacer vers le bas", menu).getAttribute("aria-disabled"),
  ).toBe("true");
  await click("Déplacer vers le haut", menu);
  expect(projectNames()).toEqual(["Other", "Soreno"]);

  menu = await context("Other", true);
  expect(
    button("Déplacer vers le haut", menu).getAttribute("aria-disabled"),
  ).toBe("true");
  await click("Déplacer vers le bas", menu);
  expect(projectNames()).toEqual(["Soreno", "Other"]);
});

it("restores and reconciles project order across mounts", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  localStorage.setItem(
    projectOrderKey,
    JSON.stringify(["p2", "missing", "p2", "p1"]),
  );
  await render();
  expect(projectNames()).toEqual(["Other", "Soreno"]);
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p2",
    "p1",
  ]);

  await act(async () => root.render(null));
  data.projects = [data.projects[1], { ...project, id: "p3", name: "Third" }];
  data.sessions = [];
  data.statuses = [];
  await render();
  expect(projectNames()).toEqual(["Other", "Third"]);
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p2",
    "p3",
  ]);
});

it("keeps reordered projects in memory when storage access is refused", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  await render();
  projectGeometry();
  await dragProject("Other", 150, 10);
  expect(projectNames()).toEqual(["Other", "Soreno"]);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it.each(["Pi notes", "Codex tests"])(
  "drags %s without activating or restarting sessions and keeps DOM terminals",
  async (name) => {
    localStorage.setItem(
      "soreno.agents.selection.v1",
      JSON.stringify({ projectId: "p1", sessionId: "s1" }),
    );
    await render();
    tabGeometry();
    const terminal = container.querySelector('[data-terminal="s1"]');
    const target = button(name);
    await dragTab(
      name,
      name === "Pi notes" ? 50 : 150,
      name === "Pi notes" ? 250 : 0,
      target,
    );
    expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
    expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
    expect(runtime.unmounts).not.toHaveBeenCalled();
    expect(api.startAgentSession).not.toHaveBeenCalled();
    expect(api.stopAgentSession).not.toHaveBeenCalled();
    expect(api.deleteAgentSession).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
      p1: ["s2", "s1"],
    });
    await act(async () => root.render(null));
    await render();
    expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
  },
);

it("inserts between tabs, moves to both ends and does not write for an unchanged position", async () => {
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  await render();
  tabGeometry();
  await dragTab("Pi notes", 50, 180);
  expect(tabNames()).toEqual(["Codex tests", "Pi notes", "Third"]);
  await dragTab("Pi notes", 150, 380);
  expect(tabNames()).toEqual(["Codex tests", "Third", "Pi notes"]);
  await dragTab("Pi notes", 250, 0);
  expect(tabNames()).toEqual(["Pi notes", "Codex tests", "Third"]);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await dragTab("Pi notes", 50, 60);
  expect(writes).not.toHaveBeenCalled();
});

it.each(["close", "plus"])(
  "suppresses the post-drag %s click but not a subsequent real click",
  async (kind) => {
    await render();
    tabGeometry();
    const target = button(
      kind === "close"
        ? "Fermer l’onglet · Codex tests"
        : "Nouvelle session · Soreno",
    );
    await dragTab("Codex tests", 150, 0, target);
    expect(api.deleteAgentSession).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(target.isConnected).toBe(true);
    await mouseClick(target);
    if (kind === "close")
      expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
    else
      await act(async () =>
        vi.waitFor(
          () => expect(document.querySelector('[role="menu"]')).not.toBeNull(),
          { timeout: 500 },
        ),
      );
  },
);

it("reorders through the keyboard context menu, preserving focus and selection", async () => {
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  let menu = await context("Codex tests", true);
  expect(button("Déplacer à droite", menu).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await click("Déplacer à gauche", menu);
  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
  await act(async () =>
    vi.waitFor(
      () => expect(document.activeElement).toBe(button("Codex tests")),
      { timeout: 500 },
    ),
  );
  expect(button("Pi notes").getAttribute("aria-current")).toBe("page");
  menu = await context("Codex tests", true);
  expect(button("Déplacer à gauche", menu).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await click("Déplacer à droite", menu);
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  await act(async () =>
    vi.waitFor(
      () => expect(document.activeElement).toBe(button("Codex tests")),
      { timeout: 500 },
    ),
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(runtime.unmounts).not.toHaveBeenCalled();
});

it("keeps pinned tabs first, compact and protected until they are unpinned", async () => {
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  await render();
  await action("Third", "Épingler l’onglet");
  const pinnedTab = () =>
    container.querySelector<HTMLElement>(".agent-session-tab-item.is-pinned");
  expect(JSON.parse(localStorage.getItem(pinnedTabsKey)!)).toEqual(["s3"]);
  expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
    p1: ["s3", "s1", "s2"],
  });
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  expect(pinnedTab()!.querySelector(".agent-session-close")).toBeNull();
  const pinnedLabel = pinnedTab()!
    .querySelector(".agent-session-tab")!
    .getAttribute("aria-label")!;

  await act(async () =>
    pinnedTab()!
      .querySelector(".agent-session-tab")!
      .dispatchEvent(
        new MouseEvent("auxclick", {
          button: 1,
          bubbles: true,
          cancelable: true,
        }),
      ),
  );
  expect(api.stopAgentSession).not.toHaveBeenCalled();
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(pinnedTab()).not.toBeNull();

  let menu = await context(pinnedLabel, true);
  expect(
    button("Supprimer la session", menu).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(button("Déplacer à droite", menu).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await escape();
  menu = await context("Pi notes", true);
  expect(button("Déplacer à gauche", menu).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await click("Déplacer à droite", menu);
  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);

  await action(pinnedLabel, "Désépingler l’onglet");
  expect(pinnedTab()).toBeNull();
  expect(tabNames()).toEqual(["Third", "Codex tests", "Pi notes"]);
  expect(JSON.parse(localStorage.getItem(pinnedTabsKey)!)).toEqual([]);
  await click("Fermer l’onglet · Third");
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s3");
});

it("lists favorites at the start of the tabs to reopen, rename or remove them", async () => {
  const favorites = async () => {
    await click("Favoris · Soreno");
    return dialog();
  };
  await render();
  await action("Codex tests", "Ajouter aux favoris");
  await click("Fermer l’onglet · Codex tests");

  expect(api.setAgentSessionClosed).toHaveBeenCalledExactlyOnceWith("s2", true);
  expect(api.deleteAgentSession).not.toHaveBeenCalled();
  expect(tabNames()).toEqual(["Pi notes"]);

  await click("Renommer la session · Codex tests", await favorites());
  await input("Nom", "Revue");
  await click("Enregistrer", dialog());
  expect(api.saveAgentSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "s2", customName: "Revue", favorite: true }),
  );
  expect(tabNames()).toEqual(["Pi notes"]);

  await click("Revue", await favorites());
  expect(api.setAgentSessionClosed).toHaveBeenLastCalledWith("s2", false);
  expect(api.startAgentSession).toHaveBeenCalledWith("s2");
  expect(tabNames()).toEqual(["Pi notes", "Revue"]);
  expect(button("Revue").getAttribute("aria-current")).toBe("page");

  await click("Fermer l’onglet · Revue");
  expect(tabNames()).toEqual(["Pi notes"]);
  const list = await favorites();
  await click("Retirer des favoris · Revue", list);
  expect(api.saveAgentSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "s2", favorite: false }),
  );
  expect(list.querySelector("button[role='button']")).toBeNull();
  expect(tabNames()).toEqual(["Pi notes", "Revue"]);
  await escape();
  await click("Fermer l’onglet · Revue");
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it("restores pinned tabs and forgets the ones whose session disappeared", async () => {
  localStorage.setItem(pinnedTabsKey, JSON.stringify(["s2", "gone"]));
  await render();
  expect(tabNames()).toEqual(["Pi notes"]);
  expect(
    [...container.querySelectorAll(".agent-session-tab")].map(
      (tab) => tab.getAttribute("aria-label")!.split(" · ")[0],
    ),
  ).toEqual(["Codex tests", "Pi notes"]);
  expect(JSON.parse(localStorage.getItem(pinnedTabsKey)!)).toEqual(["s2"]);
});

it("marks the source and insertion point without changing the DOM order before dropping", async () => {
  await render();
  tabGeometry();
  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 0));
  expect(tabNames()).toEqual(["Pi notes", "Codex tests"]);
  await act(async () => pointer(document, "pointerup", 0));
  expect(
    container.querySelector("[data-drop], .is-dragging, .is-reordering"),
  ).toBeNull();
  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
});

it("keeps a sub-threshold click launching normally without persisting an order", async () => {
  await render();
  tabGeometry();
  await dragTab("Codex tests", 150, 152, button("Codex tests"));
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
  expect(localStorage.getItem(tabOrderKey)).toBeNull();
});

it.each([
  "escape",
  "cancel",
  "blur",
  "outside",
  "hidden",
  "project",
  "dialog",
  "disabled",
])("cancels tab reordering on %s", async (reason) => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  await render();
  tabGeometry();
  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 0));
  expect(container.querySelector(".is-reordering")).not.toBeNull();
  if (reason === "escape")
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  if (reason === "cancel")
    await act(async () => pointer(document, "pointercancel", 0));
  if (reason === "blur")
    await act(async () => window.dispatchEvent(new Event("blur")));
  if (reason === "hidden") await render(true);
  if (reason === "project") await click("Other");
  if (reason === "dialog") await action("Soreno", "Modifier le projet");
  if (reason === "disabled")
    await act(async () => {
      void guard.prepare();
    });
  await act(async () =>
    pointer(document, "pointerup", 0, reason === "outside" ? 80 : 20),
  );
  expect(container.querySelector(".is-reordering")).toBeNull();
  expect(localStorage.getItem(tabOrderKey)).toBeNull();
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("does not launch an inactive session when the mouse is released long after Escape", async () => {
  vi.useFakeTimers();
  await render();
  tabGeometry();
  const target = button("Codex tests");
  await act(async () => pointer(target, "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 0));
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => {
    pointer(document, "pointerup", 0);
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(localStorage.getItem(tabOrderKey)).toBeNull();
  await mouseClick(target);
  expect(api.startAgentSession).toHaveBeenCalledExactlyOnceWith("s2");
});

it("keeps project orders independent and ignores live status/title changes during drag", async () => {
  vi.useFakeTimers();
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push(
    { ...session, id: "s3", projectId: "p2", name: "Other one" },
    { ...session, id: "s4", projectId: "p2", name: "Other two" },
  );
  await render();
  tabGeometry();
  await act(async () => pointer(button("Codex tests"), "pointerdown", 150));
  await act(async () => pointer(document, "pointermove", 0));
  await act(async () => {
    runtime.titles.get("s1")!("π - Updated - soreno");
    data.statuses[0].working = true;
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(container.querySelector(".is-reordering")).not.toBeNull();
  await act(async () => pointer(document, "pointerup", 0));
  expect(tabNames()).toEqual(["Codex tests", "Updated"]);
  await mouseClick(button("Other"));
  tabGeometry();
  expect(tabNames()).toEqual(["Other one", "Other two"]);
  await dragTab("Other two", 150, 0);
  expect(tabNames()).toEqual(["Other two", "Other one"]);
  await mouseClick(button("Soreno"));
  expect(tabNames()).toEqual(["Codex tests", "Updated"]);
  expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
    p1: ["s2", "s1"],
    p2: ["s4", "s3"],
  });
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("reorders disconnected sessions in memory when storage access is refused", async () => {
  sshStatusHost();
  data.disconnectedProjectIds = ["p1"];
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Denied");
  });
  await render();
  tabGeometry();
  await dragTab("Codex tests", 150, 0);
  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
  expect(api.startAgentSession).not.toHaveBeenCalled();
});

it("creates, edits, collapses, restores, and deletes project groups", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    { ...project, id: "p3", name: "Backoffice" },
  );
  await render();

  await click("Ajouter un projet");
  await click("Créer un groupe", document.querySelector('[role="menu"]')!);
  await input("Nom du groupe", "x".repeat(101));
  await click("Enregistrer", dialog());
  expect(notificationMessages()).toContain("Utilisez 100 caractères maximum.");
  await input("Nom du groupe", "Suite DashPro");
  await click("Enregistrer", dialog());
  expect(notificationMessages()).toContain("Choisissez au moins un projet.");
  await check("Soreno");
  await check("Website");
  await click("Enregistrer", dialog());

  expect(projectNames()).toEqual(["Soreno", "Website", "Backoffice"]);
  expect(button("Replier le groupe · Suite DashPro")).not.toBeNull();
  expect(data.groups).toEqual([
    expect.objectContaining({
      name: "Suite DashPro",
      projectIds: ["p1", "p2"],
      groupProjectId: null,
    }),
  ]);
  const groupId = data.groups![0].id;

  projectGeometry();
  const saveGroup = vi
    .mocked(api.saveAgentProjectGroup)
    .getMockImplementation()!;
  let releaseSave!: () => void;
  vi.mocked(api.saveAgentProjectGroup).mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    return saveGroup(value);
  });
  await dragProject("Backoffice", 250, 100);
  expect(projectNames()).toEqual(["Soreno", "Backoffice", "Website"]);
  await act(async () => releaseSave());
  await vi.waitFor(() =>
    expect(data.groups![0].projectIds).toEqual(["p1", "p2", "p3"]),
  );
  expect(projectNames()).toEqual(["Soreno", "Backoffice", "Website"]);

  await act(async () => pointer(button("Suite DashPro"), "pointerdown", 20));
  await click("Suite DashPro");
  expect(projectNames()).toEqual([]);
  expect(api.prepareAgentGroupProject).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toContain(
    `group:${groupId}`,
  );

  await act(async () => root.render(null));
  await render();
  expect(projectNames()).toEqual([]);
  let menu = await context("Déplier le groupe · Suite DashPro", true);
  await click("Modifier le groupe", menu);
  await check("Soreno");
  await input("Nom du groupe", "DashPro");
  await click("Enregistrer", dialog());
  await nextAnimationFrame();
  await nextAnimationFrame();

  expect(document.activeElement).toBe(button("Déplier le groupe · DashPro"));
  expect(data.groups![0]).toEqual(
    expect.objectContaining({ name: "DashPro", projectIds: ["p3", "p2"] }),
  );

  menu = await context("Déplier le groupe · DashPro", true);
  await click("Supprimer le groupe", menu);
  await click("Supprimer le groupe", dialog());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  await nextAnimationFrame();
  await nextAnimationFrame();
  expect(api.deleteAgentProjectGroup).toHaveBeenCalledWith(groupId, false);
  expect(document.activeElement).toBe(button("Backoffice"));
  expect(projectNames()).toEqual(["Soreno", "Backoffice", "Website"]);
  expect(data.groups).toEqual([]);
});

it("drags a project group as one block among root projects", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    { ...project, id: "p3", name: "Backoffice" },
  );
  data.groups = [
    {
      id: "g1",
      name: "Suite DashPro",
      projectIds: ["p1", "p2"],
      groupProjectId: null,
    },
  ];
  await render();
  projectGeometry();

  await dragProjectGroup("Suite DashPro", 20, 250);

  expect(projectNames()).toEqual(["Backoffice", "Soreno", "Website"]);
  expect(button("Replier le groupe · Suite DashPro")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p3",
    "p1",
    "p2",
  ]);
  expect(data.groups![0].projectIds).toEqual(["p1", "p2"]);
});

it("drops a group's last project right after the group, outside it", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    { ...project, id: "p3", name: "Backoffice" },
  );
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1", "p2"], groupProjectId: null },
  ];
  await render();
  projectGeometry();

  // Below the group's bottom edge, above the next project's header midpoint.
  await dragProject("Website", 110, 205);

  await vi.waitFor(() => expect(data.groups![0].projectIds).toEqual(["p1"]));
  expect(projectNames()).toEqual(["Soreno", "Website", "Backoffice"]);
});

it("keeps the chosen section order while a group move is being saved", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.groups = [
    { id: "g1", name: "G1", projectIds: ["p1"], groupProjectId: null },
    { id: "g2", name: "G2", projectIds: [], groupProjectId: null },
  ];
  let finishSave!: () => void;
  vi.mocked(api.saveAgentProjectGroup).mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    data.groups = data.groups!.map((group) =>
      group.id === value.id
        ? { ...group, projectIds: value.projectIds }
        : group,
    );
  });
  const sectionNames = () =>
    [...container.querySelectorAll(".agent-project-section")].map(
      (section) => section.querySelector(".agent-project-name")?.textContent,
    );
  const expectedOrder = ["group:g1", "project:p2", "group:g2", "project:p1"];
  await render();
  projectGeometry();

  await dragProject("Soreno", 50, 280);
  expect(JSON.parse(localStorage.getItem(projectSectionOrderKey)!)).toEqual(
    expectedOrder,
  );

  await act(async () => finishSave());
  await vi.waitFor(() =>
    expect(sectionNames()).toEqual(["G1", "Other", "G2", "Soreno"]),
  );
  expect(data.groups?.map((group) => group.projectIds)).toEqual([[], []]);
  expect(JSON.parse(localStorage.getItem(projectSectionOrderKey)!)).toEqual(
    expectedOrder,
  );
});

it("moves a project group as one block through the keyboard context menu", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    { ...project, id: "p3", name: "Backoffice" },
  );
  data.groups = [
    {
      id: "g1",
      name: "Suite DashPro",
      projectIds: ["p1", "p2"],
      groupProjectId: null,
    },
  ];
  await render();

  let menu = await context("Replier le groupe · Suite DashPro", true);
  expect(
    button("Déplacer le groupe vers le haut", menu).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  await click("Déplacer le groupe vers le bas", menu);
  expect(projectNames()).toEqual(["Backoffice", "Soreno", "Website"]);

  menu = await context("Replier le groupe · Suite DashPro", true);
  expect(
    button("Déplacer le groupe vers le bas", menu).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  await click("Déplacer le groupe vers le haut", menu);
  expect(projectNames()).toEqual(["Soreno", "Website", "Backoffice"]);
});

it("explains why a project cannot move to a group on another machine", async () => {
  data.projects = [
    {
      ...project,
      path: "/home/me/soreno",
      environment: { kind: "wsl", distribution: "Ubuntu", ssh: null },
    },
    {
      ...project,
      id: "p2",
      name: "Remote",
      path: "/srv/remote",
      environment: {
        kind: "ssh",
        distribution: null,
        ssh: {
          host: "dev.example",
          user: "dev",
          port: null,
          identityFile: null,
          hostKey: null,
        },
      },
    },
  ];
  data.groups = [
    { id: "g1", name: "WSL", projectIds: ["p1"], groupProjectId: null },
    { id: "g2", name: "Serveurs", projectIds: ["p2"], groupProjectId: null },
  ];
  await render();

  await click("Déplacer vers « Serveurs »", await context("Soreno", true));
  await vi.waitFor(() =>
    expect(notificationMessages()).toContain(
      "Impossible de déplacer « Soreno » (WSL · Ubuntu) vers « Serveurs » (SSH · dev@dev.example) : un groupe ne peut contenir que des projets d’une même machine.",
    ),
  );
  expect(api.saveAgentProjectGroup).not.toHaveBeenCalled();
});

it("moves a root project before a collapsed project group", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    { ...project, id: "p3", name: "Grouped" },
  );
  localStorage.setItem(projectOrderKey, JSON.stringify(["p1", "p3", "p2"]));
  data.groups = [
    { id: "g1", name: "Archive", projectIds: ["p3"], groupProjectId: null },
  ];
  localStorage.setItem(collapsedProjectsKey, JSON.stringify(["group:g1"]));
  await render();
  projectGeometry();

  await dragProject("Website", 220, 110);

  expect(
    [...container.querySelectorAll(".agent-project-section")].map(
      (section) => section.querySelector(".agent-project-name")?.textContent,
    ),
  ).toEqual(["Soreno", "Website", "Archive"]);
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p1",
    "p2",
    "p3",
  ]);
  expect(data.groups![0].projectIds).toEqual(["p3"]);
});

it("keeps project actions on the project row and only Git actions on worktree rows", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects.push(linked, {
    ...project,
    id: "p3",
    name: "Archive",
    path: "/projects/archive",
  });
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p1"], groupProjectId: null },
    { id: "g2", name: "Archive", projectIds: ["p3"], groupProjectId: null },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
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
            path: linked.path,
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  setStatus("s1", "idle");
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Feature agent",
  });
  data.statuses.push({ sessionId: "s3", state: "running", exitCode: null });
  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );

  expect(await context("main", true)).toBeNull();
  const projectMenu = await context("Soreno", true);
  expect(button("Retirer du groupe", projectMenu)).not.toBeNull();
  expect(button("Déplacer vers « Archive »", projectMenu)).not.toBeNull();
  await escape();

  const worktreeMenu = await context("feature", true);
  expect(
    [...worktreeMenu.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Fusionner dans main et supprimer", "Supprimer le worktree"]);
  await escape();

  await click("Replier le groupe · Repository");
  expect(
    button("Repository").querySelector(".agent-project-activity"),
  ).not.toBeNull();
});

it("waits for complete topology before migrating a manual group to a missing partial representative", async () => {
  vi.useFakeTimers();
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects = [linked];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p1"], groupProjectId: null },
  ];
  const worktree = {
    path: project.path,
    head: "a".repeat(40),
    branch: "main",
    projectIds: ["p1"],
  };
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [
        {
          repositoryProjectId: "p2",
          projectIds: ["p1"],
          worktrees: [worktree],
        },
      ],
      complete: false,
      missingProjectIds: [],
    })
    .mockResolvedValueOnce({
      groups: [
        {
          repositoryProjectId: "p2",
          projectIds: ["p1", "p2"],
          worktrees: [worktree],
        },
      ],
      complete: true,
      missingProjectIds: [],
    });

  await render();
  expect(api.listAgentWorktrees).toHaveBeenCalledOnce();
  expect(data.groups![0].projectIds).toEqual(["p1"]);

  await act(async () => vi.advanceTimersByTimeAsync(500));

  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);
  expect(data.groups![0].projectIds).toEqual(["p2"]);
  expect(button("Replier le groupe · Repository")).not.toBeNull();
});

it("keeps a manual group when the visible worktree representative changes", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects = [linked];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p2"], groupProjectId: null },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p2"],
        worktrees: [
          {
            path: linked.path,
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  await render();
  expect(button("Replier le groupe · Repository")).not.toBeNull();

  await act(async () => root.render(null));
  data.projects = [project, linked];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
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
            path: linked.path,
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  await render();

  await vi.waitFor(() => expect(data.groups![0].projectIds).toEqual(["p1"]));
  expect(button("Replier le groupe · Repository")).not.toBeNull();
  expect(projectNames()).toEqual(["Soreno"]);

  await act(async () => root.render(null));
  data.projects = [linked];
  data.groups![0].projectIds = [];
  vi.mocked(api.saveAgentProjectGroup).mockClear();
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p2"],
        worktrees: [
          {
            path: linked.path,
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  await render();

  expect(button("Replier le groupe · Repository")).not.toBeNull();
  expect(projectNames()).toEqual(["Feature"]);
  expect(api.saveAgentProjectGroup).not.toHaveBeenCalled();
});

it("keeps a manual group when its deleted repository representative is replaced", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects = [project, linked];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p1"], groupProjectId: null },
  ];
  const initialGroups: AgentProjectWorktreeGroup[] = [
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
          path: linked.path,
          head: "b".repeat(40),
          branch: "feature",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: initialGroups,
      complete: true,
      missingProjectIds: [],
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  await render();
  await vi.waitFor(() => expect(projectNames()).toEqual(["Soreno"]));
  expect(button("Replier le groupe · Repository")).not.toBeNull();

  await action("Soreno", "Supprimer le projet");
  await click("Supprimer le projet", dialog());

  await vi.waitFor(() =>
    expect(data.groups).toEqual([
      expect.objectContaining({ projectIds: ["p2"] }),
    ]),
  );
  expect(button("Replier le groupe · Repository")).not.toBeNull();
  expect(projectNames()).toEqual(["Feature"]);
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");
  await act(async () =>
    finish({
      groups: [
        {
          repositoryProjectId: "p2",
          projectIds: ["p2"],
          worktrees: [initialGroups[0].worktrees[1]],
        },
      ],
      complete: true,
      missingProjectIds: [],
    }),
  );
});

it("hands a deleted worktree representative's group membership to the remaining worktree", async () => {
  const feature = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  const review = {
    ...project,
    id: "p3",
    name: "Review",
    path: "/worktrees/review",
  };
  data.projects = [feature, review];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p2"], groupProjectId: null },
  ];
  const mainWorktree = {
    path: project.path,
    head: "a".repeat(40),
    branch: "main",
    projectIds: [] as string[],
  };
  const featureWorktree = {
    path: feature.path,
    head: "b".repeat(40),
    branch: "feature",
    projectIds: ["p2"],
  };
  const reviewWorktree = {
    path: review.path,
    head: "c".repeat(40),
    branch: "review",
    projectIds: ["p3"],
  };
  const worktrees = [mainWorktree, featureWorktree, reviewWorktree];
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => {
    const paths = new Set(data.projects.map((item) => item.path));
    const remaining = worktrees.filter(
      (worktree) => worktree === mainWorktree || paths.has(worktree.path),
    );
    return {
      groups: [
        {
          repositoryProjectId: "p1",
          projectIds: remaining.flatMap((worktree) => worktree.projectIds),
          worktrees: remaining,
        },
      ],
      complete: true,
      missingProjectIds: [],
    };
  });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));
  expect(button("Replier le groupe · Repository")).not.toBeNull();

  await action("feature", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(data.groups).toEqual([
      expect.objectContaining({ id: "g1", projectIds: ["p3"] }),
    ]),
  );
  expect(gitApi.removeGitWorktree).toHaveBeenCalledWith(
    expect.any(String),
    featureWorktree,
  );
  expect(button("Replier le groupe · Repository")).not.toBeNull();
});

function linkedWorktreesOnly() {
  const feature = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  const review = {
    ...project,
    id: "p3",
    name: "Review",
    path: "/worktrees/review",
  };
  data.projects = [feature, review];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p2"], groupProjectId: null },
  ];
  const mainWorktree = {
    path: project.path,
    head: "a".repeat(40),
    branch: "main",
    projectIds: [] as string[],
  };
  const worktrees = [
    mainWorktree,
    {
      path: feature.path,
      head: "b".repeat(40),
      branch: "feature",
      projectIds: ["p2"],
    },
    {
      path: review.path,
      head: "c".repeat(40),
      branch: "review",
      projectIds: ["p3"],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => {
    const paths = new Set(data.projects.map((item) => item.path));
    const remaining = worktrees.filter(
      (worktree) => worktree === mainWorktree || paths.has(worktree.path),
    );
    return {
      groups: [
        {
          repositoryProjectId: "p1",
          projectIds: remaining.flatMap((worktree) => worktree.projectIds),
          worktrees: remaining,
        },
      ],
      complete: true,
      missingProjectIds: [],
    };
  });
}

it("restores a handed-over group membership and keeps the Git error when the worktree removal fails", async () => {
  linkedWorktreesOnly();
  vi.mocked(gitApi.removeGitWorktree).mockRejectedValueOnce(
    new Error("Le worktree contient des modifications."),
  );
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));

  await action("feature", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(gitApi.removeGitWorktree).toHaveBeenCalledOnce(),
  );
  expect(api.saveAgentProjectGroup).toHaveBeenCalledWith({
    id: "g1",
    name: "Repository",
    projectIds: ["p3"],
  });
  for (let frame = 0; frame < 5; frame++) await nextAnimationFrame();
  await vi.waitFor(() =>
    expect(data.groups).toEqual([
      expect.objectContaining({ id: "g1", projectIds: ["p2"] }),
    ]),
  );
  for (let frame = 0; frame < 5; frame++) await nextAnimationFrame();
  expect(data.groups).toEqual([
    expect.objectContaining({ id: "g1", projectIds: ["p2"] }),
  ]);
  expect(notificationMessages()).toContain("L’opération a échoué. Réessayez.");
});

it("finishes a worktree removal when only the workspace reload fails", async () => {
  linkedWorktreesOnly();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p2", sessionId: null }),
  );
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Workspace refresh failed"),
  );

  await action("feature", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(gitApi.removeGitWorktree).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("/worktrees/feature");
  expect(notificationMessages()).toContain("L’opération a échoué. Réessayez.");
  await vi.waitFor(() =>
    expect(api.listAgentBranches).toHaveBeenCalledTimes(2),
  );
});

it("hands the group membership over while the Git panel prepares removing another worktree, and restores it on demand", async () => {
  linkedWorktreesOnly();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p3", sessionId: null }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));
  expect(gitPanelContainer.textContent).toContain("Review");

  await click("Préparer la suppression du worktree feature", gitPanelContainer);

  expect(api.saveAgentProjectGroup).toHaveBeenCalledExactlyOnceWith({
    id: "g1",
    name: "Repository",
    projectIds: ["p3"],
  });
  expect(data.groups).toEqual([
    expect.objectContaining({ id: "g1", projectIds: ["p3"] }),
  ]);
  await act(async () => runtime.worktreeRemovalRestore!());
  expect(data.groups).toEqual([
    expect.objectContaining({ id: "g1", projectIds: ["p2"] }),
  ]);
});

it("keeps a manual group after a deleted representative reload is retried before topology resolves", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects = [project, linked];
  data.sessions = [];
  data.statuses = [];
  data.groups = [
    { id: "g1", name: "Repository", projectIds: ["p1"], groupProjectId: null },
  ];
  const initialGroups: AgentProjectWorktreeGroup[] = [
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
          path: linked.path,
          head: "b".repeat(40),
          branch: "feature",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: initialGroups,
      complete: true,
      missingProjectIds: [],
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  vi.mocked(api.loadAgentWorkspace)
    .mockResolvedValueOnce(structuredClone(data))
    .mockRejectedValueOnce(new Error("Workspace refresh failed"))
    .mockImplementationOnce(async () => structuredClone(data));

  await render();
  await vi.waitFor(() => expect(projectNames()).toEqual(["Soreno"]));
  await action("Soreno", "Supprimer le projet");
  await click("Supprimer le projet", dialog());
  await vi.waitFor(() =>
    expect(notificationMessages()).toEqual([
      "L’opération a échoué. Réessayez.",
    ]),
  );
  expect(dialog().textContent).not.toContain("Workspace refresh failed");

  await click("Annuler", dialog());
  await retryFromNotification();

  await vi.waitFor(() =>
    expect(data.groups).toEqual([
      expect.objectContaining({ projectIds: ["p2"] }),
    ]),
  );
  expect(button("Replier le groupe · Repository")).not.toBeNull();
  expect(projectNames()).toEqual(["Feature"]);
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () =>
    finish({
      groups: [
        {
          repositoryProjectId: "p2",
          projectIds: ["p2"],
          worktrees: [initialGroups[0].worktrees[1]],
        },
      ],
      complete: true,
      missingProjectIds: [],
    }),
  );
});

it("imports legacy project groups once and reports projects left on another machine", async () => {
  data.projects.push({ ...project, id: "p2", name: "Website" });
  localStorage.setItem(
    projectGroupsKey,
    JSON.stringify([
      { id: "g1", name: "Suite", projectIds: ["p1", "p2"], collapsed: true },
    ]),
  );
  vi.mocked(api.importAgentProjectGroups).mockImplementationOnce(
    async ([value]) => {
      data.groups = [{ ...value, projectIds: ["p1"], groupProjectId: null }];
      return { ungroupedProjectIds: ["p2"], groupIds: ["g1"] };
    },
  );
  await render();

  await vi.waitFor(() =>
    expect(localStorage.getItem(projectGroupsKey)).toBeNull(),
  );
  expect(api.importAgentProjectGroups).toHaveBeenCalledExactlyOnceWith([
    { id: "g1", name: "Suite", projectIds: ["p1", "p2"] },
  ]);
  expect(notificationMessages()).toContain(
    "Ces projets étaient sur une autre machine et ont quitté leur groupe : Website",
  );
  await vi.waitFor(() =>
    expect(button("Déplier le groupe · Suite")).not.toBeNull(),
  );
  expect(projectNames()).toEqual(["Website"]);
});

it("collapses a migrated group under its normalized identifier", async () => {
  localStorage.setItem(
    projectGroupsKey,
    JSON.stringify([
      { id: "g 1", name: "Suite", projectIds: ["p1"], collapsed: true },
    ]),
  );
  vi.mocked(api.importAgentProjectGroups).mockImplementationOnce(
    async ([value]) => {
      data.groups = [{ ...value, id: "legacy-abc", groupProjectId: null }];
      return { ungroupedProjectIds: [], groupIds: ["legacy-abc"] };
    },
  );
  await render();

  await vi.waitFor(() =>
    expect(localStorage.getItem(projectGroupsKey)).toBeNull(),
  );
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toContain(
    "group:legacy-abc",
  );
  await vi.waitFor(() =>
    expect(button("Déplier le groupe · Suite")).not.toBeNull(),
  );
  expect(projectNames()).toEqual([]);
});

it("renames an existing group that has no members left", async () => {
  data.groups = [
    { id: "g1", name: "Suite", projectIds: [], groupProjectId: null },
  ];
  await render();

  expect(document.body.textContent).not.toContain("Vue d’ensemble");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".agent-group-empty-action")!
      .click(),
  );
  await input("Nom du groupe", "Archive");
  await click("Enregistrer", dialog());

  await vi.waitFor(() =>
    expect(api.saveAgentProjectGroup).toHaveBeenCalledWith({
      id: "g1",
      name: "Archive",
      projectIds: [],
    }),
  );
  expect(notificationMessages()).not.toContain(
    "Choisissez au moins un projet.",
  );
  await vi.waitFor(() =>
    expect(button("Replier le groupe · Archive")).not.toBeNull(),
  );
});

it("restores an empty group order before and after adding its first project", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.groups = [
    { id: "g1", name: "Archive", projectIds: [], groupProjectId: null },
  ];
  const sectionNames = () =>
    [...container.querySelectorAll(".agent-project-section")].map(
      (section) => section.querySelector(".agent-project-name")?.textContent,
    );
  await render();
  expect(sectionNames()).toEqual(["Soreno", "Other", "Archive"]);

  const menu = await context("Replier le groupe · Archive", true);
  await click("Déplacer le groupe vers le haut", menu);
  expect(sectionNames()).toEqual(["Soreno", "Archive", "Other"]);
  expect(JSON.parse(localStorage.getItem(projectSectionOrderKey)!)).toEqual([
    "project:p1",
    "group:g1",
    "project:p2",
  ]);

  await act(async () => root.render(null));
  await render();
  expect(sectionNames()).toEqual(["Soreno", "Archive", "Other"]);

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".agent-group-empty-action")!
      .click(),
  );
  await check("Soreno");
  await click("Enregistrer", dialog());

  await vi.waitFor(() => expect(data.groups![0].projectIds).toEqual(["p1"]));
  expect(sectionNames()).toEqual(["Archive", "Other"]);
  expect(JSON.parse(localStorage.getItem(projectSectionOrderKey)!)).toEqual([
    "group:g1",
    "project:p2",
  ]);

  await act(async () => root.render(null));
  await render();
  expect(sectionNames()).toEqual(["Archive", "Other"]);
});

it("preserves hidden section positions across a filter round trip", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Without agent" },
    { ...project, id: "p3", name: "Third" },
  );
  data.sessions.push({ ...session, id: "s3", projectId: "p3" });
  localStorage.setItem(
    projectSectionOrderKey,
    JSON.stringify(["project:p2", "project:p1", "project:p3"]),
  );
  await render();
  expect(projectNames()).toEqual(["Without agent", "Soreno", "Third"]);

  await click("Uniquement les projets avec agents");
  expect(projectNames()).toEqual(["Soreno", "Third"]);
  expect(JSON.parse(localStorage.getItem(projectSectionOrderKey)!)).toEqual([
    "project:p2",
    "project:p1",
    "project:p3",
  ]);

  await click("Uniquement les projets avec agents");
  expect(projectNames()).toEqual(["Without agent", "Soreno", "Third"]);
});

it("blocks the empty group action while workspace actions are locked", async () => {
  data.groups = [
    { id: "g1", name: "Archive", projectIds: [], groupProjectId: null },
  ];
  await render();
  const addProject = container.querySelector<HTMLButtonElement>(
    ".agent-group-empty-action",
  )!;

  await act(async () => {
    await guard.prepare();
  });
  expect(addProject.disabled).toBe(true);
  await act(async () => addProject.click());
  expect(dialog()).toBeNull();
});

it("opens a group overview on its prepared group project", async () => {
  data.projects.push({ ...project, id: "p2", name: "Website" });
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1", "p2"], groupProjectId: null },
  ];
  vi.mocked(gitApi.readGitRepository).mockResolvedValue({
    availability: "notRepository",
    identity: null,
    version: "v1",
    head: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: null,
    mergeMessage: null,
    files: [],
    limited: false,
    truncated: false,
  });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);

  await click("Ouvrir la vue d’ensemble · Suite");

  expect(api.prepareAgentGroupProject).toHaveBeenCalledWith("g1");
  await vi.waitFor(() =>
    expect(button("Suite").getAttribute("aria-current")).toBe("page"),
  );
  expect(
    container.querySelector('.agent-project[data-project-id="group-g1"]'),
  ).toBeNull();
  expect(projectNames()).toEqual(["Soreno", "Website"]);
  const panels =
    gitPanelContainer.querySelectorAll<HTMLElement>(".agent-git-panel");
  expect([...panels].map((panel) => panel.hidden)).toEqual([true, false]);
  await vi.waitFor(() =>
    expect(gitPanelContainer.textContent).toContain("Aucun changement."),
  );
  expect(gitPanelContainer.textContent).not.toContain("Website");
  expect(gitApi.readGitRepository).toHaveBeenCalledWith("p2");
});

it("orders overview projects like the project rail", async () => {
  data.projects.push({ ...project, id: "p2", name: "Website" });
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1", "p2"], groupProjectId: null },
  ];
  localStorage.setItem(projectOrderKey, JSON.stringify(["p2", "p1"]));
  vi.mocked(gitApi.readGitRepository).mockRejectedValue(new Error("offline"));
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);

  await click("Ouvrir la vue d’ensemble · Suite");

  await vi.waitFor(() =>
    expect(
      [
        ...gitPanelContainer.querySelectorAll(
          ".project-group-member .git-change-group-toggle > span",
        ),
      ].map((item) => item.textContent),
    ).toEqual(["Website", "Soreno"]),
  );
});

it("launches a group agent from the overview row", async () => {
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1"], groupProjectId: null },
  ];
  await render();

  await click("Nouvelle session · Vue d’ensemble · Suite");
  await click("Claude Code", document.querySelector('[role="menu"]')!);

  await vi.waitFor(() =>
    expect(api.saveAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "group-g1", executable: "claude" }),
    ),
  );
});

it("only offers projects of the first selected machine in a group", async () => {
  data.projects.push({
    ...project,
    id: "remote",
    name: "Remote",
    path: "/srv/remote",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "dev.example",
        user: "dev",
        port: null,
        identityFile: null,
        hostKey: null,
      },
    },
  });
  await render();
  await click("Ajouter un projet");
  await click("Créer un groupe", document.querySelector('[role="menu"]')!);

  await check("Remote");

  const local = [...dialog().querySelectorAll("label")].find(
    (label) => label.querySelector("strong")?.textContent === "Soreno",
  )!;
  expect(
    local.querySelector('[role="checkbox"]')?.getAttribute("aria-disabled"),
  ).toBe("true");
});

it("confirms deleting a group, optionally with its projects", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Website" },
    {
      ...project,
      id: "group-g1",
      name: "Suite",
      path: "/home/dev/.soreno/groups/g1",
    },
  );
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1"], groupProjectId: "group-g1" },
    { id: "g2", name: "Archive", projectIds: ["p2"], groupProjectId: null },
  ];
  await render();

  let menu = await context("Replier le groupe · Suite", true);
  await click("Supprimer le groupe", menu);
  expect(api.deleteAgentProjectGroup).not.toHaveBeenCalled();
  await click("Supprimer le groupe", dialog());
  await vi.waitFor(() =>
    expect(api.deleteAgentProjectGroup).toHaveBeenCalledWith("g1", false),
  );
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(projectNames()).toContain("Soreno");

  menu = await context("Replier le groupe · Archive", true);
  await click("Supprimer le groupe", menu);
  await act(async () =>
    dialog().querySelector<HTMLElement>('[role="checkbox"]')!.click(),
  );
  await click("Supprimer le groupe", dialog());
  await vi.waitFor(() =>
    expect(api.deleteAgentProjectGroup).toHaveBeenCalledWith("g2", true),
  );
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(projectNames()).not.toContain("Website");
});

it("customizes a group's icon from its menu and keeps it after a rename", async () => {
  data.groups = [
    { id: "g1", name: "Suite", projectIds: ["p1"], groupProjectId: null },
  ];
  await render();
  const popover = (name: string) =>
    document.querySelector<HTMLElement>(
      `[aria-label="Personnaliser l’icône et la couleur · ${name}"]`,
    )!;
  let menu = await context("Replier le groupe · Suite", true);
  await click("Personnaliser l’icône et la couleur", menu);
  await click("Lancement", popover("Suite"));
  expect(api.updateAgentProjectGroupAppearance).toHaveBeenCalledExactlyOnceWith(
    "g1",
    { icon: "rocket", iconDataUrl: null },
  );
  expect(api.updateAgentProjectAppearance).not.toHaveBeenCalled();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );

  menu = await context("Replier le groupe · Suite", true);
  await click("Modifier le groupe", menu);
  await input("Nom du groupe", "Suite 2");
  await click("Enregistrer", dialog());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  menu = await context("Replier le groupe · Suite 2", true);
  await click("Personnaliser l’icône et la couleur", menu);
  expect(
    button("Lancement", popover("Suite 2")).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("collapses and expands all projects and groups", async () => {
  data.projects.push(
    { ...project, id: "p2", name: "Other" },
    {
      ...project,
      id: "group-g1",
      name: "Suite",
      path: "/home/dev/.soreno/groups/g1",
    },
  );
  data.groups = [
    { id: "g1", name: "Suite", projectIds: [], groupProjectId: "group-g1" },
  ];
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "group-g1",
    name: "Group agent",
  });
  data.statuses.push({ sessionId: "s3", state: "running", exitCode: null });
  await render();
  const overviewSessions = () =>
    container.querySelector('[aria-label="Activité des sessions · Suite"]');
  expect(overviewSessions()?.textContent).toContain("Group agent");
  const groupActivity = () =>
    button("Suite").querySelector(".agent-project-activity");
  expect(groupActivity()).toBeNull();

  await click("Tout replier");
  expect(
    button("Déplier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    button("Déplier le projet · Other").getAttribute("aria-expanded"),
  ).toBe("false");
  expect(overviewSessions()).toBeNull();
  expect(groupActivity()?.getAttribute("aria-label")).toBe("1 agent actif");
  expect(
    button("Déplier le groupe · Suite").getAttribute("aria-expanded"),
  ).toBe("false");
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toEqual(
    expect.arrayContaining(["p1", "p2", "group-g1", "group:g1"]),
  );

  await click("Tout déplier");
  expect(
    button("Replier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    button("Replier le projet · Other").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toEqual([]);
  expect(overviewSessions()?.textContent).toContain("Group agent");

  await click("Tout replier");
  await click("Déplier le groupe · Suite");
  expect(overviewSessions()?.textContent).toContain("Group agent");
  await click("Replier le groupe · Suite");
  expect(groupActivity()?.textContent).toBe("1");
});

it("persists collapsed projects across mounts", async () => {
  await render();
  await click("Replier le projet · Soreno");
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toEqual([
    "p1",
  ]);
  expect(container.querySelector(".agent-activity-list")).toBeNull();
  await act(async () => root.render(null));
  await render();
  expect(
    button("Déplier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("false");
  await click("Déplier le projet · Soreno");
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toEqual([]);
});

it("summarizes active agents when a project is collapsed", async () => {
  vi.useFakeTimers();
  setStatus("s2", "running");
  await render();
  await click("Replier le projet · Soreno");
  const projectRow = button("Soreno");
  const activity = () =>
    projectRow.querySelector<HTMLElement>(".agent-project-activity");

  expect(activity()?.textContent).toBe("2");
  expect(
    activity()?.querySelector(".agent-status-dot.is-running"),
  ).not.toBeNull();

  data.statuses[0].working = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(activity()?.querySelector(".app-loading-spinner")).not.toBeNull();

  setStatus("s1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(activity()?.getAttribute("aria-label")).toBe(
    "1 agent actif · Agent terminé · non lu",
  );
  expect(
    activity()?.querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();

  setStatus("s2", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    activity()?.querySelector(".agent-status-dot.is-unread"),
  ).not.toBeNull();
  expect(activity()?.textContent).toBe("");
});

it("opens the clicked session tab while the project title toggles the section", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push(
    {
      ...session,
      id: "s3",
      projectId: "p2",
      name: "Other agent",
    },
    {
      ...session,
      id: "s4",
      projectId: "p2",
      name: "Other tests",
    },
  );
  await render();
  const otherProject = button("Other").closest(".agent-project")!;
  const activity = otherProject.querySelectorAll<HTMLButtonElement>(
    ".agent-activity-session",
  )[1];

  await act(async () => activity.click());
  const tabs = container.querySelector('[aria-label="Sessions du projet"]')!;
  expect(button("Other").getAttribute("aria-current")).toBe("page");
  expect(button("Other tests", tabs).getAttribute("aria-current")).toBe("page");
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(
    button("Replier le projet · Other").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(otherProject.querySelector(".agent-activity-list")).not.toBeNull();

  await click("Other");
  expect(
    button("Déplier le projet · Other").getAttribute("aria-expanded"),
  ).toBe("false");
  expect(otherProject.querySelector(".agent-activity-list")).toBeNull();
  expect(JSON.parse(localStorage.getItem(collapsedProjectsKey)!)).toEqual([
    "p2",
  ]);
});

it("closes another project's session from the rail without leaving the current project", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  await render();
  const otherProject = button("Other").closest(".agent-project")!;
  const tabs = container.querySelector('[aria-label="Sessions du projet"]')!;
  await click("Pi notes", tabs);
  expect(button("Pi notes", tabs).getAttribute("aria-current")).toBe("page");
  const close = button("Fermer l’onglet · Other agent", otherProject);
  await act(async () => close.focus());
  await act(async () => close.click());
  expect(api.deleteAgentSession).toHaveBeenCalledExactlyOnceWith("s3");
  expect(button("Other").getAttribute("aria-current")).toBeNull();
  expect(otherProject.textContent).not.toContain("Other agent");
  expect(button("Pi notes", tabs).getAttribute("aria-current")).toBe("page");
  await act(async () =>
    vi.waitFor(
      () => expect(document.activeElement).toBe(button("Pi notes", tabs)),
      { timeout: 500 },
    ),
  );

  const currentProject = button("Soreno").closest(".agent-project")!;
  const row = [
    ...currentProject.querySelectorAll<HTMLButtonElement>(
      ".agent-activity-session",
    ),
  ].find((item) => item.textContent?.includes("Pi notes"))!;
  await act(async () => row.focus());
  await act(async () =>
    button("Codex tests", tabs).dispatchEvent(
      new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.deleteAgentSession).toHaveBeenLastCalledWith("s2");
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(document.activeElement).toBe(row);
});

it("guards edits to the displayed fallback project instead of the stale stored selection", async () => {
  data.sessions = [];
  data.statuses = [];
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "missing", sessionId: null }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await action("Soreno", "Modifier le projet");
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/projects/replacement",
    suggestedName: "replacement",
    environment: project.environment,
  });
  await click("Choisir un dossier…", dialog());
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await click("Enregistrer", dialog());

  expect(runtime.projectNavigationPrepare).toHaveBeenCalledOnce();
  expect(api.saveAgentProject).not.toHaveBeenCalled();
});

it("guards deletion of the displayed fallback project instead of the stale stored selection", async () => {
  data.sessions = [];
  data.statuses = [];
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "missing", sessionId: null }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await action("Soreno", "Supprimer le projet");
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await click("Supprimer le projet", dialog());

  expect(runtime.projectNavigationPrepare).toHaveBeenCalledOnce();
  expect(api.deleteAgentProject).not.toHaveBeenCalled();
});

it("guards disconnection of the displayed fallback project instead of the stale stored selection", async () => {
  const host = sshStatusHost();
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "missing", sessionId: null }),
  );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  await click("Déconnecter · Soreno", host);
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await click("Déconnecter", dialog());

  expect(runtime.projectNavigationPrepare).toHaveBeenCalledOnce();
  expect(api.setAgentProjectConnected).not.toHaveBeenCalled();
});

it("keeps the current project when the file editor refuses navigation", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Other agent",
  });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);

  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);
  await click("Other");
  expect(runtime.projectNavigationPrepare).toHaveBeenCalledTimes(1);
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(button("Other").getAttribute("aria-current")).toBeNull();

  await click("Other");
  expect(button("Other").getAttribute("aria-current")).toBe("page");
});

it("restores per-project order, reconciles automatic titles and closes in displayed order", async () => {
  data.sessions.push({ ...session, id: "s3", name: "Third" });
  localStorage.setItem(
    tabOrderKey,
    JSON.stringify({ p1: ["s3", "s2", "s1"], gone: ["old"] }),
  );
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  await render();
  expect(tabNames()).toEqual(["Third", "Codex tests", "Pi notes"]);
  expect(
    [...container.querySelectorAll(".agent-activity-name")].map(
      (item) => item.textContent,
    ),
  ).toEqual(tabNames());
  expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
    p1: ["s3", "s2", "s1"],
  });
  await act(async () => runtime.titles.get("s1")!("π - Renamed - soreno"));
  expect(tabNames()).toEqual(["Third", "Codex tests", "Renamed"]);
  await click("Fermer l’onglet · Renamed");
  expect(button("Third").getAttribute("aria-current")).toBe("page");
  expect(JSON.parse(localStorage.getItem(tabOrderKey)!)).toEqual({
    p1: ["s3", "s2"],
  });
  expect(api.startAgentSession).not.toHaveBeenCalled();
  await newAgent("Terminal");
  expect(tabNames()).toEqual(["Third", "Codex tests", "Terminal"]);
});

it("does not discard saved order before a successful initial load", async () => {
  data.projects.push({ ...project, id: "p2", name: "Other" });
  const saved = JSON.stringify({ p1: ["s2", "s1"], gone: ["old"] });
  const savedProjects = JSON.stringify(["p2", "missing", "p1"]);
  localStorage.setItem(tabOrderKey, saved);
  localStorage.setItem(projectOrderKey, savedProjects);
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p1", sessionId: "s1" }),
  );
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Unavailable"),
  );
  await render();
  expect(localStorage.getItem(tabOrderKey)).toBe(saved);
  expect(localStorage.getItem(projectOrderKey)).toBe(savedProjects);
  let finish!: (value: WorkspaceData) => void;
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await retryFromNotification();
  expect(localStorage.getItem(tabOrderKey)).toBe(saved);
  expect(localStorage.getItem(projectOrderKey)).toBe(savedProjects);
  await act(async () => finish(structuredClone(data)));
  expect(tabNames()).toEqual(["Codex tests", "Pi notes"]);
  expect(projectNames()).toEqual(["Other", "Soreno"]);
  expect(JSON.parse(localStorage.getItem(projectOrderKey)!)).toEqual([
    "p2",
    "p1",
  ]);
});
