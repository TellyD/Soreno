import type {
  AgentEnvironment,
  AgentEnvironments,
} from "../../domain/agentSessions";
import { Select } from "../ui/Select";
import { useAgentStrings } from "./agentStrings";
import { emptySshConnection } from "./SshProjectFields";

/** The environment an `AgentEnvironmentSelect` value names; SSH keeps the current connection. */
export function selectedAgentEnvironment(
  value: string,
  current: AgentEnvironment,
): AgentEnvironment {
  return value === "local"
    ? { kind: "local", distribution: null }
    : value === "ssh"
      ? {
          kind: "ssh",
          distribution: null,
          ssh:
            current.kind === "ssh"
              ? (current.ssh ?? emptySshConnection())
              : emptySshConnection(),
        }
      : { kind: "wsl", distribution: value.slice(4) };
}

export function AgentEnvironmentSelect({
  id,
  environment,
  environments,
  discovering,
  disabled,
  onValueChange,
}: {
  id: string;
  environment: AgentEnvironment;
  environments: AgentEnvironments | null;
  discovering: boolean;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const s = useAgentStrings();
  const distributions = [
    ...new Set([
      ...(environments?.distributions ?? []),
      ...(environment.distribution ? [environment.distribution] : []),
    ]),
  ];
  return (
    <>
      <label htmlFor={`${id}-environment`}>{s.environment}</label>
      <Select
        id={`${id}-environment`}
        aria-label={s.environment}
        disabled={disabled}
        aria-busy={discovering}
        aria-description={discovering ? s.discovering : undefined}
        value={
          environment.kind === "local"
            ? "local"
            : environment.kind === "ssh"
              ? "ssh"
              : `wsl:${environment.distribution}`
        }
        options={[
          { value: "local", label: s.local },
          ...distributions.map((name) => ({
            value: `wsl:${name}`,
            label: `WSL · ${name}`,
          })),
          { value: "ssh", label: s.ssh },
        ]}
        onValueChange={onValueChange}
      />
    </>
  );
}
