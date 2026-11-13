// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as agentApi from "../../data/agentSessionsApi";
import * as forgeApi from "../../data/forgeApi";
import * as api from "../../data/projectGitApi";
import type {
  AgentProject,
  AgentSessionMessage,
} from "../../domain/agentSessions";
import type { DiffLineSelection } from "../../domain/diffLineComment";
import type { ForgeRequestDetail } from "../../domain/forge";
import type {
  GitComparison,
  GitFile,
  GitMutationResult,
  GitRepository,
} from "../../domain/projectGit";
import { clearNotifications, getNotifications } from "../../notifications";
import { useGitFilesRatioPreference } from "./GitChangesWorkspace";
import { agentStringsForLocale } from "./agentStrings";
import { ProjectGroupPanel } from "./ProjectGroupPanel";
import { setInputValue } from "../ui/testInput";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { materialFileIconsEnabled: false } }),
}));
vi.mock("../../data/projectGitApi", () => ({
  readGitRepository: vi.fn(),
  readGitComparison: vi.fn(),
  stageGitFiles: vi.fn(),
  unstageGitFiles: vi.fn(),
  restoreGitFiles: vi.fn(),
  resolveGitFiles: vi.fn(),
  quickCommitGitChanges: vi.fn(),
}));
vi.mock("../../data/agentSessionsApi", () => ({
  sendAgentSessionMessage: vi.fn(),
  listAgentSessionMessages: vi.fn(async () => []),
  listenAgentSessionMessages: vi.fn(async () => () => {}),
}));
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
vi.mock("./GitDiffView", () => ({
  default: ({
    comparison,
    toolbarActions,
    lineComments,
    footer,
  }: {
    comparison: { path: string };
    toolbarActions?: ReactNode;
    lineComments?: {
      side: DiffLineSelection["side"];
      onComment: (selection: DiffLineSelection) => void;
    };
    footer?: ReactNode;
  }) => (
    <>
      <p data-diff="">{comparison.path}</p>
      {toolbarActions}
      {lineComments ? (
        <button
          onClick={() =>
            lineComments.onComment({
              path: comparison.path,
              side: lineComments.side,
              version: "after",
              fromLine: 1,
              toLine: 1,
              text: "changed();",
            })
          }
        >
          Select line 1
        </button>
      ) : null}
      {footer}
    </>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const member = (id: string, name: string): AgentProject => ({
  id,
  name,
  path: `/srv/${id}`,
  environment: { kind: "local", distribution: null },
});
const file = (path: string, indexStatus: string, worktreeStatus: string) =>
  ({
    path,
    oldPath: null,
    indexStatus,
    worktreeStatus,
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 2,
    deleted: 1,
  }) satisfies GitFile;
const repository = (overrides: Partial<GitRepository>): GitRepository => ({
  availability: "ready",
  identity: null,
  version: "v1",
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
  ...overrides,
});

let root: Root;
let host: HTMLDivElement;
const onSelectProject = vi.fn();
const onClose = vi.fn();
const getButton = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

function RatioConsumer() {
  const [ratio, setRatio] = useGitFilesRatioPreference(28, 15, 80);
  return (
    <button aria-label="ratio consumer" onClick={() => setRatio(ratio + 2)}>
      {ratio}
    </button>
  );
}

beforeEach(() => {
  clearNotifications();
  localStorage.removeItem("soreno:git-file-tree");
  localStorage.removeItem("soreno:git-files-ratio");
  localStorage.removeItem("soreno:git-files-visible");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(forgeApi.readForgeRemote).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    projectId === "api"
      ? repository({
          branch: "feature",
          ahead: 2,
          files: [
            file("src/a.ts", ".", "M"),
            file("b.ts", "A", "."),
            file("src/new.ts", "?", "?"),
          ],
        })
      : repository({ availability: "notRepository" }),
  );
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_, path, _side, version) => ({
      path,
      oldPath: null,
      version: version ?? "v1",
      before: {} as never,
      after: {} as never,
    }),
  );
  const mutationResult = {
    oid: null,
    message: "Done",
    warning: null,
  };
  vi.mocked(api.stageGitFiles).mockResolvedValue(mutationResult);
  vi.mocked(api.unstageGitFiles).mockResolvedValue(mutationResult);
  vi.mocked(api.restoreGitFiles).mockResolvedValue(mutationResult);
  vi.mocked(api.resolveGitFiles).mockResolvedValue(mutationResult);
  vi.mocked(api.quickCommitGitChanges).mockResolvedValue({
    oid: "abc123",
    message: "Committed",
    warning: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function render(
  members = [
    member("api", "API"),
    member("docs", "Docs"),
    member("www", "Site"),
  ],
  working = [{ id: "s1", projectId: "api" }],
  disconnectedProjectIds = ["www"],
) {
  await act(async () => {
    root.render(
      <ProjectGroupPanel
        groupName="Jinka"
        members={members}
        disconnectedProjectIds={disconnectedProjectIds}
        workingSessions={working}
        visible
        onClose={onClose}
        onSelectProject={onSelectProject}
      />,
    );
  });
}

it("shows Changes and only members with changes", async () => {
  await render();

  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(api.readGitRepository).not.toHaveBeenCalledWith("www");
  const text = host.textContent ?? "";
  expect(text).toContain("Changements");
  expect(text).toContain("Jinka");
  expect(text).toContain("feature");
  expect(text).toContain("feature↑2");
  expect(text).not.toContain("↓0");
  expect(text).toContain("1 préparé · 1 modifié · 1 non suivi");
  expect(text).toContain("1 agent actif");
  expect(text).not.toContain("Docs");
  expect(text).not.toContain("Site");
});

it("lists the members' merge requests together and acts on each one's project", async () => {
  const mr = (projectId: string, number: number, createdAt: string) =>
    ({
      number,
      title: `${projectId} change`,
      author: "ada",
      sourceBranch: "feature",
      targetBranch: "main",
      crossRepository: false,
      draft: false,
      state: "open",
      checks: null,
      review: null,
      conflicts: false,
      createdAt,
      url: `https://gitlab.com/jinka/${projectId}/-/merge_requests/${number}`,
      body: "",
      headOid: `head-${projectId}`,
      baseOid: "base",
      reviewers: [],
      labels: [],
      checkRuns: [],
      commits: [],
      mergeBlockers: [],
      mergeMethods: ["merge"],
      deleteSourceBranch: false,
      changedFiles: 0,
      repository: `gitlab.com/jinka/${projectId}`,
    }) satisfies ForgeRequestDetail;
  const requests: Record<string, ForgeRequestDetail> = {
    api: mr("api", 7, "2026-11-10T00:00:00Z"),
    www: mr("www", 3, "2026-11-11T00:00:00Z"),
  };
  const noRemote = { code: "noRemote", message: "Pas de dépôt distant." };
  vi.mocked(forgeApi.readForgeRemote).mockImplementation(async (projectId) => {
    if (projectId === "docs") throw noRemote;
    return {
      kind: "gitlab",
      host: "gitlab.com",
      path: `jinka/${projectId}`,
      remote: "origin",
      webUrl: `https://gitlab.com/jinka/${projectId}`,
    };
  });
  vi.mocked(forgeApi.readForgeRequests).mockImplementation(
    async (projectId) => {
      if (projectId === "docs") throw noRemote;
      return [requests[projectId]];
    },
  );
  vi.mocked(forgeApi.readForgeRequest).mockImplementation(
    async (projectId) => requests[projectId],
  );
  vi.mocked(forgeApi.mergeForgeRequest).mockResolvedValue(null);
  await render(undefined, [], []);

  // Named after the members' forge before it is opened.
  const tab = await vi.waitFor(() => {
    const found = [
      ...host.querySelectorAll<HTMLButtonElement>(".git-panel-view-tab"),
    ].find((item) => item.textContent === "Merge requests");
    expect(found).toBeDefined();
    return found!;
  });
  await act(async () => tab.click());

  const rows = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".git-forge-row")].map((row) =>
      row.getAttribute("aria-label")!.split("\n").slice(0, 2),
    );
  await vi.waitFor(() =>
    expect(rows()).toEqual([
      ["www change #3", "Site · ada · feature → main"],
      ["api change #7", "API · ada · feature → main"],
    ]),
  );
  // A member without a forge remote has nothing to list, not an error.
  expect(getNotifications()).toEqual([]);
  await vi.waitFor(() =>
    expect(forgeApi.readForgeRequest).toHaveBeenCalledWith("www", 3),
  );

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('.git-forge-row[aria-label^="api"]')!
      .click(),
  );
  const merge = () =>
    [
      ...host.querySelectorAll<HTMLButtonElement>(".git-forge-actions button"),
    ].find((item) => item.textContent === "Merger")!;
  await vi.waitFor(() => {
    expect(host.textContent).toContain("api change");
    expect(merge().disabled).toBe(false);
  });
  await act(async () => merge().click());
  const confirmation = document.querySelector<HTMLElement>(
    '[role="alertdialog"]',
  )!;
  await act(async () =>
    [...confirmation.querySelectorAll("button")]
      .find((item) => item.textContent === "Merger")!
      .click(),
  );
  expect(forgeApi.mergeForgeRequest).toHaveBeenCalledExactlyOnceWith(
    "api",
    "gitlab.com/jinka/api",
    7,
    "merge",
    "head-api",
  );
});

it("closes, hides files and persists the tree layout", async () => {
  await render();

  const files = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Masquer les fichiers"]',
  )!;
  const close = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Fermer les outils du projet"]',
  )!;
  await act(async () => close.click());
  expect(onClose).toHaveBeenCalledOnce();

  await act(async () => files.click());
  expect(
    host.querySelector(".git-review-sidebar")?.hasAttribute("hidden"),
  ).toBe(true);
  await act(async () => getButton("Afficher les fichiers").click());

  await act(async () => getButton("Afficher en arborescence").click());
  expect(
    host.querySelector('.git-tree-directory summary[title="src"]'),
  ).not.toBeNull();
  expect(localStorage.getItem("soreno:git-file-tree")).toBe("true");

  act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(
    host.querySelector('.git-tree-directory summary[title="src"]'),
  ).not.toBeNull();
});

