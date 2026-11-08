// @vitest-environment jsdom
import {
  act,
  useEffect,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  GitComparison,
  GitRepository,
  GitWorktree,
} from "../../domain/projectGit";
import { writeClipboardText } from "../../data/clipboard";
import * as forgeApi from "../../data/forgeApi";
import type { ForgeRequestDetail } from "../../domain/forge";
import * as api from "../../data/projectGitApi";
import { useProjectGit } from "../../hooks/useProjectGit";
import {
  clearNotifications,
  closeNotification,
  getNotifications,
} from "../../notifications";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import { projectGitTestState } from "./projectGitTestState";
import { localTestProject as project } from "./testProject";
import { setInputValue } from "../ui/testInput";
import { stubModalSelector } from "../ui/testTopLayer";
import { deferred } from "../../testing/deferred";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { materialFileIconsEnabled: false } }),
}));
vi.mock("@base-ui/react/menu", async () => {
  const { cloneElement } = await import("react");
  const Pass = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: {
      Root: Pass,
      Portal: Pass,
      Positioner: Pass,
      RadioGroup: Pass,
      Separator: () => null,
      RadioItem: ({
        render,
        children,
      }: {
        render: ReactElement;
        children: ReactNode;
      }) => cloneElement(render, {}, children),
      Trigger: ({
        render,
        ref,
      }: {
        render: ReactElement;
        ref?: Ref<HTMLButtonElement>;
      }) => cloneElement(render, { ref } as never),
      Popup: ({
        render,
        children,
      }: {
        render: ReactElement;
        children: ReactNode;
      }) => cloneElement(render, {}, children),
      Item: ({
        render,
        children,
        disabled,
        onClick,
      }: {
        render: ReactElement;
        children: ReactNode;
        disabled?: boolean;
        onClick: () => void;
      }) => cloneElement(render, { disabled, onClick } as never, children),
    },
  };
});
vi.mock("../../hooks/useProjectGit", () => ({ useProjectGit: vi.fn() }));
vi.mock("../../data/forgeApi", () => ({
  readForgeRemote: vi.fn(),
  readForgeRequests: vi.fn(),
  readForgeRequest: vi.fn(),
  readForgeChanges: vi.fn(),
  readForgeComparison: vi.fn(),
  mergeForgeRequest: vi.fn(),
  updateForgeRequest: vi.fn(),
  checkoutForgeRequest: vi.fn(),
}));
vi.mock("../../data/clipboard", () => ({ writeClipboardText: vi.fn() }));
vi.mock("../../data/projectGitApi", () => ({
  generateGitCommitMessage: vi.fn(),
  initGitRepository: vi.fn(),
  stageGitFiles: vi.fn(),
  unstageGitFiles: vi.fn(),
  commitGitChanges: vi.fn(),
  quickCommitGitChanges: vi.fn(),
  setGitIdentity: vi.fn(),
  restoreGitFiles: vi.fn(),
  resolveGitFiles: vi.fn(),
  readGitHistory: vi.fn(),
  readGitPathPrefix: vi.fn(),
  readGitCommitDetail: vi.fn(),
  readGitCommitComparison: vi.fn(),
  readGitBranches: vi.fn(),
  createGitBranch: vi.fn(),
  removeGitBranch: vi.fn(),
  switchGitBranch: vi.fn(),
  readGitWorktrees: vi.fn(),
  createGitWorktree: vi.fn(),
  removeGitWorktree: vi.fn(),
  mergeGitWorktree: vi.fn(),
  readGitRemotes: vi.fn(),
  fetchGitRemote: vi.fn(),
  pullGitRemote: vi.fn(),
  pushGitRemote: vi.fn(),
}));
const explorerRuntime = vi.hoisted(() => ({
  guard: {
    cancel: vi.fn(),
    discard: vi.fn(),
    hasPendingWork: vi.fn(() => true),
    lock: vi.fn(),
    prepare: vi.fn(async () => true),
  },
  props: null as null | Record<string, unknown>,
}));
vi.mock("./GitDiffView", () => ({
  default: ({
    comparison,
    toolbarActions,
  }: {
    comparison: GitComparison;
    toolbarActions?: ReactNode;
  }) => <div data-diff={comparison.path}>{toolbarActions}</div>,
}));
vi.mock("./ProjectExplorer", () => ({
  ProjectExplorer: (props: {
    openFileRequest?: { id: number; path: string } | null;
    registerGuard?: (guard: typeof explorerRuntime.guard) => () => void;
    onOpenFileRequestHandled?: (id: number) => void;
  }) => {
    const { openFileRequest, registerGuard, onOpenFileRequestHandled } = props;
    explorerRuntime.props = props;
    useEffect(() => registerGuard?.(explorerRuntime.guard), [registerGuard]);
    useEffect(() => {
      if (openFileRequest) onOpenFileRequestHandled?.(openFileRequest.id);
    }, [onOpenFileRequestHandled, openFileRequest]);
    return (
      <div
        data-testid="project-explorer"
        data-open-path={openFileRequest?.path}
      >
        Explorer content
      </div>
    );
  },
}));

const repo: GitRepository = {
  availability: "ready",
  identity: {
    root: "/projects/soreno",
    gitDir: "/projects/soreno/.git",
    commonDir: "/projects/soreno/.git",
  },
  version: "v2",
  head: "abc",
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  operation: null,
  mergeMessage: null,
  limited: false,
  truncated: false,
  files: [
    {
      path: "partial.ts",
      oldPath: null,
      indexStatus: "M",
      worktreeStatus: "M",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: 3,
      deleted: 1,
    },
    {
      path: "new.txt",
      oldPath: null,
      indexStatus: ".",
      worktreeStatus: "?",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: 1,
      deleted: 0,
    },
    {
      path: "conflict.rs",
      oldPath: null,
      indexStatus: "U",
      worktreeStatus: "U",
      conflict: true,
      submodule: false,
      actionable: false,
      mode: "100644",
      added: null,
      deleted: null,
    },
  ],
};
const comparison: GitComparison = {
  path: "partial.ts",
  oldPath: null,
  version: "v1",
  before: {
    text: "const a = 1;\n",
    oid: "a",
    size: 13,
    mode: "100644",
    reason: null,
  },
  after: {
    text: "const a = 2;\n",
    oid: "b",
    size: 13,
    mode: "100644",
    reason: null,
  },
};
let container: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useProjectGit>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(forgeApi.readForgeRemote).mockReturnValue(new Promise(() => {}));
  localStorage.removeItem("soreno:git-file-tree");
  localStorage.removeItem("soreno:git-files-ratio");
  localStorage.removeItem("soreno:git-files-visible");
  localStorage.removeItem("soreno:project-panel-view");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  hook = projectGitTestState(repo, {
    mutate: vi.fn(async (work: () => Promise<unknown>) => {
      try {
        return await work();
      } catch {
        return undefined;
      }
    }) as ReturnType<typeof useProjectGit>["mutate"],
  });
  vi.mocked(api.readGitPathPrefix).mockResolvedValue("");
  vi.mocked(api.initGitRepository).mockResolvedValue({
    oid: null,
    message: "Git initialized",
    warning: null,
  });
  vi.mocked(api.stageGitFiles).mockResolvedValue({
    oid: null,
    message: "Prepared",
    warning: null,
  });
  vi.mocked(api.unstageGitFiles).mockResolvedValue({
    oid: null,
    message: "Removed",
    warning: null,
  });
  vi.mocked(api.commitGitChanges).mockResolvedValue({
    oid: "abc123",
    message: "Commit created",
    warning: null,
  });
  vi.mocked(api.setGitIdentity).mockResolvedValue({
    oid: null,
    message: "Identity saved",
    warning: null,
  });
  vi.mocked(api.restoreGitFiles).mockResolvedValue({
    oid: "stash-backup",
    message: "Restored",
    warning: "Le stash peut aussi contenir des changements de l’index.",
  });
  vi.mocked(api.resolveGitFiles).mockResolvedValue({
    oid: null,
    message: "Resolved",
    warning: null,
  });
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["abc"],
    commits: [],
    hasMore: false,
  });
  vi.mocked(api.readGitBranches).mockResolvedValue([]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: project.path, head: "abc", branch: "main" },
  ]);
  vi.mocked(api.createGitBranch).mockResolvedValue({
    oid: null,
    message: "Branch created",
    warning: null,
  });
  vi.mocked(api.removeGitBranch).mockResolvedValue({
    oid: null,
    message: "Branch removed",
    warning: null,
  });
  vi.mocked(api.removeGitWorktree).mockResolvedValue({
    oid: null,
    message: "Worktree removed",
    warning: null,
  });
  vi.mocked(api.switchGitBranch).mockResolvedValue({
    oid: null,
    message: "Branch switched",
    warning: null,
  });
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    {
      name: "origin",
      url: "ssh://fetch",
      pushUrl: "ssh://push",
      ambiguous: false,
    },
  ]);
  vi.mocked(api.fetchGitRemote).mockResolvedValue({
    oid: null,
    message: "Fetched",
    warning: null,
  });
  vi.mocked(api.pullGitRemote).mockResolvedValue({
    oid: null,
    message: "Pulled",
    warning: null,
  });
  vi.mocked(api.pushGitRemote).mockResolvedValue({
    oid: null,
    message: "Pushed",
    warning: null,
  });
  vi.mocked(useProjectGit).mockImplementation(() => hook);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  clearNotifications();
});
function gitError() {
  return getNotifications().find(
    ({ key, tone }) => key.startsWith("git:") && tone === "error",
  );
}
async function render(props: Partial<GitPanelProps> = {}) {
  await act(async () =>
    root.render(
      <GitPanel project={project} visible onClose={vi.fn()} {...props} />,
    ),
  );
}
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function pointerEvent(
  type: string,
  pointerId: number,
  clientY: number,
  button = 0,
  clientX = 0,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}
async function pressKey(element: Element, key: string) {
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    ),
  );
}

async function loadStatefulHistory(props: Partial<GitPanelProps> = {}) {
  const oid = "history-commit";
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [repo.head!],
    commits: [
      {
        oid,
        parents: [],
        references: [],
        author: "Ada",
        date: "2025-01-01T00:00:00Z",
        subject: "Keep history state",
      },
    ],
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail).mockResolvedValue({
    oid,
    parent: null,
    files: [repo.files[0]],
  });
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparison,
    path: repo.files[0].path,
  });
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render(props);
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Keep history state"),
  );
  const commit = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent?.includes("Keep history state"))!;
  await act(async () => commit.click());
  await vi.waitFor(() =>
    expect(
      container.querySelector(`[data-diff="${repo.files[0].path}"]`),
    ).not.toBeNull(),
  );
  return {
    commit,
    diff: container.querySelector(`[data-diff="${repo.files[0].path}"]`)!,
    history: container.querySelector(".git-history-view")!,
  };
}

