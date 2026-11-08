// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteHost } from "./mobileApi";
import type { Channel, ChannelEnd } from "./relayChannel";
import { ServerFeeds } from "./serverFeeds";
import type { PairedServer } from "./serverStore";

class FakeChannel implements Channel {
  open = false;
  closed = false;
  onopen: Channel["onopen"] = null;
  onmessage: Channel["onmessage"] = null;
  onclose: Channel["onclose"] = null;
  constructor(readonly server: string) {}
  send() {}
  close() {
    this.closed = true;
  }
  end(reason: ChannelEnd) {
    this.onclose?.(reason);
  }
}

const VPS: PairedServer = {
  server: `${"V".repeat(42)}Q`,
  host: "vps",
  keyPair: {} as CryptoKeyPair,
  publicKey: "",
  pairedAt: 0,
};

function follow() {
  const channels: FakeChannel[] = [];
  let hosts: RemoteHost[] = [];
  const feeds = new ServerFeeds(
    (server) => {
      const channel = new FakeChannel(server.server);
      channels.push(channel);
      return channel;
    },
    (next) => {
      hosts = next;
    },
  );
  feeds.follow([VPS]);
  return { feeds, channels, hosts: () => hosts };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps the last sessions of a server gone offline and retries with backoff", async () => {
  const { feeds, channels, hosts } = follow();
  channels[0].onopen?.({ host: "vps-1", version: "1" });
  expect(hosts()[0]).toMatchObject({ host: "vps-1", state: "connecting" });
  const session = { key: "k", label: null, attached: false, provider: null };
  channels[0].onmessage?.({
    type: "sessions",
    host: "vps-1",
    sessions: [session],
  });
  expect(hosts()[0]).toMatchObject({ state: "online", sessions: [session] });
  feeds.follow([{ ...VPS }]);
  expect(channels).toHaveLength(1);

  channels[0].end("offline");
  expect(hosts()[0]).toMatchObject({ state: "offline", sessions: [session] });
  await vi.advanceTimersByTimeAsync(1000);
  channels[1].end("network");
  await vi.advanceTimersByTimeAsync(1999);
  expect(channels).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(channels).toHaveLength(3);
});

it("stops at a revoked device until its pairing is refreshed, even with the same key", async () => {
  const { feeds, channels, hosts } = follow();
  channels[0].end("unpaired");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(channels).toHaveLength(1);
  expect(hosts()[0].state).toBe("unpaired");

  feeds.follow([{ ...VPS }]);
  const session = { key: "k", label: null, attached: false, provider: null };
  channels[1].onmessage?.({
    type: "sessions",
    host: "vps",
    sessions: [session],
  });
  expect(hosts()[0]).toMatchObject({ state: "online", sessions: [session] });
});

it("closes the channels while the page is hidden, and reopens them when shown", () => {
  const { feeds, channels } = follow();
  feeds.suspend();
  expect(channels[0].closed).toBe(true);
  feeds.follow([VPS]);
  expect(channels).toHaveLength(1);
  feeds.wake();
  expect(channels).toHaveLength(2);
  feeds.follow([]);
  expect(channels[1].closed).toBe(true);
});