it("shows global totals and stages every changed project", async () => {
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    repository({
      version: `v-${projectId}`,
      files: [file(`${projectId}.ts`, ".", "M")],
    }),
  );
  await render([member("api", "API"), member("docs", "Docs")], []);

  expect(
    host.querySelector(".project-group-changes-summary")?.textContent,
  ).toContain("Changements 2+4−2");
  const stageAll = getButton("Tout préparer · Jinka");
  await act(async () => stageAll.click());

  expect(api.stageGitFiles).toHaveBeenCalledTimes(2);
  expect(api.stageGitFiles).toHaveBeenCalledWith("api", ["api.ts"], "v-api");
  expect(api.stageGitFiles).toHaveBeenCalledWith("docs", ["docs.ts"], "v-docs");
});

it("ignores focus refreshes and keeps Stage blocked until the post-mutation refresh completes", async () => {
  let resolveRefresh!: (repo: GitRepository) => void;
  vi.mocked(api.readGitRepository)
    .mockResolvedValueOnce(
      repository({
        version: "before-stage",
        files: [file("before.ts", ".", "M")],
      }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
  await render([member("mutation-refresh", "Mutation refresh")], [], []);

  const stageAll = getButton("Tout préparer · Jinka");
  await act(async () => {
    stageAll.click();
    await Promise.resolve();
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(stageAll.disabled).toBe(true);

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(stageAll.disabled).toBe(true);

  await act(async () =>
    resolveRefresh(
      repository({
        version: "after-stage",
        files: [file("after.ts", ".", "M")],
      }),
    ),
  );
  expect(stageAll.disabled).toBe(false);
  expect(api.stageGitFiles).toHaveBeenCalledWith(
    "mutation-refresh",
    ["before.ts"],
    "before-stage",
  );
});

it("corrects a diff that advances during a partial post-mutation refresh", async () => {
  const readCounts = new Map<string, number>();
  let resolvePostMutationB!: (repo: GitRepository) => void;
  vi.mocked(api.readGitRepository).mockImplementation((projectId) => {
    const count = (readCounts.get(projectId) ?? 0) + 1;
    readCounts.set(projectId, count);
    if (count === 1)
      return Promise.resolve(
        repository({
          version: `${projectId}-v1`,
          files: projectId === "a" ? [file("a.ts", ".", "M")] : [],
        }),
      );
    if (count === 2)
      return projectId === "a"
        ? Promise.resolve(
            repository({ version: "a-v2", files: [file("a.ts", ".", "M")] }),
          )
        : new Promise((resolve) => {
            resolvePostMutationB = resolve;
          });
    return Promise.resolve(
      repository({
        version: `${projectId}-v3`,
        files: projectId === "a" ? [file("a.ts", ".", "M")] : [],
      }),
    );
  });
  let resolveAheadDiff!: (comparison: GitComparison) => void;
  let resolveCurrentDiff!: (comparison: GitComparison) => void;
  vi.mocked(api.readGitComparison).mockImplementation(
    (_projectId, path, _side, version) => {
      if (version === "a-v2")
        return new Promise((resolve) => {
          resolveAheadDiff = resolve;
        });
      if (version === "a-v3")
        return new Promise((resolve) => {
          resolveCurrentDiff = resolve;
        });
      return Promise.resolve({
        path,
        oldPath: null,
        version: version ?? "",
        before: {} as never,
        after: {} as never,
      });
    },
  );
  await render([member("a", "A"), member("b", "B")], [], []);

  await act(async () => {
    getButton("Préparer · a.ts").click();
    await Promise.resolve();
  });
  await vi.waitFor(() =>
    expect(api.readGitComparison).toHaveBeenCalledWith(
      "a",
      "a.ts",
      "unstaged",
      "a-v2",
    ),
  );
  await act(async () =>
    resolveAheadDiff({
      path: "a.ts",
      oldPath: null,
      version: "a-v3",
      before: {} as never,
      after: {} as never,
    }),
  );
  expect(api.readGitRepository).toHaveBeenCalledTimes(4);

  await act(async () =>
    resolvePostMutationB(repository({ version: "b-v2", files: [] })),
  );
  await vi.waitFor(() =>
    expect(api.readGitComparison).toHaveBeenCalledWith(
      "a",
      "a.ts",
      "unstaged",
      "a-v3",
    ),
  );
  expect(api.readGitRepository).toHaveBeenCalledTimes(6);
  expect(getButton("Préparer · a.ts").disabled).toBe(false);

  await act(async () =>
    resolveCurrentDiff({
      path: "a.ts",
      oldPath: null,
      version: "a-v3",
      before: {} as never,
      after: {} as never,
    }),
  );
  expect(getButton("Préparer · a.ts").disabled).toBe(false);
});

it("retries the post-mutation refresh when a member disconnects", async () => {
  const readCounts = new Map<string, number>();
  let resolveOldA!: (repo: GitRepository) => void;
  let resolveOldB!: (repo: GitRepository) => void;
  let resolveCurrentA!: (repo: GitRepository) => void;
  vi.mocked(api.readGitRepository).mockImplementation((projectId) => {
    const count = (readCounts.get(projectId) ?? 0) + 1;
    readCounts.set(projectId, count);
    if (count === 1)
      return Promise.resolve(
        repository({
          version: `${projectId}-before`,
          files: projectId === "a" ? [file("a.ts", ".", "M")] : [],
        }),
      );
    return new Promise((resolve) => {
      if (projectId === "a" && count === 2) resolveOldA = resolve;
      else if (projectId === "b") resolveOldB = resolve;
      else resolveCurrentA = resolve;
    });
  });
  const members = [member("a", "A"), member("b", "B")];
  await render(members, [], []);

  const stage = getButton("Préparer · a.ts");
  await act(async () => {
    stage.click();
    await Promise.resolve();
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(4);

  await render(members, [], ["b"]);
  expect(stage.disabled).toBe(true);

  await act(async () => {
    resolveOldA(repository({ version: "a-old", files: [] }));
    resolveOldB(repository({ version: "b-old", files: [] }));
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(5);
  expect(stage.disabled).toBe(true);

  await act(async () =>
    resolveCurrentA(
      repository({
        version: "a-current",
        files: [file("a.ts", ".", "M")],
      }),
    ),
  );
  expect(getButton("Préparer · a.ts").disabled).toBe(false);
  expect(api.stageGitFiles).toHaveBeenCalledWith("a", ["a.ts"], "a-before");
});

it("unstages an individual staged file with the shared row action", async () => {
  await render();

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Retirer · b.ts"]')!
      .click(),
  );
  expect(api.unstageGitFiles).toHaveBeenCalledWith("api", ["b.ts"], "v1");
});

it("confirms discarding a file before restoring it", async () => {
  await render();

  await act(async () =>
    getButton("Annuler les modifications… · src/a.ts").click(),
  );
  const dialog = document.body.querySelector<HTMLElement>(
    ".confirmation-dialog",
  )!;
  expect(dialog.textContent).toContain("src/a.ts");
  await act(async () =>
    dialog
      .querySelector<HTMLButtonElement>(".confirmation-dialog-confirm")!
      .click(),
  );
  expect(api.restoreGitFiles).toHaveBeenCalledWith("api", ["src/a.ts"], "v1");
});

it("blocks an open restore confirmation when its project disconnects", async () => {
  const members = [member("api", "API")];
  await render(members, [], []);

  await act(async () =>
    getButton("Annuler les modifications… · src/a.ts").click(),
  );
  const confirm = document.body.querySelector<HTMLButtonElement>(
    ".confirmation-dialog-confirm",
  )!;

  await render(members, [], ["api"]);
  expect(confirm.disabled).toBe(true);
  await act(async () => confirm.click());
  expect(api.restoreGitFiles).not.toHaveBeenCalled();
});

it.each(["removed", "scope changed"])(
  "invalidates an open restore confirmation when its member is %s",
  async (change) => {
    const original = member("api", "API");
    await render([original], [], []);
    await act(async () =>
      getButton("Annuler les modifications… · src/a.ts").click(),
    );
    const confirm = document.body.querySelector<HTMLButtonElement>(
      ".confirmation-dialog-confirm",
    )!;

    await render(
      change === "removed" ? [] : [{ ...original, path: "/srv/replacement" }],
      [],
      [],
    );
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(api.restoreGitFiles).not.toHaveBeenCalled();
  },
);

it("refuses restore and resolve actions for submodules", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({
      files: [
        { ...file("vendor", ".", "M"), submodule: true },
        {
          ...file("nested", "U", "U"),
          conflict: true,
          mode: "160000",
        },
      ],
    }),
  );
  await render([member("modules", "Modules")], []);

  expect(
    host.querySelector<HTMLButtonElement>(
      'button[aria-label="Annuler les modifications… · vendor"]',
    )?.disabled,
  ).toBe(true);
  expect(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Marquer résolu…",
    )?.disabled,
  ).toBe(true);
  expect(api.restoreGitFiles).not.toHaveBeenCalled();
  expect(api.resolveGitFiles).not.toHaveBeenCalled();
});

it("confirms resolving a conflicted file", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({
      operation: "merge",
      files: [
        {
          ...file("conflict.ts", "U", "U"),
          conflict: true,
        },
      ],
    }),
  );
  await render([member("conflict", "Conflict")], []);

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Marquer résolu…")!
      .click(),
  );
  const dialog = document.body.querySelector<HTMLElement>(
    ".confirmation-dialog",
  )!;
  expect(dialog.textContent).toContain("conflict.ts");
  await act(async () =>
    dialog
      .querySelector<HTMLButtonElement>(".confirmation-dialog-confirm")!
      .click(),
  );
  expect(api.resolveGitFiles).toHaveBeenCalledWith(
    "conflict",
    ["conflict.ts"],
    "v1",
    false,
  );
});

it("detects conflict markers from the displayed snapshot", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({
      operation: "merge",
      files: [{ ...file("conflict.ts", "U", "U"), conflict: true }],
    }),
  );
  vi.mocked(api.readGitComparison).mockResolvedValue({
    path: "conflict.ts",
    oldPath: null,
    version: "v1",
    before: {} as never,
    after: { text: "<<<<<<< ours\n=======\n>>>>>>> theirs\n" } as never,
  });
  await render([member("conflict-markers", "Conflict markers")], []);

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Marquer résolu…")!
      .click(),
  );
  const dialog = document.body.querySelector<HTMLElement>(
    ".confirmation-dialog",
  )!;
  await act(async () =>
    dialog
      .querySelector<HTMLButtonElement>(".confirmation-dialog-confirm")!
      .click(),
  );
  expect(api.resolveGitFiles).toHaveBeenCalledWith(
    "conflict-markers",
    ["conflict.ts"],
    "v1",
    true,
  );
});

