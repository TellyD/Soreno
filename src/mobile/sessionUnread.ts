import type { RemoteHost } from "./mobileApi";
import { readStorage, writeStorage } from "./mobileStorage";

/** Keys are `server/key`; mirrors the desktop unread marks of `AgentWorkspace`. */
export type UnreadState = {
  working: ReadonlySet<string>;
  unread: ReadonlySet<string>;
};

const STORAGE_KEY = "soreno-mobile-session-unread";
// Marks of absent or unreachable servers are kept until they answer again, within this bound.
const MAX_MARKS = 200;

export const EMPTY_UNREAD: UnreadState = {
  working: new Set(),
  unread: new Set(),
};

export function unreadKey(server: string, key: string) {
  return `${server}/${key}`;
}

export function nextUnreadState(
  state: UnreadState,
  hosts: RemoteHost[],
  displayed: string | null,
): UnreadState {
  const statusById = new Map<string, boolean | null>();
  const reachable = new Set<string>();
  for (const host of hosts) {
    // An unreachable server lists stale sessions: only its return can settle them.
    if (host.state !== "online") continue;
    reachable.add(host.server);
    for (const session of host.sessions)
      statusById.set(unreadKey(host.server, session.key), session.working);
  }
  const pending = (id: string) =>
    !reachable.has(id.slice(0, id.lastIndexOf("/")));
  const working = new Set<string>();
  const observedWorking = new Set<string>();
  const finished: string[] = [];
  for (const id of state.working) {
    if (pending(id)) working.add(id);
    else if (!statusById.has(id)) continue;
    // An unknown activity is not finished: wait for a real one.
    else if (statusById.get(id) === false) finished.push(id);
    else working.add(id);
  }
  for (const [id, status] of statusById)
    if (status === true) observedWorking.add(id);
  for (const id of observedWorking) working.add(id);
  // A new run supersedes the previous unread mark.
  const unread = new Set(
    [...state.unread, ...finished].filter(
      (id) =>
        (pending(id) || statusById.has(id)) &&
        id !== displayed &&
        !observedWorking.has(id),
    ),
  );
  const next = { working: newest(working), unread: newest(unread) };
  return sameSet(next.working, state.working) &&
    sameSet(next.unread, state.unread)
    ? state
    : next;
}

function newest(ids: Set<string>) {
  return ids.size > MAX_MARKS ? new Set([...ids].slice(-MAX_MARKS)) : ids;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function stringSet(value: unknown) {
  return new Set(
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [],
  );
}

export function loadUnreadState(): UnreadState {
  try {
    const saved = JSON.parse(readStorage(STORAGE_KEY) ?? "null") as {
      working?: unknown;
      unread?: unknown;
    } | null;
    if (!saved) return EMPTY_UNREAD;
    return {
      working: stringSet(saved.working),
      unread: stringSet(saved.unread),
    };
  } catch {
    return EMPTY_UNREAD;
  }
}

export function saveUnreadState(state: UnreadState) {
  writeStorage(
    STORAGE_KEY,
    JSON.stringify({
      working: [...state.working],
      unread: [...state.unread],
    }),
  );
}
