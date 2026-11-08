import { useCallback, useEffect, useState } from "react";
import * as api from "../data/automationsApi";
import type {
  AgentAutomation,
  AgentAutomationInput,
} from "../domain/automations";
import { errorMessage } from "../domain/errors";
import { notifyError } from "../notifications";

const REFRESH_INTERVAL = 30_000;

const replaced = (list: AgentAutomation[], next: AgentAutomation) =>
  list.some((item) => item.sessionId === next.sessionId)
    ? list.map((item) => (item.sessionId === next.sessionId ? next : item))
    : [...list, next];

/**
 * Automations and their last runs, read from the servers of `connectedProjectIds` while visible.
 * Dormant projects are never listed there: reading must not wake a server.
 */
export function useAgentAutomations(
  visible: boolean,
  connectedProjectIds: readonly string[],
) {
  const [automations, setAutomations] = useState<AgentAutomation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refreshKey = connectedProjectIds.join("\n");

  useEffect(() => {
    if (!visible) return;
    let current = true;
    void api.loadAgentAutomations().then(
      (list) => {
        if (!current) return;
        setAutomations(list);
        setLoaded(true);
      },
      (reason) => notifyError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [visible]);

  // shortcut: a read still pending when the view closes is not awaited by the next opening, and a pass
  // checks `document.hidden` only before starting; share the in-flight pass if slow servers pile reads up.
  // One pass at a time, then the next one later: a slow server never stacks reads.
  useEffect(() => {
    if (!visible || !loaded || !refreshKey) return;
    let current = true;
    let timer: number | undefined;
    const refresh = async () => {
      // A hidden window reads nothing; the next pass after it shows again catches up.
      if (!document.hidden)
        for (const projectId of refreshKey.split("\n")) {
          try {
            const list = await api.refreshAgentAutomations(projectId);
            if (current) setAutomations(list);
          } catch (reason) {
            // Keyed: an unreachable server keeps one notice, not one per pass.
            if (current)
              notifyError(errorMessage(reason), {
                key: `automations-refresh:${projectId}`,
              });
          }
          if (!current) return;
        }
      if (current) timer = window.setTimeout(refresh, REFRESH_INTERVAL);
    };
    void refresh();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [visible, loaded, refreshKey]);

  const save = useCallback(async (input: AgentAutomationInput) => {
    const saved = await api.saveAgentAutomation(input);
    setAutomations((list) => replaced(list, saved));
    return saved;
  }, []);
  const remove = useCallback(async (sessionId: string) => {
    await api.deleteAgentAutomation(sessionId);
    setAutomations((list) =>
      list.filter((item) => item.sessionId !== sessionId),
    );
  }, []);
  const run = useCallback(async (sessionId: string) => {
    const updated = await api.runAgentAutomation(sessionId);
    setAutomations((list) => replaced(list, updated));
  }, []);
  const markSeen = useCallback(async (sessionId: string) => {
    const updated = await api.markAgentAutomationSeen(sessionId);
    setAutomations((list) => replaced(list, updated));
  }, []);

  return { automations, loaded, save, remove, run, markSeen };
}
