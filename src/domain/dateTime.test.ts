import { describe, expect, it } from "vitest";
import {
  formatCompactDate,
  formatRelativeShortDateTime,
  formatShortDateTime,
  isNewer,
} from "./dateTime";

describe("formatShortDateTime", () => {
  it("formats a local date with minutes", () => {
    expect(formatShortDateTime("2026-06-29T14:05:00", "fr-FR")).toBe(
      "29/06/2026 14:05",
    );
  });

  it("returns an empty string for invalid dates", () => {
    expect(formatShortDateTime("not-a-date", "fr-FR")).toBe("");
  });
});

describe("formatCompactDate", () => {
  it.each([
    ["2026-09-08T14:32:00", "time", "14:32"],
    ["2026-09-07T23:59:00", "relative", "hier"],
    ["2026-09-06T14:32:00", "relative", "il y a 2 jours"],
    ["2026-09-02T14:32:00", "relative", "il y a 6 jours"],
    ["2026-09-01T14:32:00", "date", "1 sept."],
    ["2025-09-08T14:32:00", "date", "8 sept. 2025"],
    ["2026-09-09T14:32:00", "date", "9 sept."],
  ])("formats %s compactly", (value, kind, text) => {
    expect(
      formatCompactDate(value, "fr-FR", new Date("2026-09-08T18:00:00")),
    ).toEqual({ kind, value: text });
  });

  it("counts local calendar days across month and daylight-saving boundaries", () => {
    expect(
      formatCompactDate(
        "2026-03-28T23:59:00",
        "fr-FR",
        new Date("2026-03-30T00:01:00"),
      ),
    ).toEqual({ kind: "relative", value: "il y a 2 jours" });
    expect(
      formatCompactDate(
        "2025-12-31T23:59:00",
        "en-US",
        new Date("2026-01-01T00:01:00"),
      ),
    ).toEqual({ kind: "relative", value: "yesterday" });
  });

  it("rejects invalid dates", () => {
    expect(formatCompactDate("invalid", "fr-FR")).toBeNull();
    expect(
      formatCompactDate("2026-09-08", "fr-FR", new Date("invalid")),
    ).toBeNull();
  });
});

describe("formatRelativeShortDateTime", () => {
  it("formats a same-day date as a local time", () => {
    expect(
      formatRelativeShortDateTime(
        "2026-06-29T14:05:00",
        "fr-FR",
        new Date("2026-06-29T22:00:00"),
      ),
    ).toEqual({
      kind: "time",
      value: "14:05",
    });
  });

  it("formats an older date with local date and time", () => {
    expect(
      formatRelativeShortDateTime(
        "2026-06-29T14:05:00",
        "fr-FR",
        new Date("2026-06-30T09:00:00"),
      ),
    ).toEqual({
      kind: "dateTime",
      value: "29/06/2026 14:05",
    });
  });

  it("returns null for invalid dates", () => {
    expect(
      formatRelativeShortDateTime(
        "not-a-date",
        "fr-FR",
        new Date("2026-06-30T09:00:00"),
      ),
    ).toBeNull();
  });

  it("returns null for an invalid comparison date", () => {
    expect(
      formatRelativeShortDateTime(
        "2026-06-29T14:05:00",
        "fr-FR",
        new Date("not-a-date"),
      ),
    ).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only for a strictly later valid timestamp", () => {
    const earlier = { updatedAt: "2026-06-29T14:05:00.000Z" };
    const later = { updatedAt: "2026-06-29T14:05:00.001Z" };
    expect(isNewer(later, earlier)).toBe(true);
    expect(isNewer(earlier, later)).toBe(false);
    expect(isNewer(later, { ...later })).toBe(false);
    expect(isNewer({ updatedAt: "not-a-date" }, earlier)).toBe(false);
    expect(isNewer(later, { updatedAt: "not-a-date" })).toBe(false);
  });
});
