// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteHost, RemoteSession } from "./mobileApi";
import { SessionList } from "./SessionList";
import { mobileStrings } from "./mobileStrings";
import type { PairedServer } from "./serverStore";
import type { ServersState } from "./useServers";

const VPS = `${"V".repeat(42)}Q`;
const LAB = `${"L".repeat(42)}Q`;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function session(
  key: string,
  provider: string | null,
  working: boolean | null,
): RemoteSession {
  return {
    key,
    label: key,
    attached: false,
    provider,
    name: null,
    working,
    awaiting: false,
  };
}

function paired(server: string, host: string): PairedServer {
  return {
    server,
    host,
    keyPair: {} as CryptoKeyPair,
    publicKey: "",
    pairedAt: 0,
  };
}

function servers(
  hosts: RemoteHost[],
  change: Partial<ServersState> = {},
): ServersState {
  return {
    servers: hosts.map((host) => paired(host.server, host.host)),
    hosts,
    storeFailed: false,
    add: () => undefined,
    forget: async () => undefined,
    reload: () => undefined,
    ...change,
  };
}

async function render(state: ServersState, unread = new Set<string>()) {
  const onScan = vi.fn();
  await act(async () =>
    root.render(
      <SessionList
        strings={mobileStrings.fr}
        servers={state}
        unread={unread}
        onScan={onScan}
      />,
    ),
  );
  return onScan;
}

it("lists unread sessions first and badges each session like the desktop", async () => {
  await render(
    servers([
      {
        server: VPS,
        host: "vps",
        state: "online",
        sessions: [
          session("done", "claude", false),
          session("busy", "omp", true),
          session("idle", "codex", false),
          session("plain", null, null),
          { ...session("asking", "pi", true), awaiting: true },
        ],
      },
    ]),
    new Set([`${VPS}/done`, `${VPS}/busy`]),
  );
  expect(
    [".mobile-unread", ".mobile-host"].map((section) =>
      [...container.querySelectorAll(`${section} .mobile-session`)].map(
        (row) =>
          row.querySelector(".mobile-session-provider")?.textContent ?? null,
      ),
    ),
  ).toEqual([
    ["Claude Code"],
    ["Claude Code", "OMP", "Codex", "Sans conversation", "Pi"],
  ]);
  expect(
    container.querySelector<HTMLAnchorElement>(".mobile-host a")?.hash,
  ).toBe(`#/s/${VPS}/done`);
});

it("groups the sessions by server and offers to forget a server that revoked this phone", async () => {
  const forget = vi.fn(async () => undefined);
  vi.stubGlobal("confirm", () => true);
  await render(
    servers(
      [
        {
          server: VPS,
          host: "vps",
          state: "online",
          sessions: [session("one", "omp", false)],
        },
        { server: LAB, host: "lab", state: "unpaired", sessions: [] },
      ],
      { forget },
    ),
  );
  const groups = [...container.querySelectorAll(".mobile-host")];
  expect(
    groups.map((group) => [
      group.getAttribute("aria-label"),
      group.querySelector(".mobile-host-status")?.textContent,
    ]),
  ).toEqual([
    ["lab", "Appareil retiré"],
    ["vps", "En ligne"],
  ]);
  const button = [...groups[0].querySelectorAll("button")].find(
    (element) => element.textContent === "Oublier ce serveur",
  )!;
  await act(async () => button.click());
  expect(forget).toHaveBeenCalledWith(LAB);
});

it("shows an offline server's last sessions without opening them", async () => {
  await render(
    servers([
      {
        server: LAB,
        host: "lab",
        state: "offline",
        sessions: [session("one", "omp", false)],
      },
    ]),
  );
  expect(container.querySelector(".mobile-host-status")?.textContent).toBe(
    "Injoignable",
  );
  expect(container.querySelector(".mobile-host a")).toBeNull();
  expect(
    container.querySelector(".mobile-session")?.getAttribute("aria-disabled"),
  ).toBe("true");
});

it("explains how to pair when no server is paired, and offers to scan", async () => {
  const onScan = await render(servers([]));
  expect(container.textContent).toContain("Aucun serveur appairé");
  const scan = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Scanner un QR code",
  )!;
  await act(async () => scan.click());
  expect(onScan).toHaveBeenCalled();
});
