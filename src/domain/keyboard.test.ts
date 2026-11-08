import { describe, expect, it } from "vitest";
import { isImeComposing } from "./keyboard";

describe("isImeComposing", () => {
  it("detects composition from either the flag or the IME keyCode", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
