// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGitReadCache } from "../../data/gitReadCache";
import * as api from "../../data/projectGitApi";
import type { AgentProject } from "../../domain/agentSessions";
import type {
  GitBranch,
  GitRepository,
  GitWorktree,
} from "../../domain/projectGit";
import type { useProjectGit } from "../../hooks/useProjectGit";
import { clearNotifications, getNotifications } from "../../notifications";
import { GitBranchesView } from "./GitBranchesView";
import { projectGitTestState } from "./projectGitTestState";
import { setInputValue } from "../ui/testInput";
import { deferred } from "../../testing/deferred";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../data/projectGitApi", () => ({
  readGitBranches: vi.fn(),
  createGitBranch: vi.fn(),
  removeGitBranch: vi.fn(),
  mergeGitWorktree: vi.fn(),
  switchGitBranch: vi.fn(),
  readGitWorktrees: vi.fn(),
  createGitWorktree: vi.fn(),
  removeGitWorktree: vi.fn(),
}));

const project: AgentProject = {
  id: "p1",
  name: "Repo",
  path: "/repo",
  environment: { kind: "local", distribution: null },
};
const repo: GitRepository = {
  availability: "ready",
  identity: { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" },
  version: "v2",
  head: "abc",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  operation: null,
  mergeMessage: null,
  files: [],
  limited: false,
  truncated: false,
};
let container: HTMLDivElement;
let root: Root;
let git: ReturnType<typeof useProjectGit>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: "origin/main",
    },
    {
      name: "origin/feature/x",
      oid: "remote-oid",
      remote: true,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.createGitBranch).mockResolvedValue({
    oid: null,
    message: "created",
    warning: null,
  });
  vi.mocked(api.switchGitBranch).mockResolvedValue({
    oid: null,
    message: "switched",
    warning: null,
  });
  vi.mocked(api.removeGitBranch).mockResolvedValue({
    oid: null,
    message: "deleted",
    warning: null,
  });
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
  ]);
  vi.mocked(api.createGitWorktree).mockResolvedValue({
    id: "created",
    name: "Created",
    path: "/repo-feature",
    environment: project.environment,
  });
  vi.mocked(api.removeGitWorktree).mockResolvedValue({
    oid: null,
    message: "deleted",
    warning: null,
  });
  git = projectGitTestState(repo, {
    draft: { view: "branches", message: "", selection: null },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  clearNotifications();
});
async function render(
  props: Partial<ComponentProps<typeof GitBranchesView>> = {},
) {
  await act(async () =>
    root.render(
      <GitBranchesView
        active
        git={git}
        project={project}
        projects={[project]}
        {...props}
      />,
    ),
  );
}

it("keeps loaded refs visible when a forced refresh fails", async () => {
  const cache = createGitReadCache();
  await render({ readCache: cache, readScope: "scope" });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("origin/feature/x"),
  );
  expect(container.textContent).toContain("/repo");

  const branchesRead = deferred<GitBranch[]>();
  const worktreesRead = deferred<GitWorktree[]>();
  vi.mocked(api.readGitBranches).mockReturnValueOnce(branchesRead.promise);
  vi.mocked(api.readGitWorktrees).mockReturnValueOnce(worktreesRead.promise);

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les branches"]',
      )!
      .click(),
  );
  expect(container.textContent).toContain("origin/feature/x");
  expect(container.textContent).toContain("/repo");

  await act(async () => {
    branchesRead.reject(new Error("Refresh failed"));
    worktreesRead.reject(new Error("Refresh failed"));
  });
  await vi.waitFor(() =>
    expect(getNotifications()).toContainEqual(
      expect.objectContaining({
        key: "git-branches:scope",
        message: "Lecture des branches et worktrees Git impossible.",
        tone: "error",
      }),
    ),
  );
  expect(document.body.textContent).not.toContain("Refresh failed");
  expect(container.textContent).toContain("origin/feature/x");
  expect(container.textContent).toContain("/repo");
});

it("forces a refresh when the agent branch revision changes", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-review", head: "def", branch: "review" },
  ]);
  await render({ readCache: cache, readScope: "scope", branchRevision: 0 });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-review"),
  );

  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
  ]);
  await render({ readCache: cache, readScope: "scope", branchRevision: 1 });

  await vi.waitFor(() =>
    expect(container.textContent).not.toContain("/repo-review"),
  );
  expect(api.readGitWorktrees).toHaveBeenCalledTimes(2);
});

