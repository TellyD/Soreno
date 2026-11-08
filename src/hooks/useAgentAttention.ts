import { useEffect, useRef, useState } from "react";
import {
  isWindowFocused,
  listenWindowFocus,
  setAgentAttentionBadge,
  showAgentNotification,
} from "../data/agentAttentionApi";
import {
  agentNotification,
  emptyAgentAttention,
  notifiableAgentEvents,
  observeAgentAttention,
  type AgentAttentionEvent,
  type AgentNotificationStrings,
  type AgentNotificationSubject,
} from "../domain/agentAttention";
import type { AgentSession, AgentSessionStatus } from "../domain/agentSessions";
import { notifyWarning } from "../notifications";
import { useAppSettings } from "../settings";

/** Turns ending within this delay share one notification. */
const NOTIFICATION_BATCH_MS = 1000;

type AgentAttentionOptions = {
  desktop: boolean;
  sessions: readonly AgentSession[];
  statuses: ReadonlyMap<string, AgentSessionStatus>;
  /** Sessions whose terminal is on screen in the workspace. */
  displayed: ReadonlySet<string>;
  describe: (sessionId: string) => AgentNotificationSubject | undefined;
  strings: AgentNotificationStrings & { failed: (error: string) => string };
};

/** Unread and waiting sessions, with their OS notifications and badge. */
export function useAgentAttention({
  desktop,
  sessions,
  statuses,
  displayed,
  describe,
  strings,
}: AgentAttentionOptions) {
  const { settings } = useAppSettings();
  const enabled = desktop && settings.agentNotificationsEnabled === true;
  const latest = useRef({ describe, strings, settings, displayed });
  latest.current = { describe, strings, settings, displayed };
  const tracking = useRef(emptyAgentAttention);
  const [attention, setAttention] = useState(emptyAgentAttention);
  const windowFocused = useRef(document.hasFocus());
  const pending = useRef<AgentAttentionEvent[]>([]);
  const batch = useRef<number | null>(null);
  const displayedKey = [...displayed].join("\n");

  useEffect(() => {
    const { state, events } = observeAgentAttention(
      tracking.current,
      statuses,
      new Set(sessions.map((session) => session.id)),
      latest.current.displayed,
    );
    tracking.current = state;
    setAttention((current) =>
      current.awaiting === state.awaiting && current.unread === state.unread
        ? current
        : state,
    );
    if (!enabled || events.length === 0) return;
    pending.current.push(...events);
    batch.current ??= window.setTimeout(() => {
      batch.current = null;
      const events = pending.current;
      pending.current = [];
      const { describe, strings, settings, displayed } = latest.current;
      if (settings.agentNotificationsEnabled !== true) return;
      // Decided at delivery: a session shown meanwhile needs no notification.
      const notification = agentNotification(
        notifiableAgentEvents(events, {
          displayed,
          windowFocused: windowFocused.current,
        }),
        describe,
        strings,
      );
      if (!notification) return;
      showAgentNotification(notification).catch((error: unknown) =>
        notifyWarning(strings.failed(String(error)), {
          key: "agent-notification",
        }),
      );
    }, NOTIFICATION_BATCH_MS);
  }, [displayedKey, enabled, sessions, statuses]);

  useEffect(
    () => () => {
      if (batch.current !== null) window.clearTimeout(batch.current);
      batch.current = null;
      pending.current = [];
    },
    [],
  );

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void isWindowFocused()
      .then((focused) => {
        if (!disposed) windowFocused.current = focused;
      })
      .catch(() => undefined);
    void listenWindowFocus((focused) => {
      windowFocused.current = focused;
    })
      .then((stop) => (disposed ? stop() : (stopListening = stop)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [desktop]);

  const badge = enabled
    ? attention.awaiting.length + attention.unread.length
    : 0;
  const shownBadge = useRef(0);
  useEffect(() => {
    if (!desktop || badge === shownBadge.current) return;
    shownBadge.current = badge;
    // The badge only mirrors the sessions' marks: a refusal leaves them intact.
    setAgentAttentionBadge(badge).catch(() => undefined);
  }, [badge, desktop]);

  return attention;
}
