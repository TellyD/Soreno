// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../data/kanbanApi";
import type {
  KanbanComment,
  KanbanIssueDescriptionUpdate,
  KanbanIssueDetail,
  KanbanSource,
} from "../domain/kanban";
import { useKanbanIssue } from "./useKanbanIssue";
import { deferred } from "../testing/deferred";

vi.mock("../data/kanbanApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  createKanbanComment: vi.fn(),
  deleteKanbanComment: vi.fn(),
  loadKanbanIssue: vi.fn(),
  updateKanbanIssueDescription: vi.fn(),
}));

function detail(id: string): KanbanIssueDetail {
  return {
    source: "local",
    id,
    identifier: id.toUpperCase(),
    title: `Issue ${id}`,
    description: null,
    branchName: `acme/${id}`,
    priority: 0,
    stateId: "todo",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    project: null,
    labels: [],
    children: [],
    comments: [],
    pullRequests: [],
  };
}

let root: Root;
let issue: {
  addComment: (body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  detail: KanbanIssueDetail | null;
  error: unknown;
  loading: boolean;
  receiveComment: (issueId: string, comment: KanbanComment) => void;
  reload: () => void;
  updateDescription: (description: string) => Promise<string | null>;
};
function Harness({
  issueId,
  source = "local",
}: {
  issueId: string | null;
  source?: KanbanSource;
}) {
  issue = useKanbanIssue(issueId === null ? null : { id: issueId, source });
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.resetAllMocks();
});

it("ignores a late response for an issue that is no longer selected", async () => {
  const first = deferred<KanbanIssueDetail>();
  const second = deferred<KanbanIssueDetail>();
  vi.mocked(api.loadKanbanIssue)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  await act(async () => root.render(<Harness issueId="a" />));
  await act(async () => root.render(<Harness issueId="b" />));
  expect(issue).toMatchObject({ detail: null, loading: true });

  await act(async () => first.resolve(detail("a")));
  expect(issue).toMatchObject({ detail: null, loading: true });

  await act(async () => second.resolve(detail("b")));
  expect(issue).toMatchObject({ detail: { id: "b" }, loading: false });
  expect(api.loadKanbanIssue).toHaveBeenNthCalledWith(2, "local", "b");
});

it("reports a failure and loads the issue again on retry", async () => {
  const failure = new Error("Base de données indisponible.");
  vi.mocked(api.loadKanbanIssue)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(detail("a"));

  await act(async () => root.render(<Harness issueId="a" />));
  expect(issue).toMatchObject({ detail: null, error: failure, loading: false });

  await act(async () => issue.reload());
  expect(issue).toMatchObject({
    detail: { id: "a" },
    error: null,
    loading: false,
  });
});

function comment(id: string, body: string): KanbanComment {
  return {
    id,
    body,
    createdAt: "2026-09-27T10:00:00.000Z",
  };
}

it("appends a created comment after the existing ones", async () => {
  vi.mocked(api.loadKanbanIssue)
    .mockResolvedValueOnce({
      ...detail("a"),
      comments: [comment("c1", "First")],
    })
    .mockReturnValueOnce(deferred<KanbanIssueDetail>().promise);
  vi.mocked(api.createKanbanComment).mockResolvedValueOnce(
    comment("c2", "Second"),
  );
  await act(async () => root.render(<Harness issueId="a" />));

  await act(async () => issue.addComment("Second"));
  expect(api.createKanbanComment).toHaveBeenCalledWith("local", "a", "Second");
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1", "c2"]);
});

it("keeps a deleted comment out despite an older reload or a replayed agent summary", async () => {
  const stale = deferred<KanbanIssueDetail>();
  const both = {
    ...detail("a"),
    comments: [comment("c1", "Mine"), comment("c2", "Summary")],
  };
  vi.mocked(api.loadKanbanIssue)
    .mockResolvedValueOnce(both)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(deferred<KanbanIssueDetail>().promise);
  vi.mocked(api.deleteKanbanComment).mockResolvedValueOnce();
  await act(async () => root.render(<Harness issueId="a" />));
  act(() => issue.reload());

  await act(async () => issue.deleteComment("c2"));
  expect(api.deleteKanbanComment).toHaveBeenCalledWith("local", "a", "c2");
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1"]);

  await act(async () => stale.resolve(both));
  act(() => issue.receiveComment("a", comment("c2", "Summary")));
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1"]);
});

it("rejects and keeps the comment when the backend refuses its deletion", async () => {
  const failure = new Error("Issue introuvable.");
  vi.mocked(api.loadKanbanIssue).mockResolvedValueOnce({
    ...detail("a"),
    comments: [comment("c1", "Mine")],
  });
  vi.mocked(api.deleteKanbanComment).mockRejectedValueOnce(failure);
  await act(async () => root.render(<Harness issueId="a" />));

  await act(async () => {
    await expect(issue.deleteComment("c1")).rejects.toBe(failure);
  });
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1"]);
});