it("suspends Git reads and hides repository actions until the project reconnects", async () => {
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render({ disconnected: true });
  expect(vi.mocked(useProjectGit).mock.lastCall?.[0]).toBe(project.id);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[1]).toBe(false);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[4]).toBeDefined();
  expect(vi.mocked(useProjectGit).mock.lastCall?.[7]).toBe(true);
  expect(container.textContent).toContain("Projet déconnecté");
  expect(
    container.querySelector(".git-panel-content")?.closest("[hidden]"),
  ).not.toBeNull();
  expect(container.querySelector(".git-branch-label")).toBeNull();
  expect(api.readGitHistory).not.toHaveBeenCalled();
  expect(api.readGitRemotes).not.toHaveBeenCalled();

  await render({ disconnected: false });
  expect(vi.mocked(useProjectGit).mock.lastCall?.[0]).toBe(project.id);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[7]).toBe(false);
  expect(container.textContent).not.toContain("Projet déconnecté");
  expect(api.readGitHistory).toHaveBeenCalled();
});

it("keeps stateful History mounted across Explorer and back", async () => {
  const mounted = await loadStatefulHistory();
  expect(mounted.commit.getAttribute("aria-pressed")).toBe("true");

  await act(async () => button("Fichiers").click());
  expect(
    container.querySelector('[data-testid="project-explorer"]'),
  ).not.toBeNull();
  expect(mounted.history.isConnected).toBe(true);
  expect(mounted.history.closest("[hidden]")).not.toBeNull();
  expect(api.readGitHistory).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitDetail).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);

  await act(async () => button("Historique").click());
  expect(container.querySelector(".git-history-view")).toBe(mounted.history);
  expect(container.querySelector(`[data-diff="${repo.files[0].path}"]`)).toBe(
    mounted.diff,
  );
  expect(mounted.commit.getAttribute("aria-pressed")).toBe("true");
});

it("keeps stateful History mounted across SSH disconnect and reconnect", async () => {
  const sshProject = {
    ...project,
    id: "ssh-p1",
    environment: {
      kind: "ssh" as const,
      distribution: null,
      ssh: {
        host: "remote.example",
        user: "dev",
        port: 22,
        identityFile: null,
        hostKey: "ssh-ed25519 pinned",
      },
    },
  };
  hook = { ...hook, hasFreshStatus: false };
  const mounted = await loadStatefulHistory({ project: sshProject });
  const readScope = vi.mocked(useProjectGit).mock.lastCall?.[4];

  await render({ project: sshProject, disconnected: true });
  expect(container.textContent).toContain("Projet déconnecté");
  expect(vi.mocked(useProjectGit).mock.lastCall?.[0]).toBe(sshProject.id);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[1]).toBe(false);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[4]).toBe(readScope);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[7]).toBe(true);
  expect(mounted.history.isConnected).toBe(true);
  expect(mounted.history.closest("[hidden]")).not.toBeNull();
  expect(container.querySelector(".git-branch-label")).toBeNull();

  await render({ project: sshProject, disconnected: false });
  expect(vi.mocked(useProjectGit).mock.lastCall?.[0]).toBe(sshProject.id);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[4]).toBe(readScope);
  expect(vi.mocked(useProjectGit).mock.lastCall?.[7]).toBe(false);
  expect(container.querySelector(".git-history-view")).toBe(mounted.history);
  expect(container.querySelector(`[data-diff="${repo.files[0].path}"]`)).toBe(
    mounted.diff,
  );
  expect(mounted.commit.getAttribute("aria-pressed")).toBe("true");
});

it("selects each side of a partially staged file separately", async () => {
  await render();
  const unstaged = container.querySelector<HTMLButtonElement>(
    '[aria-label^="partial.ts · non préparé"]',
  )!;
  await act(async () => unstaged.click());
  expect(hook.updateDraft).toHaveBeenCalledWith({
    selection: { path: "partial.ts", side: "unstaged" },
  });
  const staged = container.querySelector<HTMLButtonElement>(
    '[aria-label^="partial.ts · préparé"]',
  )!;
  await act(async () => staged.click());
  expect(hook.updateDraft).toHaveBeenLastCalledWith({
    selection: { path: "partial.ts", side: "staged" },
  });
});

it("offers a manual fallback when a stale diff is not being refreshed", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: comparison,
    stale: true,
  };
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(
        container.querySelector('[data-diff="partial.ts"]'),
      ).not.toBeNull(),
    ),
  );
  expect(container.textContent).toContain("Le dépôt a changé");
  expect(hook.loadComparison).not.toHaveBeenCalled();
  const refresh = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Actualiser le diff")!;
  await act(async () => refresh.click());
  expect(hook.loadComparison).toHaveBeenCalledTimes(1);
  expect(hook.refresh).not.toHaveBeenCalled();
});

it("keeps the same diff mounted during refresh and shows its pending state", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: comparison,
    stale: true,
  };
  await render();
  const diff = container.querySelector('[data-diff="partial.ts"]');
  const next = button("Fichier suivant", container);
  expect(diff).not.toBeNull();
  act(() => next.focus());

  hook = { ...hook, diffLoading: true };
  await render();
  expect(container.querySelector('[data-diff="partial.ts"]')).toBe(diff);
  expect(button("Fichier suivant", container)).toBe(next);
  expect(document.activeElement).toBe(next);
  expect(
    container.querySelector(".git-diff-area")?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(container.querySelector(".git-panel-notice.is-stale")).toBeNull();
  expect(container.textContent).not.toContain("Actualiser le diff");

  hook = {
    ...hook,
    diffLoading: false,
    stale: false,
    diff: { ...comparison, version: repo.version },
  };
  await render();
  expect(container.querySelector('[data-diff="partial.ts"]')).toBe(diff);
  expect(
    container.querySelector(".git-diff-area")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("keeps repeated status revalidation silent without inserting content or remounting the diff", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: { ...comparison, version: repo.version },
  };
  await render();
  const content = container.querySelector(".git-panel-content")!;
  const children = [...content.children];
  const diff = content.querySelector('[data-diff="partial.ts"]');
  expect(diff).not.toBeNull();

  for (const revalidating of [true, false, true, false]) {
    hook = { ...hook, loading: revalidating, revalidating };
    await render();
    expect(container.querySelector(".git-panel-content")).toBe(content);
    expect(content.children).toHaveLength(children.length);
    children.forEach((child, index) =>
      expect(content.children[index]).toBe(child),
    );
    expect(content.querySelector('[data-diff="partial.ts"]')).toBe(diff);
    expect(content.querySelector(".git-panel-notice")).toBeNull();
    expect(content.getAttribute("aria-busy")).toBe(String(revalidating));
  }
});

it("keeps actionable mutation errors and uncertain recovery guidance dismissible", async () => {
  hook = {
    ...hook,
    error: {
      message: "Échec de récupération : utilisez Git hors de Soreno.",
      uncertain: true,
      source: "mutation",
    },
  };
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain("Échec de récupération");
  const error = gitError();
  expect(error).toMatchObject({
    message:
      "L’opération a échoué. Réessayez. Le résultat est incertain. Vérifiez le dépôt avant de réessayer.",
    tone: "error",
    action: { label: "Fermer" },
  });
  await act(async () => error!.action!.onAction());
  expect(hook.dismissError).toHaveBeenCalledTimes(1);
  await act(async () => closeNotification(error!.key));
  expect(hook.dismissError).toHaveBeenCalledTimes(2);
});

it("shows parent project loading and errors before the real no-project state", async () => {
  const retry = vi.fn();
  await render({
    project: undefined,
    projectsLoading: true,
    onRetryProjects: retry,
  });
  expect(
    container.querySelector('[role="status"]')?.getAttribute("aria-label"),
  ).toContain("Chargement des projets");
  expect(container.textContent).not.toContain("Chargement des projets");
  expect(container.textContent).not.toContain("Sélectionnez un projet");

  await render({
    project: undefined,
    projectsError: "Workspace unavailable",
    onRetryProjects: retry,
  });
  expect(container.textContent).not.toContain("Workspace unavailable");
  expect(container.textContent).not.toContain("Sélectionnez un projet");
  expect(getNotifications()).toEqual([]);
});

it("distinguishes pending and failed Git reads from missing repository data", async () => {
  hook = { ...hook, repo: null, loading: true };
  await render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Lecture de l’état Git",
  );
  expect(container.textContent).not.toContain("indisponibles");

  hook = {
    ...hook,
    loading: false,
    error: { message: "Git read failed", uncertain: false, source: "read" },
  };
  await render();
  expect(container.textContent).not.toContain("Git read failed");
  const error = gitError();
  expect(error).toMatchObject({
    message: "Lecture du dépôt Git impossible.",
    tone: "error",
    action: { label: "Réessayer" },
  });
  await act(async () => error!.action!.onAction());
  expect(hook.refresh).toHaveBeenCalledTimes(1);

  hook = { ...hook, error: null };
  await render();
  expect(gitError()).toBeUndefined();
  expect(container.textContent).toContain(
    "informations du dépôt Git sont indisponibles",
  );
});

it("initializes Git only after confirmation with the captured project and version", async () => {
  hook = {
    ...hook,
    repo: { ...repo, availability: "notRepository", identity: null },
  };
  await render();
  await act(async () => button("Initialiser Git", container).click());
  let confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  await act(async () => button("Initialiser Git", confirmation).click());
  expect(api.initGitRepository).toHaveBeenCalledExactlyOnceWith("p1", "v2");
  hook = { ...hook, repo };
  await render();
  expect(container.textContent).not.toContain("Git initialized");
  expect(container.querySelector(".git-panel-notice.is-success")).toBeNull();

  hook = {
    ...hook,
    repo: { ...repo, availability: "notRepository", identity: null },
  };
  await render();
  await act(async () => button("Initialiser Git", container).click());
  hook = { ...hook, repo: { ...hook.repo!, version: "v3" } };
  await render();
  confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(button("Initialiser Git", confirmation).disabled).toBe(true);
  await act(async () => button("Initialiser Git", confirmation).click());
  expect(api.initGitRepository).toHaveBeenCalledTimes(1);
  await act(async () => button("Annuler", confirmation).click());

  hook = {
    ...hook,
    repo: { ...repo, availability: "notRepository", identity: null },
    isBusy: vi.fn(() => true),
  };
  await render();
  await act(async () => button("Initialiser Git", container).click());
  confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  await act(async () => button("Initialiser Git", confirmation).click());
  expect(api.initGitRepository).toHaveBeenCalledTimes(1);
});

it("shows repository availability and limited states without inert mutation actions", async () => {
  hook = { ...hook, repo: { ...repo, limited: true } };
  await render();
  expect(container.textContent).toContain("peuvent être incomplets");
  expect(button("Commit", container).disabled).toBe(true);
  expect(button("Tout préparer", container).disabled).toBe(true);
  hook = { ...hook, repo: { ...repo, availability: "bare" } };
  await render();
  expect(container.textContent).toContain("dépôt nu");
  expect(container.querySelector(".git-change-list")).toBeNull();
});

