import type { RemoteHost, RemoteSession } from "./mobileApi";
import { jsonField, type Channel, type OpenRequest } from "./relayChannel";
import type { PairedServer } from "./serverStore";

export type OpenChannel = (
  server: PairedServer,
  open: OpenRequest,
  pair?: string,
) => Channel;

const RETRY_MAX_MS = 15_000;

function retryDelay(attempt: number) {
  return Math.min(RETRY_MAX_MS, 1000 * 2 ** attempt);
}

/** The `sessions` channel of one server: reconnects with backoff until this phone is revoked there. */
class SessionsFeed {
  host: RemoteHost;
  private channel: Channel | null = null;
  private timer = 0;
  private attempt = 0;

  constructor(
    readonly server: PairedServer,
    private readonly openChannel: OpenChannel,
    private readonly onChange: () => void,
  ) {
    this.host = {
      server: server.server,
      host: server.host,
      state: "connecting",
      sessions: [],
    };
  }

  connect() {
    if (this.channel || this.host.state === "unpaired") return;
    clearTimeout(this.timer);
    const channel = this.openChannel(this.server, { kind: "sessions" });
    this.channel = channel;
    // Online only with its list: an empty one meanwhile would drop the unread marks.
    channel.onopen = (hello) => {
      this.attempt = 0;
      if (hello.host) this.update({ host: hello.host });
    };
    channel.onmessage = (message) => {
      const sessions = jsonField(message, "sessions");
      const host = jsonField(message, "host");
      if (jsonField(message, "type") !== "sessions" || !Array.isArray(sessions))
        return;
      // The server writes them from `sessions::Session`; the list only reads them.
      const list: RemoteSession[] = sessions;
      this.update({
        state: "online",
        host: typeof host === "string" ? host : this.host.host,
        sessions: list,
      });
    };
    channel.onclose = (end) => {
      this.channel = null;
      if (end === "unpaired") {
        this.update({ state: "unpaired", sessions: [] });
        return;
      }
      this.update({ state: "offline" });
      this.timer = window.setTimeout(
        () => this.connect(),
        retryDelay(this.attempt++),
      );
    };
  }

  /** Reconnects now, e.g. when the page is shown again. */
  wake() {
    this.attempt = 0;
    this.connect();
  }

  suspend() {
    clearTimeout(this.timer);
    this.channel?.close();
    this.channel = null;
  }

  private update(change: Partial<RemoteHost>) {
    this.host = { ...this.host, ...change };
    this.onChange();
  }
}

/** One `sessions` channel per paired server, down while the page is hidden. */
export class ServerFeeds {
  private feeds = new Map<string, SessionsFeed>();
  private suspended = false;

  constructor(
    private readonly openChannel: OpenChannel,
    private readonly onChange: (hosts: RemoteHost[]) => void,
  ) {}

  /** Follows exactly these servers, in this order. */
  follow(servers: PairedServer[]) {
    const kept = new Map<string, SessionsFeed>();
    for (const server of servers) {
      let feed = this.feeds.get(server.server);
      // shortcut: a refusal decrypted after the re-pairing reload still ends the kept feed as unpaired until reload; restart it explicitly after pairing if reported.
      // Re-pairing a revoked device can keep the same key.
      if (
        feed &&
        (feed.server.publicKey !== server.publicKey ||
          feed.host.state === "unpaired")
      ) {
        feed.suspend();
        feed = undefined;
      }
      feed ??= new SessionsFeed(server, this.openChannel, () => this.emit());
      kept.set(server.server, feed);
      if (!this.suspended) feed.connect();
    }
    for (const [id, feed] of this.feeds) if (!kept.has(id)) feed.suspend();
    this.feeds = kept;
    this.emit();
  }

  suspend() {
    this.suspended = true;
    for (const feed of this.feeds.values()) feed.suspend();
  }

  wake() {
    this.suspended = false;
    for (const feed of this.feeds.values()) feed.wake();
  }

  dispose() {
    this.suspend();
    this.feeds.clear();
  }

  private emit() {
    this.onChange([...this.feeds.values()].map((feed) => feed.host));
  }
}
