import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../data/designApi";
import type {
  DesignBoard,
  DesignFrame,
  DesignFrameGeometry,
} from "../domain/design";
import {
  emptyDesignHistory,
  recordDesignAction,
  settleDesignHistory,
  takeDesignHistory,
  type DesignHistory,
  type DesignHistoryDirection,
  type DesignHistoryEntry,
} from "../domain/designHistory";
import { errorMessage } from "../domain/errors";
import { notifyError } from "../notifications";

// Undo history lives as long as the app runs: it survives board switches and the view's unmounts.
const histories = new Map<string, DesignHistory>();

const frameGeometry = ({
  boardId,
  id,
  x,
  y,
  width,
  height,
  z,
}: DesignFrameGeometry): DesignFrameGeometry => ({
  boardId,
  id,
  x,
  y,
  width,
  height,
  z,
});

/** The app's close guard registration, as `AgentWorkspace` receives it. */
type RegisterTransitionGuard = (guard: {
  prepare: () => Promise<boolean>;
  hasPendingWork: () => boolean;
}) => () => void;

/** Design boards, and the frames of the open one kept in sync with the agent's writes. */
export function useDesignBoard(
  visible: boolean,
  registerTransitionGuard?: RegisterTransitionGuard,
) {
  const [boards, setBoards] = useState<DesignBoard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed by board, so a switch never shows the previous board's frames.
  const [loadedFrames, setLoadedFrames] = useState<{
    boardId: string | null;
    frames: DesignFrame[];
  }>({ boardId: null, frames: [] });
  const board =
    boards.find((item) => item.id === selectedId) ?? boards[0] ?? null;
  const boardId = board?.id ?? null;
  const frames = loadedFrames.boardId === boardId ? loadedFrames.frames : [];
  const framesRef = useRef(frames);
  framesRef.current = frames;
  // Frame mutations run one at a time; a read older than the last mutation is dropped and redone once they settle.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const revision = useRef(0);
  const reloadSkipped = useRef(false);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  // Latest mutation per frame: an older response or rollback must not undo a newer change.
  const latest = useRef(new Map<string, number>());
  const setFrames = useCallback(
    (id: string, update: (frames: DesignFrame[]) => DesignFrame[]) =>
      setLoadedFrames((current) =>
        current.boardId === id
          ? { boardId: id, frames: update(current.frames) }
          : current,
      ),
    [],
  );

  useEffect(() => {
    if (!visible) return;
    let current = true;
    void api.loadDesignBoards().then(
      (list) => {
        if (!current) return;
        setBoards(list);
        setLoaded(true);
      },
      (reason) => notifyError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [visible]);

  useEffect(() => {
    if (!boardId) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let request = 0;
    const reload = async () => {
      const current = ++request;
      const startedAt = revision.current;
      try {
        const list = await api.loadDesignFrames(boardId);
        if (disposed || current !== request) return;
        if (revision.current !== startedAt || pending.current > 0) {
          // The read predates the last mutation: redo it once the queue drains, or now if it already has.
          if (pending.current > 0) reloadSkipped.current = true;
          else void reload();
          return;
        }
        setLoadedFrames({ boardId, frames: list });
      } catch (reason) {
        if (!disposed) notifyError(errorMessage(reason));
      }
    };
    reloadRef.current = reload;
    // Read only once subscribed: a frame written before registration would be missed.
    void api
      .listenDesignFramesChanged((changed) => {
        if (changed === boardId) void reload();
      })
      .then(
        (stop) => {
          if (disposed) stop();
          else unlisten = stop;
        },
        () => undefined,
      )
      .then(() => {
        if (!disposed) void reload();
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [boardId]);

  const mutate = useCallback(
    (
      frameId: string,
      work: (isLatest: () => boolean) => Promise<boolean | void>,
    ) => {
      const token = ++revision.current;
      latest.current.set(frameId, token);
      pending.current += 1;
      const run = queue.current.then(async () => {
        try {
          return (
            (await work(() => latest.current.get(frameId) === token)) !== false
          );
        } catch (reason) {
          notifyError(errorMessage(reason));
          return false;
        } finally {
          // Settling invalidates reads started while this mutation ran.
          revision.current += 1;
          pending.current -= 1;
          if (pending.current === 0 && reloadSkipped.current) {
            reloadSkipped.current = false;
            void reloadRef.current();
          }
        }
      });
      queue.current = run.then(() => undefined);
      return run;
    },
    [],
  );

  // Closing waits for every queued frame write: one queued behind another must still reach the backend.
  useEffect(
    () =>
      registerTransitionGuard?.({
        hasPendingWork: () => pending.current > 0,
        prepare: async () => {
          while (pending.current > 0) await queue.current;
          return true;
        },
      }),
    [registerTransitionGuard],
  );

  const [, setHistoryRevision] = useState(0);
  const historyOf = (id: string | null) =>
    (id && histories.get(id)) || emptyDesignHistory;
  function writeHistory(id: string, next: DesignHistory) {
    histories.set(id, next);
    setHistoryRevision((value) => value + 1);
  }
  function record(id: string, entry: DesignHistoryEntry) {
    writeHistory(id, recordDesignAction(historyOf(id), entry));
  }

  const createBoard = useCallback(
    async (name: string, projectId: string | null, executable: string) => {
      const created = await api.createDesignBoard(name, projectId, executable);
      setBoards((list) => [created, ...list]);
      setSelectedId(created.id);
      return created;
    },
    [],
  );
  const renameBoard = useCallback(async (id: string, name: string) => {
    const renamed = await api.renameDesignBoard(id, name);
    setBoards((list) => list.map((item) => (item.id === id ? renamed : item)));
  }, []);
  const deleteBoard = useCallback(async (id: string) => {
    await api.deleteDesignBoard(id);
    histories.delete(id);
    setBoards((list) => list.filter((item) => item.id !== id));
  }, []);

  // Only the geometry applies: html and title may have been rewritten by the agent meanwhile.
  function saveGeometry(geometry: DesignFrameGeometry, gesture: boolean) {
    const previous = framesRef.current.find((item) => item.id === geometry.id);
    if (!previous && gesture) return Promise.resolve(false);
    const id = geometry.boardId;
    setFrames(id, (list) =>
      list.map((item) =>
        item.id === geometry.id
          ? { ...item, ...frameGeometry(geometry) }
          : item,
      ),
    );
    return mutate(geometry.id, async (isLatest) => {
      // shortcut: a move still queued when the user switches board finds no frame here and is dropped; keep the origin board's frames for queued mutations if users lose moves.
      if (gesture && !framesRef.current.some((item) => item.id === geometry.id))
        return false;
      try {
        const saved = await api.updateDesignFrame(geometry);
        if (isLatest())
          setFrames(id, (list) =>
            list.map((item) => (item.id === saved.id ? saved : item)),
          );
      } catch (reason) {
        // The optimistic `previous` may be an unsaved move: snap back, then let the server's state settle it.
        if (isLatest() && previous) {
          setFrames(id, (list) =>
            list.map((item) =>
              item.id === previous.id
                ? { ...item, ...frameGeometry(previous) }
                : item,
            ),
          );
          reloadSkipped.current = true;
        }
        throw reason;
      }
    });
  }
  /** Resolves with the frame as the server deleted it, null on failure. */
  async function removeFrame(
    id: string,
    frameId: string,
  ): Promise<DesignFrame | null> {
    const previous = framesRef.current.find((item) => item.id === frameId);
    setFrames(id, (list) => list.filter((item) => item.id !== frameId));
    let deleted: DesignFrame | null = null;
    const done = await mutate(frameId, async (isLatest) => {
      try {
        deleted = await api.deleteDesignFrame(id, frameId);
      } catch (reason) {
        if (isLatest() && previous)
          setFrames(id, (list) =>
            list.some((item) => item.id === frameId)
              ? list
              : [...list, previous].sort((left, right) => left.z - right.z),
          );
        throw reason;
      }
    });
    return done ? deleted : null;
  }
  function restoreFrame(frame: DesignFrame) {
    const inserted = !framesRef.current.some((item) => item.id === frame.id);
    if (inserted)
      setFrames(frame.boardId, (list) =>
        [...list, frame].sort((left, right) => left.z - right.z),
      );
    return mutate(frame.id, async (isLatest) => {
      try {
        const saved = await api.restoreDesignFrame(frame);
        if (isLatest())
          setFrames(frame.boardId, (list) =>
            list.map((item) => (item.id === saved.id ? saved : item)),
          );
      } catch (reason) {
        if (isLatest() && inserted)
          setFrames(frame.boardId, (list) =>
            list.filter((item) => item.id !== frame.id),
          );
        throw reason;
      }
    });
  }

  async function updateFrame(gesture: DesignFrameGeometry) {
    // shortcut: `before` is the optimistic geometry, so if an earlier overlapping save fails, undoing this move lands on that unsaved position; take it from the last confirmed frame if users hit it.
    const previous = framesRef.current.find((item) => item.id === gesture.id);
    if (!previous) return;
    const entry: DesignHistoryEntry = {
      kind: "update",
      frameId: gesture.id,
      before: frameGeometry(previous),
      after: frameGeometry(gesture),
    };
    if (await saveGeometry(gesture, true)) record(gesture.boardId, entry);
  }
  async function duplicateFrame(frameId: string) {
    if (!boardId) return;
    const id = boardId;
    let copy: DesignFrame | undefined;
    const done = await mutate(`${frameId}\ncopy`, async () => {
      const created = await api.duplicateDesignFrame(id, frameId);
      copy = created;
      setFrames(id, (list) =>
        list.some((item) => item.id === created.id) ? list : [...list, created],
      );
    });
    if (done && copy) record(id, { kind: "duplicate", frame: copy });
  }
  // The server's copy, not the screen's: the agent may have rewritten the frame while the queue was busy.
  async function deleteFrame(frameId: string) {
    if (!boardId || !framesRef.current.some((item) => item.id === frameId))
      return;
    const id = boardId;
    const deleted = await removeFrame(id, frameId);
    if (deleted) record(id, { kind: "delete", frame: deleted });
  }

  // A failed replay drops its entry: the frame it needs is gone or its id is taken.
  async function replay(direction: DesignHistoryDirection) {
    if (!boardId) return;
    const id = boardId;
    const taken = takeDesignHistory(historyOf(id), direction);
    if (!taken) return;
    writeHistory(id, taken.history);
    const { entry } = taken;
    const forward = direction === "redo";
    const removal =
      entry.kind !== "update" && (entry.kind === "delete") === forward;
    let settled = entry;
    let done: boolean;
    if (entry.kind === "update")
      done = await saveGeometry(forward ? entry.after : entry.before, false);
    else if (removal) {
      // The inverse restores the frame as the server deleted it, agent edits included.
      const deleted = await removeFrame(id, entry.frame.id);
      if (deleted) settled = { ...entry, frame: deleted };
      done = !!deleted;
    } else done = await restoreFrame(entry.frame);
    // shortcut: an action made while this replay is in flight does not clear the redo it lands in; settle against a history revision if redo replays stale moves.
    if (done)
      writeHistory(id, settleDesignHistory(historyOf(id), direction, settled));
  }
  const history = historyOf(boardId);

  return {
    boards,
    loaded,
    board,
    frames,
    selectBoard: setSelectedId,
    createBoard,
    renameBoard,
    deleteBoard,
    updateFrame,
    duplicateFrame,
    deleteFrame,
    undo: () => replay("undo"),
    redo: () => replay("redo"),
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
  };
}