it("blocks selected-project actions while its displayed diff is stale", async () => {
  const conflict = {
    ...file("stale-conflict.ts", "U", "U"),
    conflict: true,
  };
  vi.mocked(api.readGitRepository)
    .mockResolvedValueOnce(
      repository({ version: "v1", operation: "merge", files: [conflict] }),
    )
    .mockResolvedValueOnce(
      repository({ version: "v2", operation: "merge", files: [conflict] }),
    );
  let resolveFreshDiff!: (comparison: GitComparison) => void;
  vi.mocked(api.readGitComparison)
    .mockResolvedValueOnce({
      path: "stale-conflict.ts",
      oldPath: null,
      version: "v1",
      before: {} as never,
      after: { text: "<<<<<<< old\n" } as never,
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFreshDiff = resolve;
        }),
    );
  const members = [member("stale", "Stale")];
  await render(members, [{ id: "turn", projectId: "stale" }], []);

  await render(members, [], []);
  const resolve = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Marquer résolu…",
  )!;
  expect(resolve.disabled).toBe(true);
  await act(async () => resolve.click());
  expect(document.body.querySelector(".confirmation-dialog")).toBeNull();

  await act(async () =>
    resolveFreshDiff({
      path: "stale-conflict.ts",
      oldPath: null,
      version: "v2",
      before: {} as never,
      after: { text: "resolved\n" } as never,
    }),
  );
});

