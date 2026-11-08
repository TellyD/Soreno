// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ConversationReset } from "./conversation";
import {
  ConversationConnection,
  suspendWhileHidden,
  type ConnectionStatus,
} from "./conversationConnection";
import type { Channel, ChannelEnd } from "./relayChannel";

class FakeChannel implements Channel {
  open = false;
  closed = false;
  sent: unknown[] = [];
  onopen: Channel["onopen"] = null;
  onmessage: Channel["onmessage"] = null;
  onclose: Channel["onclose"] = null;

  send(message: unknown) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
    this.open = false;
  }
  accept() {
    this.open = true;
    this.onopen?.({ host: "vps", version: "1" });
  }
  receive(message: unknown) {
    this.onmessage?.(message);
  }
  drop(end: ChannelEnd = "network") {
    this.open = false;
    this.onclose?.(end);
  }
}

function connect() {
  const channels: FakeChannel[] = [];
  const statuses: ConnectionStatus[] = [];
  const events: unknown[] = [];
  const connection = new ConversationConnection({
    openChannel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    },
    onStatus: (status) => statuses.push(status),
    onReset: (reset: ConversationReset, items: ConversationItem[]) =>
      events.push(["reset", reset, items]),
    onItems: (items: ConversationItem[]) => events.push(["items", items]),
    onWorking: (working) => events.push(["working", working]),
  });
  return { connection, channels, statuses, events };
}

const user: ConversationItem = {
  kind: "user",
  id: "u1",
  text: "Salut",
  images: 0,
};

describe("ConversationConnection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispatches the reset with its items, later items and the agent state without answering", () => {
    const { channels, events } = connect();
    channels[0].accept();
    channels[0].receive({
      type: "reset",
      provider: "claude",
      available: true,
      truncated: false,
      rpc: true,
      items: [user],
    });
    channels[0].receive({ type: "status", working: true });
    channels[0].receive({ type: "items", items: [user] });
    // An older server sends the first items apart.
    channels[0].receive({
      type: "reset",
      provider: "claude",
      available: true,
      truncated: false,
    });
    const reset = {
      provider: "claude",
      available: true,
      truncated: false,
      images: false,
      deleted: false,
    };
    expect(events).toEqual([
      ["reset", { ...reset, rpc: true }, [user]],
      ["working", true],
      ["items", [user]],
      ["reset", { ...reset, rpc: false }, []],
    ]);
    expect(channels[0].sent).toEqual([]);
  });

  it("sends input to the session once the server accepted the channel", () => {
    const { connection, channels } = connect();
    expect(connection.input("\r")).toBe(false);
    channels[0].accept();
    expect(connection.input("\r")).toBe(true);
    expect(channels[0].sent).toEqual([{ type: "input", data: "\r" }]);
  });

  it("answers each image with its saved path, and fails it on a refusal or a lost connection", async () => {
    const { connection, channels } = connect();
    channels[0].accept();
    const saved = connection.sendImage("image/png", "aW1n");
    const refused = connection.sendImage("image/png", "aW1n");
    expect(channels[0].sent).toEqual([
      { type: "image", id: 1, mimeType: "image/png", data: "aW1n" },
      { type: "image", id: 2, mimeType: "image/png", data: "aW1n" },
    ]);
    channels[0].receive({ type: "imageFailed", id: 2 });
    channels[0].receive({ type: "imageSaved", id: 1, path: "/h/clipboard/i" });
    await expect(saved).resolves.toBe("/h/clipboard/i");
    await expect(refused).rejects.toThrow();

    const lost = connection.sendImage("image/png", "aW1n");
    channels[0].drop();
    await expect(lost).rejects.toThrow();
    await expect(connection.sendImage("image/png", "aW1n")).rejects.toThrow();
  });

  it("reconnects after losing the connection, and stops once the session ends", async () => {
    const { channels, statuses } = connect();
    channels[0].accept();
    channels[0].drop("closed");
    await vi.advanceTimersByTimeAsync(500);
    expect(channels).toHaveLength(2);
    channels[1].accept();
    channels[1].receive({ type: "ended" });
    channels[1].drop("closed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels).toHaveLength(2);
    expect(statuses).toEqual([
      "connecting",
      "open",
      "reconnecting",
      "open",
      "ended",
    ]);
  });

  it("keeps retrying while the server is offline", async () => {
    const { channels, statuses } = connect();
    channels[0].drop("offline");
    await vi.advanceTimersByTimeAsync(500);
    channels[1].drop("offline");
    await vi.advanceTimersByTimeAsync(1000);
    expect(channels).toHaveLength(3);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
  });

  it.each([
    ["gone", "gone"],
    ["unpaired", "unpaired"],
  ] as const)("gives up when the server answers %s", async (end, status) => {
    const { channels, statuses } = connect();
    channels[0].drop(end);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels).toHaveLength(1);
    expect(statuses).toEqual(["connecting", status]);
  });

  it("stays disconnected when opened in a hidden page, until it is shown", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { connection, channels } = connect();
    const unfollow = suspendWhileHidden(connection);
    expect(channels[0].closed).toBe(true);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(channels).toHaveLength(2);
    unfollow();
    visibility.mockRestore();
  });

  it("splits long input under the message limit", () => {
    const { connection, channels } = connect();
    channels[0].accept();
    expect(connection.input("é".repeat(20_000))).toBe(true);
    const chunks = channels[0].sent as { type: string; data: string }[];
    expect(chunks.map((chunk) => chunk.data.length)).toEqual([
      8000, 8000, 4000,
    ]);
    expect(chunks.every((chunk) => chunk.type === "input")).toBe(true);
  });

  it("stays disconnected while hidden, and reconnects when shown", async () => {
    const { connection, channels, statuses } = connect();
    channels[0].accept();
    connection.suspend();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open", "reconnecting"]);
    connection.wake();
    expect(channels).toHaveLength(2);
  });

  it("keeps a single attempt when woken while reconnecting", async () => {
    const { connection, channels } = connect();
    channels[0].accept();
    channels[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(channels).toHaveLength(2);
    connection.wake();
    expect(channels).toHaveLength(2);
    connection.dispose();
    expect(channels[1].closed).toBe(true);
  });

  it("does not reconnect after being hidden during a backoff", async () => {
    const { connection, channels, statuses } = connect();
    channels[0].accept();
    channels[0].drop();
    connection.suspend();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels).toHaveLength(1);
    connection.wake();
    expect(channels).toHaveLength(2);
    channels[1].accept();
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("ignores the end of a channel it already left", async () => {
    const { connection, channels } = connect();
    connection.suspend();
    channels[0].drop("gone");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels).toHaveLength(1);
    connection.wake();
    expect(channels).toHaveLength(2);
  });
});
