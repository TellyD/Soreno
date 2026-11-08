import { useCallback, useEffect, useRef, useState } from "react";
import { installPlatform, isStandalone } from "./installHint";
import {
  pair,
  pairingRequest,
  persistStorage,
  takePairingFragment,
  type PairingCode,
  type PairingRequest,
} from "./pairing";
import { serverChannel, type ChannelEnd } from "./relayChannel";
import type { OpenChannel } from "./serverFeeds";
import type { PairedServer, ServerStore } from "./serverStore";

export type PairingPhase =
  | { kind: "pairing" }
  | { kind: "failed"; end: ChannelEnd | "invalid" }
  /** Shown only where the home screen app will not see this pairing: Safari on iOS. */
  | { kind: "paired"; host: string };

/** A pairing under way, shown while its attempt is the current one. */
type Flight = {
  code: PairingCode;
  attempt: number;
  request: PairingRequest | null;
};

/** iOS gives a home screen app its own storage, apart from Safari's. */
function pairingStaysInBrowser() {
  return (
    installPlatform(navigator.userAgent, navigator.maxTouchPoints) === "ios" &&
    !isStandalone()
  );
}

/**
 * Pairs with the server of a QR code: from the address the page opened with, a later
 * `#p=` fragment, or a scan. A retry reuses the secret and the key kept in memory.
 */
export function usePairing(
  store: ServerStore,
  initial: PairingCode | "invalid" | null,
  onPaired: (server: PairedServer) => void,
  openChannel: OpenChannel = serverChannel,
) {
  const [phase, setPhase] = useState<PairingPhase | null>(null);
  const requestRef = useRef<PairingRequest | null>(null);
  // Bumped by every start and close: a superseded pairing then shows nothing.
  const attemptRef = useRef(0);
  const flightsRef = useRef(new Set<Flight>());

  const run = useCallback(
    async (request: PairingRequest, flight: Flight) => {
      setPhase({ kind: "pairing" });
      const result = await pair(request, store, openChannel);
      if (flight.attempt !== attemptRef.current) {
        // Already saved: the home screen must list it even though nothing shows it.
        if (result.ok) onPaired(result.server);
        return;
      }
      if (!result.ok) {
        setPhase({ kind: "failed", end: result.end });
        return;
      }
      requestRef.current = null;
      onPaired(result.server);
      persistStorage();
      setPhase(
        pairingStaysInBrowser()
          ? { kind: "paired", host: result.server.host }
          : null,
      );
    },
    [store, openChannel, onPaired],
  );

  const fly = useCallback(
    async (flight: Flight, request: Promise<PairingRequest>) => {
      flightsRef.current.add(flight);
      try {
        try {
          flight.request = await request;
        } catch {
          if (flight.attempt === attemptRef.current)
            setPhase({ kind: "failed", end: "bad" });
          return;
        }
        if (flight.attempt !== attemptRef.current) return;
        requestRef.current = flight.request;
        await run(flight.request, flight);
      } finally {
        flightsRef.current.delete(flight);
      }
    },
    [run],
  );

  const start = useCallback(
    async (code: PairingCode | "invalid") => {
      if (code !== "invalid") {
        // The secret is single use: the same code twice would fail the second time.
        const same = [...flightsRef.current].find(
          (flight) =>
            flight.code.server === code.server &&
            flight.code.secret === code.secret,
        );
        if (same) {
          if (same.attempt !== attemptRef.current) {
            same.attempt = ++attemptRef.current;
            requestRef.current = same.request;
            setPhase({ kind: "pairing" });
          }
          return;
        }
      }
      const attempt = ++attemptRef.current;
      requestRef.current = null;
      if (code === "invalid") {
        setPhase({ kind: "failed", end: "invalid" });
        return;
      }
      setPhase({ kind: "pairing" });
      await fly({ code, attempt, request: null }, pairingRequest(code, store));
    },
    [store, fly],
  );

  const initialRef = useRef(initial);
  useEffect(() => {
    if (initialRef.current) void start(initialRef.current);
    initialRef.current = null;
    const take = () => {
      const code = takePairingFragment(window.location, window.history);
      if (code) void start(code);
    };
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, [start]);

  const retry = useCallback(() => {
    const request = requestRef.current;
    if (request)
      void fly(
        { code: request, attempt: ++attemptRef.current, request },
        Promise.resolve(request),
      );
  }, [fly]);

  const close = useCallback(() => {
    attemptRef.current++;
    requestRef.current = null;
    setPhase(null);
  }, []);

  return {
    phase,
    start,
    retry,
    close,
    canRetry: requestRef.current !== null,
  };
}
