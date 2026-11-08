import { expect, it } from "vitest";
import type { AgentSession } from "./agentSessions";
import { mergeConflictAgent, mergeConflictPrompt } from "./mergeConflictAgent";

const session = (
  id: string,
  projectId: string,
  executable: string,
  createdAt: string,
): AgentSession => ({
  id,
  projectId,
  name: id,
  executable,
  args: [],
  createdAt,
});

it("starts the worktree's latest visible agent by its preset name, else the first visible agent", () => {
  const sessions = [
    session("old", "worktree", "/opt/bin/claude.cmd", "2026-01-01T00:00:00Z"),
    session("shell", "worktree", "", "2026-01-03T00:00:00Z"),
    session("hidden", "worktree", "pi", "2026-01-04T00:00:00Z"),
    session("other", "main", "codex", "2026-01-05T00:00:00Z"),
  ];

  expect(mergeConflictAgent(sessions, ["worktree"], ["pi"])).toEqual({
    name: "Claude Code",
    executable: "claude",
  });
  expect(mergeConflictAgent(sessions, ["worktree"], [])).toEqual({
    name: "Pi",
    executable: "pi",
  });
  expect(mergeConflictAgent(sessions, ["empty"], ["pi"])).toEqual({
    name: "OMP",
    executable: "omp",
  });
  const chat = session(
    "chat",
    "worktree",
    "omp-conversation",
    "2026-01-06T00:00:00Z",
  );
  expect(mergeConflictAgent([...sessions, chat], ["worktree"], [])).toEqual({
    name: "Chat (OMP)",
    executable: "omp-conversation",
  });
});

it("keeps double quotes out of the prompt, which Windows PowerShell launchers reject", () => {
  const prompt = mergeConflictPrompt({ branch: "feature", base: "main" });
  expect(prompt).not.toContain('"');
  expect(prompt).toContain("`feature`");
  expect(prompt).toContain("`main`");

  const quoted = mergeConflictPrompt({ branch: 'a"b', base: "main" });
  expect(quoted).not.toContain('"');
  expect(quoted).toContain("`main`");
});
