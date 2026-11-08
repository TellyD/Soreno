// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/projectGitApi";
import { createGitReadCache, type GitReadCache } from "../../data/gitReadCache";
import type { GitRepository } from "../../domain/projectGit";
import type { useProjectGit } from "../../hooks/useProjectGit";
import { clearNotifications, getNotifications } from "../../notifications";
import {
  defaultGitRemote,
  defaultPushBranch,
  GitRemoteActions,
  validGitBranch,
} from "./GitRemoteActions";
import { projectGitTestState } from "./projectGitTestState";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("@base-ui/react/menu", async () => {
  const { cloneElement, createContext, useContext, useRef } =
    await import("react");
  const Pass = ({ children }: { children: ReactNode }) => children;
  const OpenContext = createContext<(() => void) | null>(null);
  const RadioContext = createContext<{
    value: string;
    onValueChange: (value: string) => void;
  } | null>(null);
  return {
    Menu: {
      Root: ({
        children,
        onOpenChange,
      }: {
        children: ReactNode;
        onOpenChange?: (open: boolean) => void;
      }) => {
        const open = useRef(false);
        return (
          <OpenContext.Provider
            value={() => {
              open.current = !open.current;
              onOpenChange?.(open.current);
            }}
          >
            {children}
          </OpenContext.Provider>
        );
      },
      Portal: Pass,
      Positioner: Pass,
      Trigger: ({
        render,
        ref,
      }: {
        render: ReactElement;
        ref?: Ref<HTMLButtonElement>;
      }) => {
        const toggle = useContext(OpenContext);
        return cloneElement(render, {
          ref,
          onClick: toggle ?? undefined,
        } as never);
      },
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
      RadioGroup: ({
        children,
        value,
        onValueChange,
      }: {
        children: ReactNode;
        value: string;
        onValueChange: (value: string) => void;
      }) => (
        <RadioContext.Provider value={{ value, onValueChange }}>
          {children}
        </RadioContext.Provider>
      ),
      RadioItem: ({
        render,
        children,
        disabled,
        value,
      }: {
        render: ReactElement;
        children: ReactNode;
        disabled?: boolean;
        value: string;
      }) => {
        const group = useContext(RadioContext)!;
        return cloneElement(
          render,
          {
            "aria-checked": group.value === value,
            disabled,
            onClick: () => group.onValueChange(value),
            role: "menuitemradio",
          } as never,
          children,
        );
      },
    },
  };
});
vi.mock("../../data/projectGitApi", () => ({
  readGitRemotes: vi.fn(),
  fetchGitRemote: vi.fn(),
  pullGitRemote: vi.fn(),
  pushGitRemote: vi.fn(),
}));

const repo: GitRepository = {
  availability: "ready",
  identity: { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" },
  version: "v2",
  head: "abc",
  branch: "main",
  upstream: "origin/release/main",
  ahead: 2,
  behind: 1,
  trackingKnown: true,
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
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    {
      name: "origin",
      url: "ssh://fetch/repo",
      pushUrl: "ssh://push/repo",
      ambiguous: false,
    },
  ]);
  vi.mocked(api.fetchGitRemote).mockResolvedValue({
    oid: null,
    message: "fetched",
    warning: null,
  });
  vi.mocked(api.pullGitRemote).mockResolvedValue({
    oid: null,
    message: "pulled",
    warning: null,
  });
  vi.mocked(api.pushGitRemote).mockResolvedValue({
    oid: null,
    message: "pushed",
    warning: null,
  });
  git = projectGitTestState(repo, { stale: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  clearNotifications();
});

