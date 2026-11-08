// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../data/designApi";
import type { DesignBoard, DesignFrame } from "../domain/design";
import { deferred } from "../testing/deferred";
import { useDesignBoard } from "./useDesignBoard";

vi.mock("../data/designApi", () => ({
  loadDesignBoards: vi.fn(),
  loadDesignFrames: vi.fn(),
  listenDesignFramesChanged: vi.fn(),
  updateDesignFrame: vi.fn(),
  deleteDesignFrame: vi.fn(),
  duplicateDesignFrame: vi.fn(),
  restoreDesignFrame: vi.fn(),
}));
vi.mock("../notifications", () => ({ notifyError: vi.fn() }));

const board: DesignBoard = {
  id: "b",
  name: "Board",
  projectId: null,
  sessionId: "s",
  createdAt: "",
  updatedAt: "",
};
const frame = (id: string, extra: Partial<DesignFrame> = {}): DesignFrame => ({
  boardId: "b",
  id,
  title: id,
  html: `<p>${id}</p>`,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  z: 1,
  updatedAt: "",
  ...extra,
});

let container: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useDesignBoard>;
let framesChanged: (boardId: string) => void;
let guard: { prepare: () => Promise<boolean>; hasPendingWork: () => boolean };
const registerGuard = (value: typeof guard) => {
  guard = value;
  return () => {};
};

function Probe() {
  hook = useDesignBoard(true, registerGuard);
  return null;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api.loadDesignBoards).mockResolvedValue([board]);
  vi.mocked(api.loadDesignFrames).mockResolvedValue([frame("a"), frame("c")]);
  vi.mocked(api.listenDesignFramesChanged).mockImplementation(
    async (onChange) => {
      framesChanged = onChange;
      return () => {};
    },
  );
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const ids = () => hook.frames.map(({ id }) => id);

it("does not resurrect a deleted frame from a read started before or during the deletion", async () => {
  const staleRead = deferred<DesignFrame[]>();
  vi.mocked(api.loadDesignFrames).mockReturnValueOnce(staleRead.promise);
  vi.mocked(api.deleteDesignFrame).mockResolvedValue(frame("a"));
  await act(async () => framesChanged("b"));

  vi.mocked(api.loadDesignFrames).mockResolvedValue([frame("c")]);
  await act(async () => hook.deleteFrame("a"));
  await act(async () => staleRead.resolve([frame("a"), frame("c")]));

  expect(ids()).toEqual(["c"]);

  // The read starts while the deletion is pending and answers once the queue has drained.
  vi.mocked(api.loadDesignFrames).mockResolvedValue([frame("a"), frame("c")]);
  await act(async () => framesChanged("b"));
  const deletion = deferred<DesignFrame>();
  const midRead = deferred<DesignFrame[]>();
  vi.mocked(api.deleteDesignFrame).mockReturnValueOnce(deletion.promise);
  let done: Promise<void> = Promise.resolve();
  await act(async () => {
    done = hook.deleteFrame("a");
  });
  vi.mocked(api.loadDesignFrames).mockReturnValueOnce(midRead.promise);
  await act(async () => framesChanged("b"));
  vi.mocked(api.loadDesignFrames).mockResolvedValue([frame("c")]);
  await act(async () => {
    deletion.resolve(frame("a"));
    await done;
  });
  await act(async () => midRead.resolve([frame("a"), frame("c")]));

  expect(ids()).toEqual(["c"]);
});

it("moves the frame and keeps the title and HTML the agent rewrote during the gesture", async () => {
  const gesture = { ...hook.frames[0], x: 120 };
  const rewritten = frame("a", { title: "New", html: "<p>new</p>" });
  vi.mocked(api.loadDesignFrames).mockResolvedValue([rewritten, frame("c")]);
  await act(async () => framesChanged("b"));
  vi.mocked(api.updateDesignFrame).mockImplementation(async ({ x }) => ({
    ...rewritten,
    x,
  }));

  await act(async () => hook.updateFrame(gesture));

  expect(hook.frames[0]).toMatchObject({
    title: "New",
    html: "<p>new</p>",
    x: 120,
  });
});

it("redoes a read that a save outdated after the save queue has drained", async () => {
  const staleRead = deferred<DesignFrame[]>();
  vi.mocked(api.loadDesignFrames).mockReturnValueOnce(staleRead.promise);
  await act(async () => framesChanged("b"));
  vi.mocked(api.updateDesignFrame).mockImplementation(async (sent) => ({
    ...frame(sent.id),
    x: sent.x,
  }));
  await act(async () => hook.updateFrame({ ...hook.frames[0], x: 30 }));

  vi.mocked(api.loadDesignFrames).mockResolvedValue([
    frame("a", { x: 30 }),
    frame("c"),
    frame("created"),
  ]);
  await act(async () => staleRead.resolve([frame("a"), frame("c")]));

  expect(ids()).toEqual(["a", "c", "created"]);
  expect(hook.frames[0].x).toBe(30);
});

