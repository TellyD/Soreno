import { MonitorX } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AppTheme } from "@/domain/theme";
import { EmptyState } from "@/components/ui/EmptyState";
import { MessageScreen, PairingView } from "./PairingView";
import { ScanView } from "./ScanView";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { parseSessionRoute } from "./mobileSessions";
import { mobileLocale, mobileStrings } from "./mobileStrings";
import { x25519Supported } from "./noise";
import type { PairingCode } from "./pairing";
import { indexedDbServerStore, type ServerStore } from "./serverStore";
import {
  loadUnreadState,
  nextUnreadState,
  saveUnreadState,
  unreadKey,
} from "./sessionUnread";
import { usePairing } from "./usePairing";
import { useServers } from "./useServers";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const locale = mobileLocale(navigator.language);
const strings = mobileStrings[locale];

function subscribeTheme(onChange: () => void) {
  darkQuery.addEventListener("change", onChange);
  return () => darkQuery.removeEventListener("change", onChange);
}

function subscribeRoute(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Without X25519 or IndexedDB, nothing can be paired. */
function useSupport() {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    const storage = typeof indexedDB !== "undefined";
    void x25519Supported().then((crypto) => {
      if (current) setSupported(crypto && storage);
    });
    return () => {
      current = false;
    };
  }, []);
  return supported;
}

export function MobileApp({
  initialPairing = null,
  store: givenStore,
}: {
  /** The pairing fragment the page opened with, already taken out of the address. */
  initialPairing?: PairingCode | "invalid" | null;
  store?: ServerStore;
}) {
  const theme = useSyncExternalStore<AppTheme>(subscribeTheme, () =>
    darkQuery.matches ? "dark" : "light",
  );
  const hash = useSyncExternalStore(subscribeRoute, () => window.location.hash);
  const route = parseSessionRoute(hash);
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
  );
  const supported = useSupport();
  const [store] = useState(() => givenStore ?? indexedDbServerStore());
  const servers = useServers(store);
  const pairing = usePairing(store, initialPairing, servers.add);
  const [scanning, setScanning] = useState(false);
  const server = route
    ? servers.servers?.find((entry) => entry.server === route.server)
    : undefined;
  const host = route
    ? servers.hosts.find((entry) => entry.server === route.server)
    : undefined;
  const opened = route && server ? unreadKey(route.server, route.key) : null;
  // The session whose conversation is on screen: a flag would carry over to the next route.
  const [shownId, setShownId] = useState<string | null>(null);
  const showSession = useCallback(
    (id: string, shown: boolean) =>
      setShownId((current) => (shown ? id : current === id ? null : current)),
    [],
  );
  // Only a conversation on screen is read: not a hidden page, nor an unreachable server's empty view.
  const displayed =
    visible && host?.state === "online" && shownId === opened ? opened : null;
  const [unreadState, setUnreadState] = useState(loadUnreadState);
  const hosts = servers.hosts;

  useEffect(() => {
    setUnreadState((current) => nextUnreadState(current, hosts, displayed));
  }, [hosts, displayed]);

  useEffect(() => saveUnreadState(unreadState), [unreadState]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, []);

  const scanned = useCallback(
    (code: PairingCode) => {
      setScanning(false);
      void pairing.start(code);
    },
    [pairing.start],
  );

  if (supported === false)
    return (
      <MessageScreen strings={strings}>
        <EmptyState
          fill
          icon={<MonitorX />}
          title={strings.oldBrowserTitle}
          description={strings.oldBrowserBody}
        />
      </MessageScreen>
    );
  if (scanning)
    return (
      <ScanView
        strings={strings}
        onCode={scanned}
        onClose={() => setScanning(false)}
      />
    );
  if (pairing.phase)
    return (
      <PairingView
        phase={pairing.phase}
        canRetry={pairing.canRetry}
        strings={strings}
        onRetry={pairing.retry}
        onScan={() => {
          pairing.close();
          setScanning(true);
        }}
        onClose={pairing.close}
      />
    );
  if (!route || !server || !opened)
    return (
      <SessionList
        servers={servers}
        unread={unreadState.unread}
        strings={strings}
        onScan={() => setScanning(true)}
      />
    );
  return (
    <SessionView
      key={opened}
      target={{ server, host: host?.host ?? server.host, key: route.key }}
      session={
        host?.sessions.find((session) => session.key === route.key) ?? null
      }
      onShown={showSession}
      strings={strings}
    />
  );
}
