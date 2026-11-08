import { useEffect, useRef, useState } from "react";
import { discoverAgentEnvironments } from "../data/agentSessionsApi";
import type { AgentEnvironments } from "../domain/agentSessions";

export function useAgentEnvironmentDiscovery() {
  const [environments, setEnvironments] = useState<AgentEnvironments | null>(
    null,
  );
  const [wslUnavailable, setWslUnavailable] = useState(false);
  const [discovering, setDiscovering] = useState(true);
  const discoveryInFlight = useRef(false);
  const mounted = useRef(false);
  async function discover() {
    if (discoveryInFlight.current) return;
    discoveryInFlight.current = true;
    setDiscovering(true);
    setWslUnavailable(false);
    try {
      const result = await discoverAgentEnvironments();
      if (mounted.current) {
        setEnvironments(result);
        setWslUnavailable(result.wslError !== null);
      }
    } catch {
      if (mounted.current) setWslUnavailable(true);
    } finally {
      discoveryInFlight.current = false;
      if (mounted.current) setDiscovering(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void discover();
    return () => {
      mounted.current = false;
    };
  }, []);
  return { environments, wslUnavailable, discovering, discover };
}
