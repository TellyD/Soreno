// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProjectGit } from "./useProjectGit";
import * as api from "../data/projectGitApi";
import { createGitReadCache, gitReadKeys } from "../data/gitReadCache";
import type { GitReadCache } from "../data/gitReadCache";
import type { AgentEnvironment } from "../domain/agentSessions";
import type {
  GitComparison,
  GitContent,
  GitRepository,
} from "../domain/projectGit";
import { deferred } from "../testing/deferred";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../data/projectGitApi", () => ({
  readGitRepository: vi.fn(),
  readGitComparison: vi.fn(),
}));
const repository = (version: string): GitRepository => ({
  availability: "ready",
  identity: { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" },
  version,
  head: null,
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  mergeMessage: null,
  files: [],
  limited: false,
  truncated: false,
});
const content = (text: string): GitContent => ({
  text,
  oid: null,
  size: text.length,
  mode: "100644",
  reason: null,
});
const comparison = (
  path: string,
  version = "1",
  text = path,
): GitComparison => ({
  path,
  oldPath: null,
  version,
  before: content(text),
  after: content(text),
});
let root: Root,
  host: HTMLDivElement,
  state: ReturnType<typeof useProjectGit>,
  renderedDiffs: (GitComparison | null)[],
  renderedLoadings: boolean[];
function Harness({
  id,
  visible,
  onMutation,
  readCache,
  readScope,
  environmentKind,
  initialRepository,
  suspended,
}: {
  id: string | undefined;
  visible: boolean;
  onMutation?: (projectId?: string, branch?: string | null) => void;
  readCache?: GitReadCache;
  readScope?: string;
  environmentKind?: AgentEnvironment["kind"];
  initialRepository?: GitRepository;
  suspended?: boolean;
}) {
  state = useProjectGit(
    id,
    visible,
    onMutation,
    readCache,
    readScope,
    environmentKind,
    initialRepository,
    suspended,
  );
  renderedDiffs.push(state.diff);
  renderedLoadings.push(state.loading);
  return null;
}
async function render(
  id = "a",
  visible = true,
  onMutation?: (projectId?: string, branch?: string | null) => void,
) {
  await act(async () =>
    root.render(<Harness id={id} visible={visible} onMutation={onMutation} />),
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("1"));
  renderedDiffs = [];
  renderedLoadings = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
it("reports loading synchronously on mount and project changes until each first read settles", async () => {
  const readA = deferred<GitRepository>();
  const readB = deferred<GitRepository>();
  vi.mocked(api.readGitRepository)
    .mockImplementationOnce(() => readA.promise)
    .mockImplementationOnce(() => readB.promise);
  await render("a");
  expect(renderedLoadings[0]).toBe(true);
  expect(state.loading).toBe(true);
  expect(state.repo).toBeNull();
  await act(async () => readA.resolve(repository("a")));
  expect(state.loading).toBe(false);

  const firstBRender = renderedLoadings.length;
  await render("b");
  expect(renderedLoadings[firstBRender]).toBe(true);
  expect(state.loading).toBe(true);
  expect(state.repo).toBeNull();
  await act(async () => readB.resolve(repository("b")));
  expect(state.loading).toBe(false);
  expect(state.repo?.version).toBe("b");
});
it.each([false, true])(
  "handles a missing project before loading and after clearing selection (visible=%s)",
  async (visible) => {
    await act(async () =>
      root.render(<Harness id={undefined} visible={visible} />),
    );
    expect(state.repo).toBeNull();
    expect(state.diff).toBeNull();
    expect(state.stale).toBe(false);
    expect(state.loading).toBe(false);
    expect(api.readGitRepository).not.toHaveBeenCalled();
    expect(api.readGitComparison).not.toHaveBeenCalled();

    vi.mocked(api.readGitComparison).mockResolvedValueOnce(comparison("a.ts"));
    await render();
    await act(async () =>
      state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
    );
    expect(state.diff?.path).toBe("a.ts");
    await act(async () =>
      root.render(<Harness id={undefined} visible={visible} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(state.repo).toBeNull();
    expect(state.diff).toBeNull();
    expect(state.diffLoading).toBe(false);
    expect(state.stale).toBe(false);
    expect(api.readGitRepository).toHaveBeenCalledTimes(1);
    expect(api.readGitComparison).toHaveBeenCalledTimes(1);
  },
);
it("polls only while visible and preserves each project's draft", async () => {
  await render();
  expect(api.readGitRepository).toHaveBeenCalledTimes(1);
  await act(async () => state.updateDraft({ message: "reviewed" }));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  await render("a", false);
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  await render("b");
  expect(state.draft.message).toBe("");
  await render("a");
  expect(state.draft.message).toBe("reviewed");
});
it.each([
  [
    "a truncated status",
    () =>
      vi.mocked(api.readGitRepository).mockResolvedValue({
        ...repository("huge"),
        limited: true,
        truncated: true,
      }),
  ],
  [
    "an oversized status",
    () =>
      vi.mocked(api.readGitRepository).mockRejectedValue({
        code: "outputTooLarge",
        message: "La sortie Git dépasse la limite de 8 Mio.",
      }),
  ],
])(
  "pauses automatic refresh after %s until an explicit refresh clears it",
  async (_, huge) => {
    huge();
    await render();
    expect(state.autoRefreshPaused).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.readGitRepository).toHaveBeenCalledTimes(1);

    await act(async () => state.refresh());
    expect(api.readGitRepository).toHaveBeenCalledTimes(2);
    expect(state.autoRefreshPaused).toBe(true);

    vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
    await act(async () => state.refresh());
    expect(state.autoRefreshPaused).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(api.readGitRepository).toHaveBeenCalledTimes(4);
  },
);
it("forces a cached truncated status to be read again when the panel reopens", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitRepository).mockResolvedValue({
    ...repository("huge"),
    limited: true,
    truncated: true,
  });
  const show = (visible: boolean) =>
    act(async () =>
      root.render(
        <Harness
          id="a"
          visible={visible}
          readCache={cache}
          readScope="scope"
        />,
      ),
    );
  await show(true);
  expect(state.autoRefreshPaused).toBe(true);
  await show(false);
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("small"));
  await show(true);
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.autoRefreshPaused).toBe(false);
});
it("rereads a cached truncated scope after another scope paused", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitRepository).mockResolvedValue({
    ...repository("huge"),
    limited: true,
    truncated: true,
  });
  const show = (id: string) =>
    act(async () =>
      root.render(
        <Harness id={id} visible readCache={cache} readScope={`scope-${id}`} />,
      ),
    );
  await show("a");
  await show("b");
  await show("a");
  const ids = vi.mocked(api.readGitRepository).mock.calls.map(([id]) => id);
  expect(ids).toEqual(["a", "b", "a"]);
});
it("stops loading after dismissing an oversized first read", async () => {
  vi.mocked(api.readGitRepository).mockRejectedValue({
    code: "outputTooLarge",
    message: "La sortie Git dépasse la limite de 8 Mio.",
  });
  await render();
  expect(state.autoRefreshPaused).toBe(true);
  await act(async () => state.dismissError());
  expect(state.repo).toBeNull();
  expect(state.loading).toBe(false);
});
it("shows a persisted SSH snapshot while revalidating it immediately", async () => {
  const freshRead = deferred<GitRepository>();
  vi.mocked(api.readGitRepository).mockImplementationOnce(
    () => freshRead.promise,
  );
  await act(async () =>
    root.render(
      <Harness
        id="ssh"
        visible
        readScope="scope"
        environmentKind="ssh"
        initialRepository={repository("persisted")}
      />,
    ),
  );
  expect(state.repo?.version).toBe("persisted");
  expect(state.hasFreshStatus).toBe(false);
  expect(state.revalidating).toBe(true);
  expect(state.loading).toBe(true);
  expect(api.readGitRepository).toHaveBeenCalledOnce();
  await act(async () => freshRead.resolve(repository("fresh")));
  expect(state.repo?.version).toBe("fresh");
  expect(state.hasFreshStatus).toBe(true);
  expect(state.revalidating).toBe(false);
});

