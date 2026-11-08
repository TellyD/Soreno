// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/testing/deferred";
import { MobileApp } from "./MobileApp";
import type { RemoteSession } from "./mobileApi";
import type { PairingCode } from "./pairing";
import type {
  Channel,
  ChannelEnd,
  OpenRequest,
  ServerHello,
} from "./relayChannel";
import type { PairedServer, ServerStore } from "./serverStore";

const KEY = "0123456789abcdef0123456789abcdef";
const VPS = `${"V".repeat(42)}Q`;
const LAB = `${"L".repeat(42)}Q`;
const SECRET = "s".repeat(43);

class FakeChannel implements Channel {
  open = false;
  closed = false;
  onopen: Channel["onopen"] = null;
  onmessage: Channel["onmessage"] = null;
  onclose: Channel["onclose"] = null;
  constructor(
    readonly server: PairedServer,
    readonly request: OpenRequest,
    readonly pair: string | undefined,
  ) {}
  send() {}
  close() {
    this.closed = true;
  }
}

const fakes = vi.hoisted(() => ({
  channels: [] as FakeChannel[],
  supported: true,
  scanned: null as ((text: string) => void) | null,
}));

vi.mock("./relayChannel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./relayChannel")>()),
  serverChannel: (
    server: PairedServer,
    request: OpenRequest,
    pair?: string,
  ) => {
    const channel = new FakeChannel(server, request, pair);
    fakes.channels.push(channel);
    return channel;
  },
}));
vi.mock("./noise", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./noise")>()),
  x25519Supported: async () => fakes.supported,
}));
vi.mock("./qrScanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./qrScanner")>()),
  startScanner: async (
    _video: HTMLVideoElement,
    onText: (text: string) => void,
  ) => {
    fakes.scanned = onText;
    return () => {
      fakes.scanned = null;
    };
  },
}));
let showConversation: (shown: boolean) => void = () => undefined;
vi.mock("./SessionView", () => ({
  SessionView: ({
    target,
    onShown,
  }: {
    target: { server: PairedServer; key: string };
    onShown: (id: string, shown: boolean) => void;
  }) => {
    showConversation = (shown) =>
      onShown(`${target.server.server}/${target.key}`, shown);
    return <p className="session-view" />;
  },
}));