it("replaces the limited notice with a manual refresh while automatic refresh is paused", async () => {
  hook = {
    ...hook,
    autoRefreshPaused: true,
    repo: { ...repo, limited: true, truncated: true },
  };
  await render();
  expect(container.textContent).toContain(
    "actualisation automatique est suspendue",
  );
  expect(container.textContent).not.toContain("peuvent être incomplets");
  expect(button("Commit", container).disabled).toBe(true);
  await act(async () => button("Actualiser", container).click());
  expect(hook.refresh).toHaveBeenCalledTimes(1);
});

it("offers a manual refresh when automatic refresh is paused before any snapshot", async () => {
  hook = { ...hook, repo: null, autoRefreshPaused: true };
  await render();
  expect(container.textContent).toContain(
    "actualisation automatique est suspendue",
  );
  await act(async () => button("Actualiser", container).click());
  expect(hook.refresh).toHaveBeenCalledTimes(1);
});

it("stages and unstages the two sides of the same file with explicit paths and version", async () => {
  await render();
  await act(async () => button("Préparer · partial.ts", container).click());
  expect(api.stageGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["partial.ts"],
    "v2",
  );
  await act(async () => button("Retirer · partial.ts", container).click());
  expect(api.unstageGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["partial.ts"],
    "v2",
  );
});

it("uses the complete group for stage all", async () => {
  hook = {
    ...hook,
    repo: {
      ...repo,
      files: [
        ...repo.files,
        { ...repo.files[0], path: "hidden.ts", indexStatus: "." },
      ],
    },
  };
  await render();
  expect(container.querySelectorAll('[aria-label^="new.txt ·"]')).toHaveLength(
    1,
  );
  const changes = [
    ...container.querySelectorAll<HTMLElement>(".git-change-group"),
  ].find(
    (group) => group.querySelector("h3 span")?.textContent === "Changements",
  )!;
  await act(async () => button("Tout préparer", changes).click());
  expect(api.stageGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["hidden.ts", "new.txt", "partial.ts"],
    "v2",
  );
});

it("keeps files and diff mounted while a Git mutation is pending", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: { ...comparison, version: repo.version },
  };
  await render();
  const groups = container.querySelector(".git-change-groups")!;
  const area = container.querySelector(".git-diff-area")!;
  const row = groups.querySelector(".git-change-row");
  const diff = area.querySelector('[data-diff="partial.ts"]');
  expect(row).not.toBeNull();
  expect(diff).not.toBeNull();

  for (const busy of [true, false]) {
    hook = { ...hook, busy };
    await render();
    expect(groups.getAttribute("aria-busy")).toBe(String(busy));
    expect(area.getAttribute("aria-busy")).toBe(String(busy));
    expect(groups.querySelector(".git-change-row")).toBe(row);
    expect(area.querySelector('[data-diff="partial.ts"]')).toBe(diff);
  }
});

it("stages unpreviewable files without confirmation from the group", async () => {
  hook = {
    ...hook,
    repo: {
      ...repo,
      files: [
        repo.files[0],
        {
          ...repo.files[0],
          path: "asset.bin",
          indexStatus: ".",
          added: null,
          deleted: null,
        },
      ],
    },
  };
  await render();
  await act(async () =>
    button(
      "Tout préparer",
      [...container.querySelectorAll(".git-change-group")].find(
        (group) =>
          group.querySelector("h3 span")?.textContent === "Changements",
      )!,
    ).click(),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.stageGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["asset.bin", "partial.ts"],
    "v2",
  );
});

it("blocks stale staging actions, including unpreviewable files", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: comparison,
    stale: true,
  };
  await render();
  expect(button("Préparer · partial.ts", container).disabled).toBe(true);
  expect(button("Tout préparer", container).disabled).toBe(true);
  await act(async () => button("Préparer · partial.ts", container).click());
  expect(api.stageGitFiles).not.toHaveBeenCalled();

  const binary = {
    path: "asset.bin",
    oldPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: null,
    deleted: null,
  };
  hook = { ...hook, repo: { ...repo, files: [...repo.files, binary] } };
  await render();
  expect(button("Préparer · asset.bin", container).disabled).toBe(true);
  await act(async () => button("Préparer · asset.bin", container).click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.stageGitFiles).not.toHaveBeenCalled();
});

it("disables mutations during incompatible Git operations", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Blocked commit" },
    repo: {
      ...repo,
      operation: "rebase",
      files: repo.files.filter((file) => !file.conflict),
    },
  };
  await render();
  expect(button("Préparer · partial.ts", container).disabled).toBe(true);
  expect(button("Tout préparer", container).disabled).toBe(true);
  expect(button("Commit", container).disabled).toBe(true);
});

it.each([
  ["Préparer · asset.bin", "stageGitFiles"],
  ["Retirer · asset.bin", "unstageGitFiles"],
  ["Tout retirer", "unstageGitFiles"],
] as const)(
  "applies %s without confirmation for unpreviewable content",
  async (label, method) => {
    hook = {
      ...hook,
      repo: {
        ...repo,
        files: [
          {
            path: "asset.bin",
            oldPath: null,
            indexStatus: "M",
            worktreeStatus: "M",
            conflict: false,
            submodule: false,
            actionable: true,
            mode: "100644",
            added: null,
            deleted: null,
          },
        ],
      },
    };
    await render();
    await act(async () => button(label, container).click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api[method]).toHaveBeenCalledExactlyOnceWith(
      "p1",
      ["asset.bin"],
      "v2",
    );
  },
);

it("ignores a second click while the first staging mutation is pending", async () => {
  let busy = false;
  const finish = deferred<{ oid: null; message: string; warning: null }>();
  hook.isBusy = vi.fn(() => busy);
  hook.mutate = vi.fn(async (work: () => Promise<unknown>) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }) as ReturnType<typeof useProjectGit>["mutate"];
  vi.mocked(api.stageGitFiles).mockReturnValueOnce(finish.promise);
  await render();
  await act(async () => {
    const action = button("Préparer · partial.ts", container);
    action.click();
    action.click();
  });
  expect(api.stageGitFiles).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish.resolve({ oid: null, message: "Prepared", warning: null }),
  );
});

it("commits the complete index without showing a success message or SHA link", async () => {
  const oid = "abc1234567890abcdef1234567890abcdef12345";
  const external = {
    path: "generated.bin",
    oldPath: null,
    indexStatus: "A",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: null,
    deleted: null,
  };
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      message: "Keep all staged files",
    },
    repo: {
      ...repo,
      files: [...repo.files.filter((file) => !file.conflict), external],
    },
  };
  vi.mocked(api.commitGitChanges).mockResolvedValueOnce({
    oid,
    message: "Commit created",
    warning: null,
  });
  await render();
  await act(async () => button("Commit", container).click());
  const confirmation = document.querySelector<HTMLElement>(
    ".git-commit-composer",
  )!;
  expect(confirmation.querySelector("textarea")?.value).toBe(
    "Keep all staged files",
  );
  await act(async () => button("Commit", confirmation).click());
  expect(api.commitGitChanges).toHaveBeenCalledExactlyOnceWith(
    "p1",
    "Keep all staged files",
    "v2",
  );
  expect(api.pushGitRemote).not.toHaveBeenCalled();
  expect(hook.clearCommittedMessage).toHaveBeenCalledWith(
    "Keep all staged files",
  );
  expect(container.textContent).not.toContain("Commit created");
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.getAttribute("aria-label") === `SHA ${oid}`,
    ),
  ).toBe(false);
  expect(container.querySelector(".git-panel-notice.is-success")).toBeNull();
});

it("shows only a commit warning with a functional SHA link and clears it before the next commit", async () => {
  const oid = "abc1234567890abcdef1234567890abcdef12345";
  const warning =
    "Un hook a modifié l’arbre préparé pendant le commit ; vérifiez son contenu.";
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Run hook" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.commitGitChanges)
    .mockResolvedValueOnce({ oid, message: "Commit créé.", warning })
    .mockResolvedValueOnce({
      oid: "next",
      message: "Commit créé.",
      warning: null,
    });
  vi.mocked(api.readGitCommitDetail).mockResolvedValueOnce({
    oid,
    parent: null,
    files: [],
  });
  await render();

  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  const commitWarning = () =>
    getNotifications().find(({ key }) => key.startsWith("git-commit-warning:"));
  expect(commitWarning()).toMatchObject({
    message: "L’opération est terminée avec un avertissement.",
    tone: "warning",
    action: { label: `SHA ${oid.slice(0, 12)}` },
  });
  expect(document.body.textContent).not.toContain(warning);
  expect(document.body.textContent).not.toContain("Commit créé.");
  await render({ project: { ...project, path: "/projects/replacement" } });
  await act(async () => commitWarning()!.action!.onAction());
  expect(hook.updateDraft).not.toHaveBeenCalledWith({ view: "history" });
  await render();
  await act(async () => commitWarning()!.action!.onAction());
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "history" });
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledWith("p1", oid),
  );

  hook = { ...hook, draft: { ...hook.draft, view: "changes" } };
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  expect(commitWarning()).toBeUndefined();
});

it("shows and hides the inline commit field while preserving its draft", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  hook.updateDraft = vi.fn((patch) => {
    hook = { ...hook, draft: { ...hook.draft, ...patch } };
  });
  await render();
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => button("Commit", container).click());
  let dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  const message = dialog.querySelector("textarea")!;
  expect(document.activeElement).toBe(message);
  expect(button("Commit", dialog).disabled).toBe(true);
  await act(async () => {
    setInputValue(message, "Write once");
  });
  expect(hook.updateDraft).toHaveBeenCalledWith({ message: "Write once" });
  expect(button("Commit", dialog).disabled).toBe(false);
  await act(async () =>
    message.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(
    document.querySelector<HTMLElement>(".git-commit-composer")?.hidden,
  ).toBe(true);
  expect(document.activeElement).toBe(button("Commit", container));
  await act(async () => button("Masquer les fichiers", container).click());
  await act(async () => button("Commit", container).click());
  dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  expect(dialog.querySelector("textarea")?.value).toBe("Write once");
  await act(async () => button("Commit", dialog).click());
  expect(api.commitGitChanges).toHaveBeenCalledExactlyOnceWith(
    "p1",
    "Write once",
    "v2",
  );
  expect(hook.clearCommittedMessage).toHaveBeenCalledWith("Write once");
});

