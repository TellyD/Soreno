import { useRef } from "react";
import { attachAgentFile } from "../data/agentSessionsApi";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AgentAttachmentTooLargeError,
} from "../domain/agentSessions";
import { useFileDropTarget } from "./useFileDropTarget";

const MAX_DROPPED_FILES = 16;

type AgentFileDropError = "count" | "tooLarge" | "failed";

type AgentFileDropOptions = {
  sessionId: string;
  // Read at every event and after every upload: a closed or hidden terminal drops the paste.
  canAttach: () => boolean;
  // Receives the uploaded paths, space-separated with a trailing space.
  paste: (text: string) => void;
  focus: () => void;
  onError: (error: AgentFileDropError) => void;
  onSuccess: () => void;
};

/** Uploads files dropped on an agent terminal, then pastes their paths into it. */
export function useAgentFileDrop(options: AgentFileDropOptions) {
  const { sessionId, canAttach, paste, focus, onError, onSuccess } = options;
  const revision = useRef(0);
  const target = useFileDropTarget(canAttach, (files) => {
    const current = ++revision.current;
    if (!canAttach()) return;
    if (files.length === 0 || files.length > MAX_DROPPED_FILES)
      return onError("count");
    if (files.some((file) => file.size > AGENT_ATTACHMENT_MAX_BYTES))
      return onError("tooLarge");
    const isCurrent = () => current === revision.current && canAttach();
    void (async () => {
      try {
        const paths: string[] = [];
        for (const file of files) {
          const path = await attachAgentFile(sessionId, file);
          if (!isCurrent()) return;
          paths.push(path);
        }
        if (!isCurrent()) return;
        paste(`${paths.join(" ")} `);
        onSuccess();
        if (isCurrent()) focus();
      } catch (reason) {
        if (isCurrent())
          onError(
            reason instanceof AgentAttachmentTooLargeError
              ? "tooLarge"
              : "failed",
          );
      }
    })();
  });

  return {
    active: target.active,
    handlers: target.handlers,
    // Drops pending uploads and the drag state after a visibility or process change.
    invalidate() {
      revision.current++;
      target.reset();
    },
  };
}
