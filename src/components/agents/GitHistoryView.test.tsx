// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/projectGitApi";
import { createGitReadCache } from "../../data/gitReadCache";
import {
  clearNotifications,
  dismissNotification,
  getNotifications,
} from "../../notifications";
import { GitHistoryView } from "./GitHistoryView";
import { deferred } from "../../testing/deferred";
import type { GitHistory } from "../../domain/projectGit";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../data/projectGitApi", () => ({
  readGitHistory: vi.fn(),
  readGitCommitDetail: vi.fn(),
  readGitCommitComparison: vi.fn(),
}));
vi.mock("./GitDiffView", () => ({
  default: ({
    comparison,
  }: {
    comparison: { path: string; version?: string };
  }) => (
    <div data-testid="diff" data-version={comparison.version}>
      {comparison.path}
    </div>
  ),
}));

const commits = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    oid: `${prefix}-${index}`,
    parents: index + 1 < count ? [`${prefix}-${index + 1}`] : [],
    references: [],
    author: "Ada",
    date: "2025-01-02T12:30:00Z",
    subject: `${prefix} commit ${index}`,
  }));
const comparisonFixture: Awaited<
  ReturnType<typeof api.readGitCommitComparison>
> = {
  path: "src/file.ts",
  oldPath: null,
  version: "v1",
  before: {
    text: "",
    oid: null,
    size: 0,
    mode: "100644",
    reason: null,
  },
  after: {
    text: "a",
    oid: null,
    size: 1,
    mode: "100644",
    reason: null,
  },
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.removeItem("soreno:git-history-rail-ratio");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  clearNotifications();
});

const historyReadError = "Lecture de l’historique Git impossible.";

function historyNotification() {
  return getNotifications().find(({ key }) => key.startsWith("git-history:"));
}

async function retryFromNotification() {
  const notification = historyNotification();
  expect(notification?.action?.label).toBe("Réessayer");
  await act(async () => {
    dismissNotification(notification!.key);
    notification!.action!.onAction();
  });
}

function pointerEvent(type: string, pointerId: number, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("restores and validates the saved history column size", async () => {
  localStorage.setItem("soreno:git-history-rail-ratio", "120");
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [],
    commits: [],
    hasMore: false,
  });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  let separator = container.querySelector<HTMLElement>(".git-history-resizer")!;
  expect(separator.getAttribute("aria-valuenow")).toBe("85");
  await act(async () =>
    separator.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(localStorage.getItem("soreno:git-history-rail-ratio")).toBe("83");

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  separator = container.querySelector<HTMLElement>(".git-history-resizer")!;
  expect(separator.getAttribute("aria-valuenow")).toBe("83");
});

it("resizes the right history column with pointer and keyboard controls", async () => {
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [],
    commits: [],
    hasMore: false,
  });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  const main = container.querySelector<HTMLElement>(".git-history-main")!;
  const separator = container.querySelector<HTMLElement>(
    ".git-history-resizer",
  )!;
  main.getBoundingClientRect = vi.fn(() => ({ width: 1001 }) as DOMRect);
  Object.defineProperty(separator, "setPointerCapture", { value: vi.fn() });

  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointerdown", 1, 700)),
  );
  await act(async () =>
    separator.dispatchEvent(pointerEvent("pointermove", 1, 500)),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("50");
  expect(main.style.getPropertyValue("--history-rail-size")).toBe("50fr");
  await act(async () =>
    separator.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("48");
  await act(async () =>
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(separator.getAttribute("aria-valuenow")).toBe("30");
});

it("paginates by 50 with the first-page roots", async () => {
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["head-at-open", "unmerged-tip"],
      commits: commits("first", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["ignored-new-anchor"],
      commits: commits("next", 2),
      hasMore: false,
    })
    .mockResolvedValueOnce({
      roots: ["head-refreshed"],
      commits: commits("fresh", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["head-refreshed"],
      commits: commits("fresh-next", 1),
      hasMore: false,
    });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("first commit 49"),
  );
  const more = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Charger la suite")!;
  await act(async () => more.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("next commit 1"),
  );
  expect(api.readGitHistory).toHaveBeenNthCalledWith(1, "p1", null, 0, null);
  expect(api.readGitHistory).toHaveBeenNthCalledWith(
    2,
    "p1",
    ["head-at-open", "unmerged-tip"],
    50,
    null,
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("fresh-next commit 0"),
  );
  expect(api.readGitHistory).toHaveBeenNthCalledWith(3, "p1", null, 0, null);
  expect(api.readGitHistory).toHaveBeenNthCalledWith(
    4,
    "p1",
    ["head-refreshed"],
    50,
    null,
  );
});

