import { vi } from "vitest";

// jsdom has no top layer; nwsapi's :modal fallback recursively calls matches().
// Restored by the caller's `vi.restoreAllMocks()`.
export function stubModalSelector() {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector,
  ) {
    return selector === ":modal" ? false : matches.call(this, selector);
  });
}
