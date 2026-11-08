import { MessagesSquare, Pi, SquarePi, SquareTerminal } from "lucide-react";
import {
  agentProviderOf,
  ompConversationExecutable,
} from "../../domain/agentSessions";
import "./AgentProviderIcon.css";

export function AgentProviderIcon({
  executable,
  size = 12,
}: {
  executable: string;
  size?: number;
}) {
  const provider = agentProviderOf(executable);
  if (provider === "claude" || provider === "codex") {
    return (
      <span
        className={`agent-provider-icon agent-provider-logo is-${provider}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  const Icon =
    provider === "pi"
      ? Pi
      : provider === "omp"
        ? SquarePi
        : provider === ompConversationExecutable
          ? MessagesSquare
          : SquareTerminal;
  return (
    <Icon
      size={size}
      className={`agent-provider-icon is-${provider ?? "terminal"}`}
      aria-hidden="true"
    />
  );
}