it("renders references and reconnects graph lanes after pagination", async () => {
  const graphCommits = [
    {
      oid: "merge",
      parents: ["main", "side"],
      references: [
        { name: "origin/main", kind: "remoteBranch" as const },
        { name: "v1.0", kind: "tag" as const },
        { name: "main", kind: "localBranch" as const },
        { name: "HEAD", kind: "head" as const },
      ],
      author: "Ada",
      date: "2025-01-02T12:30:00Z",
      subject: "Merge side",
    },
    {
      oid: "side",
      parents: ["root"],
      references: [],
      author: "Ada",
      date: "2025-01-02T12:20:00Z",
      subject: "Side work",
    },
    {
      oid: "main",
      parents: ["root"],
      references: [],
      author: "Ada",
      date: "2025-01-02T12:10:00Z",
      subject: "Main work",
    },
    {
      oid: "root",
      parents: [],
      references: [],
      author: "Ada",
      date: "2025-01-02T12:00:00Z",
      subject: "Root",
    },
  ];
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["merge"],
      commits: graphCommits.slice(0, 2),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["merge"],
      commits: graphCommits.slice(2),
      hasMore: false,
    });

  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".git-history-graph")).toHaveLength(2),
  );
  const firstButton = container.querySelector<HTMLButtonElement>(
    ".git-history-list button",
  )!;
  const references = [
    ...firstButton.querySelectorAll(".git-history-reference"),
  ];
  expect(references.map((reference) => reference.textContent)).toEqual([
    "HEAD -> main",
    "tag: v1.0",
  ]);

  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Charger la suite")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".git-history-graph")).toHaveLength(4),
  );
  const graphs = container.querySelectorAll<SVGElement>(".git-history-graph");
  expect(graphs[0].dataset.nodeLane).toBe("0");
  expect(graphs[1].dataset.nodeLane).toBe("1");
  const rejoin = graphs[2].querySelector<SVGPathElement>(".is-through")!;
  expect(rejoin.dataset.from).toBe("1");
  expect(rejoin.dataset.to).toBe("0");
});

it("keeps dense closing lanes clear of the current node", async () => {
  const laneCount = 18;
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["merge"],
    commits: [
      {
        oid: "merge",
        parents: Array.from(
          { length: laneCount },
          (_, index) => `parent-${index}`,
        ),
        references: [],
        author: "Ada",
        date: "2025-01-02T12:30:00Z",
        subject: "Merge many branches",
      },
      {
        oid: "parent-0",
        parents: [],
        references: [],
        author: "Ada",
        date: "2025-01-02T12:20:00Z",
        subject: "Close first lane",
      },
    ],
    hasMore: false,
  });

  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.querySelector(".git-history-graph-node")).not.toBeNull(),
  );

  const graph = container.querySelector<SVGElement>(".git-history-graph")!;
  const width = Number(graph.getAttribute("viewBox")!.split(" ")[2]);
  const spacing = (width - 8) / (laneCount - 1);
  const radius = Number(
    graph.querySelector(".git-history-graph-node")!.getAttribute("r"),
  );
  const lineWidth = Number(
    graph
      .querySelector(".git-history-graph-line")!
      .getAttribute("stroke-width"),
  );

  expect(radius + lineWidth / 2).toBeLessThan(spacing);

  const closingGraph =
    container.querySelectorAll<SVGElement>(".git-history-graph")[1];
  const through = closingGraph.querySelector<SVGPathElement>(
    '.is-through[data-from="1"][data-to="0"]',
  )!;
  const entryX = 4 + spacing;
  expect(through.getAttribute("d")).toBe(
    `M ${entryX} 0 L ${entryX} 15 C ${entryX} 22.5, 4 22.5, 4 30`,
  );
});

