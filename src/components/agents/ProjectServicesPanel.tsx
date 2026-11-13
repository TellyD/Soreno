import {
  GitBranch,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AgentSession,
  AgentSessionStatus,
} from "../../domain/agentSessions";
import {
  projectServiceKey,
  type ProjectService,
} from "../../domain/projectServices";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { useAgentStrings } from "./agentStrings";
import "./ProjectServicesPanel.css";

export type ProjectServicesSection = {
  projectId: string;
  projectName: string;
  services: ProjectService[];
  launchableServiceIds: ReadonlySet<string>;
  sessions: AgentSession[];
  serviceBranches: Readonly<Record<string, string | null>>;
  disconnected: boolean;
};

export type ProjectServicesPanelProps = {
  sections: ProjectServicesSection[];
  statuses: AgentSessionStatus[];
  pendingServiceKeys: ReadonlySet<string>;
  selectedServiceKey: string;
  terminal?: ReactNode;
  disabled?: boolean;
  /** Name each section, even a single one, when the scope is a project group. */
  grouped?: boolean;
  onServiceChange: (projectId: string, serviceId: string) => void;
  onStartServices: (projectId: string, services: ProjectService[]) => void;
  onStopServices: (projectId: string, services: ProjectService[]) => void;
  onRestartService: (projectId: string, service: ProjectService) => void;
  /** Connects a disconnected section's SSH project. */
  connectAction?: (projectId: string, size?: "small") => ReactNode;
};