it("keeps actions blocked and rereads status when a completed diff has another version", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({
      version: "status-v1",
      files: [file("ahead.ts", ".", "M")],
    }),
  );
  vi.mocked(api.readGitComparison).mockResolvedValue({
    path: "ahead.ts",
    oldPath: null,
    version: "diff-v2",
    before: {} as never,
    after: {} as never,
  });
  await render([member("diff-ahead", "Diff ahead")], [], []);

  await vi.waitFor(() =>
    expect(api.readGitRepository).toHaveBeenCalledTimes(2),
  );
  expect(
    host.querySelector<HTMLButtonElement>(
      'button[aria-label="Préparer · ahead.ts"]',
    )?.disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>(
      'button[aria-label="Annuler les modifications… · ahead.ts"]',
    )?.disabled,
  ).toBe(true);
});

it("runs project mutations sequentially and continues after failure", async () => {
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    repository({
      version: `v-${projectId}`,
      files: [file(`${projectId}.ts`, ".", "M")],
    }),
  );
  let rejectFirst!: (reason: unknown) => void;
  let resolveSecond!: (result: GitMutationResult) => void;
  vi.mocked(api.stageGitFiles).mockImplementation(
    (projectId) =>
      new Promise((resolve, reject) => {
        if (projectId === "api") rejectFirst = reject;
        else resolveSecond = resolve;
      }),
  );
  await render([member("api", "API"), member("docs", "Docs")], []);

  const stageAll = getButton("Tout préparer · Jinka");
  act(() => stageAll.click());

  expect(api.stageGitFiles).toHaveBeenCalledTimes(1);
  expect(api.stageGitFiles).toHaveBeenCalledWith("api", ["api.ts"], "v-api");
  await act(async () => {
    rejectFirst({
      code: "dirty",
      message: "private backend detail",
      uncertain: true,
    });
    await Promise.resolve();
  });
  expect(api.stageGitFiles).toHaveBeenCalledTimes(2);
  expect(api.stageGitFiles).toHaveBeenLastCalledWith(
    "docs",
    ["docs.ts"],
    "v-docs",
  );
  await act(async () =>
    resolveSecond({ oid: null, message: "Staged", warning: null }),
  );

  const failure = getNotifications().find((item) =>
    item.key.includes("group-git:stage:api"),
  );
  expect(failure?.message).toContain("API");
  expect(failure?.message).toContain(
    agentStringsForLocale("fr-FR").operationDirtyRepository,
  );
  expect(failure?.message).toContain(
    "Le résultat est incertain. Vérifiez le dépôt avant de réessayer.",
  );
  expect(failure?.message).not.toContain("private backend detail");
  act(() => failure?.action?.onAction());
  expect(onSelectProject).toHaveBeenCalledWith("api");
});

