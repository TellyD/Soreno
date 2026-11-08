import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteHost } from "./mobileApi";
import { serverChannel } from "./relayChannel";
import { ServerFeeds, type OpenChannel } from "./serverFeeds";
import type { PairedServer, ServerStore } from "./serverStore";

export type ServersState = {
  /** null until the store answers. */
  servers: PairedServer[] | null;
  hosts: RemoteHost[];
  storeFailed: boolean;
  /** Reloads the saved pairing and notifies other tabs. */
  add: () => void;
  forget: (server: string) => Promise<void>;
  reload: () => void;
};

/** The paired servers of this browser and the live sessions of each. */
export function useServers(
  store: ServerStore,
  openChannel: OpenChannel = serverChannel,
): ServersState {
  const [servers, setServers] = useState<PairedServer[] | null>(null);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [storeFailed, setStoreFailed] = useState(false);
  const feedsRef = useRef<ServerFeeds | null>(null);
  const revision = useRef(0);

  // shortcut: each read yields new server objects, so an open conversation restarts when another visible tab changes a pairing; keep unchanged entries if split-screen use reports it.
  const reload = useCallback(() => {
    const current = ++revision.current;
    setStoreFailed(false);
    store.list().then(
      (next) => {
        if (current === revision.current) setServers(next);
      },
      () => {
        if (current === revision.current) setStoreFailed(true);
      },
    );
  }, [store]);

  // Other tabs keep their own copy of the keys: they re-read the store on each change.
  const tabsRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const tabs = new BroadcastChannel("soreno-mobile-servers");
    tabsRef.current = tabs;
    tabs.onmessage = reload;
    reload();
    return () => {
      revision.current++;
      tabs.close();
      tabsRef.current = null;
    };
  }, [reload]);

  useEffect(() => {
    const feeds = new ServerFeeds(openChannel, setHosts);
    feedsRef.current = feeds;
    const onVisibility = () => {
      if (document.visibilityState === "visible") feeds.wake();
      else feeds.suspend();
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      feeds.dispose();
      feedsRef.current = null;
    };
  }, [openChannel]);

  useEffect(() => {
    if (servers) feedsRef.current?.follow(servers);
  }, [servers, openChannel]);

  const add = useCallback(() => {
    reload();
    tabsRef.current?.postMessage(null);
  }, [reload]);

  const forget = useCallback(
    async (server: string) => {
      await store.forget(server);
      reload();
      setServers(
        (current) =>
          current?.filter((entry) => entry.server !== server) ?? current,
      );
      tabsRef.current?.postMessage(null);
    },
    [store, reload],
  );

  return { servers, hosts, storeFailed, add, forget, reload };
}
