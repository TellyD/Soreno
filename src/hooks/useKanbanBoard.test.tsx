// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../data/kanbanApi";
import type {
  KanbanBoard,
  KanbanIssue,
  KanbanIssueCreateInput,
  KanbanIssuePatch,
  KanbanIssueUpdate,
  KanbanLabel,
  KanbanSource,
  LinearKanbanBoard,
} from "../domain/kanban";
import { useKanbanBoard } from "./useKanbanBoard";
import { deferred } from "../testing/deferred";

vi.mock("../data/kanbanApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  loadKanbanBoard: vi.fn(),
  loadLinearKanbanBoard: vi.fn(),
  listLinearWorkspaces: vi.fn(),
  setLinearApiKey: vi.fn(),
  clearLinearApiKey: vi.fn(),
  createKanbanLabel: vi.fn(),
  updateKanbanIssue: vi.fn(),
  createKanbanIssue: vi.fn(),
  deleteKanbanIssue: vi.fn(),
  transferKanbanIssueToLinear: vi.fn(),
}));

const board: KanbanBoard = {
  source: "local",
  team: { id: "t1", key: "ACM", name: "Acme" },
  states: [
    { id: "todo", name: "Todo", type: "unstarted", color: "#888", position: 0 },
    { id: "doing", name: "Doing", type: "started", color: "#888", position: 1 },
    { id: "done", name: "Done", type: "completed", color: "#888", position: 2 },
  ],
  labels: [{ id: "l-bug", name: "Bug", color: "#f00" }],
  issues: [
    {
      source: "local",
      id: "i1",
      identifier: "ACM-1",
      title: "Issue",
      priority: 0,
      stateId: "todo",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      project: null,
      labels: [],
      pullRequests: [],
    },
  ],
};

function updated(
  fields: Partial<KanbanIssueUpdate> & { updatedAt: string },
): KanbanIssueUpdate {
  return {
    id: "i1",
    title: "Issue",
    stateId: "todo",
    priority: 0,
    project: null,
    labels: [],
    ...fields,
  };
}

let root: Root;
let container: HTMLDivElement;
let kanban: {
  applyServerUpdate: (
    source: KanbanSource,
    response: KanbanIssueUpdate,
  ) => void;
  board: KanbanBoard | null;
  connectLinear: (apiKey: string) => Promise<void>;
  createIssue: (
    source: KanbanSource,
    input: KanbanIssueCreateInput,
  ) => Promise<KanbanIssue>;
  createLabel: (
    source: KanbanSource,
    teamId: string,
    name: string,
  ) => Promise<KanbanLabel>;
  deleteIssue: (issue: KanbanIssue) => Promise<void>;
  disconnectLinear: (workspaceId: string) => Promise<void>;
  error: unknown;
  issues: readonly KanbanIssue[];
  linear: LinearKanbanBoard | null;
  linearConnected: boolean;
  linearError: unknown;
  reload: (source?: KanbanSource) => void;
  transferIssue: (
    issue: KanbanIssue,
    input: KanbanIssueCreateInput,
    comments: { id: string; body: string }[],
    sourceDescription: string | null,
  ) => Promise<KanbanIssue>;
  updateIssue: (issue: KanbanIssue, patch: KanbanIssuePatch) => Promise<void>;
};
function Harness({
  linearTeamId = null,
  visible = true,
}: {
  linearTeamId?: string | null;
  visible?: boolean;
}) {
  kanban = useKanbanBoard({ linearTeamId, visible });
  return null;
}
const issue = () => kanban.board!.issues[0];

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
  vi.mocked(api.loadKanbanBoard).mockResolvedValue(structuredClone(board));
  vi.mocked(api.listLinearWorkspaces).mockResolvedValue([]);
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("moves optimistically and restores the previous state when the backend refuses", async () => {
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  let move!: Promise<void>;
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });
  expect(issue().stateId).toBe("done");

  const failure = new Error("Issue introuvable.");
  await act(async () => {
    request.reject(failure);
    await expect(move).rejects.toBe(failure);
  });
  expect(issue()).toMatchObject({
    stateId: "todo",
    updatedAt: "2026-08-01T10:00:00.000Z",
  });
});