it("notifies the executed prefix before stopping an invalidated mutation batch", async () => {
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    repository({
      version: `v-${projectId}`,
      files: [file(`${projectId}.ts`, ".", "M")],
    }),
  );
  let rejectFirst!: (reason: unknown) => void;
  vi.mocked(api.stageGitFiles).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectFirst = reject;
      }),
  );
  const members = [member("api", "API"), member("docs", "Docs")];
  await render(members, [], []);

  const stageAll = getButton("Tout préparer · Jinka");
  act(() => stageAll.click());
  expect(api.stageGitFiles).toHaveBeenCalledOnce();

  await render(members, [], ["docs"]);
  await act(async () =>
    rejectFirst({
      code: "dirty",
      message: "private backend detail",
      uncertain: true,
    }),
  );

  expect(api.stageGitFiles).toHaveBeenCalledOnce();
  const failure = getNotifications().find((item) =>
    item.key.includes("group-git:stage:api"),
  );
  expect(failure?.message).toContain("API");
  expect(failure?.message).toContain(
    agentStringsForLocale("fr-FR").operationDirtyRepository,
  );
  expect(failure?.message).toContain(
    "Le résultat est incertain. Vérifiez le dépôt avant de réessayer.",
  );
});

it("auto commits each changed project with its own unstaged paths", async () => {
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    repository({
      version: `v-${projectId}`,
      files:
        projectId === "api"
          ? [file("api.ts", ".", "M"), file("staged.ts", "A", ".")]
          : [file("docs.ts", "A", ".")],
    }),
  );
  await render([member("api", "API"), member("docs", "Docs")], []);

  await act(async () => getButton("Commit · Jinka").click());

  await vi.waitFor(() =>
    expect(api.quickCommitGitChanges).toHaveBeenCalledTimes(2),
  );
  expect(api.quickCommitGitChanges).toHaveBeenCalledWith(
    "api",
    ["api.ts"],
    "v-api",
  );
  expect(api.quickCommitGitChanges).toHaveBeenCalledWith("docs", [], "v-docs");
});

