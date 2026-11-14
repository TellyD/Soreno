import { agentProviderOf } from "./agentSessions";

export type AutomationFrequency = "daily" | "weekdays" | "weekly";

export type AgentAutomationInput = {
  sessionId: string;
  prompt: string;
  frequency: AutomationFrequency;
  /** 1 (Monday) to 7 (Sunday); read for `weekly` only. */
  weekday: number;
  /** `HH:MM` in `timeZone`. */
  time: string;
  timeZone: string;
  enabled: boolean;
};

export type AgentAutomationRun = {
  /** Unix seconds, on the server's clock. */
  at: number;
  outcome: "started" | "skipped" | "failed";
  exitCode: number | null;
  /** The started run still lives on the server. */
  running: boolean;
};

export type AgentAutomation = AgentAutomationInput & {
  lastRun: AgentAutomationRun | null;
  seenRunAt: number | null;
};

type AutomationRunState =
  "never" | "running" | "finished" | "skipped" | "missingAgent" | "failed";

// Mirrors MISSING_EXECUTABLE_EXIT_CODE in src-tauri/src/agent_sessions.rs.
const MISSING_AGENT_EXIT_CODE = 209;

export function automationRunState(
  run: AgentAutomationRun | null,
): AutomationRunState {
  if (!run) return "never";
  if (run.outcome === "skipped") return "skipped";
  if (run.outcome === "failed") return "failed";
  if (run.running) return "running";
  if (run.exitCode === MISSING_AGENT_EXIT_CODE) return "missingAgent";
  return run.exitCode ? "failed" : "finished";
}

/** A run the user has not opened since it started; a skipped run changed nothing. */
export function automationUnread(automation: AgentAutomation): boolean {
  const run = automation.lastRun;
  return (
    !!run && run.outcome !== "skipped" && run.at > (automation.seenRunAt ?? 0)
  );
}

function runsOn(frequency: AutomationFrequency, weekday: number, date: Date) {
  const day = date.getDay() || 7;
  if (frequency === "weekdays") return day <= 5;
  if (frequency === "weekly") return day === weekday;
  return true;
}

/**
 * The next scheduled start after `now`.
 * shortcut: computed in this computer's time zone, which the schedule was saved with; compute in
 * `timeZone` if schedules saved elsewhere must show their own next run.
 */
export function nextAutomationRun(
  automation: Pick<
    AgentAutomationInput,
    "frequency" | "weekday" | "time" | "enabled"
  >,
  now: Date,
): Date | null {
  if (!automation.enabled) return null;
  const [hours, minutes] = automation.time.split(":").map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + offset,
      hours,
      minutes,
    );
    if (
      candidate > now &&
      runsOn(automation.frequency, automation.weekday, candidate)
    )
      return candidate;
  }
  return null;
}

/** How the agent's CLI invokes a skill from a message: prefix and name for the `/` completion. */
export function automationSkillToken(
  executable: string,
  skill: string,
): { prefix: string; name: string } {
  const provider = agentProviderOf(executable);
  // Codex takes `$skill` and rejects `/skill` (openai/codex#11817); Pi and OMP namespace skills.
  if (provider === "codex") return { prefix: "$", name: skill };
  if (provider === "pi" || provider === "omp")
    return { prefix: "/", name: `skill:${skill}` };
  return { prefix: "/", name: skill };
}