it("generates a message on demand without committing and prevents duplicate requests", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  const finish = deferred<string>();
  vi.mocked(api.generateGitCommitMessage).mockReturnValueOnce(finish.promise);
  await render();
  await act(async () => button("Commit", container).click());
  const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  expect(api.generateGitCommitMessage).not.toHaveBeenCalled();
  const generate = button("Générer le message", dialog);
  await act(async () => {
    generate.click();
    generate.click();
  });
  expect(api.generateGitCommitMessage).toHaveBeenCalledExactlyOnceWith(
    "p1",
    "v2",
  );
  expect(generate.disabled).toBe(true);
  expect(dialog.querySelector("textarea")?.disabled).toBe(false);
  await act(async () => finish.resolve("Add commit message generation"));
  expect(dialog.querySelector("textarea")?.value).toBe(
    "Add commit message generation",
  );
  expect(hook.updateDraft).toHaveBeenCalledWith({
    message: "Add commit message generation",
  });
  expect(api.commitGitChanges).not.toHaveBeenCalled();
  expect(api.pushGitRemote).not.toHaveBeenCalled();
});

it("preserves typing during generation even when the user restores the original text", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  const finish = deferred<string>();
  vi.mocked(api.generateGitCommitMessage).mockReturnValueOnce(finish.promise);
  await render();
  await act(async () => button("Commit", container).click());
  const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  await act(async () => button("Générer le message", dialog).click());
  const textarea = dialog.querySelector("textarea")!;
  for (const value of ["My draft", ""]) {
    await act(async () => {
      setInputValue(textarea, value);
    });
  }
  await act(async () => finish.resolve("Generated message"));
  expect(textarea.value).toBe("");
  expect(dialog.textContent).toContain("Votre saisie a été conservée");
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Generated message",
  });
});

it("finishes message generation while the inline field is hidden", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  const finish = deferred<string>();
  vi.mocked(api.generateGitCommitMessage).mockReturnValueOnce(finish.promise);
  await render();
  await act(async () => button("Commit", container).click());
  const composer = container.querySelector<HTMLElement>(
    ".git-commit-composer",
  )!;
  await act(async () => button("Générer le message", composer).click());
  await act(async () => button("Commit", container).click());
  expect(composer.hidden).toBe(true);

  await act(async () => finish.resolve("Generated in background"));
  expect(hook.updateDraft).toHaveBeenCalledWith({
    message: "Generated in background",
  });
  expect(composer.querySelector("textarea")?.value).toBe(
    "Generated in background",
  );

  await act(async () => button("Commit", container).click());
  expect(composer.hidden).toBe(false);
});

it("keeps the draft when disconnecting during message generation", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Keep draft" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  const finish = deferred<string>();
  vi.mocked(api.generateGitCommitMessage).mockReturnValueOnce(finish.promise);
  await render();
  await act(async () => button("Commit", container).click());
  const composer = container.querySelector<HTMLElement>(
    ".git-commit-composer",
  )!;
  await act(async () => button("Générer le message", composer).click());

  await render({ disconnected: true });
  await act(async () => finish.resolve("Stale message"));

  expect(composer.querySelector("textarea")?.value).toBe("Keep draft");
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Stale message",
  });
});

it.each(["project", "version"])(
  "ignores a generation after %s changes",
  async (change) => {
    hook = {
      ...hook,
      draft: { ...hook.draft, message: "Keep draft" },
      repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
    };
    const finish = deferred<string>();
    vi.mocked(api.generateGitCommitMessage).mockReturnValueOnce(finish.promise);
    await render();
    await act(async () => button("Commit", container).click());
    const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
    await act(async () => button("Générer le message", dialog).click());
    if (change === "project") {
      await render({ project: { ...project, id: "p2" } });
      await render();
    } else {
      hook = { ...hook, repo: { ...hook.repo!, version: "v3" } };
      await render();
    }
    await act(async () => finish.resolve("Stale message"));
    expect(
      document.querySelector<HTMLTextAreaElement>(
        ".git-commit-composer textarea",
      )?.value,
    ).toBe("Keep draft");
    expect(hook.updateDraft).not.toHaveBeenCalledWith({
      message: "Stale message",
    });
  },
);

it("keeps the draft on generation failure and allows a retry", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Keep draft" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.generateGitCommitMessage)
    .mockRejectedValueOnce({ code: "codex", message: "Codex unavailable" })
    .mockResolvedValueOnce("Retry result");
  await render();
  await act(async () => button("Commit", container).click());
  const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  await act(async () => button("Générer le message", dialog).click());
  const generationFailed =
    "Impossible de générer le message. Réessayez ou saisissez-le vous-même.";
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({ message: generationFailed, tone: "error" }),
  );
  expect(document.body.textContent).not.toContain("[Git/codex]");
  expect(dialog.querySelector("textarea")?.value).toBe("Keep draft");
  await act(async () => button("Générer le message", dialog).click());
  expect(dialog.querySelector("textarea")?.value).toBe("Retry result");
  expect(getNotifications()).not.toContainEqual(
    expect.objectContaining({ message: generationFailed }),
  );
});

it("blocks the commit composer after its version changes without losing the draft", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Captured message" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(async () => button("Commit", container).click());
  hook = { ...hook, repo: { ...hook.repo!, version: "v3" } };
  await render();
  const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("Le dépôt a changé"),
      tone: "warning",
    }),
  );
  expect(dialog.querySelector("textarea")?.value).toBe("Captured message");
  expect(dialog.querySelector("textarea")?.disabled).toBe(true);
  expect(button("Commit", dialog).disabled).toBe(true);
  await act(async () =>
    dialog.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.commitGitChanges).not.toHaveBeenCalled();
  expect(hook.clearCommittedMessage).not.toHaveBeenCalled();
});

it("hides a commit dialog outside its project scope and restores its draft on return", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Captured message" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(async () => button("Commit", container).click());
  await render({ project: { ...project, id: "p2", name: "Another project" } });
  expect(document.querySelector(".git-commit-composer")).toBeNull();
  await render();
  const dialog = document.querySelector<HTMLElement>(".git-commit-composer")!;
  expect(dialog.textContent).not.toContain("Another project");
  expect(dialog.querySelector("textarea")?.value).toBe("Captured message");
  expect(button("Commit", dialog).disabled).toBe(false);
  expect(api.commitGitChanges).not.toHaveBeenCalled();
});

it("disables the inline commit action for an ordinary empty index", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([]);
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Not an empty commit" },
    repo: { ...repo, files: [] },
  };
  await render();
  const commit = button("Commit", container);
  expect(commit.disabled).toBe(true);
  await act(async () => commit.click());
  expect(document.querySelector(".git-commit-composer")).toBeNull();
  expect(api.commitGitChanges).not.toHaveBeenCalled();
  expect(hook.draft.message).toBe("Not an empty commit");
});

it("keeps the commit warning and draft when success has no commit OID", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Await confirmed commit" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.commitGitChanges).mockResolvedValueOnce({
    oid: null,
    message: "Commit not confirmed",
    warning: "Verify HEAD",
  });
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  expect(hook.clearCommittedMessage).not.toHaveBeenCalled();
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "L’opération est terminée avec un avertissement.",
      tone: "warning",
      action: undefined,
    }),
  );
  expect(document.body.textContent).not.toContain("Verify HEAD");
});

it("keeps the commit draft after a failed mutation", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Do not lose this" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.commitGitChanges).mockRejectedValueOnce({
    code: "failed",
    message: "Commit failed",
  });
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  expect(hook.clearCommittedMessage).not.toHaveBeenCalled();
  expect(api.commitGitChanges).toHaveBeenCalledTimes(1);
});

it("saves a repository-only identity when the global option is cleared, without retrying the commit", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Authored commit" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.commitGitChanges).mockRejectedValueOnce({
    code: "identity",
    message: "Identity missing",
  });
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  const identity = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const inputs = identity.querySelectorAll<HTMLInputElement>("input");
  await act(async () => {
    setInputValue(inputs[0], "Ada");
    setInputValue(inputs[1], "ada@example.test");
  });
  const global = identity.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(global.checked).toBe(true);
  await act(async () => global.click());
  await act(async () => button("Enregistrer l’identité", identity).click());
  expect(api.setGitIdentity).toHaveBeenCalledExactlyOnceWith(
    "p1",
    "Ada",
    "ada@example.test",
    false,
    "v2",
  );
  expect(api.commitGitChanges).toHaveBeenCalledTimes(1);
  expect(document.querySelector<HTMLElement>('[role="dialog"]')).toBeNull();
});

it("auto-commits every unstaged path and asks for the identity on the same snapshot", async () => {
  await render();
  const auto = button(
    "Commit automatique : tout préparer, générer le message avec Codex et committer",
    container,
  );
  expect(auto.disabled).toBe(true);
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.quickCommitGitChanges).mockRejectedValueOnce({
    code: "identity",
    message: "Identity missing",
  });
  await render();
  await act(async () => auto.click());
  expect(api.quickCommitGitChanges).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["new.txt", "partial.ts"],
    "v2",
  );
  const identity = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const inputs = identity.querySelectorAll<HTMLInputElement>("input");
  await act(async () => {
    setInputValue(inputs[0], "Ada");
    setInputValue(inputs[1], "ada@example.test");
  });
  expect(button("Enregistrer l’identité", identity).disabled).toBe(false);
});

it("keeps a delayed identity request scoped to its project and restores it on return", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Authored commit" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  vi.mocked(api.commitGitChanges).mockRejectedValueOnce({
    code: "identity",
    message: "Identity missing",
  });
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  expect(document.querySelector<HTMLElement>('[role="dialog"]')).not.toBeNull();

  await act(async () =>
    root.render(
      <GitPanel project={{ ...project, id: "p2" }} visible onClose={vi.fn()} />,
    ),
  );
  expect(document.querySelector<HTMLElement>('[role="dialog"]')).toBeNull();
  await act(async () =>
    root.render(<GitPanel project={project} visible onClose={vi.fn()} />),
  );
  expect(document.querySelector<HTMLElement>('[role="dialog"]')).not.toBeNull();
});

it("registers a persistent close guard that locks mutations without reporting pending work", async () => {
  let guard!: Parameters<
    NonNullable<GitPanelProps["registerTransitionGuard"]>
  >[0];
  await render({
    registerTransitionGuard: (value) => {
      guard = value;
      return () => {};
    },
  });
  expect(guard.hasPendingWork()).toBe(false);
  await act(async () => {
    expect(await guard.prepare()).toBe(true);
  });
  expect(hook.prepareClose).toHaveBeenCalledOnce();
  act(() => guard.cancel?.());
  expect(hook.cancelClose).toHaveBeenCalledOnce();

  vi.mocked(hook.hasPendingMutation).mockReturnValue(true);
  vi.mocked(hook.prepareClose).mockReturnValue(false);
  expect(guard.hasPendingWork()).toBe(true);
  await act(async () => {
    expect(await guard.prepare()).toBe(false);
  });
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Attendez la fin de l’opération Git en cours.",
      tone: "error",
    }),
  );
});

it("switches to Explorer and forwards quick-open acknowledgement", async () => {
  const onOpenFileRequestHandled = vi.fn();
  await render({
    openFileRequest: { id: 1, path: "src/App.tsx", projectId: project.id },
    onOpenFileRequestHandled,
  });

  const explorer = container.querySelector('[data-testid="project-explorer"]');
  expect(explorer).not.toBeNull();
  expect(explorer?.getAttribute("data-open-path")).toBe("src/App.tsx");
  expect(onOpenFileRequestHandled).toHaveBeenCalledWith(1);
});