it("creates without switching and confirms a remote switch with its full target", async () => {
  let finish!: () => void;
  vi.mocked(api.createGitBranch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ oid: null, message: "created", warning: null });
      }),
  );
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("origin/feature/x"),
  );
  const input = container.querySelector<HTMLInputElement>("#git-branch-name")!;
  await act(async () => {
    setInputValue(input, "topic/new");
  });
  const create = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer la branche")!;
  await act(async () => create.click());
  expect(create.getAttribute("aria-busy")).toBe("true");
  expect(api.createGitBranch).toHaveBeenCalledWith("p1", "topic/new", "v2");
  await act(async () => finish());
  expect(input.value).toBe("");
  expect(api.switchGitBranch).not.toHaveBeenCalled();

  const remote = container.querySelector<HTMLButtonElement>(
    '[aria-label="Basculer · origin/feature/x"]',
  )!;
  await act(async () => remote.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Destination locale: feature/x");
  expect(dialog.textContent).toContain("Source distante: origin/feature/x");
  expect(dialog.textContent).not.toContain("Version du dépôt");
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Basculer")!;
  await act(async () => confirm.click());
  expect(api.switchGitBranch).toHaveBeenCalledWith(
    "p1",
    "origin/feature/x",
    true,
    "v2",
  );
});

it.each(["success", "failure"] as const)(
  "restores the branch input after a switch %s",
  async (outcome) => {
    let finishSwitch!: () => void;
    vi.mocked(api.switchGitBranch).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishSwitch = () =>
            outcome === "success"
              ? resolve({ oid: null, message: "switched", warning: null })
              : reject(new Error("Switch failed"));
        }),
    );
    git = {
      ...git,
      mutate: vi.fn(async (work: () => Promise<unknown>) => {
        try {
          return await work();
        } catch {
          return undefined;
        }
      }) as typeof git.mutate,
    };
    await render();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("origin/feature/x"),
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Basculer · origin/feature/x"]',
        )!
        .click(),
    );
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirm = [
      ...dialog.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Basculer")!;
    await act(async () => {
      confirm.click();
      git = { ...git, busy: true };
      root.render(
        <GitBranchesView
          active
          git={git}
          project={project}
          projects={[project]}
        />,
      );
    });

    const input =
      container.querySelector<HTMLInputElement>("#git-branch-name")!;
    expect(input.disabled).toBe(true);
    expect(document.activeElement).not.toBe(input);
    await act(async () => finishSwitch());
    git = { ...git, busy: false };
    await render();

    expect(document.activeElement).toBe(input);
  },
);

it("creates a worktree and its new branch in one operation", async () => {
  const onWorktreeCreated = vi.fn();
  const worktreeCreation = deferred<AgentProject>();
  vi.mocked(api.createGitWorktree).mockReturnValueOnce(
    worktreeCreation.promise,
  );
  await render({ onWorktreeCreated });
  const input = container.querySelector<HTMLInputElement>("#git-branch-name")!;
  await act(async () => {
    setInputValue(input, "topic/new");
  });
  const open = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;
  await act(async () => open.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Branche: topic/new");
  expect(dialog.textContent).toContain("/repo-topic-new");
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;
  await act(async () => confirm.click());
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(api.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({
      branch: "topic/new",
      remote: false,
      createBranch: true,
    }),
  );
  expect(api.createGitBranch).not.toHaveBeenCalled();
  await act(async () =>
    worktreeCreation.resolve({
      id: "created",
      name: "Created",
      path: "/repo-feature",
      environment: project.environment,
    }),
  );
  expect(onWorktreeCreated).toHaveBeenCalledWith(
    expect.objectContaining({ id: "created" }),
    expect.objectContaining({
      path: "/repo-feature",
      head: "abc",
      branch: "topic/new",
    }),
  );
  expect(input.value).toBe("");
});

it("blocks an open worktree dialog after an uncertain mutation error", async () => {
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("origin/feature/x"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Créer un worktree · origin/feature/x"]',
      )!
      .click(),
  );

  git = {
    ...git,
    error: {
      message: "Le résultat est incertain.",
      uncertain: true,
      source: "mutation",
    },
  };
  await render();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;

  expect(confirm.disabled).toBe(true);
  expect(dialog.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(
    true,
  );
  await act(async () => confirm.click());
  expect(api.createGitWorktree).not.toHaveBeenCalled();
  expect(getNotifications()).not.toContainEqual(
    expect.objectContaining({ key: "git:repository-changed" }),
  );
});

it("confirms deletion of a free local branch only", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: "origin/main",
    },
    {
      name: "feature/old",
      oid: "old-oid",
      remote: false,
      current: false,
      upstream: null,
    },
    {
      name: "origin/feature/old",
      oid: "remote-old-oid",
      remote: true,
      current: false,
      upstream: null,
    },
  ]);
  git = {
    ...git,
    error: {
      message: "Suppression précédente refusée",
      uncertain: false,
      source: "mutation",
    },
  };
  const onPrepareWorktreeRemoval = vi.fn(async () => vi.fn(async () => {}));
  await render({ onPrepareWorktreeRemoval });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("feature/old"),
  );

  expect(
    container.querySelector('[aria-label="Supprimer la branche · main"]'),
  ).toBeNull();
  expect(
    container.querySelector(
      '[aria-label="Supprimer la branche · origin/feature/old"]',
    ),
  ).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Supprimer la branche · feature/old"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(
    "uniquement si ses commits sont déjà fusionnés",
  );
  expect(dialog.textContent).toContain("feature/old");
  expect(dialog.textContent).not.toContain("Suppression précédente refusée");
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Supprimer la branche")!;
  await act(async () => confirm.click());
  expect(api.removeGitBranch).toHaveBeenCalledWith(
    "p1",
    "feature/old",
    "old-oid",
    "v2",
  );
  expect(onPrepareWorktreeRemoval).not.toHaveBeenCalled();
});

