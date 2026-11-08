import { useEffect, useState } from "react";
import * as api from "../data/designApi";
import type { DesignFrame } from "../domain/design";

/** A board's frames for a read-only view, reloaded when its agent writes one; null until loaded. */
export function useDesignFrames(boardId: string | null) {
  const [loaded, setLoaded] = useState<{
    boardId: string;
    frames: DesignFrame[];
  } | null>(null);

  useEffect(() => {
    if (!boardId) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let request = 0;
    const reload = async () => {
      const current = ++request;
      try {
        const frames = await api.loadDesignFrames(boardId);
        if (!disposed && current === request) setLoaded({ boardId, frames });
      } catch {
        // The preview keeps its last frames; the board view reports errors.
      }
    };
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

  return loaded?.boardId === boardId ? loaded.frames : null;
}
