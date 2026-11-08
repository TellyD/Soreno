import { describe, expect, it } from "vitest";
import type { RemoteHost } from "./mobileApi";
import {
  parseSessionRoute,
  sessionActivity,
  sessionActivityLabel,
  sessionHref,
  sessionSubtitle,
  sessionTitle,
  sortHosts,
  unreadSessions,
} from "./mobileSessions";
import { mobileLocale, mobileStrings } from "./mobileStrings";

describe("mobile sessions", () => {
  it("names the agent state like the desktop session dot, a reply expected first", () => {
    const labels = (
      [
        [true, true, true],
        [true, true, false],
        [false, true, false],
        [false, false, false],
        [null, false, false],
      ] as const
    ).map(([working, unread, awaiting]) =>
      sessionActivityLabel(
        sessionActivity({ working, awaiting }, unread),
        mobileStrings.fr,
      ),
    );
    expect(labels).toEqual([
      "Réponse attendue",
      "En cours",
      "Terminé · non lu",
      "Active",
      "Active",
    ]);
  });

  it("falls back to the shortened key without a label", () => {
    const key = "0123456789abcdef0123456789abcdef";
    expect(sessionTitle({ key, label: "Soreno · OMP 3" })).toBe(
      "Soreno · OMP 3",
    );
    expect(sessionTitle({ key, label: null })).toBe("01234567…");
    expect(sessionTitle({ key, label: "  " })).toBe("01234567…");
  });

  it("shows the conversation name only when the title does not already", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const name = "Clarifier le comportement du delete fichier";
    expect(
      sessionSubtitle({ key, label: `Soreno · ${name}`, name }),
    ).toBeNull();
    expect(
      sessionSubtitle({ key, label: "Soreno · Clarifier le comporte", name }),
    ).toBeNull();
    expect(sessionSubtitle({ key, label: "Soreno · OMP", name })).toBe(name);
    expect(sessionSubtitle({ key, label: null, name })).toBe(name);
    expect(
      sessionSubtitle({ key, label: "Soreno · OMP", name: " " }),
    ).toBeNull();
  });

  it("speaks French unless the browser language is another one", () => {
    expect(mobileLocale("fr-CA")).toBe("fr");
    expect(mobileLocale(undefined)).toBe("fr");
    expect(mobileLocale("en-US")).toBe("en");
  });

  it("lists servers by name, those of the same name by id", () => {
    const order = sortHosts([
      host("zeta"),
      host("alpha", { server: SERVER_B }),
      host("alpha", { server: SERVER_A, state: "unpaired" }),
      host("beta", { state: "offline" }),
    ]).map((entry) => [entry.host, entry.server]);
    expect(order).toEqual([
      ["alpha", SERVER_A],
      ["alpha", SERVER_B],
      ["beta", serverId("beta")],
      ["zeta", serverId("zeta")],
    ]);
  });

  it("gathers the unread sessions of reachable servers", () => {
    const unread = unreadSessions(
      [
        host("srv2", {
          sessions: [session(KEY_A, false), session(KEY_B, true)],
        }),
        host("down", {
          state: "offline",
          sessions: [session(KEY_C, false)],
        }),
        host("vps", {
          sessions: [session(KEY_C, null), session(KEY_A, false)],
        }),
      ],
      new Set([
        `${serverId("srv2")}/${KEY_A}`,
        `${serverId("srv2")}/${KEY_B}`,
        `${serverId("down")}/${KEY_C}`,
        `${serverId("vps")}/${KEY_C}`,
      ]),
    );
    expect(unread.map((entry) => [entry.host.host, entry.session.key])).toEqual(
      [
        ["srv2", KEY_A],
        ["vps", KEY_C],
      ],
    );
  });

  it("names a session by the id of its server", () => {
    expect(parseSessionRoute(sessionHref(SERVER_A, KEY_A))).toEqual({
      server: SERVER_A,
      key: KEY_A,
    });
    expect(parseSessionRoute(`#/s/${KEY_A}`)).toBeNull();
    expect(parseSessionRoute("#/")).toBeNull();
    expect(parseSessionRoute(`#/s/srv2/${KEY_A}`)).toBeNull();
    expect(parseSessionRoute(`#/s/${SERVER_A}/not-a-key`)).toBeNull();
  });
});

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);
const KEY_C = "c".repeat(32);
const SERVER_A = `${"A".repeat(42)}Q`;
const SERVER_B = `${"B".repeat(42)}Q`;

function serverId(name: string) {
  return name.padEnd(43, "_");
}

function host(name: string, entry: Partial<RemoteHost> = {}): RemoteHost {
  return {
    server: serverId(name),
    host: name,
    state: "online",
    sessions: [],
    ...entry,
  };
}

function session(key: string, working: boolean | null) {
  return {
    key,
    label: null,
    attached: false,
    provider: null,
    name: null,
    working,
    awaiting: false,
  };
}