it("locks Explorer during an accepted application-close transition and unlocks on cancellation", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  let guard!: Parameters<
    NonNullable<GitPanelProps["registerTransitionGuard"]>
  >[0];
  await render({
    registerTransitionGuard: (value) => {
      guard = value;
      return () => {};
    },
  });
  await act(async () => {
    expect(await guard.prepare()).toBe(true);
  });
  expect(explorerRuntime.guard.prepare).toHaveBeenCalledOnce();
  expect(explorerRuntime.guard.discard).toHaveBeenCalledOnce();
  expect(explorerRuntime.guard.lock).toHaveBeenCalledOnce();

  act(() => guard.cancel?.());
  expect(explorerRuntime.guard.cancel).toHaveBeenCalledOnce();
});

it("does not mount a fresh Explorer while an application-close transition is pending", async () => {
  let guard!: Parameters<
    NonNullable<GitPanelProps["registerTransitionGuard"]>
  >[0];
  await render({
    registerTransitionGuard: (value) => {
      guard = value;
      return () => {};
    },
  });
  await act(async () => {
    expect(await guard.prepare()).toBe(true);
  });

  act(() => button("Vue du projet", container).click());
  expect(button("Fichiers").disabled).toBe(true);
  await act(async () => button("Fichiers").click());
  expect(
    container.querySelector('[data-testid="project-explorer"]'),
  ).toBeNull();

  act(() => guard.cancel?.());
  expect(button("Fichiers").disabled).toBe(false);
  await act(async () => button("Fichiers").click());
  expect(
    container.querySelector('[data-testid="project-explorer"]'),
  ).not.toBeNull();
});

it("does not close-lock Explorer during an internal view transition", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  await render();
  await act(async () => button("Changements").click());
  expect(explorerRuntime.guard.prepare).toHaveBeenCalledOnce();
  expect(explorerRuntime.guard.discard).toHaveBeenCalledOnce();
  expect(explorerRuntime.guard.lock).not.toHaveBeenCalled();
});

it("opens the persisted Explorer independently of Git repository availability", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  hook = {
    ...hook,
    repo: { ...repo, availability: "notRepository", identity: null },
  };
  await render();
  expect(
    container.querySelector('[data-testid="project-explorer"]'),
  ).not.toBeNull();
  expect(
    button("Initialiser Git", container).closest("[hidden]"),
  ).not.toBeNull();
  expect(vi.mocked(useProjectGit).mock.lastCall?.[1]).toBe(false);
});

it("switches project views from the menu and persists Explorer", async () => {
  await render();
  act(() => button("Vue du projet", container).click());
  await act(async () => button("Fichiers").click());
  expect(
    container.querySelector('[data-testid="project-explorer"]'),
  ).not.toBeNull();
  expect(localStorage.getItem("soreno:project-panel-view")).toBe("explorer");

  await act(async () => button("Vue du projet", container).click());
  await act(async () => button("Historique").click());
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "history" });

  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  act(() => button("Vue du projet", container).click());
  act(() => button("Changements", container).click());
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "changes" });
});

it("falls back to Changes when the persisted view was the removed Review tab", async () => {
  localStorage.setItem("soreno:project-panel-view", "review");
  await render();
  const tabs = container.querySelector(".git-panel-view-tabs")!;
  expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe(
    "Changements",
  );
  expect(hook.updateDraft).not.toHaveBeenCalledWith(
    expect.objectContaining({ view: expect.anything() }),
  );
});