it("preserves Git state while suspended and forces a hidden refresh on resume", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "kept"),
  );
  const view = (suspended: boolean) => (
    <Harness
      id="ssh"
      visible={!suspended}
      readCache={cache}
      readScope="scope"
      environmentKind="ssh"
      suspended={suspended}
    />
  );

  await act(async () => root.render(view(false)));
  await act(async () =>
    state.updateDraft({
      message: "keep draft",
      selection: { path: "a.ts", side: "unstaged" },
    }),
  );
  vi.mocked(api.readGitRepository).mockRejectedValueOnce(
    new Error("Disconnected"),
  );
  await act(async () => state.refresh());
  expect(state.error?.message).toBe("Disconnected");

  const statusRead = deferred<GitRepository>();
  const comparisonRead = deferred<GitComparison>();
  vi.mocked(api.readGitRepository).mockImplementationOnce(
    () => statusRead.promise,
  );
  vi.mocked(api.readGitComparison).mockImplementationOnce(
    () => comparisonRead.promise,
  );
  let pendingStatus!: Promise<void>;
  let pendingComparison!: Promise<void>;
  await act(async () => {
    pendingStatus = state.refresh();
    pendingComparison = state.loadComparison();
    await Promise.resolve();
  });
  await act(async () => root.render(view(true)));
  await act(async () => {
    statusRead.resolve(repository("ignored"));
    comparisonRead.resolve(comparison("a.ts", "ignored", "ignored"));
    await Promise.all([pendingStatus, pendingComparison]);
  });

  expect(state.repo?.version).toBe("1");
  expect(cache.peek("scope", gitReadKeys.repository)).toBeUndefined();
  expect(state.draft.message).toBe("keep draft");
  expect(state.diff?.before.text).toBe("kept");
  expect(state.error?.message).toBe("Disconnected");
  const repositoryReads = vi.mocked(api.readGitRepository).mock.calls.length;
  const comparisonReads = vi.mocked(api.readGitComparison).mock.calls.length;
  const work = vi.fn(async () => undefined);
  await act(async () => {
    await state.refresh();
    await state.loadComparison();
    await state.mutate(work);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(repositoryReads);
  expect(api.readGitComparison).toHaveBeenCalledTimes(comparisonReads);
  expect(work).not.toHaveBeenCalled();

  vi.mocked(api.readGitRepository).mockResolvedValueOnce(repository("2"));
  await act(async () =>
    root.render(
      <Harness
        id="ssh"
        visible={false}
        readCache={cache}
        readScope="scope"
        environmentKind="ssh"
        suspended={false}
      />,
    ),
  );
  expect(api.readGitRepository).toHaveBeenCalledTimes(repositoryReads + 1);
  expect(state.repo?.version).toBe("2");
  expect(state.error).toBeNull();
});