it("does not count a partially staged file twice", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({ files: [file("partial.ts", "M", "M")] }),
  );
  await render([member("partial", "Partial")], []);

  expect(
    host.querySelector(".project-group-changes-summary")?.textContent,
  ).toContain("Changements 2+2−1");
  const staged = host.querySelector<HTMLButtonElement>(
    'button[aria-label^="Partial · partial.ts · préparé"]',
  )!;
  await act(async () => staged.click());
  expect(host.querySelector(".git-diff-side")?.textContent).toBe("Préparés");
});

it("shows a repository read error instead of a clean state", async () => {
  vi.mocked(api.readGitRepository).mockRejectedValue(
    new Error("private backend detail"),
  );
  await render([member("broken", "Broken")], []);

  expect(host.textContent).toContain("Broken");
  expect(host.textContent).toContain("L’opération a échoué. Réessayez.");
  expect(host.textContent).not.toContain("private backend detail");
  expect(host.textContent).not.toContain("Aucun changement");
  expect(api.stageGitFiles).not.toHaveBeenCalled();
});

it("hides a clean project", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(repository({}));
  await render([member("clean", "Clean")], []);

  expect(host.textContent).toContain("Aucun changement.");
  expect(host.textContent).not.toContain("Clean");
  expect(host.querySelector(".project-group-changes-summary")).toBeNull();
});

it("shares resizing and file navigation with the project view", async () => {
  await render();
  const consumerHost = document.createElement("div");
  document.body.append(consumerHost);
  const consumerRoot = createRoot(consumerHost);
  await act(async () => consumerRoot.render(<RatioConsumer />));

  expect(host.querySelector("[data-diff]")?.textContent).toBe("src/a.ts");
  const vertical = host.querySelector<HTMLElement>(
    '[role="separator"][aria-orientation="vertical"]',
  )!;
  const consumer = consumerHost.querySelector<HTMLButtonElement>(
    'button[aria-label="ratio consumer"]',
  )!;
  expect(vertical.getAttribute("aria-valuenow")).toBe("40");
  expect(consumer.textContent).toBe("28");
  await act(async () =>
    vertical.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  expect(vertical.getAttribute("aria-valuenow")).toBe("42");
  expect(consumer.textContent).toBe("42");
  expect(localStorage.getItem("soreno:git-files-ratio")).toBe("42");
  await act(async () => consumer.click());
  expect(vertical.getAttribute("aria-valuenow")).toBe("44");
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "soreno:git-files-ratio",
        newValue: "120",
      }),
    ),
  );
  expect(vertical.getAttribute("aria-valuenow")).toBe("80");
  expect(consumer.textContent).toBe("80");

  const previous = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Fichier précédent"]',
  )!;
  const next = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Fichier suivant"]',
  )!;
  expect(previous.disabled).toBe(true);
  await act(async () => next.click());
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "api",
    "src/new.ts",
    "unstaged",
    "v1",
  );
  expect(
    host.querySelector<HTMLButtonElement>(
      'button[aria-label="Fichier précédent"]',
    )?.disabled,
  ).toBe(false);

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'button[aria-label^="API · src/new.ts ·"]',
      )!
      .click(),
  );
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "api",
    "src/new.ts",
    "unstaged",
    "v1",
  );
  expect(host.querySelector("[data-diff]")?.textContent).toBe("src/new.ts");

  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Ouvrir API"]')!.click(),
  );
  expect(onSelectProject).toHaveBeenCalledWith("api");

  act(() => consumerRoot.unmount());
  consumerHost.remove();
});

