import { generateStaticKey } from "./noise";
import { decodeKey, encodeKey } from "./protocol";
import type { ChannelEnd } from "./relayChannel";
import type { OpenChannel } from "./serverFeeds";
import {
  clonesX25519Keys,
  type PairedServer,
  type ServerStore,
} from "./serverStore";

/** What a pairing QR code carries in its fragment, never sent over the network. */
export type PairingCode = { server: string; secret: string };

/** A pairing under way: the key is kept for a retry with the same secret. */
export type PairingRequest = PairingCode & {
  keyPair: CryptoKeyPair;
  publicKey: string;
  pairedAt: number | null;
};

type PairingResult =
  { ok: true; server: PairedServer } | { ok: false; end: ChannelEnd };

const PAIRING_FRAGMENT = /^#p=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

function parsePairingFragment(hash: string): PairingCode | null {
  const match = PAIRING_FRAGMENT.exec(hash);
  if (!match || !decodeKey(match[1])) return null;
  return { server: match[1], secret: match[2] };
}

/**
 * Takes the pairing fragment out of the address before anything else: the secret must not stay in history.
 * `invalid` for a damaged pairing address, null without one.
 */
export function takePairingFragment(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): PairingCode | "invalid" | null {
  const hash = location.hash;
  if (!hash.startsWith("#p=")) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return parsePairingFragment(hash) ?? "invalid";
}

/** A scanned QR code: only a pairing address of this very page is followed. */
export function pairingFromUrl(text: string, origin: string) {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.origin === origin ? parsePairingFragment(url.hash) : null;
}

/** Keeps the key of an already paired server: its devices list this phone once. */
export async function pairingRequest(
  code: PairingCode,
  store: ServerStore,
): Promise<PairingRequest> {
  const known = (await store.list()).find(
    (entry) => entry.server === code.server,
  );
  if (known)
    return {
      ...code,
      keyPair: known.keyPair,
      publicKey: known.publicKey,
      pairedAt: known.pairedAt,
    };
  const { keyPair, publicKey } = await generateStaticKey(
    !(await clonesX25519Keys()),
  );
  return { ...code, keyPair, publicKey: encodeKey(publicKey), pairedAt: null };
}

/** Pairs with the server of the request, and remembers it once the server accepts. */
export function pair(
  request: PairingRequest,
  store: ServerStore,
  openChannel: OpenChannel,
  now = Date.now(),
) {
  const server: PairedServer = {
    server: request.server,
    host: "",
    keyPair: request.keyPair,
    publicKey: request.publicKey,
    pairedAt: request.pairedAt ?? now,
  };
  return new Promise<PairingResult>((resolve) => {
    const channel = openChannel(server, { kind: "sessions" }, request.secret);
    channel.onopen = (hello) => {
      channel.close();
      const paired = { ...server, host: hello.host || request.server };
      store.save(paired).then(
        () => resolve({ ok: true, server: paired }),
        () => resolve({ ok: false, end: "bad" }),
      );
    };
    channel.onclose = (end) => resolve({ ok: false, end });
  });
}

/** Asks the browser to keep the keys when it clears storage; it may refuse. */
export function persistStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}
