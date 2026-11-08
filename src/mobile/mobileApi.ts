import type { PairedServer } from "./serverStore";

export type RemoteSession = {
  key: string;
  label: string | null;
  attached: boolean;
  provider: string | null;
  name: string | null;
  working: boolean | null;
  /** The agent stopped on a question or a call it cannot answer alone. */
  awaiting: boolean;
  /** The agent's history was deleted while it runs; omitted otherwise. */
  deleted?: boolean;
};

/** `offline`: not linked to the relay or unreachable; `unpaired`: this phone was revoked there. */
export type ServerState = "connecting" | "online" | "offline" | "unpaired";

/** A paired server as the home screen shows it; its sessions are kept while it is away. */
export type RemoteHost = {
  server: string;
  host: string;
  state: ServerState;
  sessions: RemoteSession[];
};

/** `host` is the name shown for the server. */
export type SessionTarget = { server: PairedServer; host: string; key: string };