it("returns focus to a worktree action when deletion is cancelled", async () => {
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-review", head: "def", branch: "review" },
  ]);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-review"),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Supprimer le worktree · review"]',
  )!;
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;

  await act(async () =>
    [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Annuler")!
      .click(),
  );

  expect(document.activeElement).toBe(trigger);
});

it("confirms deletion of a secondary worktree and refreshes projects", async () => {
  const onWorktreeRemoved = vi.fn();
  const restore = vi.fn(async () => {});
  const onPrepareWorktreeRemoval = vi.fn(
    async (_worktree: GitWorktree) => restore,
  );
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "review",
      oid: "review-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-review", head: "def", branch: "review" },
  ]);
  vi.mocked(api.removeGitWorktree).mockResolvedValueOnce({
    oid: null,
    message: "deleted",
    warning: "La branche review subsiste.",
  });
  await render({ onWorktreeRemoved, onPrepareWorktreeRemoval });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-review"),
  );

  expect(
    container.querySelector('[aria-label="Supprimer le worktree · main"]'),
  ).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Supprimer le worktree · review"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("/repo-review");
  expect(dialog.textContent).toContain(
    "les commits locaux non fusionnés de cette branche seront supprimés",
  );
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Supprimer le worktree")!;
  await act(async () => confirm.click());
  const reviewWorktree = {
    path: "/repo-review",
    head: "def",
    branch: "review",
  };
  expect(onPrepareWorktreeRemoval).toHaveBeenCalledExactlyOnceWith(
    reviewWorktree,
  );
  expect(api.removeGitWorktree).toHaveBeenCalledWith("p1", reviewWorktree);
  expect(onPrepareWorktreeRemoval.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(api.removeGitWorktree).mock.invocationCallOrder[0],
  );
  expect(restore).not.toHaveBeenCalled();
  expect(onWorktreeRemoved).toHaveBeenCalledOnce();
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "La branche review subsiste.",
      tone: "warning",
    }),
  );
  expect(getNotifications()).not.toContainEqual(
    expect.objectContaining({
      message: "L’opération est terminée avec un avertissement.",
    }),
  );
  expect(document.activeElement).toBe(
    container.querySelector<HTMLInputElement>("#git-branch-name"),
  );
});

