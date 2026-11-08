import { describe, expect, it } from "vitest";
import { pendingReleaseNotes } from "./releaseNotes";

const available = ["0.3.10", "0.3.9", "0.4.0", "0.4.1", "0.4.2", "0.5.0"];

describe("pendingReleaseNotes", () => {
  it("lists every changelog published since the last seen version, newest first", () => {
    expect(pendingReleaseNotes("0.3.9", "0.4.2", available)).toEqual([
      "0.4.2",
      "0.4.1",
      "0.4.0",
      "0.3.10",
    ]);
  });

  it("shows only the current changelog after an update from a version without release notes", () => {
    expect(pendingReleaseNotes(null, "0.4.1", available)).toEqual(["0.4.1"]);
    expect(pendingReleaseNotes("garbage", "0.4.1", available)).toEqual([
      "0.4.1",
    ]);
  });

  it("has nothing pending when the app is not newer than the last seen version", () => {
    expect(pendingReleaseNotes("0.4.1", "0.4.1", available)).toBeNull();
    expect(pendingReleaseNotes("0.5.0", "0.4.1", available)).toBeNull();
  });

  it("returns an empty list for an update whose versions have no changelog", () => {
    expect(pendingReleaseNotes("0.5.0", "0.5.1", available)).toEqual([]);
    expect(pendingReleaseNotes(null, "0.5.1", available)).toEqual([]);
  });
});