it("shows the author in the list and compact selected metadata", async () => {
  const oid = "0123456789abcdef0123456789abcdef01234567";
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [oid],
    commits: [
      {
        oid,
        parents: [],
        references: [],
        author: "Ada",
        date: "2025-01-02T12:30:00Z",
        subject: "Keep the complete commit title visible",
      },
      {
        oid: "empty-commit",
        parents: [],
        references: [],
        author: "Ada",
        date: "2025-01-01T12:30:00Z",
        subject: "Empty commit",
      },
    ],
    hasMore: false,
  });
  const commitFiles = [
    {
      path: "src/file.ts",
      oldPath: null,
      indexStatus: "M",
      worktreeStatus: ".",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: 1,
      deleted: 0,
    },
    {
      path: "README.md",
      oldPath: null,
      indexStatus: "A",
      worktreeStatus: ".",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: null,
      deleted: null,
    },
    {
      path: "lib/file.ts",
      oldPath: "old/file.ts",
      indexStatus: "R",
      worktreeStatus: ".",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: 2,
      deleted: 1,
    },
  ];
  vi.mocked(api.readGitCommitDetail).mockImplementation(
    async (_projectId, commitOid) => ({
      oid: commitOid,
      parent: commitOid === oid ? "fedcba9876543210" : null,
      files: commitOid === oid ? commitFiles : [],
    }),
  );
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparisonFixture,
    path: "src/file.ts",
  });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Keep the complete commit title visible",
    ),
  );
  const commit = container.querySelector<HTMLButtonElement>(
    ".git-history-list button",
  )!;
  expect(commit.querySelector(".git-history-list-author")?.textContent).toBe(
    "Ada",
  );
  expect(commit.getAttribute("aria-pressed")).toBe("true");
  await vi.waitFor(() =>
    expect(
      container.querySelector(".git-archive-selection-header"),
    ).not.toBeNull(),
  );
  const header = container.querySelector<HTMLElement>(
    ".git-archive-selection-header",
  )!;
  expect(header.textContent).toContain("01234567");
  expect(header.textContent).not.toContain(oid);
  expect(container.querySelector('[data-testid="diff"]')).not.toBeNull();
  const files = container.querySelectorAll<HTMLButtonElement>(
    ".git-history-files button",
  );
  expect(files[0].querySelector(".git-history-file-status")?.textContent).toBe(
    "M",
  );
  expect(files[0].querySelector(".git-file-stats")?.textContent).toBe("+1");
  expect(files[1].querySelector(".git-file-stats")?.textContent).toBe("");
  expect(files[2].querySelector(".git-file-stats")?.textContent).toBe("+2−1");
  expect(files[0].getAttribute("aria-pressed")).toBe("true");
  expect(api.readGitCommitComparison).toHaveBeenCalledExactlyOnceWith(
    "p1",
    oid,
    "src/file.ts",
  );

  await act(async () => files[1].click());
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={1} />),
  );
  expect(files[1].getAttribute("aria-pressed")).toBe("true");
  expect(api.readGitCommitComparison).toHaveBeenLastCalledWith(
    "p1",
    oid,
    "README.md",
  );

  await act(async () => commit.click());
  expect(files[0].getAttribute("aria-pressed")).toBe("true");
  expect(api.readGitCommitComparison).toHaveBeenLastCalledWith(
    "p1",
    oid,
    "src/file.ts",
  );

  // A pending diff of the previous commit must not keep a fileless commit loading.
  vi.mocked(api.readGitCommitComparison).mockReturnValueOnce(
    new Promise(() => {}),
  );
  await act(async () => files[1].click());
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[1]
      .click(),
  );
  const diffPane = container.querySelector(".git-history-diff")!;
  await vi.waitFor(() =>
    expect(diffPane.textContent).toContain(
      "Sélectionnez un fichier pour voir son diff.",
    ),
  );
  expect(diffPane.textContent).not.toContain("Lecture du diff…");
});

