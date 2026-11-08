// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteHost } from "./mobileApi";
import {
  EMPTY_UNREAD,
  loadUnreadState,
  nextUnreadState,
  saveUnreadState,
  type UnreadState,
} from "./sessionUnread";

const KEY = "a".repeat(32);
const ID = `vps/${KEY}`;

function hosts(working: boolean | null | "gone"): RemoteHost[] {
  return [
    {
      server: "vps",
      host: "vps",
      state: "online",
      sessions:
        working === "gone"
          ? []
          : [
              {
                key: KEY,
                label: null,
                attached: false,
                provider: "claude",
                name: null,
                working,
                awaiting: false,
              },
            ],
    },
  ];
}

function poll(
  steps: (boolean | null | "gone")[],
  displayed: string | null = null,
  state: UnreadState = EMPTY_UNREAD,
) {
  return steps.reduce(
    (current, working) => nextUnreadState(current, hosts(working), displayed),
    state,
  );
}

afterEach(() => localStorage.clear());

describe("session unread marks", () => {
  it("marks a session that finished its run while not displayed", () => {
    expect(poll([true, false]).unread).toEqual(new Set([ID]));
  });

  it("does not mark a run that finished on screen", () => {
    expect(poll([true, false], ID).unread.size).toBe(0);
  });

  it("waits for a known activity before calling a run finished", () => {
    const state = poll([true, null]);
    expect(state.unread.size).toBe(0);
    expect(poll([false], null, state).unread).toEqual(new Set([ID]));
  });

  it("never marks a session that was not seen working", () => {
    expect(poll([false, null, false]).unread.size).toBe(0);
  });

  it("clears the mark when the agent starts working again", () => {
    expect(poll([true, false, true]).unread.size).toBe(0);
  });

  it("clears the mark when the session is opened", () => {
    const unread = poll([true, false]);
    expect(nextUnreadState(unread, hosts(false), ID).unread.size).toBe(0);
  });

  it("forgets a session that no longer exists", () => {
    const state = poll([true, false, "gone"]);
    expect(state).toEqual({ working: new Set(), unread: new Set() });
  });

  it("keeps the marks of a server that is unreachable or out of the list", () => {
    const unread = poll([true, false]);
    const offline = hosts(true).map((host) => ({
      ...host,
      state: "offline" as const,
    }));
    const absent = nextUnreadState(
      nextUnreadState(unread, offline, null),
      [],
      null,
    );
    expect(nextUnreadState(absent, hosts(false), null).unread).toEqual(
      new Set([ID]),
    );
    const running = nextUnreadState(poll([true]), [], null);
    expect(nextUnreadState(running, hosts(false), null).unread).toEqual(
      new Set([ID]),
    );
  });
  it("keeps the same state while nothing changes", () => {
    const state = poll([true, false]);
    expect(nextUnreadState(state, hosts(false), null)).toBe(state);
  });

  it("restores the marks after a reload", () => {
    saveUnreadState(poll([true]));
    expect(poll([false], null, loadUnreadState()).unread).toEqual(
      new Set([ID]),
    );
    saveUnreadState(poll([true, false]));
    expect(loadUnreadState().unread).toEqual(new Set([ID]));
    localStorage.setItem("soreno-mobile-session-unread", "{broken");
    expect(loadUnreadState()).toBe(EMPTY_UNREAD);
  });
});
