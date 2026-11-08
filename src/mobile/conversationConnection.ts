import type { ConversationItem, ConversationReset } from "./conversation";
import type { Channel } from "./relayChannel";

export type ConnectionStatus =
  "connecting" | "open" | "reconnecting" | "ended" | "gone" | "unpaired";

type ServerMessage =
  | ({ type: "reset"; items?: ConversationItem[] } & ConversationReset)
  | { type: "items"; items: ConversationItem[] }
  | { type: "status"; working: boolean | null }
  | { type: "ended" }
  | { type: "imageSaved"; id: number; path: string }
  | { type: "imageFailed"; id: number };

type PendingImage = {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
};

type ConversationConnectionOptions = {
  /** A `conversation` channel to the server of the session. */
  openChannel: () => Channel;
  onStatus: (status: ConnectionStatus) => void;
  onReset: (reset: ConversationReset, items: ConversationItem[]) => void;
  onItems: (items: ConversationItem[]) => void;
  onWorking: (working: boolean | null) => void;
};

const RECONNECT_MAX_MS = 8000;
// JSON escapes a control character in six bytes: stays under 64 KiB whatever the text.
const INPUT_CHUNK_POINTS = 8000;

function reconnectDelay(attempt: number) {
  return Math.min(RECONNECT_MAX_MS, 500 * 2 ** attempt);
}

/**
 * Follows the agent history of a session; every (re)connection starts with a `reset`.
 * Reconnects with backoff, stays down while suspended, and stops once the session ends.
 */
export class ConversationConnection {
  private socket: Channel | null = null;
  private attempt = 0;
  private timer = 0;
  // Bumped by every connect, suspend and dispose: a stale backoff then does nothing.
  private generation = 0;
  private status: ConnectionStatus = "connecting";
  private disposed = false;
  // Answered on the socket that carried them: any other end fails them.
  private images = new Map<number, PendingImage>();
  private nextImage = 0;

  constructor(private readonly options: ConversationConnectionOptions) {
    this.connect();
  }

  /** Sends program input in messages under the server's 64 KiB limit. */
  input(data: string) {
    const socket = this.socket;
    if (!socket?.open) return false;
    const points = Array.from(data);
    for (let start = 0; start < points.length; start += INPUT_CHUNK_POINTS) {
      const chunk = points.slice(start, start + INPUT_CHUNK_POINTS).join("");
      socket.send({ type: "input", data: chunk });
    }
    return true;
  }

  /** Saves an image in the session directory on the server; resolves to its path there. */
  sendImage(mimeType: string, data: string) {
    const socket = this.socket;
    if (!socket?.open) return Promise.reject(new Error("Connection closed"));
    const id = ++this.nextImage;
    socket.send({ type: "image", id, mimeType, data });
    return new Promise<string>((resolve, reject) =>
      this.images.set(id, { resolve, reject }),
    );
  }

  /** Reconnects now instead of waiting for the backoff, e.g. when the page is shown again. */
  wake() {
    if (this.disposed || this.socket) return;
    if (this.status !== "reconnecting") return;
    clearTimeout(this.timer);
    this.connect();
  }

  /** Drops the connection while the page is hidden; only `wake` reconnects, once it is shown again. */
  suspend() {
    if (this.disposed) return;
    this.generation++;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.failImages();
    if (this.status === "connecting" || this.status === "open")
      this.setStatus("reconnecting");
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.failImages();
  }

  private setStatus(status: ConnectionStatus) {
    if (status === this.status && status !== "connecting") return;
    this.status = status;
    this.options.onStatus(status);
  }

  private failImages() {
    for (const image of this.images.values())
      image.reject(new Error("Connection closed"));
    this.images.clear();
  }

  private settleImage(id: number, path: string | null) {
    const image = this.images.get(id);
    if (!image) return;
    this.images.delete(id);
    if (path === null) image.reject(new Error("Image refused"));
    else image.resolve(path);
  }

  private receive(message: ServerMessage) {
    switch (message.type) {
      case "reset":
        this.options.onReset(
          {
            provider: message.provider,
            available: message.available,
            truncated: message.truncated,
            images: message.images === true,
            deleted: message.deleted === true,
            rpc: message.rpc === true,
          },
          // An older server sends the first items in a separate message.
          message.items ?? [],
        );
        return;
      case "items":
        this.options.onItems(message.items);
        return;
      case "status":
        this.options.onWorking(message.working);
        return;
      case "ended":
        this.setStatus("ended");
        return;
      case "imageSaved":
        this.settleImage(message.id, message.path);
        return;
      case "imageFailed":
        this.settleImage(message.id, null);
    }
  }

  private connect() {
    const socket = this.options.openChannel();
    this.socket = socket;
    this.generation++;
    let opened = false;
    if (this.status !== "reconnecting") this.setStatus("connecting");
    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.attempt = 0;
      this.setStatus("open");
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      this.receive(message as ServerMessage);
    };
    socket.onclose = (end) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failImages();
      if (this.status === "ended") return;
      if (!opened && end === "gone") this.setStatus("gone");
      else if (!opened && end === "unpaired") this.setStatus("unpaired");
      else this.retry();
    };
  }

  private retry() {
    clearTimeout(this.timer);
    this.setStatus("reconnecting");
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      if (generation === this.generation) this.connect();
    }, reconnectDelay(this.attempt++));
  }
}

/** Keeps the connection down while the page is hidden; returns the cleanup. */
export function suspendWhileHidden(connection: ConversationConnection) {
  // Unloading may fire `visibilitychange` after `pagehide` while still "visible".
  let pageHidden = false;
  const wake = () => {
    if (!pageHidden && document.visibilityState === "visible")
      connection.wake();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") connection.suspend();
    else wake();
  };
  const show = () => {
    pageHidden = false;
    wake();
  };
  const hide = () => {
    pageHidden = true;
    connection.suspend();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", show);
  window.addEventListener("pagehide", hide);
  // The page may already be hidden, e.g. opened in the background.
  onVisibility();
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", show);
    window.removeEventListener("pagehide", hide);
  };
}