export function ProjectServicesPanel({
  sections,
  statuses,
  pendingServiceKeys,
  selectedServiceKey,
  terminal,
  disabled = false,
  grouped = false,
  onServiceChange,
  onStartServices,
  onStopServices,
  onRestartService,
  connectAction,
}: ProjectServicesPanelProps) {
  const s = useAgentStrings();
  const statusBySession = new Map(
    statuses.map((status) => [status.sessionId, status]),
  );
  const operating = pendingServiceKeys.size > 0;
  const orderedSections = sections.map((section) => {
    const sessionByService = new Map(
      section.sessions.flatMap((session) =>
        session.serviceId ? [[session.serviceId, session] as const] : [],
      ),
    );
    return {
      ...section,
      services: [...section.services].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
      statusFor: (serviceId: string) => {
        const session = sessionByService.get(serviceId);
        return session ? statusBySession.get(session.id) : undefined;
      },
    };
  });
  const selectedService =
    orderedSections.flatMap((section) =>
      section.services.filter(
        (service) =>
          projectServiceKey(section.projectId, service.id) ===
          selectedServiceKey,
      ),
    )[0] ?? orderedSections[0]?.services[0];

  const bulk = (section: (typeof orderedSections)[number]) => {
    const startableServices = section.services.filter(
      (service) =>
        section.launchableServiceIds.has(service.id) &&
        section.statusFor(service.id)?.state !== "running",
    );
    const runningServices = section.services.filter(
      (service) => section.statusFor(service.id)?.state === "running",
    );
    const startAll =
      startableServices.length > 0 || runningServices.length === 0;
    return (
      <button
        type="button"
        className="project-services-bulk"
        disabled={
          disabled ||
          section.disconnected ||
          operating ||
          (startAll ? startableServices : runningServices).length === 0
        }
        onClick={() =>
          startAll
            ? onStartServices(section.projectId, startableServices)
            : onStopServices(section.projectId, runningServices)
        }
      >
        {operating ? (
          <LoaderCircle
            size={13}
            className="app-loading-spinner"
            aria-hidden="true"
          />
        ) : startAll ? (
          <Play size={13} aria-hidden="true" />
        ) : (
          <Square size={13} aria-hidden="true" />
        )}
        {startAll ? s.startAllServices : s.stopAllServices}
      </button>
    );
  };

  const list = (section: (typeof orderedSections)[number]) => (
    <ul className="project-services-list">
      {section.services.map((service) => {
        const key = projectServiceKey(section.projectId, service.id);
        const selected = key === selectedServiceKey;
        const status = section.statusFor(service.id);
        const pending = pendingServiceKeys.has(key);
        const running = status?.state === "running";
        const branch = section.serviceBranches[service.id];
        const launchable = section.launchableServiceIds.has(service.id);
        const commandsDisabled = disabled || section.disconnected;
        const toggleAvailable =
          !section.disconnected && (running || launchable);
        const restartAvailable = !section.disconnected && launchable;
        const stateLabel = pending
          ? s.servicePending
          : running
            ? s.serviceRunning
            : status?.state === "exited"
              ? s.serviceStopped
              : s.serviceReady;
        return (
          <li className={selected ? "is-selected" : undefined} key={key}>
            <button
              type="button"
              className="project-services-service-select"
              aria-current={selected ? "true" : undefined}
              aria-pressed={selected}
              aria-label={s.showServiceLogs(service.label)}
              onClick={() => onServiceChange(section.projectId, service.id)}
            >
              <span className="project-services-service-title">
                <span className="project-services-state-icon">
                  {pending ? (
                    <LoaderCircle
                      size={13}
                      className="app-loading-spinner"
                      role="status"
                      aria-label={stateLabel}
                    />
                  ) : (
                    <span
                      className={`agent-status-dot is-${status?.state ?? "idle"}`}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="project-services-service-name">
                  {service.label}
                </span>
              </span>
              <span className="project-services-service-meta">
                <span className="project-services-status">
                  {stateLabel}
                  {!pending &&
                  status?.state === "exited" &&
                  status.exitCode !== null
                    ? ` · ${s.serviceExitCode(status.exitCode)}`
                    : null}
                </span>
                {branch ? (
                  <span className="project-services-branch" title={branch}>
                    <GitBranch size={11} aria-hidden="true" />
                    <span>{branch}</span>
                  </span>
                ) : null}
                {service.port ? (
                  <span className="project-services-port">
                    {s.servicePort(service.port)}
                  </span>
                ) : null}
              </span>
            </button>
            <div className="project-services-actions">
              <IconButton
                size="small"
                className={`project-services-toggle${running ? " is-running" : ""}${toggleAvailable ? " is-operation-lockable" : ""}`}
                aria-label={
                  running
                    ? s.stopService(service.label)
                    : s.startService(service.label)
                }
                title={
                  running
                    ? s.stopService(service.label)
                    : s.startService(service.label)
                }
                disabled={
                  commandsDisabled || pending || (!running && !launchable)
                }
                onClick={() =>
                  running
                    ? onStopServices(section.projectId, [service])
                    : onStartServices(section.projectId, [service])
                }
              >
                {running ? <Square /> : <Play />}
              </IconButton>
              <IconButton
                size="small"
                className={`project-services-restart${restartAvailable ? " is-operation-lockable" : ""}`}
                aria-label={s.restartService(service.label)}
                title={s.restartService(service.label)}
                disabled={commandsDisabled || pending || !launchable}
                onClick={() => onRestartService(section.projectId, service)}
              >
                <RefreshCw />
              </IconButton>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const disconnectedSection = sections.find((section) => section.disconnected);
  return (
    <section className="project-services-panel" aria-label={s.services}>
      {disconnectedSection ? (
        <div className="project-services-disconnected" role="status">
          <span>{s.servicesDisconnected}</span>
          {connectAction?.(disconnectedSection.projectId, "small")}
        </div>
      ) : null}

      <div className="project-services-body">
        <div className="project-services-list-pane">
          <header className="project-services-header">
            <strong>{s.services}</strong>
            {grouped || !orderedSections[0] ? null : bulk(orderedSections[0])}
          </header>
          <div className="project-services-scroll">
            {grouped
              ? orderedSections.map((section) => (
                  <section
                    className="project-services-section"
                    aria-label={section.projectName}
                    key={section.projectId}
                  >
                    <header className="project-services-section-header">
                      <span>{section.projectName}</span>
                      {bulk(section)}
                    </header>
                    {list(section)}
                  </section>
                ))
              : orderedSections.map(list)}
          </div>
        </div>
        <section
          className="project-services-logs"
          aria-label={`${s.serviceLogs} · ${selectedService?.label ?? ""}`}
        >
          {terminal ?? (
            <EmptyState
              fill
              headingLevel={3}
              icon={<TerminalSquare />}
              title={s.serviceNoLogs}
              description={s.serviceNoLogsDescription}
            />
          )}
        </section>
      </div>
    </section>
  );
}