it("does not ask for a commit selection when the repository has no commits", async () => {
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: [],
    commits: [],
    hasMore: false,
  });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  expect(container.querySelector(".git-history-diff p")?.textContent).toBe(
    "Aucun commit.",
  );
});

it("keeps pagination and selection when reactivated without repeating cached reads", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["head"],
      commits: commits("first", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["head"],
      commits: commits("next", 1),
      hasMore: false,
    });
  vi.mocked(api.readGitCommitDetail).mockImplementation(
    async (_projectId, oid) => ({ oid, parent: null, files: [] }),
  );
  await act(async () =>
    root.render(
      <GitHistoryView
        active
        head="head"
        projectId="p1"
        revision={0}
        readCache={cache}
        readScope="scope"
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("first commit 49"),
  );
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[2]
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2),
  );
  const more = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Charger la suite")!;
  await act(async () => more.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("next commit 0"),
  );

  await act(async () =>
    root.render(
      <GitHistoryView
        active={false}
        head="head"
        projectId="p1"
        revision={1}
        readCache={cache}
        readScope="scope"
      />,
    ),
  );
  await act(async () =>
    root.render(
      <GitHistoryView
        active
        head="head"
        projectId="p1"
        revision={1}
        readCache={cache}
        readScope="scope"
      />,
    ),
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(2);
  expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll(".git-history-list li")).toHaveLength(51);
  expect(
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[2]
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("drops a delayed history response after the project changes", async () => {
  const oldHistory = deferred<GitHistory>();
  vi.mocked(api.readGitHistory)
    .mockImplementationOnce(() => oldHistory.promise)
    .mockResolvedValueOnce({
      roots: ["new"],
      commits: commits("new", 1),
      hasMore: false,
    });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await act(async () =>
    root.render(<GitHistoryView active projectId="p2" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("new commit 0"),
  );
  await act(async () =>
    oldHistory.resolve({
      roots: ["old"],
      commits: commits("old", 1),
      hasMore: false,
    }),
  );
  expect(container.textContent).not.toContain("old commit 0");
});

it("retries a failed multi-page refresh without mixing old commits into a shorter history", async () => {
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["old"],
      commits: commits("old-first", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["old"],
      commits: commits("old-next", 50),
      hasMore: false,
    })
    .mockResolvedValueOnce({
      roots: ["new"],
      commits: commits("new-first", 50),
      hasMore: true,
    })
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockResolvedValueOnce({
      roots: ["new"],
      commits: commits("new-first", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["new"],
      commits: commits("new-next", 1),
      hasMore: false,
    });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("old-first commit 49"),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Charger la suite")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".git-history-list li")).toHaveLength(
      100,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (button) =>
          button.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() =>
    expect(historyNotification()).toMatchObject({
      message: historyReadError,
      tone: "error",
    }),
  );
  expect(container.textContent).not.toContain("refresh failed");
  expect(container.querySelectorAll(".git-history-list li")).toHaveLength(100);

  await retryFromNotification();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("new-next commit 0"),
  );
  expect(container.querySelectorAll(".git-history-list li")).toHaveLength(51);
  expect(container.textContent).not.toContain("old-first commit");
  expect(container.textContent).not.toContain("old-next commit");
  expect(api.readGitHistory).toHaveBeenNthCalledWith(5, "p1", null, 0, null);
  expect(api.readGitHistory).toHaveBeenNthCalledWith(
    6,
    "p1",
    ["new"],
    50,
    null,
  );
});

