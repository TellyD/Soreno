import { Monitor, Server, SquareTerminal } from "lucide-react";
import type {
  AgentEnvironment,
  AgentEnvironments,
  AgentProject,
} from "../../domain/agentSessions";
import { SegmentedControl, SegmentedControlItem } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { useAgentStrings } from "./agentStrings";
import { lastSshConnection } from "./SshProjectFields";

/** The environment an `AgentEnvironmentSelect` value names; SSH keeps the current connection, else reuses the last one. */
export function selectedAgentEnvironment(
  value: string,
  current: AgentEnvironment,
  projects: AgentProject[],
): AgentEnvironment {
  return value === "local"
    ? { kind: "local", distribution: null }
    : value === "ssh"
      ? {
          kind: "ssh",
          distribution: null,
          ssh:
            (current.kind === "ssh" ? current.ssh : null) ??
            lastSshConnection(projects),
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
  const wsl = environment.kind === "wsl";
  return (
    <>
      <label>{s.environment}</label>
      <SegmentedControl
        aria-label={s.environment}
        aria-busy={discovering}
        aria-description={discovering ? s.discovering : undefined}
      >
        <SegmentedControlItem
          selected={environment.kind === "local"}
          disabled={disabled}
          onClick={() => onValueChange("local")}
        >
          <Monitor size={14} aria-hidden="true" />
          {s.local}
        </SegmentedControlItem>
        {distributions.length ? (
          <SegmentedControlItem
            selected={wsl}
            disabled={disabled}
            onClick={() =>
              onValueChange(
                `wsl:${wsl ? environment.distribution : distributions[0]}`,
              )
            }
          >
            <SquareTerminal size={14} aria-hidden="true" />
            WSL
          </SegmentedControlItem>
        ) : null}
        <SegmentedControlItem
          selected={environment.kind === "ssh"}
          disabled={disabled}
          onClick={() => onValueChange("ssh")}
        >
          <Server size={14} aria-hidden="true" />
          {s.ssh}
        </SegmentedControlItem>
      </SegmentedControl>
      {wsl ? (
        <>
          <label htmlFor={`${id}-distribution`}>{s.wslDistribution}</label>
          <Select
            id={`${id}-distribution`}
            aria-label={s.wslDistribution}
            disabled={disabled}
            value={`wsl:${environment.distribution}`}
            options={distributions.map((name) => ({
              value: `wsl:${name}`,
              label: name,
            }))}
            onValueChange={onValueChange}
          />
        </>
      ) : null}
    </>
  );
}
