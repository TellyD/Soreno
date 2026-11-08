import type { KeyboardEvent } from "react";

export function isContextMenuKey(event: KeyboardEvent) {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/** Base UI opens context menus on `contextmenu` only: synthesize one under the anchor. */
export function openContextMenuFromKeyboard(
  event: KeyboardEvent,
  anchor: HTMLElement,
) {
  event.preventDefault();
  event.stopPropagation();
  const bounds = anchor.getBoundingClientRect();
  anchor.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + 16,
      clientY: bounds.bottom,
    }),
  );
}
