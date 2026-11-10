import { useRef, useState } from "react";
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
  // Receives the uploaded paths, each quoted for a shell, in the order of `files`.
  paste: (paths: string[], files: File[]) => void;
  focus: () => void;
  onError: (error: AgentFileDropError) => void;
  onSuccess: () => void;
  // A new batch keeps earlier pending ones instead of superseding them; only `invalidate` drops them.
  additive?: boolean;
};

/** Uploads files dropped on, pasted into or picked for an agent, then pastes their paths. */
export function useAgentFileDrop(options: AgentFileDropOptions) {
  const { sessionId, canAttach, paste, focus, onError, onSuccess, additive } =
    options;
  const revision = useRef(0);
  const [pending, setPending] = useState(0);
  function attach(files: File[]) {
    const current = additive ? revision.current : ++revision.current;
    if (!canAttach()) return;
    if (files.length === 0 || files.length > MAX_DROPPED_FILES)
      return onError("count");
    if (files.some((file) => file.size > AGENT_ATTACHMENT_MAX_BYTES))
      return onError("tooLarge");
    const isCurrent = () => current === revision.current && canAttach();
    setPending((count) => count + 1);
    void (async () => {
      try {
        const paths: string[] = [];
        for (const file of files) {
          const path = await attachAgentFile(sessionId, file);
          if (!isCurrent()) return;
          paths.push(path);
        }
        if (!isCurrent()) return;
        paste(paths, files);
        onSuccess();
        if (isCurrent()) focus();
      } catch (reason) {
        if (isCurrent())
          onError(
            reason instanceof AgentAttachmentTooLargeError
              ? "tooLarge"
              : "failed",
          );
      } finally {
        setPending((count) => count - 1);
      }
    })();
  }
  const target = useFileDropTarget(canAttach, attach);

  return {
    attach,
    active: target.active,
    // Uploads still running, invalidated ones included until they settle.
    pending,
    handlers: target.handlers,
    // Drops pending uploads and the drag state after a visibility or process change.
    invalidate() {
      revision.current++;
      target.reset();
    },
  };
}