async function render(
  props: {
    active?: boolean;
    projectId?: string;
    readCache?: GitReadCache;
    readScope?: string;
  } = {},
) {
  await act(async () =>
    root.render(
      <GitRemoteActions
        active={props.active ?? true}
        git={git}
        projectId={props.projectId ?? "p1"}
        readCache={props.readCache}
        readScope={props.readScope}
      />,
    ),
  );
}
function maybeButton(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
}
function button(label: string, scope: ParentNode = document) {
  const result = maybeButton(label, scope);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

it("accepts only an unambiguous upstream remote", () => {
  const nested = [
    { name: "team", url: "a" },
    { name: "team/core", url: "b" },
  ];
  expect(defaultGitRemote(nested, "team/core/main")).toBe("");
  expect(
    defaultGitRemote([{ name: "team/core", url: "b" }], "team/core/main"),
  ).toBe("team/core");
  expect(defaultGitRemote([{ name: "origin", url: "a" }], "missing/main")).toBe(
    "",
  );
  expect(
    defaultGitRemote(
      [
        { name: "backup", url: "a" },
        { name: "origin", url: "b" },
      ],
      null,
    ),
  ).toBe("origin");
  expect(defaultGitRemote([{ name: "backup", url: "a" }], null)).toBe("backup");
  expect(
    defaultGitRemote(
      [
        { name: "a", url: "a" },
        { name: "b", url: "b" },
      ],
      null,
    ),
  ).toBe("");
  expect(
    defaultPushBranch("team/core/main", "team/core", "topic", nested),
  ).toBe("");
  expect(defaultPushBranch("team/core/main", "team", "topic", nested)).toBe("");
  expect(
    validGitBranch(
      defaultPushBranch("team/core/main", "team", "topic", nested),
    ),
  ).toBe(false);
  expect(validGitBranch("release/main")).toBe(true);
  expect(validGitBranch("bad..branch")).toBe(false);
});

it("shows only the useful sync action for each tracking state", async () => {
  git = { ...git, repo: { ...repo, ahead: 0, behind: 0 } };
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("À jour"));
  expect(button("Fetch", container).disabled).toBe(false);

  let finishPush!: () => void;
  vi.mocked(api.pushGitRemote).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPush = () => resolve({ oid: null, message: "", warning: null });
      }),
  );
  git = { ...git, repo: { ...repo, ahead: 2, behind: 0 } };
  await render();
  await act(async () => void button("Push 2", container).click());
  expect(button("Push…", container).disabled).toBe(true);
  await act(async () => finishPush());
  expect(button("Push 2", container).disabled).toBe(false);
  expect(api.pushGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "release/main",
    "ssh://push/repo",
    "v2",
  );

  git = { ...git, repo: { ...repo, ahead: 0, behind: 1 } };
  await render();
  await act(async () => button("Pull 1", container).click());
  expect(api.pullGitRemote).toHaveBeenLastCalledWith(
    "p1",
    "origin",
    "ssh://fetch/repo",
    "v2",
    false,
  );

  git = { ...git, repo: { ...repo, ahead: 2, behind: 3 } };
  await render();
  expect(maybeButton("Push 2", container)).toBeUndefined();
  expect(button("Pull", container).disabled).toBe(true);
  expect(button("Pull", container).title).toBe(
    "La branche a divergé de sa branche amont. Utilisez Pull avec rebase depuis le menu.",
  );
  expect(button("Push", container).disabled).toBe(false);

  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "origin", url: "ssh://fetch/repo" },
  ]);
  const reads = vi.mocked(api.readGitRemotes).mock.calls.length;
  await act(async () => button("Autres actions", container).click());
  await vi.waitFor(() =>
    expect(api.readGitRemotes).toHaveBeenCalledTimes(reads + 1),
  );
  await vi.waitFor(() => expect(button("Push", container).disabled).toBe(true));
  expect(button("Push", container).title).toBe(
    "La branche distante a des commits absents en local. Intégrez-les avec Pull avant de pousser.",
  );
  await act(async () => button("Pull 3", container).click());
  expect(api.pullGitRemote).toHaveBeenLastCalledWith(
    "p1",
    "origin",
    "ssh://fetch/repo",
    "v2",
    true,
  );
});

it("keeps standard sync actions visible when upstream tracking is unknown", async () => {
  git = {
    ...git,
    repo: { ...repo, ahead: 0, behind: 0, trackingKnown: false },
  };
  await render();

  for (const action of ["Fetch", "Push", "Pull", "Pull avec rebase"]) {
    expect(button(action, container).disabled).toBe(false);
  }
});

