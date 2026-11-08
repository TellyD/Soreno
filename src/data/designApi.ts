import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentSessionMessage } from "../domain/agentSessions";
import type {
  DesignBoard,
  DesignFrame,
  DesignFrameGeometry,
} from "../domain/design";

export const loadDesignBoards = () => invoke<DesignBoard[]>("design_boards");
export const createDesignBoard = (
  name: string,
  projectId: string | null,
  executable: string,
) =>
  invoke<DesignBoard>("design_create_board", { name, projectId, executable });
export const renameDesignBoard = (boardId: string, name: string) =>
  invoke<DesignBoard>("design_rename_board", { boardId, name });
export const deleteDesignBoard = (boardId: string) =>
  invoke<void>("design_delete_board", { boardId });
export const loadDesignFrames = (boardId: string) =>
  invoke<DesignFrame[]>("design_frames", { boardId });
export const updateDesignFrame = ({
  boardId,
  id,
  x,
  y,
  width,
  height,
  z,
}: DesignFrameGeometry) =>
  invoke<DesignFrame>("design_update_frame", {
    boardId,
    frameId: id,
    x,
    y,
    width,
    height,
    z,
  });
export const restoreDesignFrame = (frame: DesignFrame) =>
  invoke<DesignFrame>("design_restore_frame", { frame });
export const duplicateDesignFrame = (boardId: string, frameId: string) =>
  invoke<DesignFrame>("design_duplicate_frame", { boardId, frameId });
/** Returns the frame as it was deleted, for undo. */
export const deleteDesignFrame = (boardId: string, frameId: string) =>
  invoke<DesignFrame>("design_delete_frame", { boardId, frameId });
/** Fires with the board ID after the agent wrote one of its frames. */
export const listenDesignFramesChanged = (
  onChange: (boardId: string) => void,
) =>
  listen<{ boardId: string }>("design-frames-changed", (event) =>
    onChange(event.payload.boardId),
  );
export const linkDesignSession = (sessionId: string, boardId: string) =>
  invoke<void>("design_link_session", { sessionId, boardId });
export const unlinkDesignSession = (sessionId: string) =>
  invoke<void>("design_unlink_session", { sessionId });
/** Drops the frames (all when `frameIds` is null) in the session's folder and queues a message about them; `update` sends the short "board updated" message. */
export const sendDesignToSession = (
  sessionId: string,
  boardId: string,
  frameIds: string[] | null,
  update: boolean,
) =>
  invoke<AgentSessionMessage>("design_send_to_session", {
    sessionId,
    boardId,
    frameIds,
    update,
  });