it("does not request another stale refresh page after deactivation", async () => {
  const refresh = deferred<GitHistory>();
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["old"],
      commits: commits("old-first", 50),
      hasMore: true,
    })
    .mockResolvedValueOnce({
      roots: ["old"],
      commits: commits("old-next", 50),
      hasMore: false,
    })
    .mockImplementationOnce(() => refresh.promise);
  const view = (active: boolean) => (
    <GitHistoryView active={active} projectId="p1" revision={0} />
  );
  await act(async () => root.render(view(true)));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("old-first commit 49"),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Charger la suite")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".git-history-list li")).toHaveLength(
      100,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (button) =>
          button.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() => expect(api.readGitHistory).toHaveBeenCalledTimes(3));

  await act(async () => root.render(view(false)));
  await act(async () =>
    refresh.resolve({
      roots: ["stale"],
      commits: commits("stale", 50),
      hasMore: true,
    }),
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(3);
  expect(api.readGitHistory).not.toHaveBeenCalledWith("p1", ["stale"], 50);
});

it("hides errors after their head or selected commit becomes stale", async () => {
  vi.mocked(api.readGitHistory)
    .mockRejectedValueOnce(new Error("old head failed"))
    .mockResolvedValueOnce({
      roots: ["head-b"],
      commits: commits("commit", 2),
      hasMore: false,
    });
  vi.mocked(api.readGitCommitDetail)
    .mockImplementationOnce(async (_projectId, oid) => ({
      oid,
      parent: null,
      files: [],
    }))
    .mockRejectedValueOnce(new Error("old detail failed"))
    .mockImplementationOnce(async (_projectId, oid) => ({
      oid,
      parent: null,
      files: [],
    }));
  const view = (head: string) => (
    <GitHistoryView
      active
      head={head}
      projectId="p1"
      revision={0}
      readScope="scope"
    />
  );
  await act(async () => root.render(view("head-a")));
  await vi.waitFor(() => expect(historyNotification()).toBeDefined());
  await act(async () => root.render(view("head-b")));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("commit commit 1"),
  );
  expect(historyNotification()).toBeUndefined();

  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[1]
      .click(),
  );
  await vi.waitFor(() => expect(historyNotification()).toBeDefined());
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[0]
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(3),
  );
  expect(historyNotification()).toBeUndefined();
});

it("retries the failed history page even while a diff is selected", async () => {
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  const comparison = { ...comparisonFixture, path: file.path };
  vi.mocked(api.readGitHistory)
    .mockResolvedValueOnce({
      roots: ["head"],
      commits: commits("first", 50),
      hasMore: true,
    })
    .mockRejectedValueOnce(new Error("page failed"))
    .mockResolvedValueOnce({
      roots: ["head"],
      commits: commits("next", 1),
      hasMore: false,
    });
  vi.mocked(api.readGitCommitDetail).mockResolvedValue({
    oid: "first-0",
    parent: null,
    files: [file],
  });
  vi.mocked(api.readGitCommitComparison).mockResolvedValue(comparison);
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("first commit 49"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector(".git-history-files button")).not.toBeNull(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-files button")!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "Charger la suite")!
      .click(),
  );
  await vi.waitFor(() => expect(historyNotification()).toBeDefined());
  await retryFromNotification();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("next commit 0"),
  );
  expect(api.readGitHistory).toHaveBeenNthCalledWith(
    3,
    "p1",
    ["head"],
    50,
    null,
  );
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitComparison).toHaveBeenCalledWith(
    "p1",
    "first-0",
    "src/a.ts",
  );
});

it("retries list and detail failures independently of the selected diff", async () => {
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("commit", 1),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail).mockResolvedValue({
    oid: "commit-0",
    parent: null,
    files: [file],
  });
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparisonFixture,
    path: file.path,
  });
  await act(async () =>
    root.render(<GitHistoryView active projectId="p1" revision={0} />),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("commit commit 0"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector(".git-history-files button")).not.toBeNull(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-files button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1),
  );

  vi.mocked(api.readGitHistory).mockRejectedValueOnce(new Error("list failed"));
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() => expect(historyNotification()).toBeDefined());
  await retryFromNotification();
  await vi.waitFor(() => expect(api.readGitHistory).toHaveBeenCalledTimes(3));
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2);

  vi.mocked(api.readGitCommitDetail).mockRejectedValueOnce(
    new Error("detail failed"),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() => expect(historyNotification()).toBeDefined());
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2);
  await retryFromNotification();
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(4),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(3),
  );
  expect(api.readGitCommitComparison).toHaveBeenLastCalledWith(
    "p1",
    "commit-0",
    "src/a.ts",
  );
});

