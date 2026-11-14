import { deviceLabel } from "./deviceLabel";
import { Initiator, type Transport } from "./noise";
import {
  MESSAGE_LIMIT,
  PHONE_FRAME_LIMIT,
  PHONE_PROLOGUE,
  Reassembly,
  chunks,
  decodeKey,
} from "./protocol";
import type { PairedServer } from "./serverStore";

export type OpenRequest =
  { kind: "sessions" } | { kind: "conversation"; key: string };

export type ServerHello = { host: string; version: string };

/** Why a channel ended: a server refusal, a relay close code, or the network. */
export type ChannelEnd =
  | "unpaired"
  | "pairing"
  | "throttled"
  | "gone"
  | "bad"
  | "offline"
  | "busy"
  | "closed"
  | "network";

/** One end-to-end encrypted conversation with a server, carrying JSON messages. */
export type Channel = {
  readonly open: boolean;
  send(message: unknown): void;
  /** Ends the channel without calling `onclose`. */
  close(): void;
  onopen: ((hello: ServerHello) => void) | null;
  onmessage: ((message: unknown) => void) | null;
  onclose: ((end: ChannelEnd) => void) | null;
};

export type RelaySocket = Pick<
  WebSocket,
  | "binaryType"
  | "readyState"
  | "send"
  | "close"
  | "onopen"
  | "onmessage"
  | "onclose"
>;

type ChannelOptions = {
  server: string;
  keyPair: CryptoKeyPair;
  /** The phone's raw public key for this server. */
  publicKey: Uint8Array;
  label: string;
  open: OpenRequest;
  /** The secret of a pairing QR code. */
  pair?: string;
  location: Pick<Location, "protocol" | "host">;
  createSocket?: (url: string) => RelaySocket;
};

const SERVER_ERRORS: readonly ChannelEnd[] = [
  "unpaired",
  "pairing",
  "throttled",
  "gone",
  "bad",
];

const BACKLOG_LIMIT = 2 * MESSAGE_LIMIT;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RELAY_HOST = "relay.soreno.dev";

export function relayUrl(
  location: Pick<Location, "protocol" | "host">,
  server: string,
) {
  // In development the page's own server (Vite) proxies /relay/ to a local relay.
  const origin = import.meta.env.DEV
    ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`
    : `wss://${RELAY_HOST}`;
  return `${origin}/relay/phone/${server}`;
}

function closeEnd(code: number, opened: boolean): ChannelEnd {
  if (code === 4404) return "offline";
  if (code === 4429) return "busy";
  if (code === 4400) return "bad";
  // The server closes without answering a first message it cannot read.
  if (code === 1000) return opened ? "closed" : "bad";
  return "network";
}