it("blocks pull and push for ambiguous nested upstream prefixes but allows fetch", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "team", url: "ssh://team" },
    { name: "team/core", url: "ssh://core" },
  ]);
  git = {
    ...git,
    repo: {
      ...repo,
      branch: "topic",
      upstream: "team/core/main",
      ahead: 2,
      behind: 3,
    },
  };
  await render();
  expect(maybeButton("Push 2", container)).toBeUndefined();
  expect(maybeButton("Pull 3", container)).toBeUndefined();

  for (const remote of ["team", "team/core"]) {
    await act(async () => button(remote, container).click());
    expect(button("Fetch", container).disabled).toBe(false);
    for (const action of [
      button("Pull", container),
      button("Push", container),
    ]) {
      expect(action.disabled).toBe(true);
      await act(async () => action.click());
    }
    await act(async () => button("Fetch", container).click());
  }

  expect(api.fetchGitRemote).toHaveBeenNthCalledWith(
    1,
    "p1",
    "team",
    "ssh://team",
    "v2",
  );
  expect(api.fetchGitRemote).toHaveBeenNthCalledWith(
    2,
    "p1",
    "team/core",
    "ssh://core",
    "v2",
  );
  expect(api.pullGitRemote).not.toHaveBeenCalled();
  expect(api.pushGitRemote).not.toHaveBeenCalled();
});

it("does not read or fetch remotes while hidden and ignores a delayed result from the previous project", async () => {
  await render({ active: false });
  expect(api.readGitRemotes).not.toHaveBeenCalled();
  const hiddenFetch = button("Fetch", container);
  expect(hiddenFetch.disabled).toBe(true);
  expect(hiddenFetch.title).toBe(
    "Ouvrez le panneau Git pour utiliser les actions réseau.",
  );
  await act(async () => hiddenFetch.click());
  expect(api.fetchGitRemote).not.toHaveBeenCalled();
  let resolveOld!: (value: { name: string; url: string }[]) => void;
  vi.mocked(api.readGitRemotes)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce([{ name: "new", url: "ssh://new" }]);
  await render({ active: true });
  await render({ active: true, projectId: "p2" });
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledWith("p2"));
  await act(async () => resolveOld([{ name: "old", url: "ssh://old" }]));
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledWith(
    "p2",
    "new",
    "ssh://new",
    "v2",
  );
});

it("does not reload remotes for a Git revision alone", async () => {
  await render();
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(1));
  git = { ...git, revision: 1 };
  await render();
  expect(api.readGitRemotes).toHaveBeenCalledTimes(1);
});

it("revalidates remotes when shown again after the TTL without reading while hidden", async () => {
  let now = 0;
  const cache = createGitReadCache({ now: () => now });
  await render({ readCache: cache, readScope: "scope" });
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(1));
  now = 4_000;
  await render({ active: false, readCache: cache, readScope: "scope" });
  expect(api.readGitRemotes).toHaveBeenCalledTimes(1);
  now = 5_000;
  await render({ active: true, readCache: cache, readScope: "scope" });
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(2));
});