it("keeps file navigation focused while a new diff is pending", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({
      version: "focus-v1",
      files: [file("first.ts", ".", "M"), file("second.ts", ".", "M")],
    }),
  );
  let resolveDiff!: (comparison: GitComparison) => void;
  vi.mocked(api.readGitComparison).mockImplementation((_, path) =>
    path === "second.ts"
      ? new Promise((resolve) => {
          resolveDiff = resolve;
        })
      : Promise.resolve({
          path,
          oldPath: null,
          version: "focus-v1",
          before: {} as never,
          after: {} as never,
        }),
  );
  await render([member("focus", "Focus")], []);

  const next = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Fichier suivant"]',
  )!;
  await act(async () => {
    next.focus();
    next.click();
  });
  expect(document.activeElement).toBe(next);
  expect(host.querySelector('button[aria-label="Fichier suivant"]')).toBe(next);
  expect(
    host.querySelector(".git-panel-centered-status")?.textContent,
  ).toContain("Lecture du diff…");
  expect(host.querySelector(".git-diff-content > [data-diff]")).toBeNull();

  await act(async () =>
    resolveDiff({
      path: "second.ts",
      oldPath: null,
      version: "focus-v1",
      before: {} as never,
      after: {} as never,
    }),
  );
  expect(document.activeElement).toBe(next);
  expect(host.querySelector('button[aria-label="Fichier suivant"]')).toBe(next);
  expect(host.querySelector("[data-diff]")?.textContent).toBe("second.ts");
});

it("keeps Commit and Stage active during cached background revalidation", async () => {
  let resolve!: (repo: GitRepository) => void;
  vi.mocked(api.readGitRepository).mockImplementation(
    () => new Promise((done) => (resolve = done)),
  );
  const members = [member("slow", "Slow")];
  await render(members);

  expect(host.textContent).toContain("Lecture des dépôts…");
  expect(host.textContent).not.toContain("Slow");
  await act(async () =>
    resolve(
      repository({
        branch: "slow-branch",
        files: [file("slow.ts", ".", "M")],
      }),
    ),
  );
  expect(host.textContent).toContain("slow-branch");

  act(() => root.unmount());
  root = createRoot(host);
  await render(members);
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("Lecture des dépôts…");
  expect(host.textContent).toContain("slow-branch");
  expect(getButton("Commit · Jinka").disabled).toBe(false);
  expect(getButton("Tout préparer · Jinka").disabled).toBe(false);
});

it("rereads repositories when an agent turn ends", async () => {
  await render();
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);

  await render(undefined, [{ id: "s1", projectId: "api" }]);
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  await render(undefined, []);
  expect(api.readGitRepository).toHaveBeenCalledTimes(4);
});

it("shows a known diff immediately after reopening the panel", async () => {
  await render();
  expect(host.querySelector("[data-diff]")?.textContent).toBe("src/a.ts");

  act(() => root.unmount());
  root = createRoot(host);
  vi.mocked(api.readGitComparison).mockImplementation(
    () => new Promise(() => {}),
  );
  await render();
  expect(host.querySelector("[data-diff]")?.textContent).toBe("src/a.ts");
  expect(host.textContent).not.toContain("Lecture du diff…");
});

it("rereads a constant id after its path and environment change and ignores the old response", async () => {
  let resolveOld!: (repo: GitRepository) => void;
  let resolveNew!: (repo: GitRepository) => void;
  vi.mocked(api.readGitRepository)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
  const original = member("moving", "Moving");
  await render([original], [], []);
  await render(
    [
      {
        ...original,
        path: "/srv/replacement",
        environment: { kind: "wsl", distribution: "Ubuntu" },
      },
    ],
    [],
    [],
  );
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);

  await act(async () =>
    resolveNew(
      repository({ branch: "new", files: [file("new.ts", ".", "M")] }),
    ),
  );
  expect(host.textContent).toContain("new");
  await act(async () =>
    resolveOld(
      repository({ branch: "old", files: [file("old.ts", ".", "M")] }),
    ),
  );
  expect(host.textContent).toContain("new");
  expect(host.textContent).not.toContain("old.ts");
});

