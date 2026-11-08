import { useEffect, useId } from "react";
import {
  dismissNotification,
  notifyError,
  type NotificationAction,
} from "./notifications";

/** One replaceable error notification per component instance, withdrawn on unmount. */
export function useScopedNotification(scope: string) {
  const key = `${scope}:${useId()}`;
  useEffect(() => () => dismissNotification(key), [key]);
  return {
    error: (message: string, action?: NotificationAction) =>
      notifyError(message, { key, action }),
    clear: () => dismissNotification(key),
  };
}
