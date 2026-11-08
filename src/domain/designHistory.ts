import type { DesignFrame, DesignFrameGeometry } from "./design";

export type DesignHistoryEntry =
  | {
      kind: "update";
      frameId: string;
      before: DesignFrameGeometry;
      after: DesignFrameGeometry;
    }
  | { kind: "duplicate"; frame: DesignFrame }
  | { kind: "delete"; frame: DesignFrame };

export type DesignHistory = {
  undo: readonly DesignHistoryEntry[];
  redo: readonly DesignHistoryEntry[];
};

export type DesignHistoryDirection = "undo" | "redo";

export const DESIGN_HISTORY_LIMIT = 100;
export const emptyDesignHistory: DesignHistory = { undo: [], redo: [] };

const capped = (entries: readonly DesignHistoryEntry[]) =>
  entries.slice(-DESIGN_HISTORY_LIMIT);

/** A new user action: it becomes the next undo and makes the redone ones unreachable. */
export function recordDesignAction(
  history: DesignHistory,
  entry: DesignHistoryEntry,
): DesignHistory {
  return { undo: capped([...history.undo, entry]), redo: [] };
}

/** Takes the entry to replay; until settled it is in neither stack, so a failure simply drops it. */
export function takeDesignHistory(
  history: DesignHistory,
  direction: DesignHistoryDirection,
): { entry: DesignHistoryEntry; history: DesignHistory } | null {
  const stack = history[direction];
  const entry = stack[stack.length - 1];
  if (!entry) return null;
  return { entry, history: { ...history, [direction]: stack.slice(0, -1) } };
}

/** A replayed entry moves to the opposite stack. */
export function settleDesignHistory(
  history: DesignHistory,
  direction: DesignHistoryDirection,
  entry: DesignHistoryEntry,
): DesignHistory {
  const other = direction === "undo" ? "redo" : "undo";
  return { ...history, [other]: capped([...history[other], entry]) };
}