it("does not publish or cache a late diff from a previous scope", async () => {
  vi.mocked(api.readGitRepository)
    .mockResolvedValueOnce(
      repository({ version: "old-v", files: [file("same.ts", ".", "M")] }),
    )
    .mockResolvedValueOnce(
      repository({ version: "new-v", files: [file("same.ts", ".", "M")] }),
    );
  let resolveOld!: (comparison: GitComparison) => void;
  let resolveNew!: (comparison: GitComparison) => void;
  vi.mocked(api.readGitComparison)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
  const original = member("diff-moving", "Diff moving");
  await render([original], [], []);
  await render([{ ...original, path: "/srv/new-scope" }], [], []);

  await act(async () =>
    resolveNew({
      path: "same.ts",
      oldPath: null,
      version: "new-v",
      before: { text: "new" } as never,
      after: {} as never,
    }),
  );
  expect(host.querySelector("[data-diff]")?.textContent).toBe("same.ts");
  await act(async () =>
    resolveOld({
      path: "same.ts",
      oldPath: null,
      version: "old-v",
      before: { text: "old" } as never,
      after: {} as never,
    }),
  );
  expect(host.querySelector("[data-diff]")?.textContent).toBe("same.ts");

  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({ version: "old-v", files: [file("same.ts", ".", "M")] }),
  );
  vi.mocked(api.readGitComparison).mockImplementation(
    () => new Promise(() => {}),
  );
  await render([original], [], []);
  expect(api.readGitComparison).toHaveBeenCalledTimes(3);
});

it("retries a failed diff for the same selection", async () => {
  vi.mocked(api.readGitRepository).mockResolvedValue(
    repository({ files: [file("retry.ts", ".", "M")] }),
  );
  vi.mocked(api.readGitComparison)
    .mockRejectedValueOnce(new Error("diff failed"))
    .mockResolvedValueOnce({
      path: "retry.ts",
      oldPath: null,
      version: "v1",
      before: {} as never,
      after: {} as never,
    });
  await render([member("retry-diff", "Retry diff")], [], []);

  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Réessayer",
  )!;
  await act(async () => retry.click());
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-diff]")?.textContent).toBe("retry.ts");
});

async function commentFirstLine(path: string) {
  vi.mocked(agentApi.sendAgentSessionMessage).mockResolvedValue({
    id: "m1",
    sessionId: "group-agent",
    body: "",
    status: "queued",
    error: null,
    createdAt: "2026-09-29T10:12:00Z",
    deliveredAt: null,
  } satisfies AgentSessionMessage);
  await act(async () => {
    root.render(
      <ProjectGroupPanel
        groupName="Jinka"
        members={[member("api", "API"), member("docs", "Docs")]}
        disconnectedProjectIds={[]}
        workingSessions={[]}
        visible
        onClose={onClose}
        onSelectProject={onSelectProject}
        commentTargets={[
          {
            sessionId: "docs-agent",
            projectId: "docs",
            name: "Docs agent",
            executable: "pi",
          },
          {
            sessionId: "group-agent",
            projectId: "group",
            name: "Jinka",
            executable: "claude",
          },
          {
            sessionId: "api-agent",
            projectId: "api",
            name: "API agent",
            executable: "omp",
          },
        ]}
      />,
    );
  });
  await vi.waitFor(() =>
    expect(host.querySelector("[data-diff]")?.textContent).toBe(path),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Select line 1")!
      .click(),
  );
  const textarea = host.querySelector<HTMLTextAreaElement>(
    ".git-diff-comment textarea",
  )!;
  await act(async () => {
    setInputValue(textarea, "Renomme cet appel.");
  });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );
  return vi.mocked(agentApi.sendAgentSessionMessage).mock.calls[0];
}

it("comments a member's diff for the group agent, not another member's agent", async () => {
  const [sessionId, , body] = await commentFirstLine("src/a.ts");
  expect(sessionId).toBe("group-agent");
  expect(body.split("\n")[0]).toBe(
    "Soreno comment on src/a.ts line 1 in API: Renomme cet appel.",
  );
  expect(body).toContain("`git -C /srv/api diff -- src/a.ts`");
});

it("runs git from the member's Git root when the member is a subdirectory", async () => {
  vi.mocked(api.readGitRepository).mockImplementation(async (projectId) =>
    projectId === "api"
      ? repository({
          identity: {
            root: "/srv/mono repo",
            gitDir: "/srv/mono repo/.git",
            commonDir: "/srv/mono repo/.git",
          },
          files: [file("api/src/a.ts", ".", "M")],
        })
      : repository({ availability: "notRepository" }),
  );
  const [, , body] = await commentFirstLine("api/src/a.ts");
  expect(body).toContain("Repository: API at /srv/mono repo\n");
  expect(body).toContain("`git -C '/srv/mono repo' diff -- api/src/a.ts`");
});