it("undoes the removal preparation and keeps the Git error when the worktree removal fails", async () => {
  const failure = new Error("Le worktree contient des modifications.");
  let reported: unknown;
  git = {
    ...git,
    mutate: vi.fn(async (work: () => Promise<unknown>) => {
      try {
        return await work();
      } catch (reason) {
        reported = reason;
        return undefined;
      }
    }) as typeof git.mutate,
  };
  const onWorktreeRemoved = vi.fn();
  const restore = vi.fn(async () => {});
  const onPrepareWorktreeRemoval = vi.fn(
    async (_worktree: GitWorktree) => restore,
  );
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-review", head: "def", branch: "review" },
  ]);
  vi.mocked(api.removeGitWorktree).mockRejectedValueOnce(failure);
  await render({ onWorktreeRemoved, onPrepareWorktreeRemoval });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-review"),
  );

  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Supprimer le worktree · review"]',
  )!;
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Supprimer le worktree")!;
  await act(async () => confirm.click());

  expect(api.removeGitWorktree).toHaveBeenCalledOnce();
  expect(restore).toHaveBeenCalledOnce();
  expect(
    vi.mocked(api.removeGitWorktree).mock.invocationCallOrder[0],
  ).toBeLessThan(restore.mock.invocationCallOrder[0]);
  expect(reported).toBe(failure);
  expect(onWorktreeRemoved).not.toHaveBeenCalled();
  expect(container.textContent).toContain("/repo-review");
});

it.each([
  { name: "restores the branch input after the refresh", focusOutside: false },
  {
    name: "keeps focus on a control used during the refresh",
    focusOutside: true,
  },
])("$name", async ({ focusOutside }) => {
  const onWorktreeRemoved = vi.fn();
  let finishMerge!: () => void;
  let finishRefresh!: () => void;
  git = {
    ...git,
    mutate: vi.fn(async (work: () => Promise<unknown>) => {
      const result = await work();
      await new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      return result;
    }) as typeof git.mutate,
  };
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature",
      oid: "def",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-feature", head: "def", branch: "feature" },
  ]);
  vi.mocked(api.mergeGitWorktree).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishMerge = () =>
          resolve({ oid: null, message: "merged", warning: null });
      }),
  );
  await render({ onWorktreeRemoved });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-feature"),
  );

  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Fusionner dans main et supprimer · feature"]',
  )!;
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Fusionner et supprimer")!;
  await act(async () => confirm.click());
  git = { ...git, busy: true };
  await render({ onWorktreeRemoved });
  await act(async () => finishMerge());

  expect(api.mergeGitWorktree).toHaveBeenCalledWith(
    "p1",
    { path: "/repo-feature", head: "def", branch: "feature" },
    "main",
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const input = container.querySelector<HTMLInputElement>("#git-branch-name")!;
  expect(input.disabled).toBe(true);
  expect(document.activeElement).not.toBe(input);
  const outside = focusOutside ? document.createElement("button") : null;
  if (outside) {
    document.body.append(outside);
    outside.focus();
  }
  expect(container.textContent).not.toContain("/repo-feature");
  expect(container.querySelector('[aria-label*="· feature"]')).toBeNull();
  expect(onWorktreeRemoved).toHaveBeenCalledWith({
    path: "/repo-feature",
    head: "def",
    branch: "feature",
  });
  await act(async () => finishRefresh());
  git = { ...git, busy: false };
  await render({ onWorktreeRemoved });
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(outside ?? input);
  outside?.remove();
});

it("stops the worktree sessions before merging, and merges nothing if stopping fails", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature",
      oid: "def",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-feature", head: "def", branch: "feature" },
  ]);
  vi.mocked(api.mergeGitWorktree).mockResolvedValue({
    oid: null,
    message: "merged",
    warning: null,
  });
  const onStopWorktreeSessions = vi
    .fn()
    .mockRejectedValueOnce(new Error("Le processus n’est pas encore arrêté."))
    .mockResolvedValueOnce(undefined);
  await render({
    worktreeRunningSessions: (worktree) =>
      worktree.path === "/repo-feature" ? 1 : 0,
    onStopWorktreeSessions,
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-feature"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Fusionner dans main et supprimer · feature"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(
    "La session active de ce worktree sera d’abord arrêtée.",
  );
  const confirm = () =>
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Arrêter les sessions et fusionner",
    )!;

  await act(async () => confirm().click());
  expect(api.mergeGitWorktree).not.toHaveBeenCalled();
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Impossible d’arrêter les sessions de ce worktree.",
      tone: "error",
    }),
  );
  expect(dialog.textContent).not.toContain(
    "Le processus n’est pas encore arrêté.",
  );

  await act(async () => confirm().click());
  expect(onStopWorktreeSessions).toHaveBeenCalledTimes(2);
  expect(api.mergeGitWorktree).toHaveBeenCalledExactlyOnceWith(
    "p1",
    { path: "/repo-feature", head: "def", branch: "feature" },
    "main",
  );
  expect(onStopWorktreeSessions.mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(api.mergeGitWorktree).mock.invocationCallOrder[0],
  );
});

