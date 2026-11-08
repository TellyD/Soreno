import type { RemoteHost, RemoteSession } from "./mobileApi";
import type { MobileStrings } from "./mobileStrings";
import { unreadKey } from "./sessionUnread";

export type SessionActivity = "awaiting" | "working" | "unread" | "active";

/** `server` is the server id, its public key in base64url. */
export type SessionRoute = { server: string; key: string };

export type HostSession = { host: RemoteHost; session: RemoteSession };

const SESSION_ROUTE = /^#\/s\/([A-Za-z0-9_-]{43})\/([0-9a-f]{32})$/;

export function sessionActivity(
  session: Pick<RemoteSession, "working" | "awaiting">,
  unread: boolean,
): SessionActivity {
  if (session.awaiting) return "awaiting";
  if (session.working === true) return "working";
  return unread ? "unread" : "active";
}

export function sessionActivityLabel(
  activity: SessionActivity,
  strings: MobileStrings,
) {
  if (activity === "awaiting") return strings.stateAwaiting;
  if (activity === "working") return strings.stateWorking;
  if (activity === "unread") return strings.stateUnread;
  return strings.stateActive;
}

export function sessionTitle(session: Pick<RemoteSession, "key" | "label">) {
  const label = session.label?.trim();
  return label ? label : `${session.key.slice(0, 8)}…`;
}

/** The conversation name, unless the title already shows it (Soreno writes it into the label). */
export function sessionSubtitle(
  session: Pick<RemoteSession, "key" | "label" | "name">,
) {
  const name = session.name?.trim();
  if (!name) return null;
  const title = sessionTitle(session);
  const separator = title.indexOf(" · ");
  // The label is capped: its end may be a cut copy of the name.
  const tail = separator < 0 ? title : title.slice(separator + 3);
  return title.includes(name) || name.startsWith(tail.replace(/…$/, ""))
    ? null
    : name;
}

/** By name; two servers may share one, their ids then keep a stable order. */
export function sortHosts(hosts: RemoteHost[]) {
  return [...hosts].sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      (a.server < b.server ? -1 : a.server > b.server ? 1 : 0),
  );
}

/** Unread sessions of reachable servers, in server order. */
export function unreadSessions(
  hosts: RemoteHost[],
  unread: ReadonlySet<string>,
): HostSession[] {
  return sortHosts(hosts)
    .filter((host) => host.state === "online")
    .flatMap((host) =>
      host.sessions
        .filter(
          (session) =>
            session.working !== true &&
            unread.has(unreadKey(host.server, session.key)),
        )
        .map((session) => ({ host, session })),
    );
}

export function parseSessionRoute(hash: string): SessionRoute | null {
  const match = SESSION_ROUTE.exec(hash);
  return match ? { server: match[1], key: match[2] } : null;
}

export function sessionHref(server: string, key: string) {
  return `#/s/${server}/${key}`;
}