/** A field of a parsed JSON value, `undefined` when it is not an object. */
export function jsonField(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function serverError(answer: unknown): ChannelEnd {
  const error = jsonField(answer, "error");
  return SERVER_ERRORS.find((end) => end === error) ?? "bad";
}

export class RelayChannel implements Channel {
  onopen: Channel["onopen"] = null;
  onmessage: Channel["onmessage"] = null;
  onclose: Channel["onclose"] = null;
  private readonly socket: RelaySocket;
  private transport: Transport | null = null;
  private finished = false;
  // The socket is gone or failed: frames still queued would be lost anyway.
  private dropped = false;
  // WebCrypto answers asynchronously: frames are handled, and sent, one after the other.
  private receiving = Promise.resolve();
  private sending = Promise.resolve();
  private readonly reassembly = new Reassembly();
  private backlog = 0;

  constructor(options: ChannelOptions) {
    const create =
      options.createSocket ?? ((url: string) => new WebSocket(url));
    this.socket = create(relayUrl(options.location, options.server));
    this.socket.binaryType = "arraybuffer";
    const remote = decodeKey(options.server);
    const handshake = remote
      ? Initiator.start({
          local: {
            privateKey: options.keyPair.privateKey,
            publicKey: new Uint8Array(options.publicKey),
          },
          remote,
          prologue: PHONE_PROLOGUE,
          payload: encoder.encode(
            JSON.stringify({
              v: 1,
              label: options.label,
              ...(options.pair ? { pair: options.pair } : {}),
              open: options.open,
            }),
          ),
        })
      : Promise.reject(new Error("Invalid server key"));
    // Settled here so that a refused key fails the channel once its socket opens.
    handshake.catch(() => undefined);
    this.socket.onopen = () => {
      this.receiving = this.receiving.then(async () => {
        const { message } = await handshake;
        if (!this.finished) this.socket.send(message);
      });
      this.receiving.catch(() => this.fail("bad"));
    };
    this.socket.onmessage = (event) => {
      if (this.finished) return;
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength > PHONE_FRAME_LIMIT
      ) {
        this.fail("bad");
        return;
      }
      const frame = new Uint8Array(event.data);
      // Every queued frame counts as a full one, so that empty frames cannot pile up either.
      const cost = Math.max(frame.length, PHONE_FRAME_LIMIT);
      this.backlog += cost;
      if (this.backlog > BACKLOG_LIMIT) {
        this.fail("bad");
        return;
      }
      this.receiving = this.receiving
        .then(() => this.receive(frame, handshake))
        .finally(() => {
          this.backlog -= cost;
        });
      this.receiving.catch(() => this.fail("bad"));
    };
    this.socket.onclose = (event) => {
      this.dropped = true;
      // The server answers then closes: its last frames are still being decrypted.
      const end = () => {
        if (!this.finished)
          this.finish(closeEnd(event.code, this.transport !== null));
      };
      this.receiving = this.receiving.then(end, end);
    };
  }

  // A closing socket drops what it is given: refuse the message so the page keeps it.
  get open() {
    return (
      this.transport !== null &&
      !this.finished &&
      !this.dropped &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  send(message: unknown) {
    const transport = this.transport;
    if (!transport || !this.open) return;
    const sealed = chunks(encoder.encode(JSON.stringify(message))).map(
      (chunk) => transport.seal(chunk),
    );
    this.sending = this.sending.then(async () => {
      for (const frame of sealed) {
        const bytes = await frame;
        if (this.dropped) return;
        this.socket.send(bytes);
      }
    });
    this.sending.catch(() => this.fail("bad"));
  }

  close() {
    if (this.finished) return;
    this.finished = true;
    // Messages `send` accepted are already gone from the page: they leave first.
    void this.sending
      .catch(() => undefined)
      .then(() => this.socket.close(1000));
  }

  private async receive(
    frame: Uint8Array,
    handshake: Promise<{ handshake: Initiator }>,
  ) {
    if (this.finished) return;
    if (!this.transport) {
      const { payload, transport } = await (
        await handshake
      ).handshake.finish(frame);
      // The channel may have ended while the answer was decrypting.
      if (this.finished) return;
      const answer: unknown = JSON.parse(decoder.decode(payload));
      if (jsonField(answer, "ok") !== true) {
        this.fail(serverError(answer));
        return;
      }
      this.transport = transport;
      const host = jsonField(answer, "host");
      const version = jsonField(answer, "version");
      this.onopen?.({
        host: typeof host === "string" ? host : "",
        version: typeof version === "string" ? version : "",
      });
      return;
    }
    const message = this.reassembly.push(await this.transport.open(frame));
    if (message && !this.finished)
      this.onmessage?.(JSON.parse(decoder.decode(message)));
  }

  private fail(end: ChannelEnd) {
    if (this.finished) return;
    this.dropped = true;
    this.finish(end);
    this.socket.close(1000);
  }

  private finish(end: ChannelEnd) {
    this.finished = true;
    this.onclose?.(end);
  }
}

/** A channel to a paired server from this page, or to the server of a pairing QR code. */
export function serverChannel(
  server: Pick<PairedServer, "server" | "keyPair" | "publicKey">,
  open: OpenRequest,
  pair?: string,
): Channel {
  return new RelayChannel({
    server: server.server,
    keyPair: server.keyPair,
    publicKey: decodeKey(server.publicKey) ?? new Uint8Array(),
    label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
    open,
    pair,
    location: window.location,
  });
}
