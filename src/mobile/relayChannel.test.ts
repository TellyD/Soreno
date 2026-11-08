import { afterEach, describe, expect, it, vi } from "vitest";
import { Initiator, generateStaticKey, type Transport } from "./noise";
import { Responder, randomStaticKey } from "./noiseResponder.testing";
import {
  CHUNK_LIMIT,
  MESSAGE_LIMIT,
  PHONE_FRAME_LIMIT,
  PHONE_PROLOGUE,
  Reassembly,
  chunks,
  encodeKey,
} from "./protocol";
import {
  RelayChannel,
  relayUrl,
  type ChannelEnd,
  type OpenRequest,
  type RelaySocket,
} from "./relayChannel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeSocket implements RelaySocket {
  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  sent: Uint8Array[] = [];
  closed: number | null = null;
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = code ?? 1005;
    this.readyState = WebSocket.CLOSING;
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.call(this as never, new Event("open"));
  }
  receive(data: Uint8Array | string) {
    this.onmessage?.call(
      this as never,
      new MessageEvent("message", {
        data: typeof data === "string" ? data : data.slice().buffer,
      }),
    );
  }
  drop(code: number) {
    this.readyState = WebSocket.CLOSED;
    // Node 22 has no CloseEvent global.
    this.onclose?.call(
      this as never,
      Object.assign(new Event("close"), { code }) as CloseEvent,
    );
  }
}