it("consumes request tokens once while allowing a new request for the same OID", async () => {
  const token = {};
  const repeatedToken = {};
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("commit", 2),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail).mockImplementation(
    async (_projectId, oid) => ({ oid, parent: null, files: [file] }),
  );
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparisonFixture,
    path: file.path,
  });
  const view = (active: boolean, requestToken: object) => (
    <GitHistoryView
      active={active}
      projectId="p1"
      requestedOid="commit-0"
      requestToken={requestToken}
      revision={0}
    />
  );
  await act(async () => root.render(view(true, token)));
  await vi.waitFor(() =>
    expect(container.querySelector(".git-history-files button")).not.toBeNull(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-files button")!
      .click(),
  );
  await act(async () => root.render(view(true, repeatedToken)));
  expect(
    container
      .querySelector<HTMLButtonElement>(".git-history-files button")
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[1]
      .click(),
  );
  await act(async () => root.render(view(false, repeatedToken)));
  await act(async () => root.render(view(true, repeatedToken)));
  expect(
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[1]
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await act(async () => root.render(view(true, {})));
  expect(
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-list button")[0]
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("waits for fresh commit detail before refreshing its comparison", async () => {
  const cache = createGitReadCache();
  const oid = "commit-0";
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  const detail = { oid, parent: null, files: [file] };
  const freshDetail = deferred<typeof detail>();
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("commit", 1),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail)
    .mockResolvedValueOnce(detail)
    .mockImplementationOnce(() => freshDetail.promise);
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparisonFixture,
    path: file.path,
  });

  await act(async () =>
    root.render(
      <GitHistoryView active projectId="p1" revision={0} readCache={cache} />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("commit commit 0"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1),
  );

  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2),
  );
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);

  await act(async () => freshDetail.resolve(detail));
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2),
  );
});

it("does not replace a newly selected file diff when a prior refresh detail resolves", async () => {
  const cache = createGitReadCache();
  const oid = "commit-0";
  const files = ["src/a.ts", "src/b.ts"].map((path) => ({
    path,
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  }));
  const detail = { oid, parent: null, files };
  const freshDetail = deferred<typeof detail>();
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("commit", 1),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail)
    .mockResolvedValueOnce(detail)
    .mockImplementationOnce(() => freshDetail.promise);
  vi.mocked(api.readGitCommitComparison).mockImplementation(
    async (_projectId, _oid, path) => ({
      path,
      oldPath: null,
      version: "v1",
      before: {
        text: "",
        oid: null,
        size: 0,
        mode: "100644",
        reason: null,
      },
      after: {
        text: path,
        oid: null,
        size: path.length,
        mode: "100644",
        reason: null,
      },
    }),
  );

  await act(async () =>
    root.render(
      <GitHistoryView active projectId="p1" revision={0} readCache={cache} />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("commit commit 0"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
      "src/a.ts",
    ),
  );

  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2),
  );
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".git-history-files button")[1]
      .click(),
  );
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);

  await act(async () => freshDetail.resolve(detail));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
      "src/b.ts",
    ),
  );
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2);
  expect(api.readGitCommitComparison).toHaveBeenLastCalledWith(
    "p1",
    oid,
    "src/b.ts",
  );
});