it("ignores a branch read started before an optimistic worktree removal", async () => {
  let finishRefresh!: () => void;
  git = {
    ...git,
    mutate: vi.fn(async (work: () => Promise<unknown>) => {
      const result = await work();
      await new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      return result;
    }) as typeof git.mutate,
  };
  const branches = [
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature",
      oid: "def",
      remote: false,
      current: false,
      upstream: null,
    },
  ];
  vi.mocked(api.readGitBranches).mockResolvedValue(branches);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-feature", head: "def", branch: "feature" },
  ]);
  vi.mocked(api.mergeGitWorktree).mockResolvedValueOnce({
    oid: null,
    message: "merged",
    warning: null,
  });
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-feature"),
  );

  let finishRead!: () => void;
  vi.mocked(api.readGitBranches).mockReturnValueOnce(
    new Promise((resolve) => {
      finishRead = () => resolve(branches);
    }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les branches"]',
      )!
      .click(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Fusionner dans main et supprimer · feature"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Fusionner et supprimer")!;
  await act(async () => confirm.click());
  expect(container.textContent).not.toContain("/repo-feature");

  await act(async () => finishRead());
  expect(container.textContent).not.toContain("/repo-feature");
  expect(container.querySelector('[aria-label*="· feature"]')).toBeNull();
  await act(async () => finishRefresh());
});

it("offers branch creation while HEAD is detached and blocks switching with dirty files", async () => {
  git = {
    ...git,
    repo: {
      ...repo,
      branch: null,
      files: [
        {
          path: "dirty.ts",
          oldPath: null,
          indexStatus: ".",
          worktreeStatus: "M",
          conflict: false,
          submodule: false,
          actionable: true,
          mode: "100644",
          added: 1,
          deleted: 0,
        },
      ],
    },
  };
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("HEAD est détachée"),
  );
  const current = container.querySelector<HTMLButtonElement>(
    '[aria-label="Basculer · main"]',
  )!;
  const remote = container.querySelector<HTMLButtonElement>(
    '[aria-label="Basculer · origin/feature/x"]',
  )!;
  expect(current.getAttribute("aria-current")).toBe("true");
  expect(remote.disabled).toBe(true);
  expect(container.textContent).toContain("Commitez ou remisez");
  expect(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Créer un worktree · origin/feature/x"]',
    )?.disabled,
  ).toBe(false);
});

it("does not reuse or mark a differently named local branch tracking the same remote", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "develop",
      oid: "develop-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "review-main",
      oid: "review-oid",
      remote: false,
      current: false,
      upstream: "origin/main",
    },
    {
      name: "origin/main",
      oid: "remote-main-oid",
      remote: true,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "develop" },
    { path: "/repo-review", head: "def", branch: "review-main" },
  ]);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("origin/main"),
  );
  const remote = container.querySelector<HTMLButtonElement>(
    '[aria-label="Basculer · origin/main"]',
  )!;
  expect(remote.getAttribute("aria-current")).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Créer un worktree · origin/main"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;
  await act(async () => confirm.click());
  expect(api.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ branch: "origin/main", remote: true }),
  );
});

it("uses the exact-name local tracking branch when creating from its remote row", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature/tracked",
      oid: "tracked-oid",
      remote: false,
      current: false,
      upstream: "origin/feature/tracked",
    },
    {
      name: "origin/feature/tracked",
      oid: "remote-tracked-oid",
      remote: true,
      current: false,
      upstream: null,
    },
  ]);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("origin/feature/tracked"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Créer un worktree · origin/feature/tracked"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;
  await act(async () => confirm.click());
  expect(api.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ branch: "feature/tracked", remote: false }),
  );
});