it("keeps the newer move when an older save of the same frame fails", async () => {
  const first = deferred<DesignFrame>();
  vi.mocked(api.updateDesignFrame)
    .mockReturnValueOnce(first.promise)
    .mockImplementationOnce(async (sent) => ({ ...frame(sent.id), x: sent.x }));
  const start = hook.frames[0];
  let saves: Promise<void>[] = [];
  await act(async () => {
    saves = [
      hook.updateFrame({ ...start, x: 50 }),
      hook.updateFrame({ ...start, x: 90 }),
    ];
  });
  await act(async () => {
    first.reject(new Error("refused"));
    await Promise.all(saves);
  });

  expect(hook.frames[0].x).toBe(90);
});

it("returns to the saved position when overlapping saves of a frame all fail", async () => {
  vi.mocked(api.updateDesignFrame).mockRejectedValue(new Error("refused"));
  const start = hook.frames[0];
  await act(async () => {
    await Promise.all([
      hook.updateFrame({ ...start, x: 50 }),
      hook.updateFrame({ ...start, x: 90 }),
    ]);
  });

  expect(hook.frames[0].x).toBe(0);
});

it("redoes a duplicate with the HTML the agent wrote into the copy after it", async () => {
  const copy = frame("a-copy", { x: 40, y: 40, z: 2 });
  vi.mocked(api.duplicateDesignFrame).mockResolvedValue(copy);
  await act(async () => hook.duplicateFrame("a"));
  const rewritten = { ...copy, html: "<p>agent</p>" };
  vi.mocked(api.loadDesignFrames).mockResolvedValue([
    frame("a"),
    frame("c"),
    rewritten,
  ]);
  await act(async () => framesChanged("b"));

  vi.mocked(api.deleteDesignFrame).mockResolvedValue(rewritten);
  await act(async () => hook.undo());
  expect(ids()).not.toContain("a-copy");
  vi.mocked(api.restoreDesignFrame).mockImplementation(async (sent) => sent);
  await act(async () => hook.redo());

  expect(api.restoreDesignFrame).toHaveBeenCalledExactlyOnceWith(rewritten);
});

it("undoes a deletion by restoring the frame as the server deleted it and redoes it by deleting again", async () => {
  // The screen still shows the old HTML; the agent's rewrite only reached the server.
  const deleted = frame("a", { title: "Accueil", html: "<p>agent</p>", z: 3 });
  vi.mocked(api.loadDesignFrames).mockResolvedValue([
    frame("a", { title: "Accueil", z: 3 }),
    frame("c"),
  ]);
  await act(async () => framesChanged("b"));
  vi.mocked(api.deleteDesignFrame).mockResolvedValue(deleted);
  await act(async () => hook.deleteFrame("a"));
  expect(ids()).toEqual(["c"]);

  const restored = deferred<DesignFrame>();
  vi.mocked(api.restoreDesignFrame).mockReturnValue(restored.promise);
  let undo: Promise<void> = Promise.resolve();
  await act(async () => {
    undo = hook.undo();
  });
  expect(api.restoreDesignFrame).toHaveBeenCalledExactlyOnceWith(deleted);
  await act(async () => {
    restored.resolve(deleted);
    await undo;
  });
  expect(hook.frames).toContainEqual(deleted);
  expect(hook.canRedo).toBe(true);

  await act(async () => hook.redo());
  expect(api.deleteDesignFrame).toHaveBeenLastCalledWith("b", "a");
  expect(ids()).toEqual(["c"]);
});

it("lets Soreno close only once every queued frame write has reached the backend", async () => {
  const first = deferred<DesignFrame>();
  const second = deferred<DesignFrame>();
  vi.mocked(api.updateDesignFrame)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const start = hook.frames[0];
  await act(async () => {
    void hook.updateFrame({ ...start, x: 50 });
    void hook.updateFrame({ ...start, x: 90 });
  });
  expect(guard.hasPendingWork()).toBe(true);

  let closed = false;
  const prepared = guard.prepare().then((ready) => (closed = ready));
  await act(async () => first.resolve({ ...start, x: 50 }));
  expect(closed).toBe(false);
  expect(api.updateDesignFrame).toHaveBeenCalledTimes(2);

  await act(async () => second.resolve({ ...start, x: 90 }));
  await prepared;
  expect(closed).toBe(true);
  expect(guard.hasPendingWork()).toBe(false);
});