it("revalidates a hidden SSH snapshot once after disconnecting and reconnecting", async () => {
  const firstRead = deferred<GitRepository>();
  const secondRead = deferred<GitRepository>();
  vi.mocked(api.readGitRepository)
    .mockImplementationOnce(() => firstRead.promise)
    .mockImplementationOnce(() => secondRead.promise);
  const view = (id: string | undefined) => (
    <Harness
      id={id}
      visible={false}
      readScope={id ? "scope" : undefined}
      environmentKind="ssh"
      initialRepository={repository("persisted")}
    />
  );

  await act(async () => root.render(view(undefined)));
  expect(api.readGitRepository).not.toHaveBeenCalled();
  await act(async () => root.render(view("ssh")));
  expect(state.repo?.version).toBe("persisted");
  expect(state.hasFreshStatus).toBe(false);
  expect(api.readGitRepository).toHaveBeenCalledOnce();
  await act(async () => firstRead.resolve(repository("fresh")));
  expect(state.repo?.version).toBe("fresh");
  expect(state.hasFreshStatus).toBe(true);

  await act(async () => root.render(view(undefined)));
  expect(state.hasFreshStatus).toBe(false);
  await act(async () => root.render(view("ssh")));
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.hasFreshStatus).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.hasFreshStatus).toBe(false);
  await act(async () => secondRead.resolve(repository("reconnected")));
  expect(state.repo?.version).toBe("reconnected");
  expect(state.hasFreshStatus).toBe(true);
});

it("prefetches a hidden project once without starting its polling loop", async () => {
  await act(async () =>
    root.render(
      <Harness id="ssh-hidden" visible={false} environmentKind="ssh" />,
    ),
  );
  expect(api.readGitRepository).toHaveBeenCalledOnce();
  expect(state.repo?.version).toBe("1");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(api.readGitRepository).toHaveBeenCalledOnce();
});