it("opens a registered worktree only in the selected SSH environment", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature/occupied",
      oid: "occupied-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/shared/repo", head: "def", branch: "feature/occupied" },
  ]);
  const ssh = {
    host: "one.example",
    user: "git",
    port: 22,
    identityFile: null,
    hostKey: null,
  };
  const remoteProject: AgentProject = {
    ...project,
    environment: { kind: "ssh", distribution: null, ssh },
  };
  const matching: AgentProject = {
    ...remoteProject,
    id: "matching",
    name: "Matching",
    path: "/shared/repo",
  };
  const wrongHost: AgentProject = {
    ...matching,
    id: "wrong",
    name: "Wrong host",
    environment: {
      kind: "ssh",
      distribution: null,
      ssh: { ...ssh, host: "two.example" },
    },
  };
  const onOpenProject = vi.fn();
  await render({
    project: remoteProject,
    projects: [remoteProject, matching, wrongHost],
    onOpenProject,
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/shared/repo"),
  );

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Ouvrir le worktree · feature/occupied"]',
      )!
      .click(),
  );
  expect(onOpenProject).toHaveBeenCalledWith("matching");
});

it("opens a registered WSL worktree when distribution casing differs", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature/occupied",
      oid: "occupied-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/shared/repo", head: "def", branch: "feature/occupied" },
  ]);
  const source: AgentProject = {
    ...project,
    environment: { kind: "wsl", distribution: "Ubuntu-24.04" },
  };
  const matching: AgentProject = {
    ...source,
    id: "matching",
    name: "Matching",
    path: "/shared/repo",
    environment: { kind: "wsl", distribution: "ubuntu-24.04" },
  };
  const onOpenProject = vi.fn();
  const onOpenExternalWorktree = vi.fn();
  await render({
    project: source,
    projects: [source, matching],
    onOpenProject,
    onOpenExternalWorktree,
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/shared/repo"),
  );

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Ouvrir le worktree · feature/occupied"]',
      )!
      .click(),
  );
  expect(onOpenProject).toHaveBeenCalledWith("matching");
  expect(onOpenExternalWorktree).not.toHaveBeenCalled();
});

it("keeps distinct POSIX paths containing backslashes", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "review",
      oid: "review-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/work/repo\\review", head: "def", branch: "review" },
  ]);
  const backslashProject: AgentProject = {
    ...project,
    id: "backslash",
    name: "Backslash",
    path: "/work/repo\\review",
  };
  const slashProject: AgentProject = {
    ...project,
    id: "slash",
    name: "Slash",
    path: "/work/repo/review",
  };
  const onOpenProject = vi.fn();
  await render({
    projects: [project, backslashProject, slashProject],
    onOpenProject,
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/work/repo\\review"),
  );

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Ouvrir le worktree · review"]',
      )!
      .click(),
  );
  expect(onOpenProject).toHaveBeenCalledWith("backslash");
});

it("opens an external worktree without requiring a pre-registered project", async () => {
  const external = { path: "/external/review", head: "def", branch: "review" };
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "review",
      oid: "review-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    external,
  ]);
  const onOpenExternalWorktree = vi.fn();
  await render({ onOpenExternalWorktree });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/external/review"),
  );

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Ouvrir le worktree · review"]',
      )!
      .click(),
  );
  expect(onOpenExternalWorktree).toHaveBeenCalledWith(external);
});

it("lists occupied worktrees, opens registered ones and creates a project from a free branch", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
    {
      name: "feature/free",
      oid: "free-oid",
      remote: false,
      current: false,
      upstream: null,
    },
    {
      name: "feature/occupied",
      oid: "occupied-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo-occupied", head: "def", branch: "feature/occupied" },
  ]);
  const occupied: AgentProject = {
    ...project,
    id: "p2",
    name: "Occupied",
    path: "/repo-occupied",
  };
  const onOpenProject = vi.fn();
  const onWorktreeCreated = vi.fn();
  await render({
    projects: [project, occupied],
    onOpenProject,
    onWorktreeCreated,
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/repo-occupied"),
  );

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Ouvrir le worktree · feature/occupied"]',
      )!
      .click(),
  );
  expect(onOpenProject).toHaveBeenCalledWith("p2");

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Créer un worktree · feature/free"]',
      )!
      .click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("/repo-feature-free");
  const confirm = [
    ...dialog.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Créer un worktree")!;
  await act(async () => confirm.click());
  expect(api.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({
      name: "Repo · feature/free",
      parentPath: "/",
      folderName: "repo-feature-free",
      branch: "feature/free",
      remote: false,
      version: "v2",
    }),
  );
  expect(onWorktreeCreated).toHaveBeenCalledWith(
    expect.objectContaining({ id: "created" }),
    expect.objectContaining({
      path: "/repo-feature",
      head: "free-oid",
      branch: "feature/free",
    }),
  );
});