it("revalidates an expired reopened diff only after fresh commit detail", async () => {
  let now = 0;
  const cache = createGitReadCache({ now: () => now });
  const oid = "commit-0";
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  const detail = { oid, parent: null, files: [file] };
  const freshDetail = deferred<typeof detail>();
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("commit", 1),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail)
    .mockResolvedValueOnce(detail)
    .mockImplementationOnce(() => freshDetail.promise);
  vi.mocked(api.readGitCommitComparison)
    .mockResolvedValueOnce({
      path: file.path,
      oldPath: null,
      version: "old",
      before: {
        text: "",
        oid: null,
        size: 0,
        mode: "100644",
        reason: null,
      },
      after: {
        text: "old",
        oid: null,
        size: 3,
        mode: "100644",
        reason: null,
      },
    })
    .mockResolvedValueOnce({
      path: file.path,
      oldPath: null,
      version: "fresh",
      before: {
        text: "",
        oid: null,
        size: 0,
        mode: "100644",
        reason: null,
      },
      after: {
        text: "fresh",
        oid: null,
        size: 5,
        mode: "100644",
        reason: null,
      },
    });
  const view = (active: boolean) => (
    <GitHistoryView
      active={active}
      projectId="p1"
      revision={0}
      readCache={cache}
      readScope="scope"
    />
  );

  await act(async () => root.render(view(true)));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("commit commit 0"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(
      container
        .querySelector('[data-testid="diff"]')
        ?.getAttribute("data-version"),
    ).toBe("old"),
  );

  await act(async () => root.render(view(false)));
  now = 5_000;
  await act(async () => root.render(view(true)));
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2),
  );
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);
  expect(
    container
      .querySelector('[data-testid="diff"]')
      ?.getAttribute("data-version"),
  ).toBe("old");

  await act(async () => freshDetail.resolve(detail));
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2),
  );
  expect(
    container
      .querySelector('[data-testid="diff"]')
      ?.getAttribute("data-version"),
  ).toBe("fresh");
});

it("revalidates mutable pages, detail and diff after TTL and on explicit refresh", async () => {
  let now = 0;
  const cache = createGitReadCache({ now: () => now });
  const file = {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
  };
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["same"],
    commits: commits("same", 1),
    hasMore: false,
  });
  vi.mocked(api.readGitCommitDetail).mockImplementation(async () => ({
    oid: "same-0",
    parent: `parent-${vi.mocked(api.readGitCommitDetail).mock.calls.length}`,
    files: [file],
  }));
  vi.mocked(api.readGitCommitComparison).mockResolvedValue({
    ...comparisonFixture,
    path: file.path,
  });
  const view = (revision: number) => (
    <GitHistoryView
      active
      head="same"
      projectId="p1"
      revision={revision}
      readCache={cache}
      readScope="scope"
    />
  );
  await act(async () => root.render(view(0)));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("same commit 0"),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-list button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector(".git-history-files button")).not.toBeNull(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".git-history-files button")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1),
  );
  await act(async () => root.render(view(1)));
  expect(api.readGitHistory).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitDetail).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitComparison).toHaveBeenCalledTimes(1);
  now = 5_000;
  await act(async () => root.render(view(2)));
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(2),
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(2);
  expect(api.readGitCommitDetail).toHaveBeenCalledTimes(2);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(
        (item) => item.getAttribute("aria-label") === "Actualiser l’historique",
      )!
      .click(),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledTimes(3),
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(3);
  expect(api.readGitCommitDetail).toHaveBeenCalledTimes(3);
});