it("polls SSH repositories less often without delaying the initial read", async () => {
  await act(async () =>
    root.render(<Harness id="ssh" visible environmentKind="ssh" />),
  );
  expect(api.readGitRepository).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(9_999));
  expect(api.readGitRepository).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
});
it("reuses scoped status synchronously on A to B to A and isolates a changed path or environment", async () => {
  const cache = createGitReadCache();
  vi.mocked(api.readGitRepository).mockImplementation(async () =>
    repository(String(vi.mocked(api.readGitRepository).mock.calls.length)),
  );
  await act(async () =>
    root.render(
      <Harness
        id="same"
        visible
        readCache={cache}
        readScope='["same","/a","local",null]'
      />,
    ),
  );
  expect(state.repo?.version).toBe("1");
  await act(async () =>
    root.render(
      <Harness
        id="same"
        visible
        readCache={cache}
        readScope='["same","/b","wsl","Ubuntu"]'
      />,
    ),
  );
  expect(state.repo?.version).toBe("2");
  const renderCount = renderedLoadings.length;
  await act(async () =>
    root.render(
      <Harness
        id="same"
        visible
        readCache={cache}
        readScope='["same","/a","local",null]'
      />,
    ),
  );
  expect(renderedLoadings[renderCount]).toBe(false);
  expect(state.repo?.version).toBe("1");
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
});

it("reports a branch read only when the repository was actually read", async () => {
  const cache = createGitReadCache();
  await cache.read("scope", gitReadKeys.repository, async () => ({
    ...repository("cached"),
    branch: "stale",
  }));
  await act(async () =>
    root.render(<Harness id="a" visible readCache={cache} readScope="scope" />),
  );
  expect(api.readGitRepository).not.toHaveBeenCalled();
  expect(state.repo?.version).toBe("cached");
  expect(state.hasFreshStatus).toBe(true);
  expect(state.branchRead).toBeNull();

  const startedAt = Date.now();
  await act(async () => state.refresh());
  expect(api.readGitRepository).toHaveBeenCalledOnce();
  expect(state.branchRead).toEqual({
    projectId: "a",
    branch: "main",
    startedAt,
  });
});

it("invalidates mutable reads and increments revision after an explicit same-version refresh", async () => {
  const cache = createGitReadCache();
  const scope = "scope";
  await cache.read(scope, gitReadKeys.branches, async () => ["cached"]);
  await act(async () =>
    root.render(<Harness id="a" visible readCache={cache} readScope={scope} />),
  );
  expect(state.revision).toBe(0);
  await act(async () => state.refresh());
  expect(cache.peek(scope, gitReadKeys.branches)).toBeUndefined();
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.repo?.version).toBe("1");
  expect(state.revision).toBe(1);
});

it("does not invalidate mutable reads or increment revision during normal polling", async () => {
  const cache = createGitReadCache();
  const scope = "scope";
  await cache.read(scope, gitReadKeys.branches, async () => ["cached"]);
  await act(async () =>
    root.render(<Harness id="a" visible readCache={cache} readScope={scope} />),
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(cache.peek(scope, gitReadKeys.branches)).toEqual(["cached"]);
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.revision).toBe(0);
});

it("does not publish an explicit refresh completed for an old scope", async () => {
  const cache = createGitReadCache();
  await act(async () =>
    root.render(
      <Harness id="same" visible readCache={cache} readScope="scope-a" />,
    ),
  );
  const oldRead = deferred<GitRepository>();
  vi.mocked(api.readGitRepository).mockImplementationOnce(
    () => oldRead.promise,
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = state.refresh();
    await Promise.resolve();
  });
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("scope-b"));
  await act(async () =>
    root.render(
      <Harness id="same" visible readCache={cache} readScope="scope-b" />,
    ),
  );
  await act(async () => {
    oldRead.resolve(repository("1"));
    await pending;
  });
  expect(state.repo?.version).toBe("scope-b");
  expect(state.revision).toBe(0);
});

it("invalidates mutable scoped reads before and after a failed mutation", async () => {
  const cache = createGitReadCache();
  const scope = "scope";
  await cache.read(scope, gitReadKeys.branches, async () => ["before"]);
  await cache.read(
    scope,
    gitReadKeys.history("head", 50),
    async () => "before",
  );
  await cache.read(
    scope,
    gitReadKeys.commitDetail("mutable"),
    async () => "before",
  );
  await cache.read(
    scope,
    gitReadKeys.commitComparison("mutable", "a.ts"),
    async () => "before",
  );
  await act(async () =>
    root.render(<Harness id="a" visible readCache={cache} readScope={scope} />),
  );
  await act(async () =>
    state.mutate(async () => {
      await cache.read(scope, gitReadKeys.remotes, async () => ["during"]);
      throw new Error("failed");
    }),
  );
  expect(cache.peek(scope, gitReadKeys.branches)).toBeUndefined();
  expect(cache.peek(scope, gitReadKeys.remotes)).toBeUndefined();
  expect(cache.peek(scope, gitReadKeys.history("head", 50))).toBeUndefined();
  expect(
    cache.peek(scope, gitReadKeys.commitDetail("mutable")),
  ).toBeUndefined();
  expect(
    cache.peek(scope, gitReadKeys.commitComparison("mutable", "a.ts")),
  ).toBeUndefined();
  expect(cache.peek(scope, gitReadKeys.repository)).toEqual(repository("1"));
  expect(state.error?.message).toBe("failed");
});