vi.hoisted(() => {
  Object.assign(window, {
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(navigator, "language", {
    configurable: true,
    value: "fr-FR",
  });
});

function memoryStore(servers: PairedServer[] = []) {
  const saved = new Map(servers.map((server) => [server.server, server]));
  const store: ServerStore = {
    list: async () => [...saved.values()],
    save: async (server) => {
      saved.set(server.server, server);
    },
    forget: async (server) => {
      saved.delete(server);
    },
  };
  return { store, saved };
}

function paired(server: string, host: string): PairedServer {
  return {
    server,
    host,
    keyPair: {} as CryptoKeyPair,
    publicKey: "",
    pairedAt: 1,
  };
}

function session(key: string, working: boolean): RemoteSession {
  return {
    key,
    label: "Soreno · OMP",
    attached: true,
    provider: "omp",
    name: null,
    working,
    awaiting: false,
  };
}

function channelsOf(server: string) {
  return fakes.channels.filter((channel) => channel.server.server === server);
}

function latest(server: string) {
  const list = channelsOf(server);
  return list[list.length - 1];
}

async function accept(server: string, hello: ServerHello) {
  await act(async () => {
    const channel = latest(server);
    channel.open = true;
    channel.onopen?.(hello);
  });
}

async function publish(
  server: string,
  host: string,
  sessions: RemoteSession[],
) {
  await act(async () =>
    latest(server).onmessage?.({ type: "sessions", host, sessions }),
  );
}

async function end(server: string, reason: ChannelEnd) {
  await act(async () => latest(server).onclose?.(reason));
}

function unread(id: string) {
  const stored = JSON.parse(
    localStorage.getItem("soreno-mobile-session-unread") ?? "{}",
  ) as { unread?: string[] };
  return stored.unread?.includes(id) ? "unread" : "read";
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
}

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  visibility = "visible";
  fakes.channels.length = 0;
  fakes.supported = true;
  vi.stubGlobal("indexedDB", {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

async function renderApp(
  store: ServerStore,
  initialPairing: PairingCode | "invalid" | null = null,
) {
  await act(async () =>
    root.render(<MobileApp store={store} initialPairing={initialPairing} />),
  );
  await act(async () => {
    await vi.waitFor(() => expect(container.childElementCount).toBe(1));
  });
}

describe("unread marks", () => {
  beforeEach(() => {
    localStorage.setItem(
      "soreno-mobile-session-unread",
      JSON.stringify({ working: [`${VPS}/${KEY}`], unread: [] }),
    );
    window.location.hash = `#/s/${VPS}/${KEY}`;
  });

  it("keeps an open session unread until its conversation shows on a visible page", async () => {
    visibility = "hidden";
    await renderApp(memoryStore([paired(VPS, "vps")]).store);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await accept(VPS, { host: "vps", version: "1" });
    await publish(VPS, "vps", [session(KEY, false)]);
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => showConversation(true));
    expect(unread(`${VPS}/${KEY}`)).toBe("unread");

    visibility = "visible";
    await act(async () => showConversation(false));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await accept(VPS, { host: "vps", version: "1" });
    expect(unread(`${VPS}/${KEY}`)).toBe("unread");

    await act(async () => showConversation(true));
    expect(unread(`${VPS}/${KEY}`)).toBe("read");
  });

  it("keeps the unread mark of a session whose server is unreachable", async () => {
    localStorage.setItem(
      "soreno-mobile-session-unread",
      JSON.stringify({ working: [], unread: [`${LAB}/${KEY}`] }),
    );
    window.location.hash = `#/s/${LAB}/${KEY}`;
    await renderApp(
      memoryStore([paired(VPS, "vps"), paired(LAB, "lab")]).store,
    );
    await end(LAB, "offline");
    await act(async () => showConversation(true));
    expect(unread(`${LAB}/${KEY}`)).toBe("unread");
  });

  it("keeps the next session unread until its own conversation shows", async () => {
    const other = "fedcba9876543210fedcba9876543210";
    localStorage.setItem(
      "soreno-mobile-session-unread",
      JSON.stringify({ working: [], unread: [`${VPS}/${other}`] }),
    );
    await renderApp(memoryStore([paired(VPS, "vps")]).store);
    await accept(VPS, { host: "vps", version: "1" });
    await publish(VPS, "vps", [session(KEY, false), session(other, false)]);
    await act(async () => showConversation(true));

    await act(async () => {
      window.location.hash = `#/s/${VPS}/${other}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(unread(`${VPS}/${other}`)).toBe("unread");

    await act(async () => showConversation(true));
    expect(unread(`${VPS}/${other}`)).toBe("read");
  });
});

describe("home", () => {
  it("keeps both removals when a local forget overtakes another tab's pending reload", async () => {
    vi.stubGlobal("confirm", () => true);
    const { store, saved } = memoryStore([
      paired(VPS, "vps"),
      paired(LAB, "lab"),
    ]);
    await renderApp(store);
    expect(fakes.channels.map((channel) => channel.request)).toEqual([
      { kind: "sessions" },
      { kind: "sessions" },
    ]);
    await accept(VPS, { host: "vps", version: "1" });
    await publish(VPS, "vps", [session(KEY, true)]);
    await end(LAB, "unpaired");
    expect(
      [...container.querySelectorAll(".mobile-host")].map((group) => [
        group.getAttribute("aria-label"),
        group.querySelector(".mobile-host-status")?.textContent,
        group.querySelectorAll(".mobile-session").length,
      ]),
    ).toEqual([
      ["lab", "Appareil retiré", 0],
      ["vps", "En ligne", 1],
    ]);

    saved.delete(VPS);
    const snapshot = [...saved.values()];
    const stale = deferred<PairedServer[]>();
    const started = deferred<void>();
    vi.spyOn(store, "list").mockImplementationOnce(() => {
      started.resolve();
      return stale.promise;
    });
    const other = new BroadcastChannel("soreno-mobile-servers");
    await act(async () => {
      other.postMessage(null);
      await started.promise;
    });
    other.close();

    await act(async () => button("Oublier ce serveur")!.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelectorAll(".mobile-host")).toHaveLength(0),
      );
    });
    await act(async () => stale.resolve(snapshot));
    expect(container.querySelectorAll(".mobile-host")).toHaveLength(0);
    expect([...saved.keys()]).toEqual([]);
    expect(channelsOf(LAB)).toHaveLength(1);
    expect(channelsOf(VPS)[0].closed).toBe(true);
  });

  it("drops a server forgotten from another tab", async () => {
    const { store, saved } = memoryStore([
      paired(VPS, "vps"),
      paired(LAB, "lab"),
    ]);
    const list = vi.spyOn(store, "list");
    await renderApp(store);
    await accept(LAB, { host: "lab", version: "1" });
    const snapshot = [...saved.values()];
    const stale = deferred<PairedServer[]>();
    const started = deferred<void>();
    list.mockImplementationOnce(() => {
      started.resolve();
      return stale.promise;
    });
    const other = new BroadcastChannel("soreno-mobile-servers");
    await act(async () => {
      other.postMessage(null);
      await started.promise;
    });
    saved.delete(LAB);
    // The act scope must outlive the re-read, which the hook awaits before us.
    await act(async () => {
      other.postMessage(null);
      other.close();
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      await list.mock.results[2].value;
    });
    await act(async () => stale.resolve(snapshot));
    expect(container.querySelectorAll(".mobile-host")).toHaveLength(1);
    expect(channelsOf(LAB)[0].closed).toBe(true);
    expect(channelsOf(VPS)).toHaveLength(1);
  });

  it("tells an old browser it cannot pair", async () => {
    fakes.supported = false;
    await renderApp(memoryStore().store);
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Navigateur trop ancien"),
      );
    });
  });
});

describe("pairing", () => {
  const code: PairingCode = { server: VPS, secret: SECRET };

  it("pairs with the server of the QR code and remembers it", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/129.0",
      storage: { persist },
    });
    const { store, saved } = memoryStore();
    await renderApp(store, code);
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    expect(container.textContent).toContain("Appairage en cours…");
    const pairing = latest(VPS);
    expect([pairing.request, pairing.pair]).toEqual([
      { kind: "sessions" },
      SECRET,
    ]);
    expect(pairing.server.keyPair.privateKey.extractable).toBe(false);

    await accept(VPS, { host: "vps", version: "4" });
    await act(async () => {
      await vi.waitFor(() => expect(saved.get(VPS)?.host).toBe("vps"));
    });
    expect(pairing.closed).toBe(true);
    expect(persist).toHaveBeenCalled();
    expect(saved.get(VPS)?.keyPair).toBe(pairing.server.keyPair);
    // The home screen follows it on a channel of its own, without the secret.
    expect(channelsOf(VPS)).toHaveLength(2);
    expect(latest(VPS).pair).toBeUndefined();
    expect(container.querySelector(".mobile-host")?.textContent).toContain(
      "vps",
    );
  });

  it("shows sessions again after a revoked phone pairs with the same key", async () => {
    const known = paired(VPS, "vps");
    const { store, saved } = memoryStore([known]);
    await renderApp(store);
    await end(VPS, "unpaired");
    await act(async () => {
      window.location.hash = `#p=${VPS}.${SECRET}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest(VPS).pair).toBe(SECRET));
    });
    await accept(VPS, { host: "vps", version: "4" });
    await publish(VPS, "vps", [session(KEY, false)]);
    expect(saved.get(VPS)?.publicKey).toBe(known.publicKey);
    expect(
      container.querySelector(`a[href="#/s/${VPS}/${KEY}"]`),
    ).not.toBeNull();
  });

  it("tells Safari on iOS to pair the home screen app again", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    });
    await renderApp(memoryStore().store, code);
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    await accept(VPS, { host: "vps", version: "4" });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Téléphone appairé à vps"),
      );
    });
    expect(container.textContent).toContain("Partager → Sur l’écran d’accueil");
    await act(async () => button("Voir les sessions")!.click());
    expect(container.querySelector(".mobile-host")).not.toBeNull();
  });

  it.each([
    ["pairing", "Code expiré ou déjà utilisé", false],
    ["throttled", "Trop de tentatives", true],
    ["offline", "Serveur hors ligne", true],
    ["network", "Appairage impossible", true],
  ] as const)("explains a %s failure", async (reason, title, retry) => {
    const { store, saved } = memoryStore();
    await renderApp(store, code);
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    await end(VPS, reason);
    expect(container.querySelector("h2")?.textContent).toBe(title);
    expect(saved.size).toBe(0);
    expect(button("Réessayer") !== undefined).toBe(retry);
    if (!retry) return;
    await act(async () => button("Réessayer")!.click());
    const [first, second] = channelsOf(VPS);
    expect(second.pair).toBe(SECRET);
    expect(second.server.keyPair).toBe(first.server.keyPair);
  });

  it("takes a pairing fragment that arrives on an open page out of the address", async () => {
    await renderApp(memoryStore().store);
    await act(async () => {
      window.location.hash = `#p=${VPS}.${SECRET}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(window.location.hash).toBe("");
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    expect(latest(VPS).pair).toBe(SECRET);
  });

  it("pairs once when the same code arrives again before the answer", async () => {
    const { store, saved } = memoryStore();
    await renderApp(store, code);
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    await act(async () => {
      window.location.hash = `#p=${VPS}.${SECRET}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(channelsOf(VPS)).toHaveLength(1);

    await accept(VPS, { host: "vps", version: "4" });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector(".mobile-host")?.textContent).toContain(
          "vps",
        ),
      );
    });
    expect(saved.get(VPS)?.host).toBe("vps");
    expect(container.textContent).not.toContain("Appairage en cours…");
    expect(channelsOf(VPS).filter((channel) => channel.pair)).toHaveLength(1);
  });

  it("lists a superseded pairing that succeeds without showing it", async () => {
    const { store, saved } = memoryStore();
    await renderApp(store, code);
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    await act(async () => {
      window.location.hash = `#p=${LAB}.${SECRET}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(LAB)).toHaveLength(1));
    });

    await act(async () =>
      channelsOf(VPS)[0].onopen?.({ host: "vps", version: "4" }),
    );
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(2));
    });
    expect(saved.get(VPS)?.host).toBe("vps");
    expect(latest(VPS).pair).toBeUndefined();
    expect(container.textContent).toContain("Appairage en cours…");

    await end(LAB, "pairing");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Code expiré ou déjà utilisé",
    );
  });

  it("pairs from a scanned QR code of this page only", async () => {
    await renderApp(memoryStore().store);
    await act(async () => button("Scanner un QR code")!.click());
    await act(async () => {
      await vi.waitFor(() => expect(fakes.scanned).not.toBeNull());
    });
    await act(async () =>
      fakes.scanned!(`https://elsewhere.example/#p=${VPS}.${SECRET}`),
    );
    expect(container.textContent).toContain(
      "Ce QR code n’est pas un code d’appairage de Soreno.",
    );
    expect(fakes.channels).toHaveLength(0);

    await act(async () =>
      fakes.scanned!(`${window.location.origin}/#p=${VPS}.${SECRET}`),
    );
    await act(async () => {
      await vi.waitFor(() => expect(channelsOf(VPS)).toHaveLength(1));
    });
    expect(latest(VPS).pair).toBe(SECRET);
    expect(fakes.scanned).toBeNull();
  });
});