it("lists forge requests, explains a blocked merge and merges with the chosen method on the shown head", async () => {
  const pull = (
    number: number,
    sourceBranch: string,
    blocked: boolean,
  ): ForgeRequestDetail => ({
    number,
    title: `Change ${number}`,
    author: "ada",
    sourceBranch,
    targetBranch: "develop",
    crossRepository: false,
    draft: false,
    state: "open",
    checks: "success",
    review: "approved",
    conflicts: blocked,
    createdAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/o/r/pull/${number}`,
    body: "",
    headOid: `head-${number}`,
    baseOid: "base",
    reviewers: [],
    labels: [],
    checkRuns: [],
    commits: [],
    mergeBlockers: blocked ? ["conflicts"] : [],
    mergeMethods: ["squash", "merge"],
    deleteSourceBranch: true,
    changedFiles: 0,
    repository: "github.com/o/r",
  });
  const requests = [pull(2, "feature", true), pull(1, "main", false)];
  // The remote now points elsewhere: actions must target the repository the shown detail came from.
  vi.mocked(forgeApi.readForgeRemote).mockResolvedValue({
    kind: "github",
    host: "github.com",
    path: "o/moved",
    remote: "origin",
    webUrl: "https://github.com/o/moved",
  });
  vi.mocked(forgeApi.readForgeRequests).mockResolvedValue(requests);
  vi.mocked(forgeApi.readForgeRequest).mockImplementation(async (_, number) =>
    requests.find((item) => item.number === number)!,
  );
  vi.mocked(forgeApi.mergeForgeRequest).mockResolvedValue(null);
  hook = { ...hook, draft: { ...hook.draft, view: "requests" } };
  await render();

  // The current branch's request is selected first.
  const merge = () => button("Merger", container);
  await vi.waitFor(() => expect(merge().disabled).toBe(false));
  const blocked = [...container.querySelectorAll("button")].find((item) =>
    item.getAttribute("aria-label")?.startsWith("Change 2 #2"),
  )!;
  await act(async () => blocked.click());
  await vi.waitFor(() => expect(merge().disabled).toBe(true));
  expect(merge().getAttribute("aria-description")).toContain("conflits");

  const mergeable = [...container.querySelectorAll("button")].find((item) =>
    item.getAttribute("aria-label")?.startsWith("Change 1 #1"),
  )!;
  await act(async () => mergeable.click());
  await vi.waitFor(() => expect(merge().disabled).toBe(false));
  await act(async () => merge().click());
  const confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  await act(async () => button("Commit de merge", confirmation).click());
  await act(async () => button("Merger", confirmation).click());
  expect(forgeApi.mergeForgeRequest).toHaveBeenCalledExactlyOnceWith(
    "p1",
    "github.com/o/r",
    1,
    "merge",
    "head-1",
  );

  // A refresh keeps showing the previous read, but Merge waits for this round's re-read.
  await vi.waitFor(() => expect(merge().disabled).toBe(false));
  const reread = deferred<ForgeRequestDetail>();
  vi.mocked(forgeApi.readForgeRequest).mockReturnValueOnce(reread.promise);
  await act(async () => button("Actualiser", container).click());
  expect(merge().disabled).toBe(true);
  await act(async () => reread.resolve(requests[1]));
  await vi.waitFor(() => expect(merge().disabled).toBe(false));

  // Coming back to the tab re-reads too, and Merge waits for that read as well.
  hook = { ...hook, draft: { ...hook.draft, view: "changes" } };
  await render();
  const comeback = deferred<ForgeRequestDetail>();
  vi.mocked(forgeApi.readForgeRequest).mockReturnValueOnce(comeback.promise);
  hook = { ...hook, draft: { ...hook.draft, view: "requests" } };
  await render();
  expect(merge().disabled).toBe(true);
  await act(async () => comeback.resolve(requests[1]));
  await vi.waitFor(() => expect(merge().disabled).toBe(false));

  // The search opens from its toolbar button; emptying the field, as its clear button does,
  // lists without the search again.
  await act(async () => button("Rechercher", container).click());
  const search = container.querySelector<HTMLInputElement>(
    'input[aria-label="Rechercher"]',
  )!;
  await act(async () => {
    setInputValue(search, "fix");
    search.form!.requestSubmit();
  });
  await vi.waitFor(() =>
    expect(forgeApi.readForgeRequests).toHaveBeenLastCalledWith(
      "p1",
      "open",
      "fix",
    ),
  );
  await act(async () => setInputValue(search, ""));
  await vi.waitFor(() =>
    expect(forgeApi.readForgeRequests).toHaveBeenLastCalledWith(
      "p1",
      "open",
      "",
    ),
  );

  // Hiding the search drops an applied one.
  await act(async () => {
    setInputValue(search, "fix");
    search.form!.requestSubmit();
  });
  await vi.waitFor(() =>
    expect(forgeApi.readForgeRequests).toHaveBeenLastCalledWith(
      "p1",
      "open",
      "fix",
    ),
  );
  await act(async () => button("Masquer la recherche", container).click());
  expect(container.querySelector('input[aria-label="Rechercher"]')).toBeNull();
  await vi.waitFor(() =>
    expect(forgeApi.readForgeRequests).toHaveBeenLastCalledWith(
      "p1",
      "open",
      "",
    ),
  );
});

it("keeps the visited Branches view mounted with its draft and reuses reads during the cache TTL", async () => {
  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: null,
    },
  ]);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  await render();
  await vi.waitFor(() => expect(api.readGitBranches).toHaveBeenCalledTimes(1));
  const branchInput =
    container.querySelector<HTMLInputElement>("#git-branch-name")!;
  await act(async () => {
    setInputValue(branchInput, "topic/kept");
  });

  hook = { ...hook, draft: { ...hook.draft, view: "changes" } };
  await render();
  expect(branchInput.isConnected).toBe(true);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  await render();
  expect(
    container.querySelector<HTMLInputElement>("#git-branch-name")?.value,
  ).toBe("topic/kept");
  expect(api.readGitBranches).toHaveBeenCalledTimes(1);
});

it("refreshes the Branches list after an agent mutation", async () => {
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: project.path, head: "abc", branch: "main" },
    { path: "/projects/soreno-review", head: "def", branch: "review" },
  ]);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  await render({ branchRevision: 0 });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/projects/soreno-review"),
  );

  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: project.path, head: "abc", branch: "main" },
  ]);
  await render({ branchRevision: 1 });

  await vi.waitFor(() =>
    expect(container.textContent).not.toContain("/projects/soreno-review"),
  );
  expect(api.readGitWorktrees).toHaveBeenCalledTimes(2);
});

it("refreshes Git and projects after removing a worktree", async () => {
  const onMutation = vi.fn();
  const onRetryProjects = vi.fn();
  const onPrepareWorktreeRemoval = vi.fn(
    async (_worktree: GitWorktree) => async () => {},
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
    { path: project.path, head: "abc", branch: "main" },
    { path: "/projects/soreno-review", head: "def", branch: "review" },
  ]);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  await render({ onMutation, onRetryProjects, onPrepareWorktreeRemoval });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("/projects/soreno-review"),
  );

  await act(async () =>
    button("Supprimer le worktree · review", container).click(),
  );
  await act(async () =>
    button(
      "Supprimer le worktree",
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
    ).click(),
  );

  expect(onPrepareWorktreeRemoval).toHaveBeenCalledExactlyOnceWith({
    path: "/projects/soreno-review",
    head: "def",
    branch: "review",
  });
  expect(onMutation).toHaveBeenCalledOnce();
  expect(onRetryProjects).toHaveBeenCalledOnce();
});

it("offers to hand a worktree merge conflict to an agent", async () => {
  const onResolveMergeConflict = vi.fn();
  const reviewPath = "/projects/soreno-review";
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
      oid: "def",
      remote: false,
      current: false,
      upstream: null,
    },
    {
      name: "other",
      oid: "fed",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  vi.mocked(api.readGitWorktrees).mockResolvedValue([
    { path: project.path, head: "abc", branch: "main" },
    { path: reviewPath, head: "def", branch: "review" },
    { path: "/projects/soreno-other", head: "fed", branch: "other" },
  ]);
  const conflict = { code: "mergeConflict", message: "conflits" };
  vi.mocked(api.mergeGitWorktree)
    .mockRejectedValueOnce(conflict)
    .mockRejectedValueOnce(conflict);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  const props = {
    onResolveMergeConflict,
    worktreeProjectIds: (worktree: { path: string }) =>
      worktree.path === reviewPath ? ["p2"] : [],
  };
  await render(props);
  await vi.waitFor(() => expect(container.textContent).toContain(reviewPath));

  await act(async () =>
    button("Fusionner dans main et supprimer · review", container).click(),
  );
  await act(async () =>
    button(
      "Fusionner et supprimer",
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
    ).click(),
  );
  hook = {
    ...hook,
    error: {
      message: "[Git/mergeConflict]",
      uncertain: false,
      source: "mutation",
    },
  };
  await render(props);
  const error = gitError();
  expect(error?.action?.label).toBe("Résoudre avec un agent");

  await act(async () => error!.action!.onAction());
  expect(onResolveMergeConflict).toHaveBeenCalledExactlyOnceWith({
    projectIds: ["p2"],
    branch: "review",
    base: "main",
  });
  expect(hook.dismissError).toHaveBeenCalledOnce();

  hook = { ...hook, error: null };
  await render(props);
  await act(async () =>
    button("Fusionner dans main et supprimer · other", container).click(),
  );
  await act(async () =>
    button(
      "Fusionner et supprimer",
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
    ).click(),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  hook = {
    ...hook,
    error: {
      message: "[Git/mergeConflict]",
      uncertain: false,
      source: "mutation",
    },
  };
  await render(props);
  expect(gitError()?.action?.label).toBe("Fermer");
});

it("leaves the progress spinner to the button running the action", async () => {
  hook = { ...hook, repo: { ...repo, files: [] } };
  await render();
  await vi.waitFor(() =>
    expect(button("Push", container).disabled).toBe(false),
  );
  let finishPush!: () => void;
  vi.mocked(api.pushGitRemote).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPush = () => resolve({ oid: null, message: "", warning: null });
      }),
  );
  const progress = '[role="status"][aria-label="Opération Git en cours"]';
  await act(async () => void button("Push", container).click());
  hook = { ...hook, busy: true };
  await render();
  expect(button("Push…", container).disabled).toBe(true);
  expect(container.querySelector(progress)).toBeNull();

  await act(async () => finishPush());
  expect(container.querySelector(progress)).not.toBeNull();

  let finishCommit!: () => void;
  vi.mocked(api.quickCommitGitChanges).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCommit = () => resolve({ oid: null, message: "", warning: null });
      }),
  );
  hook = {
    ...hook,
    busy: false,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(
    async () =>
      void button(
        "Commit automatique : tout préparer, générer le message avec Codex et committer",
        container,
      ).click(),
  );
  hook = { ...hook, busy: true };
  await render();
  expect(button("Commit automatique en cours…", container).disabled).toBe(true);
  expect(container.querySelector(progress)).toBeNull();

  await act(async () => finishCommit());
  expect(container.querySelector(progress)).not.toBeNull();
});

it("keeps successful remote and branch mutations silent", async () => {
  hook = { ...hook, repo: { ...repo, files: [] } };
  await render();
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );
  for (const label of ["Fetch", "Push"])
    await act(async () => button(label, container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledOnce();
  expect(api.pullGitRemote).not.toHaveBeenCalled();
  expect(api.pushGitRemote).toHaveBeenCalledOnce();
  expect(container.textContent).not.toMatch(/Fetched|Pulled|Pushed/);

  vi.mocked(api.readGitBranches).mockResolvedValue([
    {
      name: "main",
      oid: "main-oid",
      remote: false,
      current: true,
      upstream: "origin/main",
    },
    {
      name: "topic",
      oid: "topic-oid",
      remote: false,
      current: false,
      upstream: null,
    },
  ]);
  hook = { ...hook, draft: { ...hook.draft, view: "branches" } };
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("topic"));
  const input = container.querySelector<HTMLInputElement>("#git-branch-name")!;
  await act(async () => {
    setInputValue(input, "new-topic");
  });
  await act(async () => button("Créer la branche", container).click());
  expect(api.createGitBranch).toHaveBeenCalledWith("p1", "new-topic", "v2");
  await act(async () => button("Basculer · topic", container).click());
  await act(async () =>
    button(
      "Basculer",
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
    ).click(),
  );
  expect(api.switchGitBranch).toHaveBeenCalledWith("p1", "topic", false, "v2");
  expect(container.textContent).not.toMatch(/Branch created|Branch switched/);
  expect(container.querySelector(".git-panel-notice.is-success")).toBeNull();
});

it("hides an init confirmation when the same project moves to another non-repository", async () => {
  hook = {
    ...hook,
    repo: {
      ...repo,
      availability: "notRepository",
      identity: null,
      files: [],
      version: "same-nonrepo-version",
    },
  };
  await render();
  await act(async () => button("Initialiser Git", container).click());
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await render({ project: { ...project, path: "/projects/replacement" } });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.initGitRepository).not.toHaveBeenCalled();
});

it.each([
  { path: "/projects/replacement" },
  { environment: { kind: "wsl" as const, distribution: "Ubuntu-24.04" } },
])(
  "does not carry a restore confirmation into a changed project scope: %j",
  async (change) => {
    hook = {
      ...hook,
      repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
    };
    await render();
    await act(async () =>
      button("Annuler les modifications… · new.txt", container).click(),
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await render({ project: { ...project, ...change } });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.restoreGitFiles).not.toHaveBeenCalled();
  },
);

it("restores a pending restore confirmation when returning to its original scope", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(async () =>
    button("Annuler les modifications… · new.txt", container).click(),
  );
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

  await render({ project: { ...project, path: "/projects/replacement" } });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();

  await render();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "new.txt",
  );
});

it("confirms restore silently even when its result includes backup information", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(async () =>
    button("Annuler toutes les modifications…", container).click(),
  );
  const confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  expect(confirmation.textContent).toContain("partial.ts");
  expect(confirmation.textContent).toContain("new.txt");
  expect(confirmation.textContent).toContain("version de l’index");
  expect(confirmation.textContent).toContain(
    "fichiers non suivis seront retirés",
  );
  expect(confirmation.textContent).toContain(
    "récupérée avec Git hors de Soreno",
  );
  expect(confirmation.textContent).not.toContain("Version du dépôt");
  await act(async () =>
    button("Annuler les modifications…", confirmation).click(),
  );
  expect(api.restoreGitFiles).toHaveBeenCalledWith(
    "p1",
    ["new.txt", "partial.ts"],
    "v2",
  );
  expect(container.textContent).not.toContain("Restored");
  expect(container.textContent).not.toContain("stash-backup");
  expect(container.textContent).not.toContain("Le stash peut aussi contenir");
  expect(container.querySelector(".git-panel-notice.is-success")).toBeNull();
});

it("requires explicit confirmation to resolve a conflict preview that still has markers", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "conflict.rs", side: "unstaged" },
    },
    diff: {
      path: "conflict.rs",
      oldPath: null,
      version: "v2",
      before: { ...comparison.before, text: "ours\n" },
      after: {
        ...comparison.after,
        text: "<<<<<<< ours\n=======\n>>>>>>> theirs\n",
      },
      conflictStages: [],
    },
  };
  await render();
  await act(async () => button("Marquer résolu…", container).click());
  const confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  const markerWarning = () =>
    getNotifications().find(({ message }) =>
      message.includes("marqueurs de conflit restent"),
    );
  expect(markerWarning()?.tone).toBe("warning");
  await act(async () => button("Marquer résolu…", confirmation).click());
  expect(markerWarning()).toBeUndefined();
  expect(api.resolveGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["conflict.rs"],
    "v2",
    true,
  );
  expect(container.textContent).not.toContain("Resolved");
  expect(container.querySelector(".git-panel-notice.is-success")).toBeNull();
});

it("allows a merge commit with no staged files once conflicts are resolved and keeps a non-empty draft", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, message: "Custom merge message" },
    repo: {
      ...repo,
      branch: null,
      operation: "merge",
      mergeMessage: "Default merge message",
      files: [],
    },
  };
  await render();
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Default merge message",
  });
  expect(button("Commit de fusion", container).disabled).toBe(false);
  await act(async () => button("Commit de fusion", container).click());
  const confirmation = document.querySelector<HTMLElement>(
    ".git-commit-composer",
  )!;
  expect(button("Générer le message", confirmation).disabled).toBe(true);
  expect(button("Commit de fusion", confirmation).disabled).toBe(false);
  await act(async () => button("Commit de fusion", confirmation).click());
  expect(api.commitGitChanges).toHaveBeenCalledWith(
    "p1",
    "Custom merge message",
    "v2",
  );
});

it("waits for fresh status before proposing the current merge message", async () => {
  hook = {
    ...hook,
    hasFreshStatus: false,
    repo: {
      ...repo,
      operation: "merge",
      mergeMessage: "Merge old-topic",
      files: [],
    },
  };
  await render();
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Merge old-topic",
  });

  hook = {
    ...hook,
    hasFreshStatus: true,
    repo: { ...hook.repo!, version: "v3", mergeMessage: "Merge new-topic" },
  };
  await render();
  expect(hook.updateDraft).toHaveBeenCalledWith({ message: "Merge new-topic" });
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Merge old-topic",
  });
});

it("does not replace a commit message typed before fresh merge status arrives", async () => {
  hook = {
    ...hook,
    hasFreshStatus: false,
    repo: {
      ...repo,
      operation: "merge",
      mergeMessage: "Merge old-topic",
      files: [],
    },
  };
  await render();
  hook = {
    ...hook,
    hasFreshStatus: true,
    draft: { ...hook.draft, message: "User merge message" },
    repo: { ...hook.repo!, version: "v3", mergeMessage: "Merge new-topic" },
  };
  await render();
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Merge old-topic",
  });
  expect(hook.updateDraft).not.toHaveBeenCalledWith({
    message: "Merge new-topic",
  });
});

it("refuses a restore confirmation after its repository version becomes stale", async () => {
  hook = {
    ...hook,
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await render();
  await act(async () =>
    button("Annuler les modifications… · new.txt", container).click(),
  );
  hook = { ...hook, repo: { ...hook.repo!, version: "v3" }, stale: true };
  await render();
  const confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  expect(button("Annuler les modifications…", confirmation).disabled).toBe(
    true,
  );
  await act(async () =>
    button("Annuler les modifications…", confirmation).click(),
  );
  expect(api.restoreGitFiles).not.toHaveBeenCalled();
});

it("moves through every file without changing the commit draft", async () => {
  await render();
  expect(hook.updateDraft).toHaveBeenCalledWith({
    selection: { path: "conflict.rs", side: "unstaged" },
  });
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      message: "Keep my draft",
      selection: { path: "new.txt", side: "unstaged" },
    },
  };
  await render();
  expect(button("Fichier précédent", container).disabled).toBe(false);
  await act(async () => button("Fichier suivant", container).click());
  expect(hook.updateDraft).toHaveBeenLastCalledWith({
    selection: { path: "partial.ts", side: "unstaged" },
  });
  expect(container.querySelector("textarea")).toBeNull();
  expect(hook.draft.message).toBe("Keep my draft");
});

it("keeps file navigation focused while a new diff is loading", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: comparison,
  };
  await render();
  const next = button("Fichier suivant", container);
  act(() => next.focus());

  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "new.txt", side: "unstaged" },
    },
    diff: null,
    diffLoading: true,
  };
  await render();
  expect(button("Fichier suivant", container)).toBe(next);
  expect(document.activeElement).toBe(next);
  expect(
    container.querySelector(".git-panel-centered-status")?.textContent,
  ).toContain("Lecture du diff…");
  expect(container.querySelector(".git-diff-content > [data-diff]")).toBeNull();

  hook = {
    ...hook,
    diff: { ...comparison, path: "new.txt", version: repo.version },
    diffLoading: false,
  };
  await render();
  expect(button("Fichier suivant", container)).toBe(next);
  expect(document.activeElement).toBe(next);
});

it("toggles the file sidebar and leaves the focus view", async () => {
  const onExpandedChange = vi.fn();
  await render({ expanded: true, onExpandedChange });
  const sidebar = container.querySelector<HTMLElement>(".git-review-sidebar")!;
  await act(async () => button("Masquer les fichiers", container).click());
  expect(sidebar.hidden).toBe(true);
  await act(async () => button("Afficher les fichiers", container).click());
  expect(sidebar.hidden).toBe(false);
  await act(async () => button("Revenir au terminal", container).click());
  expect(onExpandedChange).toHaveBeenCalledWith(false);
});

it("resizes the narrow file list with bounded keyboard controls and resets it on double click", async () => {
  await render();
  const workspace = container.querySelector<HTMLElement>(
    ".git-review-workspace",
  )!;
  const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
  expect(separator.getAttribute("aria-valuenow")).toBe("28");

  await pressKey(separator, "ArrowUp");
  expect(workspace.style.getPropertyValue("--git-files-size")).toBe("26fr");
  await pressKey(separator, "Home");
  await pressKey(separator, "ArrowUp");
  expect(separator.getAttribute("aria-valuenow")).toBe("15");
  await pressKey(separator, "End");
  await pressKey(separator, "ArrowDown");
  expect(separator.getAttribute("aria-valuenow")).toBe("80");
  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("28");
  expect(workspace.style.getPropertyValue("--git-diff-size")).toBe("72fr");
});

it("restores and validates the saved file column size", async () => {
  localStorage.setItem("soreno:git-files-ratio", "120");
  await render();
  let separator = container.querySelector<HTMLElement>(
    ".git-files-resizer-wide",
  )!;
  expect(separator.getAttribute("aria-valuenow")).toBe("80");
  expect(localStorage.getItem("soreno:git-files-ratio")).toBe("120");
  await pressKey(separator, "ArrowRight");
  expect(localStorage.getItem("soreno:git-files-ratio")).toBe("78");

  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  separator = container.querySelector<HTMLElement>(".git-files-resizer-wide")!;
  expect(separator.getAttribute("aria-valuenow")).toBe("78");
});

it("resizes the wide right column with pointer and keyboard controls", async () => {
  await render();
  const workspace = container.querySelector<HTMLElement>(
    ".git-review-workspace",
  )!;
  const separator = container.querySelector<HTMLElement>(
    ".git-files-resizer-wide",
  )!;
  workspace.getBoundingClientRect = vi.fn(() => ({ width: 1001 }) as DOMRect);
  Object.defineProperty(separator, "setPointerCapture", { value: vi.fn() });

  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 1, 0, 0, 700)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 1, 0, 0, 500)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("48");
  expect(workspace.style.getPropertyValue("--git-files-size")).toBe("48fr");
  await pressKey(separator, "ArrowRight");
  expect(separator.getAttribute("aria-valuenow")).toBe("46");
  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("28");
});

it("tracks only primary pointer drags and cleans up every captured pointer ending", async () => {
  await render();
  const workspace = container.querySelector<HTMLElement>(
    ".git-review-workspace",
  )!;
  const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
  workspace.getBoundingClientRect = vi.fn(() => ({ height: 401 }) as DOMRect);
  const setPointerCapture = vi.fn();
  Object.defineProperty(separator, "setPointerCapture", {
    value: setPointerCapture,
  });

  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 1, 100)),
  );
  expect(setPointerCapture).toHaveBeenCalledWith(1);
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 1, 300)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("78");
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerup", 1, 300)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 1, 100)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("78");

  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 2, 100)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 2, 140)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointercancel", 2, 140)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 2, 300)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("38");

  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 3, 100)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 3, 180)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("lostpointercapture", 3, 180)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 3, 300)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("48");

  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  const captures = setPointerCapture.mock.calls.length;
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 4, 100, 2)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 4, 300)),
  );
  expect(setPointerCapture).toHaveBeenCalledTimes(captures);
  expect(separator.getAttribute("aria-valuenow")).toBe("28");
});

it("keeps the file ratio and diff DOM while hiding and showing the file list", async () => {
  hook = {
    ...hook,
    draft: {
      ...hook.draft,
      selection: { path: "partial.ts", side: "unstaged" },
    },
    diff: comparison,
  };
  await render();
  const workspace = container.querySelector<HTMLElement>(
    ".git-review-workspace",
  )!;
  const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
  const diff = container.querySelector('[data-diff="partial.ts"]');
  await pressKey(separator, "ArrowDown");
  expect(workspace.style.getPropertyValue("--git-files-size")).toBe("30fr");

  const diffContent =
    container.querySelector<HTMLElement>(".git-diff-content")!;
  expect(
    diffContent.querySelector('[aria-label="Préparer · partial.ts"]'),
  ).toBeNull();
  await act(async () => button("Masquer les fichiers", container).click());
  expect(separator.hidden).toBe(true);
  expect(container.querySelector('[data-diff="partial.ts"]')).toBe(diff);
  await act(async () => button("Préparer · partial.ts", diffContent).click());
  expect(api.stageGitFiles).toHaveBeenCalledExactlyOnceWith(
    "p1",
    ["partial.ts"],
    "v2",
  );
  await act(async () => button("Afficher les fichiers", container).click());
  expect(separator.hidden).toBe(false);
  expect(separator.getAttribute("aria-valuenow")).toBe("30");
  expect(container.querySelector('[data-diff="partial.ts"]')).toBe(diff);
  expect(
    diffContent.querySelector('[aria-label="Préparer · partial.ts"]'),
  ).toBeNull();
});

it("switches between a compact list and compressed folders without changing the selected side", async () => {
  const first = { ...repo.files[0], path: "apps/mobile/src/ui/Value.tsx" };
  const second = {
    ...repo.files[0],
    path: "apps/mobile/src/hooks/Value.tsx",
    indexStatus: ".",
  };
  hook = {
    ...hook,
    repo: { ...repo, files: [first, second] },
    draft: {
      ...hook.draft,
      message: "Keep draft",
      selection: { path: first.path, side: "staged" },
    },
  };
  await render();
  expect(container.querySelector(".git-tree-directory")).toBeNull();
  expect(container.querySelector(".git-file-path small")?.textContent).toBe(
    "apps/mobile/src/ui",
  );
  const toggle = button("Afficher en arborescence");
  await act(async () => toggle.click());
  expect(localStorage.getItem("soreno:git-file-tree")).toBe("true");
  expect(
    container.querySelector(
      '.git-tree-directory summary[title="apps/mobile/src"]',
    )?.textContent,
  ).toContain("apps/mobile/src");
  expect(container.querySelector(".git-file-path small")).toBeNull();
  expect(
    container
      .querySelector<HTMLButtonElement>(
        `[aria-label^="${first.path} · préparé"]`,
      )
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  await act(async () => button(`Préparer · ${second.path}`).click());
  expect(api.stageGitFiles).toHaveBeenCalledWith("p1", [second.path], "v2");
  await act(async () => button("Afficher en liste").click());
  expect(localStorage.getItem("soreno:git-file-tree")).toBe("false");
  expect(container.querySelector(".git-tree-directory")).toBeNull();
  expect(container.querySelector("textarea")).toBeNull();
  expect(hook.draft.message).toBe("Keep draft");
});

it("keeps collapsed groups stable across rerenders", async () => {
  localStorage.setItem("soreno:git-file-tree", "true");
  hook = {
    ...hook,
    repo: {
      ...repo,
      files: [
        { ...repo.files[0], path: "src/ui/a.ts" },
        { ...repo.files[1], path: "src/ui/new.txt" },
      ],
    },
  };
  await render();
  const group = container.querySelector<HTMLButtonElement>(
    ".git-change-group-toggle",
  )!;
  await act(async () => group.click());
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(
    document.getElementById(group.getAttribute("aria-controls")!)?.hidden,
  ).toBe(true);
  await render();
  expect(
    container
      .querySelector(".git-change-group-toggle")
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  const folder = container.querySelector<HTMLDetailsElement>(
    ".git-tree-directory details",
  )!;
  await act(async () => folder.querySelector("summary")!.click());
  expect(folder.open).toBe(false);
  await render();
  const changes = [
    ...container.querySelectorAll<HTMLElement>(".git-change-group"),
  ].find(
    (node) => node.querySelector("h3 span")?.textContent === "Changements",
  )!;
  const folders = [...changes.querySelectorAll<HTMLElement>("summary[title]")];
  expect(folders.map((folder) => folder.title)).toEqual(["src/ui"]);
  expect(folders[0].textContent).toContain("2");
  await act(async () => folders[0].click());
  for (const path of ["src/ui/a.ts", "src/ui/new.txt"]) {
    const row = container.querySelector(
      `[aria-label^="${path} · non préparé"]`,
    );
    expect(row?.closest("details")?.open).toBe(false);
  }
});

it("recovers selection after a file leaves its group and offers history for a clean repository", async () => {
  hook = {
    ...hook,
    draft: { ...hook.draft, selection: { path: "gone.ts", side: "unstaged" } },
  };
  await render();
  expect(hook.updateDraft).toHaveBeenCalledWith({
    selection: { path: "conflict.rs", side: "unstaged" },
  });
  hook = { ...hook, repo: { ...repo, files: [] } };
  await render();
  expect(hook.updateDraft).toHaveBeenLastCalledWith({ selection: null });
  expect(
    container.querySelector(".git-diff-area .app-empty-state")?.textContent,
  ).toContain("Aucun changement en attente");
});

it("feeds Files with project-relative Git status and routes its Git actions", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  vi.mocked(api.readGitPathPrefix).mockResolvedValue("sub/");
  hook = {
    ...hook,
    repo: {
      ...repo,
      files: [
        { ...repo.files[0], path: "sub/src/partial.ts" },
        { ...repo.files[1], path: "outside.txt" },
      ],
    },
  };
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [],
    commits: [],
    hasMore: false,
  });
  const onAgentInput = vi.fn();
  await render({ onAgentInput });
  await act(async () =>
    vi.waitFor(() =>
      expect(explorerRuntime.props?.historyAvailable).toBe(true),
    ),
  );
  const props = explorerRuntime.props as {
    gitStatus: { files: Map<string, unknown>; directories: Set<string> };
    onAgentInput: (sessionId: string) => void;
    onFilesChanged: () => void;
    onShowChanges: (change: unknown) => void;
    onShowHistory: (path: string) => void;
  };
  expect([...props.gitStatus.files.keys()]).toEqual(["src/partial.ts"]);
  expect([...props.gitStatus.directories]).toEqual(["src"]);
  props.onAgentInput("s1");
  expect(onAgentInput).toHaveBeenCalledWith("s1");
  props.onFilesChanged();
  expect(hook.refresh).toHaveBeenCalled();

  await act(async () =>
    props.onShowChanges({
      badge: "M",
      gitPath: "sub/src/partial.ts",
      side: "unstaged",
    }),
  );
  expect(explorerRuntime.guard.prepare).toHaveBeenCalled();
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "changes" });
  expect(hook.updateDraft).toHaveBeenCalledWith({
    selection: { path: "sub/src/partial.ts", side: "unstaged" },
  });

  localStorage.setItem("soreno:project-panel-view", "explorer");
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.mocked(hook.updateDraft).mockClear();
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(explorerRuntime.props?.historyAvailable).toBe(true),
    ),
  );
  await act(async () =>
    (explorerRuntime.props as typeof props).onShowHistory("src"),
  );
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "history" });
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(api.readGitHistory).toHaveBeenCalledWith(
        project.id,
        null,
        0,
        "src",
      ),
    ),
  );
  expect(container.querySelector(".git-history-filter")?.textContent).toBe(
    "src",
  );
});

async function openGitFileMenu(gitPath: string) {
  const row = document.querySelector<HTMLElement>(
    `[data-git-path="${gitPath}"]`,
  )!;
  row.focus();
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

function menuItem(label: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(".app-menu-item"),
  ].find((item) => item.textContent === label);
}

it("maps Git file rows to project paths in Changes and History menus", async () => {
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  onTestFinished(() => {
    vi.mocked(Element.prototype.matches).mockRestore();
    vi.unstubAllGlobals();
  });
  vi.mocked(api.readGitPathPrefix).mockResolvedValue("sub/");
  const changed = { ...repo.files[0], path: "sub/src/partial.ts" };
  const other = { ...repo.files[0], path: "sub/lib/other.ts" };
  const gone = {
    ...repo.files[0],
    path: "sub/src/gone.ts",
    indexStatus: ".",
    worktreeStatus: "D",
  };
  hook = {
    ...hook,
    repo: {
      ...repo,
      files: [changed, gone, { ...repo.files[1], path: "out.txt" }],
    },
  };
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [repo.head!],
    commits: [
      {
        oid: "c1",
        parents: [],
        references: [],
        author: "Ada",
        date: "2025-01-01T00:00:00Z",
        subject: "Touch files",
      },
    ],
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail).mockResolvedValue({
    oid: "c1",
    parent: null,
    files: [changed, other],
  });
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparison,
    path: changed.path,
  });
  const onOpenFile = vi.fn();
  await render({ onOpenFile });
  await act(async () =>
    vi.waitFor(() => expect(api.readGitPathPrefix).toHaveBeenCalled()),
  );

  await openGitFileMenu("out.txt");
  expect(menuItem("Hors de ce projet")?.hasAttribute("data-disabled")).toBe(
    true,
  );
  await openGitFileMenu(changed.path);
  await act(async () => menuItem("Copier le chemin relatif")!.click());
  expect(writeClipboardText).toHaveBeenLastCalledWith("src/partial.ts");
  await openGitFileMenu(changed.path);
  await act(async () => menuItem("Ouvrir le fichier")!.click());
  expect(onOpenFile).toHaveBeenCalledWith("src/partial.ts");
  await openGitFileMenu(gone.path);
  expect(menuItem("Ouvrir le fichier")?.hasAttribute("data-disabled")).toBe(
    true,
  );
  await openGitFileMenu(changed.path);
  await act(async () => menuItem("Voir l’historique")!.click());
  expect(hook.updateDraft).toHaveBeenCalledWith({ view: "history" });

  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(
        document.querySelector(`[data-git-path="${other.path}"]`),
      ).not.toBeNull(),
    ),
  );
  expect(api.readGitHistory).toHaveBeenLastCalledWith(
    project.id,
    null,
    0,
    "src/partial.ts",
  );
  await openGitFileMenu(changed.path);
  expect(menuItem("Voir l’historique")).toBeUndefined();
  await openGitFileMenu(other.path);
  await act(async () => menuItem("Voir l’historique")!.click());
  await act(async () =>
    vi.waitFor(() =>
      expect(api.readGitHistory).toHaveBeenLastCalledWith(
        project.id,
        null,
        0,
        "lib/other.ts",
      ),
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Afficher tout l’historique",
      ),
    ),
  );
});

it("keeps file history available and retries Git badges when the prefix read fails", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  vi.mocked(api.readGitPathPrefix).mockRejectedValueOnce(new Error("offline"));
  await render();
  await act(async () =>
    vi.waitFor(() => expect(api.readGitPathPrefix).toHaveBeenCalledTimes(1)),
  );
  expect(explorerRuntime.props?.historyAvailable).toBe(true);
  expect(explorerRuntime.props?.gitStatus).toBeNull();

  hook = { ...hook, revision: hook.revision + 1 };
  await render();
  await act(async () =>
    vi.waitFor(() => expect(explorerRuntime.props?.gitStatus).not.toBeNull()),
  );
  expect(api.readGitPathPrefix).toHaveBeenCalledTimes(2);
});

it("rereads Git status each time Files is shown again over a read status", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  hook = { ...hook, hasFreshStatus: false };
  await render();
  expect(hook.refresh).not.toHaveBeenCalled();

  hook = { ...hook, hasFreshStatus: true };
  await render();
  expect(hook.refresh).not.toHaveBeenCalled();

  await render({ visible: false });
  expect(hook.refresh).not.toHaveBeenCalled();
  await render({ visible: true });
  expect(hook.refresh).toHaveBeenCalledTimes(1);

  await render({ visible: true });
  expect(hook.refresh).toHaveBeenCalledTimes(1);

  await render({ visible: true, disconnected: true });
  await render({ visible: true, disconnected: false });
  expect(hook.refresh).toHaveBeenCalledTimes(1);
});

it("reads the Git path prefix again once the project reconnects", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  await render({ disconnected: true });
  await act(async () => Promise.resolve());
  expect(api.readGitPathPrefix).not.toHaveBeenCalled();

  await render({ disconnected: false });
  await act(async () =>
    vi.waitFor(() => expect(explorerRuntime.props?.gitStatus).not.toBeNull()),
  );
  expect(api.readGitPathPrefix).toHaveBeenCalledTimes(1);
});

it("selects a commit again after clearing a file history filter", async () => {
  localStorage.setItem("soreno:project-panel-view", "explorer");
  vi.mocked(api.readGitHistory).mockImplementation(
    async (_projectId, _roots, _offset, path) => ({
      roots: [repo.head!],
      commits: [
        {
          oid: path ? "filtered" : "latest",
          parents: [],
          references: [],
          author: "Ada",
          date: "2025-01-01T00:00:00Z",
          subject: path ? "Filtered commit" : "Latest commit",
        },
      ],
      hasMore: false,
    }),
  );
  vi.mocked(api.readGitCommitDetail).mockImplementation(async (_id, oid) => ({
    oid,
    parent: null,
    files: [],
  }));
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(explorerRuntime.props?.historyAvailable).toBe(true),
    ),
  );
  const onShowHistory = explorerRuntime.props?.onShowHistory;
  if (typeof onShowHistory !== "function")
    throw new Error("Missing onShowHistory");
  await act(async () => onShowHistory("src"));
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Filtered commit"),
  );

  await act(async () => button("Afficher tout l’historique").click());
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledWith(project.id, "latest"),
  );
  expect(container.querySelector(".git-history-filter")).toBeNull();
});

it("drops the file history filter when opening a commit warning SHA", async () => {
  const oid = "abc1234567890abcdef1234567890abcdef12345";
  localStorage.setItem("soreno:project-panel-view", "explorer");
  vi.mocked(api.commitGitChanges).mockResolvedValueOnce({
    oid,
    message: "Commit créé.",
    warning: "Un hook a modifié l’arbre préparé.",
  });
  vi.mocked(api.readGitCommitDetail).mockResolvedValue({
    oid,
    parent: null,
    files: [],
  });
  await render();
  await act(async () =>
    vi.waitFor(() =>
      expect(explorerRuntime.props?.historyAvailable).toBe(true),
    ),
  );
  const onShowHistory = explorerRuntime.props?.onShowHistory;
  if (typeof onShowHistory !== "function")
    throw new Error("Missing onShowHistory");
  await act(async () => onShowHistory("src"));

  hook = {
    ...hook,
    draft: { ...hook.draft, view: "changes", message: "Run hook" },
    repo: { ...repo, files: repo.files.filter((file) => !file.conflict) },
  };
  await act(async () => button("Changements").click());
  await render();
  await act(async () => button("Commit", container).click());
  await act(async () =>
    button(
      "Commit",
      document.querySelector<HTMLElement>(".git-commit-composer")!,
    ).click(),
  );
  const action = getNotifications().find(({ key }) =>
    key.startsWith("git-commit-warning:"),
  )?.action;
  await act(async () => action!.onAction());
  hook = { ...hook, draft: { ...hook.draft, view: "history" } };
  await render();
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledWith(project.id, oid),
  );
  expect(api.readGitHistory).not.toHaveBeenCalledWith(
    project.id,
    null,
    0,
    "src",
  );
  expect(container.querySelector(".git-history-filter")).toBeNull();
});