it("ignores delayed status from a previous project", async () => {
  const oldStatus = deferred<GitRepository>();
  vi.mocked(api.readGitRepository).mockImplementationOnce(
    () => oldStatus.promise,
  );
  await render("a");
  await render("b");
  await act(async () => oldStatus.resolve(repository("old-a")));
  expect(state.repo?.version).toBe("1");
});
it("reloads the selected diff once when polling finds a new repository version", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_id, path, _side, version) => comparison(path, version, version),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "1",
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.readGitComparison).toHaveBeenCalledTimes(1);

  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  expect(state.diff?.version).toBe("2");
  expect(state.stale).toBe(false);
});
it("keeps the newest diff when repository versions change faster than comparison responses", async () => {
  let repositoryVersion = "1";
  let resolveVersionTwo!: (value: GitComparison) => void;
  vi.mocked(api.readGitRepository).mockImplementation(async () =>
    repository(repositoryVersion),
  );
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_id, path, _side, version) => {
      if (version === "2")
        return new Promise((resolve) => {
          resolveVersionTwo = resolve;
        });
      return comparison(path, version, version);
    },
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );

  repositoryVersion = "2";
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(state.diff?.version).toBe("1");
  repositoryVersion = "3";
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(state.diff?.version).toBe("3");
  await act(async () => resolveVersionTwo(comparison("a.ts", "2", "late")));
  expect(state.diff?.version).toBe("3");
  expect(
    vi.mocked(api.readGitComparison).mock.calls.map((call) => call[3]),
  ).toEqual(["1", "2", "3"]);
});
it("reloads comparisons only when the selection changes or reload is explicit", async () => {
  const firstComparison = deferred<GitComparison>();
  vi.mocked(api.readGitComparison)
    .mockImplementationOnce(() => firstComparison.promise)
    .mockImplementation(async (_id, path) => comparison(path, "1", "hello"));
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(1);
  await act(async () =>
    firstComparison.resolve(comparison("a.ts", "1", "hello")),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(1);
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "staged" } }),
  );
  expect(api.readGitComparison).toHaveBeenNthCalledWith(
    2,
    "a",
    "a.ts",
    "staged",
    "1",
  );
  await act(async () => state.loadComparison());
  expect(api.readGitComparison).toHaveBeenNthCalledWith(
    3,
    "a",
    "a.ts",
    "staged",
    "1",
  );
});
it("reuses a same-version file synchronously when revisiting it", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(async (_id, path, side) =>
    comparison(path, "1", `${side}:${path}`),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "b.ts", side: "unstaged" } }),
  );
  const renderCount = renderedDiffs.length;
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(renderedDiffs[renderCount]?.before.text).toBe("unstaged:a.ts");
  expect(state.diff?.before.text).toBe("unstaged:a.ts");
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
});
it("isolates project caches even when repository versions and paths match", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(async (id, path) =>
    comparison(path, "1", id),
  );
  await render("a");
  await act(async () =>
    state.updateDraft({ selection: { path: "same.ts", side: "unstaged" } }),
  );
  await render("b");
  const renderCount = renderedDiffs.length;
  await act(async () =>
    state.updateDraft({ selection: { path: "same.ts", side: "unstaged" } }),
  );
  expect(renderedDiffs[renderCount]).toBeNull();
  expect(state.diff?.before.text).toBe("b");
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
});
it("shows a stale cached revisit while revalidating it", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(async (_id, path) =>
    comparison(path, "1", `old:${path}`),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "b.ts", side: "unstaged" } }),
  );
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  const freshComparison = deferred<GitComparison>();
  vi.mocked(api.readGitComparison).mockImplementationOnce(
    () => freshComparison.promise,
  );
  const renderCount = renderedDiffs.length;
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(renderedDiffs[renderCount]?.before.text).toBe("old:a.ts");
  expect(state.diff?.before.text).toBe("old:a.ts");
  expect(state.stale).toBe(true);
  expect(state.diffLoading).toBe(true);
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  await act(async () =>
    freshComparison.resolve(comparison("a.ts", "2", "new:a.ts")),
  );
  expect(state.diff?.before.text).toBe("new:a.ts");
  expect(state.stale).toBe(false);
});
it("forces explicit comparison refreshes while retaining the old diff pending", async () => {
  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "old"),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  const freshComparison = deferred<GitComparison>();
  vi.mocked(api.readGitComparison).mockImplementationOnce(
    () => freshComparison.promise,
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = state.loadComparison();
    await Promise.resolve();
  });
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
  expect(state.diff?.before.text).toBe("old");
  expect(state.diffLoading).toBe(true);
  await act(async () => {
    freshComparison.resolve(comparison("a.ts", "1", "fresh"));
    await pending;
  });
  expect(state.diff?.before.text).toBe("fresh");
});
it("clears stale-path refreshes from cache and permits a same-click retry", async () => {
  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "old"),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  vi.mocked(api.readGitComparison).mockRejectedValueOnce({
    code: "stalePath",
    message: "File disappeared",
  });
  const reads = vi.mocked(api.readGitRepository).mock.calls.length;
  await act(async () => state.loadComparison());
  expect(state.diff).toBeNull();
  expect(state.error).toBeNull();
  expect(api.readGitRepository).toHaveBeenCalledTimes(reads + 1);
  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "restored"),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(3);
  expect(state.diff?.before.text).toBe("restored");
});
it("re-reads the status without an error when a newer status drops the selection", async () => {
  vi.mocked(api.readGitComparison)
    .mockResolvedValueOnce(comparison("a.ts", "1", "version one"))
    .mockRejectedValueOnce({ code: "stalePath", message: "File disappeared" });
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(state.diff?.before.text).toBe("version one");

  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  expect(state.diff).toBeNull();
  expect(state.error).toBeNull();
});

