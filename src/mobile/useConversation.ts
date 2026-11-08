import { useEffect, useRef, useState } from "react";
import {
  appendItems,
  resetConversation,
  type Conversation,
} from "./conversation";
import {
  ConversationConnection,
  suspendWhileHidden,
  type ConnectionStatus,
} from "./conversationConnection";
import type { SessionTarget } from "./mobileApi";
import { serverChannel } from "./relayChannel";

/**
 * Follows the agent history of a session; `conversation` stays null until the first `reset`.
 * `synced` tells whether the current connection got its `reset`: the previous one stays shown meanwhile.
 */
export function useConversation(target: SessionTarget) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [synced, setSynced] = useState(false);
  const [working, setWorking] = useState<boolean | null>(null);
  const connectionRef = useRef<ConversationConnection | null>(null);
  const { server, key } = target;

  useEffect(() => {
    setConversation(null);
    setSynced(false);
    const connection = new ConversationConnection({
      openChannel: () => serverChannel(server, { kind: "conversation", key }),
      // Every (re)connection starts with a `reset`; any status change precedes it.
      onStatus: (next) => {
        setStatus(next);
        setSynced(false);
      },
      onReset: (reset, items) => {
        setConversation(appendItems(resetConversation(reset), items));
        setSynced(true);
      },
      onItems: (items) =>
        setConversation((current) => current && appendItems(current, items)),
      onWorking: setWorking,
    });
    connectionRef.current = connection;
    const unfollow = suspendWhileHidden(connection);
    return () => {
      unfollow();
      connection.dispose();
      connectionRef.current = null;
    };
  }, [server, key]);

  return {
    status,
    conversation,
    synced,
    working,
    input: (data: string) => connectionRef.current?.input(data) ?? false,
    sendImage: (mimeType: string, data: string) =>
      connectionRef.current?.sendImage(mimeType, data) ??
      Promise.reject(new Error("Connection closed")),
  };
}
