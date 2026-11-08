import { useEffect, useRef } from "react";
import { setAgentRemoteLabel } from "../data/agentSessionsApi";

const PUSH_DELAY_MS = 2000;
const LABEL_LIMIT = 120;

// Same cleanup as the server, so only a visible change is pushed.
const cleanLabel = (label: string) =>
  [...label.replace(/\p{Cc}/gu, "")].slice(0, LABEL_LIMIT).join("");

/** Names each running SSH session in its remote directory, for `soreno-attach` and the phone. */
export function useRemoteSessionLabels(labels: ReadonlyMap<string, string>) {
  const wanted = useRef(new Map<string, string>());
  const pushed = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, number>());
  const sending = useRef(new Set<string>());
  const key = JSON.stringify(
    [...labels]
      .map(([id, label]) => [id, cleanLabel(label)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  // One push at a time per session: the server runs concurrent scripts in any order.
  const flush = useRef((id: string) => {
    const label = wanted.current.get(id);
    if (
      label === undefined ||
      pushed.current.get(id) === label ||
      sending.current.has(id) ||
      timers.current.has(id)
    )
      return;
    sending.current.add(id);
    pushed.current.set(id, label);
    setAgentRemoteLabel(id, label)
      .catch(() => {
        /* Best effort: the launch label stays until the next rename. */
      })
      .finally(() => {
        sending.current.delete(id);
        flush.current(id);
      });
  });
  useEffect(() => {
    const next = new Map(JSON.parse(key) as [string, string][]);
    for (const id of wanted.current.keys())
      if (!next.has(id)) {
        wanted.current.delete(id);
        pushed.current.delete(id);
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
      }
    for (const [id, label] of next) {
      if (wanted.current.get(id) === label) continue;
      wanted.current.set(id, label);
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      if (pushed.current.get(id) === label) continue;
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          flush.current(id);
        }, PUSH_DELAY_MS),
      );
    }
  }, [key]);
  useEffect(() => {
    const pending = timers.current;
    const desired = wanted.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      desired.clear();
    };
  }, []);
}