it("keeps fetch active while pull and push await the first remote read", async () => {
  let resolveRead!: (value: { name: string; url: string }[]) => void;
  vi.mocked(api.readGitRemotes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  await render();

  expect(button("Fetch", container).disabled).toBe(false);
  expect(button("Pull", container).disabled).toBe(true);
  expect(button("Push", container).disabled).toBe(true);

  await act(async () => button("Fetch", container).click());
  expect(api.readGitRemotes).toHaveBeenCalledTimes(1);
  expect(api.fetchGitRemote).not.toHaveBeenCalled();

  await act(async () =>
    resolveRead([{ name: "origin", url: "ssh://known/repo" }]),
  );
  await vi.waitFor(() =>
    expect(api.fetchGitRemote).toHaveBeenCalledWith(
      "p1",
      "origin",
      "ssh://known/repo",
      "v2",
    ),
  );
});

it("does not fetch after the first remote read when a repository read error appears", async () => {
  let resolveRead!: (value: { name: string; url: string }[]) => void;
  vi.mocked(api.readGitRemotes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  await render();
  await act(async () => button("Fetch", container).click());

  git = {
    ...git,
    error: {
      message: "Lecture Git impossible",
      uncertain: false,
      source: "read",
    },
  };
  await render();
  expect(button("Fetch", container).disabled).toBe(true);
  await act(async () =>
    resolveRead([{ name: "origin", url: "ssh://known/repo" }]),
  );

  expect(api.fetchGitRemote).not.toHaveBeenCalled();
  expect(git.mutate).not.toHaveBeenCalled();
});

it("keeps known remote actions available while revalidating, then blocks them on failure or busy", async () => {
  const cache = createGitReadCache({ now: () => 0 });
  let rejectRefresh!: (reason: Error) => void;
  vi.mocked(api.readGitRemotes)
    .mockResolvedValueOnce([{ name: "origin", url: "ssh://known/repo" }])
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );
  await render({ readCache: cache, readScope: "scope" });
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );

  await act(async () => button("Autres actions", container).click());
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(2));
  for (const action of [
    button("Fetch", container),
    button("Pull avec rebase", container),
  ]) {
    expect(action.disabled).toBe(false);
  }
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "ssh://known/repo",
    "v2",
  );

  git = { ...git, busy: true };
  await render({ readCache: cache, readScope: "scope" });
  for (const action of [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ]) {
    expect(action.disabled).toBe(true);
  }

  await act(async () => rejectRefresh(new Error("SSH unavailable")));
  git = { ...git, busy: false };
  await render({ readCache: cache, readScope: "scope" });
  for (const action of [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ]) {
    expect(action.disabled).toBe(true);
  }
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      key: "git-remotes:scope",
      message: "Lecture des dépôts distants Git impossible.",
      tone: "error",
    }),
  );
  expect(document.body.textContent).not.toContain("SSH unavailable");

  vi.mocked(api.readGitRemotes).mockResolvedValueOnce([
    { name: "origin", url: "ssh://origin" },
  ]);
  await act(async () =>
    getNotifications()
      .find(({ key }) => key === "git-remotes:scope")!
      .action!.onAction(),
  );
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );
  expect(getNotifications()).toEqual([]);
});

it("blocks unavailable, limited, read-error, and uncertain repositories but ignores ordinary mutation errors", async () => {
  await render();
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );

  git = {
    ...git,
    error: {
      message: "Ancienne erreur de push",
      uncertain: false,
      source: "mutation",
    },
  };
  await render();
  for (const action of [
    button("Fetch", container),
    button("Pull avec rebase", container),
  ])
    expect(action.disabled).toBe(false);
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledTimes(1);

  git = {
    ...git,
    error: {
      message: "Push refusé",
      uncertain: false,
      source: "mutation",
      readError: "Relecture Git impossible",
    },
  };
  await render();
  for (const action of [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ]) {
    expect(action.disabled).toBe(true);
  }

  git = {
    ...git,
    error: { message: "Push refusé", uncertain: false, source: "mutation" },
  };
  await render();
  for (const action of [
    button("Fetch", container),
    button("Pull avec rebase", container),
  ])
    expect(action.disabled).toBe(false);

  const cases: ReturnType<typeof useProjectGit>[] = [
    { ...git, repo: null },
    { ...git, repo: { ...repo, availability: "notRepository" } },
    { ...git, repo: { ...repo, availability: "bare" } },
    { ...git, repo: { ...repo, limited: true } },
    {
      ...git,
      error: {
        message: "Lecture Git impossible",
        uncertain: false,
        source: "read",
      },
    },
    {
      ...git,
      error: {
        message: "Résultat inconnu",
        uncertain: true,
        source: "mutation",
      },
    },
  ];
  for (const nextGit of cases) {
    git = nextGit;
    await render();
    for (const action of [
      button("Fetch", container),
      button("Pull", container),
      button("Push", container),
    ]) {
      expect(action.disabled).toBe(true);
    }
  }
});

