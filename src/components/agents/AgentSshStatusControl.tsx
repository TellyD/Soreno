import { CircleAlert, LoaderCircle, Network } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { AgentProject } from "../../domain/agentSessions";
import type { SshConnectionState } from "../../domain/agentWorkspaceView";
import type { AgentStrings } from "./agentStrings";
import { SshMobileAccessControl } from "./SshMobileAccessControl";
import { SshPortForwardControl } from "./SshPortForwardControl";

export type SshTransition = { projectId: string; connected: boolean };

export function AgentSshStatusControl({
  s,
  sshAddress,
  selectedProject,
  selectedProjectDisconnected,
  sshState,
  sshActiveCount,
  sshTransition,
  disabled,
  handleSshForwardBusyChange,
  toggleRef,
  onToggle,
  servicesToggle,
}: {
  s: AgentStrings;
  sshAddress: string;
  selectedProject: AgentProject;
  selectedProjectDisconnected: boolean;
  sshState: SshConnectionState;
  sshActiveCount: number;
  sshTransition: SshTransition | null;
  disabled: boolean;
  handleSshForwardBusyChange: (value: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  servicesToggle: ReactNode;
}) {
  const sshStateLabel =
    sshState === "offline"
      ? s.disconnected
      : sshState === "dormant"
        ? s.sshNotConnected
        : sshState === "starting"
          ? s.sshStarting
          : sshState === "unknown"
            ? s.sshUnknown
            : sshState === "active"
              ? s.sshActive(sshActiveCount)
              : sshState === "error"
                ? s.sshSessionError
                : s.sshOnDemand;
  const SshStatusIcon =
    sshState === "starting"
      ? LoaderCircle
      : sshState === "error"
        ? CircleAlert
        : Network;
  const selectedSshTransition =
    sshTransition?.projectId === selectedProject?.id ? sshTransition : null;
  const sshActionLabel = selectedSshTransition
    ? selectedSshTransition.connected
      ? s.connecting
      : s.disconnecting
    : selectedProjectDisconnected
      ? s.connect
      : s.disconnect;

  return (
    <span className="agent-ssh-control">
      <span
        className="agent-ssh-status"
        data-state={sshState}
        role="status"
        aria-live="polite"
        aria-label={`${sshAddress} · ${selectedProject.name} · ${sshStateLabel}`}
        title={s.sshStatusTitle(
          sshAddress,
          sshStateLabel,
          selectedProjectDisconnected,
        )}
      >
        <SshStatusIcon
          size={13}
          aria-hidden="true"
          className={
            sshState === "starting" ? "app-loading-spinner" : undefined
          }
        />
        <span className="agent-ssh-status-label">
          SSH · {selectedProject.name}
        </span>
      </span>
      {servicesToggle}
      <SshPortForwardControl
        key={selectedProject.id}
        address={sshAddress}
        disabled={disabled}
        disconnected={selectedProjectDisconnected}
        onBusyChange={handleSshForwardBusyChange}
        projectId={selectedProject.id}
      />
      <SshMobileAccessControl
        key={`mobile:${selectedProject.id}`}
        address={sshAddress}
        disabled={disabled}
        disconnected={selectedProjectDisconnected}
        onBusyChange={handleSshForwardBusyChange}
        projectId={selectedProject.id}
      />
      <button
        ref={toggleRef}
        type="button"
        className="agent-ssh-toggle"
        disabled={disabled}
        aria-label={
          selectedSshTransition
            ? sshActionLabel
            : `${sshActionLabel} · ${selectedProject.name}`
        }
        title={sshActionLabel}
        onClick={onToggle}
      >
        {selectedSshTransition ? (
          <LoaderCircle
            size={13}
            className="app-loading-spinner"
            aria-hidden="true"
          />
        ) : (
          sshActionLabel
        )}
      </button>
    </span>
  );
}
