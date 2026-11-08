import { describe, expect, it } from "vitest";
import {
  formatUsageDuration,
  maskEmail,
  resetMinutes,
  usageElapsedFraction,
  visibleUsageAccounts,
  weeklyUsageWindow,
  type UsageWindow,
} from "./subscriptionUsage";

const now = new Date("2026-06-01T12:00:00Z").getTime();
// Five-hour window with `remaining` minutes left before reset.
const fiveHours = (usedPercent: number, remaining: number): UsageWindow => ({
  usedPercent,
  windowDurationMins: 300,
  resetsAt: now / 1000 + remaining * 60,
});

describe("elapsed share of a window", () => {
  it("grows as the reset approaches", () => {
    expect(usageElapsedFraction(fiveHours(0, 240), now)).toBeCloseTo(0.2);
  });

  it("clamps expired or not yet started windows", () => {
    expect(usageElapsedFraction(fiveHours(0, -10), now)).toBe(1);
    expect(usageElapsedFraction(fiveHours(0, 400), now)).toBe(0);
  });

  it("is unknown without a duration or reset time", () => {
    expect(
      usageElapsedFraction(
        { usedPercent: 50, windowDurationMins: null, resetsAt: 1 },
        now,
      ),
    ).toBeNull();
    expect(
      usageElapsedFraction(
        { usedPercent: 50, windowDurationMins: 300, resetsAt: null },
        now,
      ),
    ).toBeNull();
  });
});

it("masks emails down to initials and the top-level domain", () => {
  expect(maskEmail("jean.dupont@example.com")).toBe("j•••@e•••.com");
  expect(maskEmail("ada@mail.example.fr")).toBe("a•••@m•••.fr");
  expect(maskEmail("root@localhost")).toBe("r•••@l•••");
  expect(maskEmail("not-an-email")).toBe("n•••");
  expect(maskEmail("@x.com")).toBe("@•••");
});

it("picks the account-wide weekly window, whatever its slot", () => {
  const week = { ...fiveHours(4, 10), windowDurationMins: 10_080 };
  const unknown = { ...week, windowDurationMins: null };
  const opus = { ...fiveHours(80, 10), windowDurationMins: 10_080 };
  expect(
    weeklyUsageWindow({
      primary: fiveHours(19, 10),
      secondary: week,
      models: [{ model: "opus", window: opus }],
    }),
  ).toBe(week);
  expect(weeklyUsageWindow({ primary: week, secondary: null })).toBe(week);
  const day = { ...fiveHours(5, 10), windowDurationMins: 1_440 };
  expect(weeklyUsageWindow({ primary: week, secondary: day })).toBe(week);
  expect(
    weeklyUsageWindow({ primary: fiveHours(19, 10), secondary: unknown }),
  ).toBe(unknown);
  expect(
    weeklyUsageWindow({ primary: fiveHours(19, 10), secondary: null }),
  ).toBeNull();
  expect(weeklyUsageWindow(null)).toBeNull();
});

it("rounds resets up to the minute and never goes negative", () => {
  expect(
    resetMinutes({ ...fiveHours(0, 0), resetsAt: now / 1000 + 61 }, now),
  ).toBe(2);
  expect(resetMinutes(fiveHours(0, -5), now)).toBe(0);
  expect(resetMinutes({ ...fiveHours(0, 0), resetsAt: null }, now)).toBeNull();
});

it("formats durations with the two largest units", () => {
  expect(formatUsageDuration(243, "en")).toBe("4h 3m");
  expect(formatUsageDuration(9480, "fr")).toBe("6j 14h");
  expect(formatUsageDuration(60, "en")).toBe("1h");
});

it("hides unidentified accounts without quota unless nothing else remains", () => {
  const unknown = { email: null, limits: null };
  const remote = {
    email: null,
    limits: {
      primary: null,
      secondary: null,
      models: [{ model: "opus", window: fiveHours(5, 10) }],
    },
  };
  const known = { email: "dev@example.com", limits: null };
  expect(visibleUsageAccounts([unknown, remote, known])).toEqual([
    remote,
    known,
  ]);
  expect(visibleUsageAccounts([unknown, { ...unknown }])).toEqual([unknown]);
  expect(visibleUsageAccounts([])).toEqual([]);
});