it("limits history to a path, preselects its file and resets on clearing", async () => {
  vi.mocked(api.readGitHistory).mockImplementation(
    async (_projectId, _roots, _offset, path) => ({
      roots: ["head"],
      commits: commits(path ? "filtered" : "full", 2),
      hasMore: false,
    }),
  );
  vi.mocked(api.readGitCommitDetail).mockImplementation(async (_id, oid) => ({
    oid,
    parent: null,
    files: ["app/a.ts", "app/src/file.ts"].map((path) => ({
      path,
      oldPath: null,
      indexStatus: "M",
      worktreeStatus: ".",
      conflict: false,
      submodule: false,
      actionable: false,
      mode: "100644",
      added: 1,
      deleted: 1,
    })),
  }));
  vi.mocked(api.readGitCommitComparison).mockResolvedValue(comparisonFixture);
  const onClearPath = vi.fn();
  const cache = createGitReadCache();
  const view = (path: string | null) => (
    <GitHistoryView
      active
      projectId="p1"
      revision={0}
      readCache={cache}
      readScope="scope"
      path={path}
      gitPath={path === null ? null : `app/${path}`}
      onClearPath={onClearPath}
    />
  );
  await act(async () => root.render(view(null)));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("full commit 0"),
  );

  await act(async () => root.render(view("src/file.ts")));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("filtered commit 0"),
  );
  expect(container.textContent).not.toContain("full commit 0");
  expect(api.readGitHistory).toHaveBeenLastCalledWith(
    "p1",
    null,
    0,
    "src/file.ts",
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenLastCalledWith(
      "p1",
      "filtered-0",
      "app/src/file.ts",
    ),
  );
  const clear = container.querySelector<HTMLButtonElement>(
    '[aria-label="Afficher tout l’historique"]',
  )!;
  await act(async () => clear.click());
  expect(onClearPath).toHaveBeenCalledTimes(1);

  await act(async () => root.render(view(null)));
  expect(container.textContent).toContain("full commit 0");
  expect(container.querySelector(".git-history-filter")).toBeNull();
});

it("applies a commit request made while clearing the path filter", async () => {
  vi.mocked(api.readGitHistory).mockImplementation(
    async (_projectId, _roots, _offset, path) => ({
      roots: ["head"],
      commits: commits(path ? "filtered" : "full", 2),
      hasMore: false,
    }),
  );
  vi.mocked(api.readGitCommitDetail).mockImplementation(async (_id, oid) => ({
    oid,
    parent: null,
    files: [],
  }));
  const view = (
    path: string | null,
    requestedOid: string | null,
    requestToken?: object,
  ) => (
    <GitHistoryView
      active
      projectId="p1"
      revision={0}
      path={path}
      gitPath={path}
      requestedOid={requestedOid}
      requestToken={requestToken}
      onClearPath={vi.fn()}
    />
  );
  await act(async () => root.render(view("src/file.ts", null)));
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenLastCalledWith(
      "p1",
      "filtered-0",
    ),
  );

  await act(async () => root.render(view(null, "full-1", {})));
  await vi.waitFor(() =>
    expect(api.readGitCommitDetail).toHaveBeenLastCalledWith("p1", "full-1"),
  );
  await vi.waitFor(() =>
    expect(
      container
        .querySelectorAll<HTMLButtonElement>(".git-history-list button")[1]
        ?.getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(container.textContent).toContain("full commit 1");
});

it("preselects a file renamed away from the filtered path", async () => {
  vi.mocked(api.readGitHistory).mockResolvedValue({
    roots: ["head"],
    commits: commits("filtered", 1),
    hasMore: false,
  });
  const file = {
    oldPath: null,
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: false,
    actionable: false,
    mode: "100644",
    added: 1,
    deleted: 1,
  };
  vi.mocked(api.readGitCommitDetail).mockImplementation(async (_id, oid) => ({
    oid,
    parent: null,
    files: [
      { ...file, path: "README.md" },
      { ...file, path: "lib/a.ts", oldPath: "src/a.ts", indexStatus: "R" },
    ],
  }));
  vi.mocked(api.readGitCommitComparison).mockResolvedValue(comparisonFixture);
  await act(async () =>
    root.render(
      <GitHistoryView
        active
        projectId="p1"
        revision={0}
        readCache={createGitReadCache()}
        readScope="scope"
        path="src"
        gitPath="src"
        onClearPath={vi.fn()}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(api.readGitCommitComparison).toHaveBeenCalledWith(
      "p1",
      "filtered-0",
      "lib/a.ts",
    ),
  );
  expect(api.readGitCommitComparison).not.toHaveBeenCalledWith(
    "p1",
    "filtered-0",
    "README.md",
  );
});
