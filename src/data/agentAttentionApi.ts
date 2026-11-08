import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentNotification } from "../domain/agentAttention";

export const showAgentNotification = (notification: AgentNotification) =>
  invoke<void>("show_agent_notification", { notification });

export const setAgentAttentionBadge = (count: number) =>
  invoke<void>("set_agent_attention_badge", { count });

/** Returns and clears the session of the last clicked notification. */
export const takeAgentNotificationActivation = () =>
  invoke<string | null>("take_agent_notification_activation");

/** A notification was clicked, after the window came to the front. */
export const listenAgentNotificationActivated = (onActivate: () => void) =>
  listen("agent-notification-activated", () => onActivate());

export const isWindowFocused = () => getCurrentWindow().isFocused();

export const listenWindowFocus = (onChange: (focused: boolean) => void) =>
  getCurrentWindow().onFocusChanged((event) => onChange(event.payload));