/** A phone channel and the server answering it, with Noise on both ends. */
async function connect(open: OpenRequest, pair?: string) {
  const server = await randomStaticKey();
  const phone = await generateStaticKey();
  const sockets: FakeSocket[] = [];
  const events: unknown[] = [];
  const channel = new RelayChannel({
    server: encodeKey(server.publicKey),
    keyPair: phone.keyPair,
    publicKey: phone.publicKey,
    label: "iPhone · Safari",
    open,
    pair,
    location: { protocol: "https:", host: "192.0.2.10" },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  channel.onopen = (hello) => events.push(["open", hello]);
  channel.onmessage = (message) => events.push(["message", message]);
  channel.onclose = (end: ChannelEnd) => events.push(["close", end]);
  const socket = sockets[0];
  socket.open();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const { responder, payload } = await Responder.read({
    local: server,
    prologue: PHONE_PROLOGUE,
    message: socket.sent[0],
  });
  expect(encodeKey(responder.remoteStatic)).toBe(encodeKey(phone.publicKey));
  return {
    channel,
    socket,
    events,
    request: JSON.parse(decoder.decode(payload)) as unknown,
    answer: async (reply: unknown) => {
      const { message, transport } = await responder.write(
        encoder.encode(JSON.stringify(reply)),
      );
      socket.receive(message);
      return transport;
    },
  };
}

async function serverSend(
  socket: FakeSocket,
  transport: Transport,
  message: unknown,
) {
  for (const chunk of chunks(encoder.encode(JSON.stringify(message))))
    socket.receive(await transport.seal(chunk));
}

describe("relay channel", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("opens through the page's own server in development, through the relay host otherwise", () => {
    expect(relayUrl({ protocol: "http:", host: "127.0.0.1:5173" }, "k")).toBe(
      "ws://127.0.0.1:5173/relay/phone/k",
    );
    vi.stubEnv("DEV", false);
    expect(relayUrl({ protocol: "https:", host: "mobile.example" }, "k")).toBe(
      "wss://relay.soreno.dev/relay/phone/k",
    );
  });

  it("asks for a pairing in the first message and exchanges chunked JSON once accepted", async () => {
    const { channel, socket, events, request, answer } = await connect(
      { kind: "sessions" },
      "secret",
    );
    expect(socket.url).toMatch(
      /^wss:\/\/192\.0\.2\.10\/relay\/phone\/[A-Za-z0-9_-]{43}$/,
    );
    expect(socket.binaryType).toBe("arraybuffer");
    expect(request).toEqual({
      v: 1,
      label: "iPhone · Safari",
      pair: "secret",
      open: { kind: "sessions" },
    });
    expect(channel.open).toBe(false);

    const transport = await answer({ ok: true, host: "vps", version: "4.2" });
    await vi.waitFor(() => expect(channel.open).toBe(true));
    expect(events).toEqual([["open", { host: "vps", version: "4.2" }]]);

    const image = { type: "image", id: 1, data: "x".repeat(CHUNK_LIMIT * 2) };
    channel.send(image);
    channel.send({ type: "input", data: "\r" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    const reassembly = new Reassembly();
    const received: unknown[] = [];
    for (const frame of socket.sent.slice(1)) {
      const message = reassembly.push(await transport.open(frame));
      if (message) received.push(JSON.parse(decoder.decode(message)));
    }
    expect(received).toEqual([image, { type: "input", data: "\r" }]);

    const sessions = {
      type: "sessions",
      host: "vps",
      sessions: [],
      padding: "é".repeat(CHUNK_LIMIT),
    };
    await serverSend(socket, transport, sessions);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual(["message", sessions]);

    socket.drop(1000);
    await vi.waitFor(() => expect(events[2]).toEqual(["close", "closed"]));
  });

  it("reports the server's refusal and closes", async () => {
    const { channel, socket, events, request, answer } = await connect({
      kind: "conversation",
      key: "0123456789abcdef0123456789abcdef",
    });
    expect(request).toEqual({
      v: 1,
      label: "iPhone · Safari",
      open: { kind: "conversation", key: "0123456789abcdef0123456789abcdef" },
    });
    await answer({ ok: false, error: "unpaired" });
    await vi.waitFor(() => expect(events).toEqual([["close", "unpaired"]]));
    expect(socket.closed).toBe(1000);
    expect(channel.open).toBe(false);
    socket.drop(1000);
    expect(events).toHaveLength(1);
  });

  it.each([
    [4404, "offline"],
    [4429, "busy"],
    [4400, "bad"],
    [1000, "bad"],
    [1006, "network"],
  ] as const)("tells close code %i apart", async (code, end) => {
    const { socket, events } = await connect({ kind: "sessions" });
    socket.drop(code);
    await vi.waitFor(() => expect(events).toEqual([["close", end]]));
  });

  it("gives up on an answer that does not decrypt", async () => {
    const { socket, events } = await connect({ kind: "sessions" });
    socket.receive(new Uint8Array(80));
    await vi.waitFor(() => expect(events).toEqual([["close", "bad"]]));
    expect(socket.closed).toBe(1000);
  });

  it("stays silent once closed by the page", async () => {
    const { channel, socket, events } = await connect({ kind: "sessions" });
    channel.close();
    await vi.waitFor(() => expect(socket.closed).toBe(1000));
    socket.drop(1000);
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("reports a refusal the server closes right behind", async () => {
    const { socket, events, answer } = await connect({ kind: "sessions" });
    await answer({ ok: false, error: "unpaired" });
    socket.drop(1000);
    await vi.waitFor(() => expect(events).toEqual([["close", "unpaired"]]));
  });

  it("delivers the messages received before the server closes", async () => {
    const { socket, events, answer } = await connect({ kind: "sessions" });
    const transport = await answer({ ok: true, host: "vps", version: "4" });
    const gone = { type: "gone" };
    const [sealed] = chunks(encoder.encode(JSON.stringify(gone)));
    socket.receive(await transport.seal(sealed));
    socket.drop(1000);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events.slice(1)).toEqual([
      ["message", gone],
      ["close", "closed"],
    ]);
  });

  it("refuses to send once the relay closed, while the last frames still decrypt", async () => {
    const { channel, socket, events, answer } = await connect({
      kind: "sessions",
    });
    const transport = await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(channel.open).toBe(true));
    const [sealed] = chunks(encoder.encode(JSON.stringify({ type: "gone" })));
    socket.receive(await transport.seal(sealed));
    socket.drop(1000);
    expect(events).toHaveLength(1);
    expect(channel.open).toBe(false);
    channel.send({ type: "input", data: "draft" });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(socket.sent).toHaveLength(1);
  });

  it("refuses to send while the relay is closing the socket", async () => {
    const { channel, socket, answer } = await connect({ kind: "sessions" });
    await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(channel.open).toBe(true));
    socket.readyState = WebSocket.CLOSING;
    expect(channel.open).toBe(false);
    channel.send({ type: "input", data: "draft" });
    channel.close();
    await vi.waitFor(() => expect(socket.closed).toBe(1000));
    expect(socket.sent).toHaveLength(1);
  });

  it("gives up when frames arrive faster than they decrypt", async () => {
    const { socket, events, answer } = await connect({ kind: "sessions" });
    await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const stalled = new Promise<ArrayBuffer>(() => undefined);
    vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(stalled);
    const frame = new Uint8Array(PHONE_FRAME_LIMIT);
    for (let queued = 0; queued <= 2 * MESSAGE_LIMIT; queued += frame.length)
      socket.receive(frame);
    expect(events[1]).toEqual(["close", "bad"]);
    expect(socket.closed).toBe(1000);
  });

  it("drops a text frame without reading it as a length", async () => {
    const { socket, events, answer } = await connect({ kind: "sessions" });
    await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    socket.receive("1073741824");
    expect(events[1]).toEqual(["close", "bad"]);
  });

  it("does not open once it gave up while the answer was decrypting", async () => {
    const { channel, socket, events, answer } = await connect({
      kind: "sessions",
    });
    const finish = Initiator.prototype.finish;
    let release = () => {};
    let answered: Promise<unknown> | null = null;
    vi.spyOn(Initiator.prototype, "finish").mockImplementationOnce(function (
      this: Initiator,
      message,
    ) {
      const result = finish.call(this, message);
      const gated = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => result);
      answered = gated;
      return gated;
    });
    await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(answered).not.toBeNull());
    const frame = new Uint8Array(PHONE_FRAME_LIMIT);
    for (let queued = 0; queued <= 2 * MESSAGE_LIMIT; queued += frame.length)
      socket.receive(frame);
    expect(events).toEqual([["close", "bad"]]);
    release();
    await answered;
    expect(events).toEqual([["close", "bad"]]);
    expect(channel.open).toBe(false);
  });

  it("sends every accepted message before closing on request", async () => {
    const { channel, socket, answer } = await connect({ kind: "sessions" });
    const transport = await answer({ ok: true, host: "vps", version: "4" });
    await vi.waitFor(() => expect(channel.open).toBe(true));
    const text = { type: "input", data: "x".repeat(CHUNK_LIMIT) };
    channel.send(text);
    channel.send({ type: "input", data: "\r" });
    channel.close();
    expect(channel.open).toBe(false);
    await vi.waitFor(() => expect(socket.closed).toBe(1000));
    const reassembly = new Reassembly();
    const received: unknown[] = [];
    for (const frame of socket.sent.slice(1)) {
      const message = reassembly.push(await transport.open(frame));
      if (message) received.push(JSON.parse(decoder.decode(message)));
    }
    expect(received).toEqual([text, { type: "input", data: "\r" }]);
  });
});