it("forces a fresh remote read when the actions menu opens but not when it closes", async () => {
  const cache = createGitReadCache({ now: () => 0 });
  vi.mocked(api.readGitRemotes)
    .mockResolvedValueOnce([{ name: "origin", url: "ssh://old/repo" }])
    .mockResolvedValue([{ name: "origin", url: "ssh://fresh/repo" }]);
  await render({ readCache: cache, readScope: "scope" });
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );

  await act(async () => button("Autres actions", container).click());
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(2));
  expect(git.mutate).not.toHaveBeenCalled();
  expect(api.fetchGitRemote).not.toHaveBeenCalled();
  expect(api.pullGitRemote).not.toHaveBeenCalled();
  expect(api.pushGitRemote).not.toHaveBeenCalled();

  await act(async () => button("Autres actions", container).click());
  expect(api.readGitRemotes).toHaveBeenCalledTimes(2);
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "ssh://fresh/repo",
    "v2",
  );
});

it("requires a user choice without a default and refuses ambiguous remotes", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "backup", url: "ssh://backup" },
    { name: "mirror", url: "ssh://mirror", ambiguous: true },
  ]);
  git = { ...git, repo: { ...repo, upstream: null } };
  await render();
  for (const action of [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ]) {
    expect(action.disabled).toBe(true);
  }
  await act(async () => button("mirror", container).click());
  const fullReason =
    "Ce remote possède plusieurs URL configurées. Les actions réseau sont désactivées ; corrigez sa configuration avec Git hors de Soreno.";
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({ message: fullReason, tone: "warning" }),
  );
  const actions = [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ];
  for (const action of actions) {
    expect(action.disabled).toBe(true);
  }
  await act(async () => actions.forEach((action) => action.click()));
  expect(api.fetchGitRemote).not.toHaveBeenCalled();
  expect(api.pullGitRemote).not.toHaveBeenCalled();
  expect(api.pushGitRemote).not.toHaveBeenCalled();
});

it("announces the selected remote and fetches the second remote URL", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    {
      name: "origin",
      url: "ssh://fetch/repo",
      pushUrl: "ssh://push/repo",
      ambiguous: false,
    },
    { name: "backup", url: "ssh://backup/repo", ambiguous: false },
  ]);
  await render();
  const choices = await vi.waitFor(() => {
    const items = container.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    expect(items).toHaveLength(2);
    return items;
  });
  expect(choices[0].getAttribute("aria-checked")).toBe("true");
  expect(choices[1].getAttribute("aria-checked")).toBe("false");
  await act(async () => choices[1].click());
  expect(choices[0].getAttribute("aria-checked")).toBe("false");
  expect(choices[1].getAttribute("aria-checked")).toBe("true");
  expect(button("Push", container).disabled).toBe(false);
  expect(button("Pull", container).disabled).toBe(true);
  expect(button("Pull avec rebase", container).disabled).toBe(true);
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledWith(
    "p1",
    "backup",
    "ssh://backup/repo",
    "v2",
  );
});

it("fetches and fast-forward pulls directly with the tracked destination", async () => {
  git = { ...git, repo: { ...repo, ahead: 0, behind: 1 } };
  await render();
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );
  await act(async () => button("Fetch", container).click());
  expect(api.fetchGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "ssh://fetch/repo",
    "v2",
  );

  await act(async () => button("Pull", container).click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.pullGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "ssh://fetch/repo",
    "v2",
    false,
  );
  expect(api.pushGitRemote).not.toHaveBeenCalled();
});

it("keeps push available without upstream while pull explains the missing upstream", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "origin", url: "ssh://fetch/repo" },
  ]);
  git = { ...git, repo: { ...repo, upstream: null } };
  await render();
  expect(button("Push", container).disabled).toBe(false);
  expect(button("Pull", container).disabled).toBe(true);
  expect(button("Pull", container).title).toBe(
    "Publiez la branche avec Push ou configurez sa branche amont avant un pull.",
  );
  await act(async () => button("Push", container).click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.pushGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "main",
    "ssh://fetch/repo",
    "v2",
  );
});

it("does not pull with rebase when the mutation gate is already locked", async () => {
  await render();
  vi.mocked(git.isBusy).mockReturnValue(true);
  await act(async () => button("Pull avec rebase", container).click());
  expect(git.mutate).not.toHaveBeenCalled();
  expect(api.pullGitRemote).not.toHaveBeenCalled();
});