it("retains the current diff after a transport error and permits a same-click retry", async () => {
  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "old"),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  vi.mocked(api.readGitComparison).mockRejectedValueOnce({
    message: "SSH connection lost",
  });
  await act(async () => state.loadComparison());
  expect(state.diff?.before.text).toBe("old");
  expect(state.error?.message).toBe("SSH connection lost");

  vi.mocked(api.readGitComparison).mockResolvedValueOnce(
    comparison("a.ts", "1", "fresh"),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(3);
  expect(state.diff?.before.text).toBe("fresh");
});
it("retries a failed comparison on the next version without duplicating the active read", async () => {
  let resolveRetry!: () => void;
  vi.mocked(api.readGitComparison)
    .mockRejectedValueOnce({ message: "Diff failed" })
    .mockImplementationOnce(
      (_id, path, _side, version) =>
        new Promise((resolve) => {
          resolveRetry = () => resolve(comparison(path, version));
        }),
    );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(state.diff).toBe(null);
  expect(state.error?.message).toBe("Diff failed");

  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(state.repo?.version).toBe("2");
  expect(state.error).toBe(null);
  expect(api.readGitComparison).toHaveBeenNthCalledWith(
    2,
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);

  await act(async () => resolveRetry());
  expect(state.diff?.version).toBe("2");
});
it("publishes a successful mutation only after its status read and skips branch invalidation on the same branch", async () => {
  const onMutation = vi.fn();
  await render("a", true, onMutation);
  const mutationRead = deferred<GitRepository>();
  vi.mocked(api.readGitRepository).mockImplementationOnce(
    () => mutationRead.promise,
  );
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = state.mutate(() => Promise.resolve("done"));
    await Promise.resolve();
  });
  expect(api.readGitRepository).toHaveBeenCalledTimes(2);
  expect(state.revision).toBe(0);
  expect(onMutation).not.toHaveBeenCalled();
  await act(async () => {
    mutationRead.resolve(repository("2"));
    await pending;
  });
  expect(state.repo?.version).toBe("2");
  expect(state.revision).toBe(1);
  expect(onMutation).not.toHaveBeenCalled();
});
it("publishes the fresh branch after status confirms it changed", async () => {
  const events: string[] = [];
  const onMutation = vi.fn(() => events.push("callback"));
  await render("a", true, onMutation);
  vi.mocked(api.readGitRepository).mockImplementationOnce(async () => {
    events.push("status");
    return { ...repository("2"), branch: "feature" };
  });
  await act(async () => {
    await state.mutate(() => Promise.resolve("done"));
  });
  expect(events).toEqual(["status", "callback"]);
  expect(onMutation).toHaveBeenCalledWith("a", "feature");
  expect(state.repo?.branch).toBe("feature");
});
it("falls back to branch invalidation after navigation or a failed post-mutation read", async () => {
  const onMutation = vi.fn();
  await render("a", true, onMutation);
  const mutation = deferred<void>();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = state.mutate(() => mutation.promise);
  });
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("project-b"));
  await render("b", true, onMutation);
  await act(async () => {
    mutation.resolve();
    await pending;
  });
  expect(state.repo?.version).toBe("project-b");
  expect(onMutation).toHaveBeenNthCalledWith(1, "a", undefined);

  vi.mocked(api.readGitRepository).mockRejectedValueOnce({
    message: "refresh failed",
  });
  await act(async () => {
    await state.mutate(() => Promise.resolve("done"));
  });
  expect(onMutation).toHaveBeenNthCalledWith(2, "b", undefined);
});
it("locks every mutation after close preparation until cancellation without reporting pending work", async () => {
  await render();
  const work = vi.fn().mockResolvedValue("done");
  expect(state.hasPendingMutation()).toBe(false);
  expect(state.prepareClose()).toBe(true);
  expect(state.isBusy()).toBe(true);
  await act(async () => {
    expect(await state.mutate(work)).toBeUndefined();
  });
  expect(work).not.toHaveBeenCalled();
  expect(state.hasPendingMutation()).toBe(false);
  state.cancelClose();
  expect(state.isBusy()).toBe(false);
  await act(async () => {
    expect(await state.mutate(work)).toBe("done");
  });
  expect(work).toHaveBeenCalledOnce();
});
it("clears only the captured project's unchanged committed message", async () => {
  await render("a");
  await act(async () => state.updateDraft({ message: "committed" }));
  const clearA = state.clearCommittedMessage;
  await act(async () => state.updateDraft({ message: "new draft" }));
  await act(async () => clearA("committed"));
  expect(state.draft.message).toBe("new draft");
  await render("b");
  await act(async () => state.updateDraft({ message: "project b" }));
  await act(async () => clearA("new draft"));
  expect(state.draft.message).toBe("project b");
  await render("a");
  expect(state.draft.message).toBe("");
});
it("loads a selection deferred by a mutation once while retaining project selections", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_id, path, _side, version) => comparison(path, version),
  );
  await render("a");
  const mutation = deferred<void>();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = state.mutate(() => mutation.promise);
  });
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).not.toHaveBeenCalled();
  await act(async () => {
    mutation.resolve();
    await pending;
  });
  expect(api.readGitComparison).toHaveBeenCalledExactlyOnceWith(
    "a",
    "a.ts",
    "unstaged",
    "1",
  );
  expect(state.diff?.path).toBe("a.ts");
  await render("b");
  await act(async () =>
    state.updateDraft({ selection: { path: "b.ts", side: "staged" } }),
  );
  await render("a");
  expect(state.draft.selection).toEqual({ path: "a.ts", side: "unstaged" });
});
it("waits for a mutation to finish before reloading the same selection", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_id, path, _side, version) => comparison(path, version, version),
  );
  await render("a");
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  const mutation = deferred<void>();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = state.mutate(() => mutation.promise);
  });
  expect(api.readGitComparison).toHaveBeenCalledTimes(1);

  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => {
    mutation.resolve();
    await pending;
  });
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  expect(state.diff?.version).toBe("2");
});
it("does not read a hidden comparison and reloads it after reopening", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(
    async (_id, path, _side, version) => comparison(path, version, version),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await render("a", false);
  vi.mocked(api.readGitRepository).mockResolvedValue(repository("2"));
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.readGitRepository).toHaveBeenCalledTimes(1);
  expect(api.readGitComparison).toHaveBeenCalledTimes(1);

  await render("a", true);
  expect(api.readGitComparison).toHaveBeenCalledTimes(2);
  expect(api.readGitComparison).toHaveBeenLastCalledWith(
    "a",
    "a.ts",
    "unstaged",
    "2",
  );
  expect(state.diff?.version).toBe("2");
});
it("serializes clicks and preserves errors and draft after an uncertain mutation", async () => {
  await render();
  await act(async () => state.updateDraft({ message: "keep" }));
  let reject!: (reason: unknown) => void;
  const work = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let first!: Promise<unknown>;
  await act(async () => {
    first = state.mutate(work);
  });
  await act(async () => {
    await state.mutate(work);
  });
  expect(work).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject({ message: "timeout", uncertain: true });
    await first;
  });
  expect(state.error?.uncertain).toBe(true);
  expect(state.draft.message).toBe("keep");
  expect(state.busy).toBe(false);
});
it("keeps ordinary mutation failures through refresh and project navigation", async () => {
  await render();
  await act(async () =>
    state.mutate(() => Promise.reject({ message: "Hook refused" })),
  );
  expect(state.error?.message).toBe("Hook refused");
  await render("b");
  expect(state.error).toBe(null);
  await render("a");
  expect(state.error?.message).toBe("Hook refused");
  await act(async () => state.dismissError());
  expect(state.error).toBe(null);
});
it("preserves mutation and read diagnostics until each one is resolved", async () => {
  await render();
  vi.mocked(api.readGitRepository).mockRejectedValueOnce({
    message: "Reload failed",
  });
  await act(async () =>
    state.mutate(() => Promise.reject({ message: "Push refused" })),
  );
  expect(state.error).toEqual({
    message: "Push refused",
    uncertain: false,
    source: "mutation",
    readError: "Reload failed",
  });

  await act(async () => state.dismissError());
  expect(state.error).toEqual({
    message: "Reload failed",
    uncertain: false,
    source: "read",
  });

  vi.mocked(api.readGitRepository).mockRejectedValueOnce({
    message: "Still unreadable",
  });
  await act(async () =>
    state.mutate(() => Promise.reject({ message: "Push refused again" })),
  );
  expect(state.error?.readError).toBe("Still unreadable");
  await act(async () => state.refresh());
  expect(state.error).toEqual({
    message: "Push refused again",
    uncertain: false,
    source: "mutation",
  });
});
it("retains a mutation error for its source project if navigation occurs during the operation", async () => {
  await render();
  let reject!: (reason: unknown) => void;
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = state.mutate(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
  });
  await render("b");
  await act(async () => {
    reject({ message: "Source failed" });
    await pending;
  });
  expect(state.error).toBe(null);
  await render("a");
  expect(state.error?.message).toBe("Source failed");
});
it("ignores delayed comparisons after selection changes and clears deleted-file previews", async () => {
  const goneComparison = deferred<GitComparison>();
  vi.mocked(api.readGitComparison).mockImplementationOnce(
    () => goneComparison.promise,
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "gone.ts", side: "unstaged" } }),
  );
  vi.mocked(api.readGitComparison).mockRejectedValue({
    code: "stalePath",
    message: "File disappeared",
  });
  await act(async () =>
    state.updateDraft({ selection: { path: "next.ts", side: "unstaged" } }),
  );
  const content = {
    text: "old",
    oid: null,
    size: 3,
    mode: "100644",
    reason: null,
  };
  await act(async () =>
    goneComparison.resolve({
      path: "gone.ts",
      oldPath: null,
      version: "1",
      before: content,
      after: content,
    }),
  );
  expect(state.diff).toBe(null);
  expect(state.error).toBeNull();
});
it("invalidates the origin project's comparison cache before a failed mutation", async () => {
  vi.mocked(api.readGitComparison).mockImplementation(async (_id, path) =>
    comparison(path),
  );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "b.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.mutate(() => Promise.reject({ message: "Rejected" })),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(api.readGitComparison).toHaveBeenCalledTimes(3);
});
it("does not cache a late response from an abandoned selection", async () => {
  const lateComparison = deferred<GitComparison>();
  vi.mocked(api.readGitComparison)
    .mockImplementationOnce(() => lateComparison.promise)
    .mockImplementation(async (_id, path) =>
      comparison(path, "1", `fresh:${path}`),
    );
  await render();
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  await act(async () =>
    state.updateDraft({ selection: { path: "b.ts", side: "unstaged" } }),
  );
  await act(async () =>
    lateComparison.resolve(comparison("a.ts", "1", "late")),
  );
  const renderCount = renderedDiffs.length;
  await act(async () =>
    state.updateDraft({ selection: { path: "a.ts", side: "unstaged" } }),
  );
  expect(renderedDiffs[renderCount]).toBeNull();
  expect(api.readGitComparison).toHaveBeenCalledTimes(3);
  expect(state.diff?.before.text).toBe("fresh:a.ts");
});
it("coalesces focus refreshes without creating additional polling loops", async () => {
  await render();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  const count = vi.mocked(api.readGitRepository).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.readGitRepository).toHaveBeenCalledTimes(count + 2);
});
it("shows failed reads without representing them as loading or a clean repository", async () => {
  vi.mocked(api.readGitRepository).mockRejectedValue({
    message: "Git missing",
  });
  await render();
  expect(state.repo).toBe(null);
  expect(state.error?.message).toBe("Git missing");
  expect(state.loading).toBe(false);
});
