import { describe, expect, it } from "vitest";
import {
  automationRunState,
  automationUnread,
  automationSkillToken,
  nextAutomationRun,
  type AgentAutomation,
} from "./automations";

const automation = (patch: Partial<AgentAutomation> = {}): AgentAutomation => ({
  sessionId: "s",
  prompt: "/revue",
  frequency: "weekdays",
  weekday: 1,
  time: "08:00",
  timeZone: "Europe/Paris",
  enabled: true,
  lastRun: null,
  seenRunAt: null,
  ...patch,
});

describe("nextAutomationRun", () => {
  // Friday 23 October 2026, local time.
  const friday = (hours: number, minutes = 0) =>
    new Date(2026, 9, 23, hours, minutes);

  it.each([
    ["later today", "daily", 1, friday(7, 59), new Date(2026, 9, 23, 8)],
    [
      "tomorrow once today's time passed",
      "daily",
      1,
      friday(8),
      new Date(2026, 9, 24, 8),
    ],
    [
      "Monday after a Friday run",
      "weekdays",
      1,
      friday(9),
      new Date(2026, 9, 26, 8),
    ],
    [
      "the chosen day next week",
      "weekly",
      5,
      friday(8, 1),
      new Date(2026, 9, 30, 8),
    ],
    ["Sunday as day 7", "weekly", 7, friday(9), new Date(2026, 9, 25, 8)],
  ] as const)("finds %s", (_, frequency, weekday, now, expected) => {
    expect(nextAutomationRun(automation({ frequency, weekday }), now)).toEqual(
      expected,
    );
  });

  it("has none while paused", () => {
    expect(
      nextAutomationRun(automation({ enabled: false }), friday(7)),
    ).toBeNull();
  });
});

describe("automation runs", () => {
  const run = (patch: Partial<NonNullable<AgentAutomation["lastRun"]>>) => ({
    at: 100,
    outcome: "started" as const,
    exitCode: null,
    running: false,
    ...patch,
  });

  it.each([
    [null, "never"],
    [run({ running: true }), "running"],
    [run({ exitCode: 0 }), "finished"],
    [run({}), "finished"],
    [run({ exitCode: 209 }), "missingAgent"],
    [run({ exitCode: 1 }), "failed"],
    [run({ outcome: "failed", exitCode: 127 }), "failed"],
    [run({ outcome: "skipped" }), "skipped"],
  ] as const)("reads %j as %s", (lastRun, state) => {
    expect(automationRunState(lastRun)).toBe(state);
  });

  it("is unread until opened, except a skipped run", () => {
    expect(automationUnread(automation({ lastRun: run({}) }))).toBe(true);
    expect(
      automationUnread(automation({ lastRun: run({}), seenRunAt: 100 })),
    ).toBe(false);
    expect(
      automationUnread(
        automation({ lastRun: run({ at: 200 }), seenRunAt: 100 }),
      ),
    ).toBe(true);
    expect(
      automationUnread(automation({ lastRun: run({ outcome: "skipped" }) })),
    ).toBe(false);
  });
});

it.each([
  ["claude", { prefix: "/", name: "revue" }],
  ["/usr/local/bin/codex", { prefix: "$", name: "revue" }],
  ["omp", { prefix: "/", name: "skill:revue" }],
  ["pi", { prefix: "/", name: "skill:revue" }],
])("writes a skill for %s as its CLI invokes it", (executable, token) => {
  expect(automationSkillToken(executable, "revue")).toEqual(token);
});