it("keeps a created comment when an older reload resolves afterwards", async () => {
  const stale = deferred<KanbanIssueDetail>();
  const created = deferred<KanbanComment>();
  const withComment = { ...detail("a"), comments: [comment("c1", "Hello")] };
  vi.mocked(api.loadKanbanIssue)
    .mockResolvedValueOnce(detail("a"))
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(withComment);
  vi.mocked(api.createKanbanComment).mockReturnValueOnce(created.promise);
  await act(async () => root.render(<Harness issueId="a" />));

  let adding!: Promise<void>;
  act(() => {
    issue.reload();
    adding = issue.addComment("Hello");
  });
  await act(async () => {
    created.resolve(comment("c1", "Hello"));
    await adding;
  });
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1"]);

  await act(async () => stale.resolve(detail("a")));
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c1"]);
  expect(issue.loading).toBe(false);
  expect(api.loadKanbanIssue).toHaveBeenCalledTimes(3);
});

it("does not append a comment to an issue selected meanwhile", async () => {
  const created = deferred<KanbanComment>();
  vi.mocked(api.loadKanbanIssue)
    .mockResolvedValueOnce(detail("a"))
    .mockResolvedValueOnce(detail("b"));
  vi.mocked(api.createKanbanComment).mockReturnValueOnce(created.promise);
  await act(async () => root.render(<Harness issueId="a" />));

  let adding!: Promise<void>;
  act(() => {
    adding = issue.addComment("Late");
  });
  await act(async () => root.render(<Harness issueId="b" />));
  await act(async () => {
    created.resolve(comment("c1", "Late"));
    await adding;
  });
  expect(issue.detail).toMatchObject({ id: "b", comments: [] });
});

it("lists a comment posted elsewhere once, only on its own issue", async () => {
  vi.mocked(api.loadKanbanIssue).mockResolvedValueOnce(detail("a"));
  await act(async () => root.render(<Harness issueId="a" />));

  act(() => issue.receiveComment("b", comment("c1", "Other issue")));
  act(() => issue.receiveComment("a", comment("c2", "Summary")));
  act(() => issue.receiveComment("a", comment("c2", "Summary")));
  expect(issue.detail?.comments.map(({ id }) => id)).toEqual(["c2"]);
});

it("shows an extended agent summary in place of its earlier version", async () => {
  vi.mocked(api.loadKanbanIssue).mockResolvedValueOnce(detail("a"));
  await act(async () => root.render(<Harness issueId="a" />));

  act(() => issue.receiveComment("a", comment("c1", "Fixed it.")));
  act(() => issue.receiveComment("a", comment("c2", "Question")));
  act(() =>
    issue.receiveComment("a", comment("c1", "Fixed it.\n\n---\n\nReviewed.")),
  );
  expect(issue.detail?.comments.map(({ id, body }) => [id, body])).toEqual([
    ["c1", "Fixed it.\n\n---\n\nReviewed."],
    ["c2", "Question"],
  ]);
});

it("rejects and keeps the comments when the backend refuses the comment", async () => {
  const failure = new Error("Le commentaire est vide.");
  vi.mocked(api.loadKanbanIssue).mockResolvedValueOnce(detail("a"));
  vi.mocked(api.createKanbanComment).mockRejectedValueOnce(failure);
  await act(async () => root.render(<Harness issueId="a" />));

  await act(async () => {
    await expect(issue.addComment("Hello")).rejects.toBe(failure);
  });
  expect(issue.detail?.comments).toEqual([]);
});

it("does not load an issue left before its description was saved", async () => {
  const saved = deferred<KanbanIssueDescriptionUpdate>();
  vi.mocked(api.loadKanbanIssue)
    .mockResolvedValueOnce(detail("a"))
    .mockResolvedValueOnce(detail("b"));
  vi.mocked(api.updateKanbanIssueDescription).mockReturnValueOnce(
    saved.promise,
  );
  await act(async () => root.render(<Harness issueId="a" />));

  let saving!: Promise<string | null>;
  act(() => {
    saving = issue.updateDescription("Late");
  });
  await act(async () => root.render(<Harness issueId="b" />));
  await act(async () => {
    saved.resolve({
      id: "a",
      description: "Late",
      updatedAt: "2026-09-27T10:00:00.000Z",
    });
    await saving;
  });
  expect(issue).toMatchObject({ detail: { id: "b" }, loading: false });
  expect(api.loadKanbanIssue).toHaveBeenCalledTimes(2);
});

it("sends every request of a Linear issue to Linear", async () => {
  vi.mocked(api.loadKanbanIssue).mockResolvedValue({
    ...detail("a"),
    source: "linear",
  });
  vi.mocked(api.createKanbanComment).mockResolvedValueOnce(comment("c1", "Hi"));
  vi.mocked(api.deleteKanbanComment).mockResolvedValueOnce();
  vi.mocked(api.updateKanbanIssueDescription).mockResolvedValueOnce({
    id: "a",
    description: "New",
    updatedAt: "2026-09-27T10:00:00.000Z",
  });
  await act(async () => root.render(<Harness issueId="a" source="linear" />));

  await act(async () => issue.addComment("Hi"));
  await act(async () => issue.deleteComment("c1"));
  await act(async () => issue.updateDescription("New"));

  expect(api.createKanbanComment).toHaveBeenCalledWith("linear", "a", "Hi");
  expect(api.deleteKanbanComment).toHaveBeenCalledWith("linear", "a", "c1");
  expect(api.updateKanbanIssueDescription).toHaveBeenCalledWith(
    "linear",
    "a",
    "New",
  );
  expect(
    vi
      .mocked(api.loadKanbanIssue)
      .mock.calls.every(([source]) => source === "linear"),
  ).toBe(true);
});
