import { describe, expect, it } from "vitest";
import { normalizeSidebarSectionState } from "./sidebarSectionState";

describe("normalizeSidebarSectionState", () => {
  it("expands every sidebar section when saved state is missing", () => {
    expect(normalizeSidebarSectionState(null)).toEqual({ types: true });
  });

  it("preserves a valid saved state", () => {
    expect(normalizeSidebarSectionState({ types: false })).toEqual({
      types: false,
    });
  });

  it("discards removed sections from legacy saved state", () => {
    expect(
      normalizeSidebarSectionState({
        assistant: false,
        sessionsX: false,
        types: false,
      }),
    ).toEqual({ types: false });
  });

  it("falls back when the saved value is invalid", () => {
    expect(normalizeSidebarSectionState({ types: "false" })).toEqual({
      types: true,
    });
  });
});
