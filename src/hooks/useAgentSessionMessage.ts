import { useEffect, useState } from "react";
import {
  listAgentSessionMessages,
  listenAgentSessionMessages,
} from "../data/agentSessionsApi";
import type { AgentSessionMessage } from "../domain/agentSessions";

/** Follows the delivery status of one sent message, starting from the value returned by the send. */
export function useAgentSessionMessage(sent: AgentSessionMessage | null) {
  const [message, setMessage] = useState(sent);
  const [followed, setFollowed] = useState(sent);
  if (followed !== sent) {
    setFollowed(sent);
    setMessage(sent);
  }

  useEffect(() => {
    if (!sent) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let request = 0;
    const reload = async () => {
      const current = ++request;
      try {
        const found = (await listAgentSessionMessages(sent.sessionId)).find(
          (candidate) => candidate.id === sent.id,
        );
        if (!disposed && current === request && found) setMessage(found);
      } catch {
        // The status stays at its last known value; the send itself succeeded.
      }
    };
    // Read only once subscribed: a delivery emitted before registration would be lost.
    void listenAgentSessionMessages((changed) => {
      if (changed === sent.sessionId) void reload();
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
  }, [sent]);

  return message;
}