it("keeps a later move when an earlier move of the same issue settles afterwards", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let firstMove!: Promise<void>;
  let secondMove!: Promise<void>;
  act(() => {
    firstMove = kanban.updateIssue(issue(), { stateId: "done" });
  });
  vi.setSystemTime(new Date("2026-09-27T10:00:01.000Z"));
  act(() => {
    secondMove = kanban.updateIssue(issue(), { stateId: "doing" });
  });

  await act(async () => {
    first.reject(new Error("timeout"));
    await firstMove.catch(() => {});
  });
  expect(issue().stateId).toBe("doing");

  await act(async () => {
    second.resolve(
      updated({
        stateId: "doing",
        priority: 0,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await secondMove;
  });
  expect(issue()).toMatchObject({
    stateId: "doing",
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("restores the last confirmed state when chained moves all fail", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let firstMove!: Promise<void>;
  let secondMove!: Promise<void>;
  act(() => {
    firstMove = kanban.updateIssue(issue(), { stateId: "doing" });
  });
  act(() => {
    secondMove = kanban.updateIssue(issue(), { stateId: "done" });
  });
  expect(issue().stateId).toBe("done");

  await act(async () => {
    first.reject(new Error("timeout"));
    await expect(firstMove).resolves.toBeUndefined();
  });
  expect(issue().stateId).toBe("done");

  const failure = new Error("Issue introuvable.");
  await act(async () => {
    second.reject(failure);
    await expect(secondMove).rejects.toBe(failure);
  });
  expect(issue()).toMatchObject({
    stateId: "todo",
    updatedAt: "2026-08-01T10:00:00.000Z",
  });
});

it("sends a chained move only after the previous one settles", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let secondMove!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { stateId: "doing" });
  });
  act(() => {
    secondMove = kanban.updateIssue(issue(), { stateId: "done" });
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(1);

  await act(async () => {
    first.resolve(
      updated({
        stateId: "doing",
        priority: 0,
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    stateId: "done",
  });
  expect(issue().stateId).toBe("done");

  await act(async () => {
    second.resolve(
      updated({
        stateId: "done",
        priority: 0,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await secondMove;
  });
  expect(issue()).toMatchObject({
    stateId: "done",
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("keeps a move when a reload started before it resolves afterwards", async () => {
  const pendingReload = deferred<KanbanBoard>();
  const lateReload = deferred<KanbanBoard>();
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.loadKanbanBoard)
    .mockReturnValueOnce(pendingReload.promise)
    .mockReturnValueOnce(lateReload.promise);
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  act(() => kanban.reload());
  let move!: Promise<void>;
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });
  await act(async () => pendingReload.resolve(structuredClone(board)));
  expect(issue().stateId).toBe("done");

  act(() => kanban.reload());
  await act(async () => {
    request.resolve(
      updated({
        stateId: "done",
        priority: 0,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await move;
  });
  await act(async () => lateReload.resolve(structuredClone(board)));
  expect(issue()).toMatchObject({
    stateId: "done",
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("keeps a server update applied during an update when a stale reload resolves afterwards", async () => {
  const staleReload = deferred<KanbanBoard>();
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(staleReload.promise);
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  act(() => kanban.reload());
  let change!: Promise<void>;
  act(() => {
    change = kanban.updateIssue(issue(), { priority: 2 });
  });
  act(() =>
    kanban.applyServerUpdate(
      "local",
      updated({
        stateId: "doing",
        priority: 2,
        updatedAt: "2026-09-27T10:00:05.000Z",
      }),
    ),
  );
  await act(async () => {
    request.resolve(
      updated({ priority: 2, updatedAt: "2026-09-27T10:00:01.000Z" }),
    );
    await change;
  });
  expect(issue().stateId).toBe("doing");

  await act(async () => staleReload.resolve(structuredClone(board)));
  expect(issue()).toMatchObject({
    stateId: "doing",
    updatedAt: "2026-09-27T10:00:05.000Z",
  });
});

it("restores the state a reload saw when a pending move fails", async () => {
  const reloaded = deferred<KanbanBoard>();
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(reloaded.promise);
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  let move!: Promise<void>;
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });
  act(() => kanban.reload());
  const doing = structuredClone(board);
  Object.assign(doing.issues[0], {
    stateId: "doing",
    updatedAt: "2026-09-27T09:00:00.000Z",
  });
  await act(async () => reloaded.resolve(doing));
  expect(issue().stateId).toBe("done");

  const failure = new Error("Issue introuvable.");
  await act(async () => {
    request.reject(failure);
    await expect(move).rejects.toBe(failure);
  });
  expect(issue()).toMatchObject({
    stateId: "doing",
    updatedAt: "2026-09-27T09:00:00.000Z",
  });
});

it("keeps a newer reloaded state over a late move response", async () => {
  const reloaded = deferred<KanbanBoard>();
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(reloaded.promise);
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  let move!: Promise<void>;
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });
  act(() => kanban.reload());
  const doing = structuredClone(board);
  Object.assign(doing.issues[0], {
    stateId: "doing",
    updatedAt: "2026-09-27T10:00:05.000Z",
  });
  await act(async () => reloaded.resolve(doing));

  await act(async () => {
    request.resolve(
      updated({
        stateId: "done",
        priority: 0,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await move;
  });
  expect(issue()).toMatchObject({
    stateId: "doing",
    updatedAt: "2026-09-27T10:00:05.000Z",
  });
});

it("changes the priority optimistically, then applies the backend's response", async () => {
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);

  let change!: Promise<void>;
  act(() => {
    change = kanban.updateIssue(issue(), { priority: 2 });
  });
  expect(issue()).toMatchObject({
    priority: 2,
    updatedAt: "2026-08-01T10:00:00.000Z",
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    priority: 2,
  });

  await act(async () => {
    request.resolve(
      updated({
        stateId: "todo",
        priority: 2,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await change;
  });
  expect(issue()).toMatchObject({
    priority: 2,
    stateId: "todo",
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("keeps a confirmed priority's timestamp when a queued move fails", async () => {
  const priorityRequest = deferred<KanbanIssueUpdate>();
  const moveRequest = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(priorityRequest.promise)
    .mockReturnValueOnce(moveRequest.promise);

  let move!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { priority: 2 });
  });
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });
  await act(async () => {
    priorityRequest.resolve(
      updated({
        stateId: "todo",
        priority: 2,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    stateId: "done",
  });

  const failure = new Error("Issue introuvable.");
  await act(async () => {
    moveRequest.reject(failure);
    await expect(move).rejects.toBe(failure);
  });
  expect(issue()).toMatchObject({
    stateId: "todo",
    priority: 2,
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("sends queued state and priority changes together", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let move!: Promise<void>;
  let change!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { stateId: "doing" });
  });
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
    change = kanban.updateIssue(issue(), { priority: 3 });
  });
  expect(issue()).toMatchObject({ stateId: "done", priority: 3 });

  await act(async () => {
    first.resolve(
      updated({
        stateId: "doing",
        priority: 0,
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    stateId: "done",
    priority: 3,
  });

  await act(async () => {
    second.resolve(
      updated({
        stateId: "done",
        priority: 3,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await Promise.all([move, change]);
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(2);
  expect(issue()).toMatchObject({
    stateId: "done",
    priority: 3,
    updatedAt: "2026-09-27T10:00:02.000Z",
  });
});

it("keeps an external priority change reported while moves are queued", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let move!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { stateId: "doing" });
  });
  act(() => {
    move = kanban.updateIssue(issue(), { stateId: "done" });
  });

  await act(async () => {
    first.resolve(
      updated({
        stateId: "doing",
        priority: 2,
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    stateId: "done",
  });
  expect(issue()).toMatchObject({ stateId: "done", priority: 2 });

  await act(async () => {
    second.resolve(
      updated({
        stateId: "done",
        priority: 2,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await move;
  });
  expect(issue()).toMatchObject({ stateId: "done", priority: 2 });
});

it("keeps an external state change reloaded while priority changes are queued", async () => {
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const external = structuredClone(board);
  Object.assign(external.issues[0], {
    stateId: "doing",
    updatedAt: "2026-09-27T10:00:01.000Z",
  });
  vi.mocked(api.loadKanbanBoard).mockResolvedValueOnce(external);

  let change!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { priority: 1 });
  });
  act(() => {
    change = kanban.updateIssue(issue(), { priority: 4 });
  });
  await act(async () => kanban.reload());
  expect(issue()).toMatchObject({ stateId: "doing", priority: 4 });

  await act(async () => {
    first.resolve(
      updated({
        stateId: "doing",
        priority: 1,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    priority: 4,
  });

  await act(async () => {
    second.resolve(
      updated({
        stateId: "doing",
        priority: 4,
        updatedAt: "2026-09-27T10:00:03.000Z",
      }),
    );
    await change;
  });
  expect(issue()).toMatchObject({ stateId: "doing", priority: 4 });
});

it("sends queued label toggles as a diff against the latest confirmed labels", async () => {
  const bug = { id: "l-bug", name: "Bug", color: "#f00" };
  const ui = { id: "l-ui", name: "UI", color: "#0f0" };
  const external = { id: "l-ext", name: "External", color: "#00f" };
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  let toggle!: Promise<void>;
  act(() => {
    void kanban.updateIssue(issue(), { labels: [bug] });
  });
  act(() => {
    toggle = kanban.updateIssue(issue(), { labels: [bug, ui] });
  });
  expect(issue().labels).toEqual([bug, ui]);
  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    addedLabelIds: ["l-bug"],
  });

  await act(async () => {
    first.resolve(
      updated({
        labels: [bug, external],
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l-ui"],
  });
  expect(issue().labels).toEqual([bug, external, ui]);

  await act(async () => {
    second.resolve(
      updated({
        labels: [bug, external, ui],
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await toggle;
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(2);
  expect(issue().labels).toEqual([bug, external, ui]);
});

const created: KanbanIssue = {
  ...board.issues[0],
  id: "i2",
  identifier: "ACM-2",
  title: "Created",
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
};

it("adds a created issue to the board and returns it", async () => {
  vi.mocked(api.createKanbanIssue).mockResolvedValueOnce(created);

  let result: KanbanIssue | undefined;
  await act(async () => {
    result = await kanban.createIssue("local", {
      teamId: "t1",
      title: "Created",
    });
  });

  expect(api.createKanbanIssue).toHaveBeenCalledWith("local", {
    teamId: "t1",
    title: "Created",
  });
  expect(result).toEqual(created);
  expect(kanban.board!.issues.map(({ id }) => id)).toEqual(["i2", "i1"]);
});

it("does not duplicate a created issue that a reload already listed", async () => {
  const request = deferred<KanbanIssue>();
  vi.mocked(api.createKanbanIssue).mockReturnValueOnce(request.promise);
  const reloaded = structuredClone(board);
  reloaded.issues.push(created);
  vi.mocked(api.loadKanbanBoard).mockResolvedValueOnce(reloaded);

  let creation!: Promise<KanbanIssue>;
  act(() => {
    creation = kanban.createIssue("local", { teamId: "t1", title: "Created" });
  });
  await act(async () => kanban.reload());
  await act(async () => {
    request.resolve(created);
    await creation;
  });

  expect(kanban.board!.issues.map(({ id }) => id)).toEqual(["i1", "i2"]);
});

it("keeps a created issue when a reload started before the creation resolves afterwards", async () => {
  const staleReload = deferred<KanbanBoard>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(staleReload.promise);
  vi.mocked(api.createKanbanIssue).mockResolvedValueOnce(created);

  act(() => kanban.reload());
  await act(async () => {
    await kanban.createIssue("local", { teamId: "t1", title: "Created" });
  });
  await act(async () => staleReload.resolve(structuredClone(board)));

  expect(kanban.board!.issues.map(({ id }) => id)).toEqual(["i2", "i1"]);

  await act(async () => kanban.reload());

  expect(kanban.board!.issues.map(({ id }) => id)).toEqual(["i1"]);
});

it("rejects a failed creation without touching the board", async () => {
  const failure = new Error("Issue introuvable.");
  vi.mocked(api.createKanbanIssue).mockRejectedValueOnce(failure);
  const before = kanban.board;

  await act(async () => {
    await expect(
      kanban.createIssue("local", { teamId: "t1", title: "Created" }),
    ).rejects.toBe(failure);
  });

  expect(kanban.board).toBe(before);
});

it("adds a created label to the board labels once, sorted by name", async () => {
  const docs = { id: "l-docs", name: "docs", color: "#26b5ce" };
  vi.mocked(api.createKanbanLabel).mockResolvedValue(docs);

  await act(async () => {
    await expect(kanban.createLabel("local", "t1", "docs")).resolves.toEqual(
      docs,
    );
  });
  await act(async () => {
    await kanban.createLabel("local", "t1", "Docs");
  });

  expect(api.createKanbanLabel).toHaveBeenCalledWith("local", "t1", "docs");
  expect(kanban.board!.labels.map(({ id }) => id)).toEqual(["l-bug", "l-docs"]);
});

it("keeps a created label when a reload started before the creation resolves afterwards", async () => {
  const apiLabel = { id: "l-api", name: "API", color: "#26b5ce" };
  const staleReload = deferred<KanbanBoard>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(staleReload.promise);
  vi.mocked(api.createKanbanLabel).mockResolvedValueOnce(apiLabel);

  act(() => kanban.reload());
  await act(async () => {
    await kanban.createLabel("local", "t1", "API");
  });
  await act(async () => staleReload.resolve(structuredClone(board)));

  expect(kanban.board!.labels.map(({ id }) => id)).toEqual(["l-api", "l-bug"]);

  vi.mocked(api.loadKanbanBoard).mockResolvedValueOnce({
    ...structuredClone(board),
    labels: [apiLabel, ...structuredClone(board.labels)],
  });
  await act(async () => kanban.reload());

  expect(kanban.board!.labels.map(({ id }) => id)).toEqual(["l-api", "l-bug"]);

  // A snapshot requested after the creation is authoritative.
  await act(async () => kanban.reload());

  expect(kanban.board!.labels.map(({ id }) => id)).toEqual(["l-bug"]);
});

it("removes a deleted issue from the board", async () => {
  vi.mocked(api.deleteKanbanIssue).mockResolvedValueOnce();

  await act(async () => kanban.deleteIssue(issue()));

  expect(api.deleteKanbanIssue).toHaveBeenCalledWith("local", "i1");
  expect(kanban.board!.issues).toEqual([]);
});

it("keeps a deleted issue gone when a reload started before the deletion resolves afterwards", async () => {
  const staleReload = deferred<KanbanBoard>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(staleReload.promise);
  vi.mocked(api.deleteKanbanIssue).mockResolvedValueOnce();

  act(() => kanban.reload());
  await act(async () => kanban.deleteIssue(issue()));
  await act(async () => staleReload.resolve(structuredClone(board)));

  expect(kanban.board!.issues).toEqual([]);

  vi.mocked(api.loadKanbanBoard).mockResolvedValueOnce({
    ...structuredClone(board),
    issues: [],
  });
  await act(async () => kanban.reload());

  expect(kanban.board!.issues).toEqual([]);

  // A snapshot requested after the deletion is authoritative.
  await act(async () => kanban.reload());

  expect(kanban.board!.issues.map(({ id }) => id)).toEqual(["i1"]);
});

it("rejects a failed deletion without touching the board", async () => {
  const failure = new Error("Issue introuvable.");
  vi.mocked(api.deleteKanbanIssue).mockRejectedValueOnce(failure);
  const before = kanban.board;

  await act(async () => {
    await expect(kanban.deleteIssue(issue())).rejects.toBe(failure);
  });

  expect(kanban.board).toBe(before);
});

it("drops updates of an issue deleted while they were queued", async () => {
  const request = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue).mockReturnValueOnce(request.promise);
  vi.mocked(api.deleteKanbanIssue).mockResolvedValueOnce();

  let sent!: Promise<void>;
  let queued!: Promise<void>;
  act(() => {
    sent = kanban.updateIssue(issue(), { stateId: "doing" });
  });
  act(() => {
    queued = kanban.updateIssue(issue(), { stateId: "done" });
  });
  await act(async () => kanban.deleteIssue(issue()));
  await expect(queued).resolves.toBeUndefined();

  await act(async () => {
    request.reject(new Error("issue not found"));
    await expect(sent).resolves.toBeUndefined();
  });

  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(1);
  expect(kanban.board!.issues).toEqual([]);
});

const acme = { id: "w1", name: "Acme" };

const linearBoard: LinearKanbanBoard = {
  source: "linear",
  teams: [{ id: "lt", key: "ENG", name: "Engineering", workspace: "Acme" }],
  team: { id: "lt", key: "ENG", name: "Engineering" },
  states: [
    {
      id: "l-todo",
      name: "Todo",
      type: "unstarted",
      color: "#888",
      position: 0,
    },
    {
      id: "l-done",
      name: "Done",
      type: "completed",
      color: "#888",
      position: 1,
    },
  ],
  labels: [],
  issues: [
    {
      ...board.issues[0],
      source: "linear",
      id: "L1",
      identifier: "ENG-1",
      stateId: "l-todo",
    },
  ],
  truncated: false,
  linkedProjectIds: [],
  members: [],
};

async function flush() {
  await act(async () => {
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
  });
}

async function mountConnected(visible = true) {
  vi.mocked(api.listLinearWorkspaces).mockResolvedValue([acme]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    root.render(<Harness linearTeamId="lt" visible={visible} />),
  );
  await flush();
}

it("keeps local issues shown when Linear fails", async () => {
  const failure = new Error(
    "[Kanban/linearAuth] Linear a refusé la clé d’API.",
  );
  vi.mocked(api.loadLinearKanbanBoard).mockRejectedValue(failure);

  await mountConnected();

  expect(api.loadLinearKanbanBoard).toHaveBeenCalledWith("lt");
  expect(kanban).toMatchObject({
    error: null,
    linear: null,
    linearConnected: true,
    linearError: failure,
  });
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1"]);
});

it("shows local and Linear issues together", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );

  await mountConnected();

  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L1"]);
});

it("reloads only the requested source", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );
  await mountConnected();
  vi.mocked(api.loadKanbanBoard).mockClear();
  vi.mocked(api.loadLinearKanbanBoard).mockClear();

  await act(async () => kanban.reload("local"));
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(1);
  expect(api.loadLinearKanbanBoard).not.toHaveBeenCalled();

  await act(async () => kanban.reload("linear"));
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(1);
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(1);

  await act(async () => kanban.reload());
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(2);
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(2);
});

it("refreshes the team chosen after the first team was loaded by default", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );
  vi.mocked(api.listLinearWorkspaces).mockResolvedValue([acme]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness linearTeamId={null} />));
  await flush();
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledExactlyOnceWith(null);

  await act(async () => root.render(<Harness linearTeamId="lt" />));
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(1);

  await act(async () => kanban.reload());
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(2);
  expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith("lt");
});

it("refreshes Linear on focus and every 5 minutes, only while shown", async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const loads = () => vi.mocked(api.loadLinearKanbanBoard).mock.calls.length;
  const fiveMinutes = 5 * 60 * 1000;
  try {
    vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
      structuredClone(linearBoard),
    );
    await mountConnected();
    expect(loads()).toBe(1);

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(loads()).toBe(2);
    await act(async () => vi.advanceTimersByTime(fiveMinutes));
    expect(loads()).toBe(3);

    visibility = "hidden";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTime(fiveMinutes * 2));
    expect(loads()).toBe(3);

    visibility = "visible";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(loads()).toBe(4);
    // The same return also focuses the window: one read only.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(loads()).toBe(4);

    await act(async () =>
      root.render(<Harness linearTeamId="lt" visible={false} />),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTime(fiveMinutes * 2));
    expect(loads()).toBe(4);
    expect(api.loadKanbanBoard).toHaveBeenCalledTimes(2);

    // Shown again before the next interval: the board must not stay stale.
    vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue({
      ...structuredClone(linearBoard),
      issues: [{ ...linearBoard.issues[0], id: "L2" }],
    });
    await act(async () => root.render(<Harness linearTeamId="lt" visible />));
    await flush();
    expect(loads()).toBe(5);
    expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L2"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

it("keeps a Linear update when an older Linear snapshot resolves afterwards", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValueOnce(
    structuredClone(linearBoard),
  );
  await mountConnected();
  const staleReload = deferred<LinearKanbanBoard>();
  vi.mocked(api.loadLinearKanbanBoard).mockReturnValueOnce(staleReload.promise);
  vi.mocked(api.updateKanbanIssue).mockResolvedValueOnce(
    updated({
      id: "L1",
      stateId: "l-done",
      updatedAt: "2026-09-27T10:00:01.000Z",
    }),
  );

  act(() => kanban.reload());
  await act(async () =>
    kanban.updateIssue(kanban.linear!.issues[0], { stateId: "l-done" }),
  );
  await act(async () => staleReload.resolve(structuredClone(linearBoard)));

  expect(api.updateKanbanIssue).toHaveBeenCalledWith("linear", "L1", {
    stateId: "l-done",
  });
  expect(kanban.linear!.issues[0]).toMatchObject({
    stateId: "l-done",
    updatedAt: "2026-09-27T10:00:01.000Z",
  });
  expect(kanban.board!.issues[0].stateId).toBe("todo");
});

it("moves a transferred issue to Linear even when older snapshots resolve afterwards", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValueOnce(
    structuredClone(linearBoard),
  );
  await mountConnected();
  const staleLocal = deferred<KanbanBoard>();
  const staleLinear = deferred<LinearKanbanBoard>();
  vi.mocked(api.loadKanbanBoard).mockReturnValueOnce(staleLocal.promise);
  vi.mocked(api.loadLinearKanbanBoard).mockReturnValueOnce(staleLinear.promise);
  const transferred: KanbanIssue = {
    ...linearBoard.issues[0],
    id: "L2",
    identifier: "ENG-2",
  };
  vi.mocked(api.transferKanbanIssueToLinear).mockResolvedValueOnce(transferred);
  const input = { teamId: "lt", title: "Issue" };

  act(() => kanban.reload());
  await act(async () => {
    await expect(kanban.transferIssue(issue(), input, [], null)).resolves.toBe(
      transferred,
    );
  });
  await act(async () => {
    staleLocal.resolve(structuredClone(board));
    staleLinear.resolve(structuredClone(linearBoard));
  });

  expect(api.transferKanbanIssueToLinear).toHaveBeenCalledWith(
    "i1",
    input,
    [],
    null,
  );
  expect(kanban.board!.issues).toEqual([]);
  expect(kanban.linear!.issues.map(({ id }) => id)).toEqual(["L2", "L1"]);
});

it("drops the previous team's board and its late response when the team changes", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValueOnce(
    structuredClone(linearBoard),
  );
  await mountConnected();
  const lateReload = deferred<LinearKanbanBoard>();
  const other = deferred<LinearKanbanBoard>();
  vi.mocked(api.loadLinearKanbanBoard)
    .mockReturnValueOnce(lateReload.promise)
    .mockReturnValueOnce(other.promise);

  act(() => kanban.reload());
  await act(async () => root.render(<Harness linearTeamId="lt2" />));
  expect(kanban.linear).toBeNull();

  await act(async () => lateReload.resolve(structuredClone(linearBoard)));
  expect(kanban.linear).toBeNull();

  const team = { id: "lt2", key: "OPS", name: "Ops" };
  await act(async () =>
    other.resolve({ ...structuredClone(linearBoard), team, issues: [] }),
  );
  expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith("lt2");
  expect(kanban.linear?.team).toEqual(team);
});

it("still sends queued Linear updates after the team changes, without touching the new team's board", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValueOnce(
    structuredClone(linearBoard),
  );
  await mountConnected();
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const team = { id: "lt2", key: "OPS", name: "Ops" };
  const otherBoard = {
    ...structuredClone(linearBoard),
    team,
    issues: [{ ...linearBoard.issues[0], id: "L2", identifier: "OPS-1" }],
  };
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValueOnce(
    structuredClone(otherBoard),
  );
  const linearIssue = kanban.linear!.issues[0];

  let firstMove!: Promise<void>;
  let secondMove!: Promise<void>;
  act(() => {
    firstMove = kanban.updateIssue(linearIssue, { stateId: "l-done" });
  });
  act(() => {
    secondMove = kanban.updateIssue(linearIssue, { stateId: "l-todo" });
  });
  await act(async () => root.render(<Harness linearTeamId="lt2" />));
  expect(kanban.linear).toEqual(otherBoard);

  await act(async () => {
    first.resolve(
      updated({
        id: "L1",
        stateId: "l-done",
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
    await firstMove;
  });
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("linear", "L1", {
    stateId: "l-todo",
  });
  expect(kanban.linear).toEqual(otherBoard);

  await act(async () => {
    second.resolve(
      updated({
        id: "L1",
        stateId: "l-todo",
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await secondMove;
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(2);
  expect(kanban.linear).toEqual(otherBoard);
});

it("keeps one ordered write queue per Linear issue when the team switches away and back", async () => {
  vi.mocked(api.loadLinearKanbanBoard)
    .mockResolvedValueOnce(structuredClone(linearBoard))
    .mockResolvedValueOnce({
      ...structuredClone(linearBoard),
      team: { id: "lt2", key: "OPS", name: "Ops" },
      issues: [],
    })
    .mockResolvedValueOnce(structuredClone(linearBoard));
  await mountConnected();
  const first = deferred<KanbanIssueUpdate>();
  const second = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const moves: Promise<void>[] = [];
  act(() => {
    moves.push(
      kanban.updateIssue(kanban.linear!.issues[0], { stateId: "l-done" }),
    );
  });
  act(() => {
    moves.push(kanban.updateIssue(kanban.linear!.issues[0], { priority: 2 }));
  });
  await act(async () => root.render(<Harness linearTeamId="lt2" />));
  await act(async () => root.render(<Harness linearTeamId="lt" />));
  act(() => {
    moves.push(kanban.updateIssue(kanban.linear!.issues[0], { priority: 3 }));
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(1);

  await act(async () => {
    first.resolve(
      updated({
        id: "L1",
        stateId: "l-done",
        updatedAt: "2026-09-27T10:00:01.000Z",
      }),
    );
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(2);
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("linear", "L1", {
    priority: 3,
  });

  await act(async () => {
    second.resolve(
      updated({
        id: "L1",
        stateId: "l-done",
        priority: 3,
        updatedAt: "2026-09-27T10:00:02.000Z",
      }),
    );
    await Promise.all(moves);
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(2);
  expect(kanban.linear!.issues[0]).toMatchObject({
    stateId: "l-done",
    priority: 3,
  });
});

it("waits until the board is shown to load Linear", async () => {
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );
  await mountConnected(false);
  await act(async () => kanban.reload());
  await flush();
  expect(kanban.linearConnected).toBe(true);
  expect(api.loadLinearKanbanBoard).not.toHaveBeenCalled();

  await act(async () => root.render(<Harness linearTeamId="lt" visible />));
  await flush();
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(1);
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L1"]);
});

it("retries a failed key check on reload, then loads Linear", async () => {
  const failure = new Error("Trousseau indisponible.");
  vi.mocked(api.listLinearWorkspaces)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue([acme]);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness linearTeamId="lt" />));
  await flush();
  expect(kanban.linearError).toBe(failure);

  await act(async () => kanban.reload());
  await flush();
  expect(kanban).toMatchObject({ linearConnected: true, linearError: null });
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L1"]);
});

it("does not call Linear beyond the key check when not connected", () => {
  expect(api.listLinearWorkspaces).toHaveBeenCalled();
  expect(api.loadLinearKanbanBoard).not.toHaveBeenCalled();
  expect(kanban).toMatchObject({ linear: null, linearConnected: false });
});

it("connects workspaces, and drops the Linear board only once the last one is disconnected", async () => {
  const beta = { id: "w2", name: "Beta" };
  vi.mocked(api.setLinearApiKey).mockResolvedValue();
  vi.mocked(api.clearLinearApiKey).mockResolvedValue();
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    structuredClone(linearBoard),
  );

  vi.mocked(api.listLinearWorkspaces).mockResolvedValue([acme]);
  await act(async () => kanban.connectLinear("lin_api_key"));
  await flush();
  expect(api.setLinearApiKey).toHaveBeenCalledWith("lin_api_key");
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L1"]);

  // Another workspace reloads the board, which lists its teams.
  vi.mocked(api.listLinearWorkspaces).mockResolvedValue([acme, beta]);
  vi.mocked(api.loadLinearKanbanBoard).mockClear();
  await act(async () => kanban.connectLinear("lin_api_beta"));
  await flush();
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(1);

  await act(async () => kanban.disconnectLinear(acme.id));
  await flush();
  expect(api.clearLinearApiKey).toHaveBeenCalledWith("w1");
  expect(kanban).toMatchObject({
    linearConnected: true,
    linearWorkspaces: [beta],
  });
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1", "L1"]);

  await act(async () => kanban.disconnectLinear(beta.id));
  expect(kanban).toMatchObject({ linear: null, linearConnected: false });
  expect(kanban.issues.map(({ id }) => id)).toEqual(["i1"]);
});
