import { useEffect, useRef, useSyncExternalStore } from "react";

export type NotificationTone = "error" | "warning" | "info";

export type NotificationAction = {
  label: string;
  onAction: () => void;
};

export type NotificationInput = {
  message: string;
  tone?: NotificationTone;
  /** Stable identity: a new notification with the same key replaces the previous one. */
  key?: string;
  /** Notifications with an action stay visible until dismissed. */
  action?: NotificationAction;
  /** Runs only when the user closes the notification, not on programmatic removal. */
  onDismiss?: () => void;
};

export type NotificationOptions = Omit<NotificationInput, "message" | "tone">;

export type AppNotification = {
  id: number;
  key: string;
  message: string;
  tone: NotificationTone;
  action?: NotificationAction;
  onDismiss?: () => void;
  occurrences: number;
  revision: number;
};

const maxNotifications = 4;
const listeners = new Set<() => void>();
let notifications: readonly AppNotification[] = [];
let nextId = 1;
let nextRevision = 1;

function publish(next: readonly AppNotification[]) {
  notifications = next;
  listeners.forEach((listener) => listener());
}

function notificationKey(input: NotificationInput): string {
  return input.key ?? `${input.tone ?? "error"}:${input.message}`;
}

// Oldest transient notifications go first so actionable ones keep their recovery path.
function evictOverflow(items: AppNotification[]): AppNotification[] {
  while (items.length > maxNotifications) {
    const transient = items.findIndex((item) => item.action === undefined);
    items.splice(transient === -1 ? 0 : transient, 1);
  }
  return items;
}

function notify(input: NotificationInput): string {
  const key = notificationKey(input);
  const tone = input.tone ?? "error";
  const existing = notifications.find((item) => item.key === key);
  const repeated =
    existing?.message === input.message && existing.tone === tone;
  const notification: AppNotification = {
    id: existing?.id ?? nextId++,
    key,
    message: input.message,
    tone,
    action: input.action,
    onDismiss: input.onDismiss,
    occurrences: repeated ? existing.occurrences + 1 : 1,
    revision: nextRevision++,
  };

  publish(
    evictOverflow([
      ...notifications.filter((item) => item.key !== key),
      notification,
    ]),
  );
  return key;
}

export function notifyError(
  message: string,
  options?: NotificationOptions,
): string {
  return notify({ ...options, message, tone: "error" });
}

export function notifyWarning(
  message: string,
  options?: NotificationOptions,
): string {
  return notify({ ...options, message, tone: "warning" });
}

export function notifyInfo(
  message: string,
  options?: NotificationOptions,
): string {
  return notify({ ...options, message, tone: "info" });
}

export function dismissNotification(key: string) {
  if (notifications.some((item) => item.key === key)) {
    publish(notifications.filter((item) => item.key !== key));
  }
}

export function closeNotification(key: string) {
  const closed = notifications.find((item) => item.key === key);
  if (!closed) return;
  publish(notifications.filter((item) => item !== closed));
  closed.onDismiss?.();
}

export function clearNotifications() {
  const closed = notifications;
  if (closed.length === 0) return;
  publish([]);
  closed.forEach((item) => item.onDismiss?.());
}

export function getNotifications(): readonly AppNotification[] {
  return notifications;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNotifications(): readonly AppNotification[] {
  return useSyncExternalStore(subscribe, getNotifications, getNotifications);
}

/**
 * Mirrors a persistent error condition: shown while `input` is non-null,
 * withdrawn when it becomes null or the owner unmounts.
 */
export function useNotification(input: NotificationInput | null) {
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const key = input ? notificationKey(input) : null;
  const message = input?.message;
  const tone = input?.tone;
  const actionLabel = input?.action?.label;
  const hasDismissHandler = input?.onDismiss !== undefined;

  useEffect(() => {
    if (key === null || message === undefined) return;
    const resolvedTone = tone ?? "error";
    // Several owners may mirror one condition; that is not a repeated failure.
    const mirrored = notifications.some(
      (item) =>
        item.key === key &&
        item.message === message &&
        item.tone === resolvedTone,
    );
    if (mirrored) return () => dismissNotification(key);
    notify({
      key,
      message,
      tone,
      action:
        actionLabel === undefined
          ? undefined
          : {
              label: actionLabel,
              onAction: () => callbacksRef.current?.action?.onAction(),
            },
      onDismiss: hasDismissHandler
        ? () => callbacksRef.current?.onDismiss?.()
        : undefined,
    });
    return () => dismissNotification(key);
  }, [actionLabel, hasDismissHandler, key, message, tone]);
}