it("pulls with the current remote URL and repository version", async () => {
  git = { ...git, repo: { ...repo, ahead: 0, behind: 1 } };
  await render();
  await vi.waitFor(() =>
    expect(button("Pull", container).disabled).toBe(false),
  );
  git = {
    ...git,
    repo: { ...repo, version: "v3", ahead: 0, behind: 1 },
  };
  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "origin", url: "ssh://fresh/repo" },
  ]);
  await render();
  await act(async () => button("Autres actions", container).click());
  await vi.waitFor(() => expect(api.readGitRemotes).toHaveBeenCalledTimes(2));
  await act(async () => button("Pull", container).click());
  expect(api.pullGitRemote).toHaveBeenCalledWith(
    "p1",
    "origin",
    "ssh://fresh/repo",
    "v3",
    false,
  );
});

it("allows dirty fast-forward pulls but blocks dirty rebases and conflicts", async () => {
  const dirty = {
    path: "dirty",
    oldPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  const untracked = { ...dirty, path: "new", worktreeStatus: "?" };
  git = {
    ...git,
    repo: { ...repo, ahead: 0, behind: 2, files: [dirty, untracked] },
  };
  await render();
  await vi.waitFor(() =>
    expect(button("Pull", container).disabled).toBe(false),
  );

  git = { ...git, repo: { ...repo, files: [dirty] } };
  await render();
  const rebase = button("Pull avec rebase", container);
  expect(rebase.disabled).toBe(true);

  git = {
    ...git,
    repo: {
      ...repo,
      ahead: 0,
      behind: 1,
      files: [{ ...dirty, conflict: true }],
    },
  };
  await render();
  const pull = button("Pull", container);
  expect(pull.disabled).toBe(true);
});

it("blocks every network action during a Git operation", async () => {
  git = {
    ...git,
    repo: { ...repo, operation: "merge" },
    error: { message: "Ancienne erreur", uncertain: false, source: "mutation" },
  };
  await render();
  for (const action of [
    button("Fetch", container),
    button("Pull", container),
    button("Push", container),
  ]) {
    expect(action.disabled).toBe(true);
  }
});

it("explains disabled pull and push without a branch or HEAD in tooltips only", async () => {
  git = { ...git, repo: { ...repo, branch: null } };
  await render();
  await vi.waitFor(() => expect(button("Push", container).disabled).toBe(true));
  let push = button("Push", container);
  let pull = button("Pull", container);
  expect(push.title).toBe("Passez sur une branche avant un push.");
  expect(pull.title).toBe("Passez sur une branche avant un pull.");
  expect(container.textContent).not.toContain("Passez sur une branche");
  await act(async () => push.click());

  git = { ...git, repo: { ...repo, head: null } };
  await render();
  push = button("Push", container);
  pull = button("Pull", container);
  for (const action of [push, pull]) {
    expect(action.disabled).toBe(true);
  }
  await act(async () => push.click());
  await act(async () => pull.click());

  expect(api.pushGitRemote).not.toHaveBeenCalled();
  expect(api.pullGitRemote).not.toHaveBeenCalled();
});

it("offers no remote configuration and blocks network actions when no remote exists", async () => {
  vi.mocked(api.readGitRemotes).mockResolvedValue([]);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Aucun remote"),
  );
  expect(maybeButton("Fetch", container)).toBeUndefined();
  for (const action of [button("Pull", container), button("Push", container)]) {
    expect(action.disabled).toBe(true);
  }
  expect(container.textContent).not.toMatch(/Ajouter|Configurer|Modifier/);

  vi.mocked(api.readGitRemotes).mockResolvedValue([
    { name: "origin", url: "ssh://fetch/repo" },
  ]);
  await render({ projectId: "p2" });
  await vi.waitFor(() =>
    expect(button("Fetch", container).disabled).toBe(false),
  );
  expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  expect(container.textContent).not.toMatch(/Ajouter|Configurer|Modifier/);
});
