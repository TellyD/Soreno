import { describe, expect, it } from "vitest";
import { dialogFocusTargetIndex } from "./Dialog";

describe("dialogFocusTargetIndex", () => {
  it("wraps focus and redirects focus that escaped the dialog", () => {
    expect(dialogFocusTargetIndex(2, 3, false)).toBe(0);
    expect(dialogFocusTargetIndex(0, 3, true)).toBe(2);
    expect(dialogFocusTargetIndex(-1, 3, false)).toBe(0);
    expect(dialogFocusTargetIndex(-1, 3, true)).toBe(2);
    expect(dialogFocusTargetIndex(1, 3, false)).toBeNull();
  });
});
