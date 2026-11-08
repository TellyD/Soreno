import { describe, expect, it } from "vitest";
import { isUsableCodexModel } from "./codexOptions";

describe("isUsableCodexModel", () => {
  it("accepts non-empty model identifiers", () => {
    expect(isUsableCodexModel("gpt-5.5")).toBe(true);
    expect(isUsableCodexModel(" gpt-5.4 ")).toBe(true);
  });

  it("rejects blank and non-string values", () => {
    expect(isUsableCodexModel("  ")).toBe(false);
    expect(isUsableCodexModel(null)).toBe(false);
  });
});
