// keyCode 229 marks IME keydowns in engines that do not set isComposing.
export function isImeComposing(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Typing targets keep their native shortcuts, such as the text undo. */
export const isTextFieldTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || !!target.closest("input, textarea, select"));

// macOS Option composes event.key; elsewhere event.key keeps AltGr characters out.
export function isPanelToggleChord(
  event: Pick<
    KeyboardEvent,
    | "isComposing"
    | "shiftKey"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "code"
    | "key"
  >,
  letter: string,
  isMacOS: boolean,
): boolean {
  return (
    !event.isComposing &&
    !event.shiftKey &&
    event.altKey &&
    (isMacOS
      ? event.code === `Key${letter.toUpperCase()}` &&
        event.metaKey &&
        !event.ctrlKey
      : event.key.toLowerCase() === letter && event.ctrlKey && !event.metaKey)
  );
}

export function listNavigation(
  key: string,
  length: number,
): ((index: number) => number) | null {
  if (!length) return null;
  switch (key) {
    case "ArrowDown":
      return (index) => (index + 1) % length;
    case "ArrowUp":
      return (index) => (index - 1 + length) % length;
    case "Home":
      return () => 0;
    case "End":
      return () => length - 1;
    default:
      return null;
  }
}
