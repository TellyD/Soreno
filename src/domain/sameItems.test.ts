import { describe, expect, it } from "vitest";
import { sameItems } from "./sameItems";

describe("sameItems", () => {
  it("compares ids in order", () => {
    expect(sameItems(["notes", "weekly"], ["notes", "weekly"])).toBe(true);
    expect(sameItems(["notes", "weekly"], ["weekly", "notes"])).toBe(false);
    expect(sameItems(["notes"], ["notes", "weekly"])).toBe(false);
  });
});
