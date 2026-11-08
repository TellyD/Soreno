import { CircleAlert, CircleCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import {
  clearNotifications,
  closeNotification,
  dismissNotification,
  useNotifications,
  type AppNotification,
  type NotificationTone,
} from "../notifications";
import { IconButton } from "./ui/IconButton";
import "./NotificationCenter.css";

export const notificationAutoDismissMs = 8000;

const toneIcons: Record<NotificationTone, typeof CircleAlert> = {
  error: CircleAlert,
  info: CircleCheck,
  warning: TriangleAlert,
};

const toneTitleKeys: Record<NotificationTone, TranslationKey> = {
  error: "notifications.error",
  info: "notifications.info",
  warning: "notifications.warning",
};

export function NotificationCenter() {
  const { t } = useI18n();
  const notifications = useNotifications();

  return (
    <section
      aria-label={t("notifications.region")}
      className="notification-center"
      data-notification-center=""
    >
      {notifications.length > 1 ? (
        <button
          className="notification-dismiss-all"
          type="button"
          onClick={clearNotifications}
        >
          {t("notifications.dismissAll")}
        </button>
      ) : null}
      {notifications.map((notification) => (
        <NotificationItem key={notification.id} notification={notification} />
      ))}
    </section>
  );
}

function NotificationItem({ notification }: { notification: AppNotification }) {
  const { t } = useI18n();
  const { action, key, message, occurrences, revision, tone } = notification;
  const ToneIcon = toneIcons[tone];
  // An info action is a shortcut; error and warning actions are recovery paths.
  const isPersistent = action !== undefined && tone !== "info";
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const isPaused = isHovered || hasFocus;
  const remainingRef = useRef(notificationAutoDismissMs);
  const timedRevisionRef = useRef(revision);

  useEffect(() => {
    if (timedRevisionRef.current !== revision) {
      timedRevisionRef.current = revision;
      remainingRef.current = notificationAutoDismissMs;
    }
    if (isPersistent || isPaused) return;

    const startedAt = Date.now();
    const timer = window.setTimeout(
      () => dismissNotification(key),
      remainingRef.current,
    );
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(
        0,
        remainingRef.current - (Date.now() - startedAt),
      );
    };
  }, [isPaused, isPersistent, key, revision]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
  };

  return (
    <div
      className="notification"
      data-paused={isPaused ? "" : undefined}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
      onBlur={handleBlur}
      onFocus={() => setHasFocus(true)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="notification-icon" aria-hidden="true">
        <ToneIcon />
      </span>
      <div className="notification-body">
        <p className="notification-title">
          {t(toneTitleKeys[tone])}
          {occurrences > 1 ? (
            <span className="notification-count">×{occurrences}</span>
          ) : null}
        </p>
        <p className="notification-message">{message}</p>
        {action ? (
          <button
            className="notification-action"
            type="button"
            onClick={() => {
              dismissNotification(key);
              action.onAction();
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <IconButton
        aria-label={t("notifications.dismiss")}
        className="notification-close"
        size="small"
        onClick={() => closeNotification(key)}
      >
        <X />
      </IconButton>
      {isPersistent ? null : (
        <span
          aria-hidden="true"
          className="notification-progress"
          key={revision}
          style={{ animationDuration: `${notificationAutoDismissMs}ms` }}
        />
      )}
    </div>
  );
}
