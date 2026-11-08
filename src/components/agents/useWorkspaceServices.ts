import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  AgentProject,
  AgentProjectWorktreeGroup,
  AgentSession,
  AgentWorkspace,
} from "../../domain/agentSessions";
import {
  agentServiceCatalog,
  servicesScope,
} from "../../domain/agentWorkspaceView";
import { isPanelToggleChord } from "../../domain/keyboard";
import type { ProjectService } from "../../domain/projectServices";
import { usePersistedValue } from "../../hooks/usePersistedValue";
import {
  useProjectServices,
  type ProjectServicesState,
} from "../../hooks/useProjectServices";
import {
  readServiceTrust,
  readServiceViews,
  serviceTrustKey,
  serviceViewsKey,
  writeStoredJson,
  type ServiceView,
} from "./agentWorkspaceStorage";

const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

type ServiceTrustRequest = {
  kind: "start" | "restart";
  projectId: string;
  services: ProjectService[];
};
type ServiceSource = {
  project: AgentProject;
  state: ProjectServicesState;
  sessions: AgentSession[];
  services: ProjectService[];
  launchableServiceIds: Set<string>;
  disconnected: boolean;
};

const serviceTrustIndex = ({ project, state }: ServiceSource) =>
  state.version
    ? JSON.stringify([
        project.id,
        project.environment.ssh?.host ?? null,
        project.environment.ssh?.user ?? null,
        project.environment.ssh?.port ?? null,
        project.path,
        state.version,
      ])
    : null;

/** Services of the selected project's scope: their dock, its persisted view and the trust asked before a first start. */
export function useWorkspaceServices({
  selectedProject,
  workspace,
  worktreeGroups,
  orderedProjects,
  closedSessionIds,
  hidden,
  boardSelected,
  isBusy,
  startServices,
  restartService,
  bumpRevision,
  setFailedConnectProjectId,
  setLaunchFailed,
  setFocusRequest,
}: {
  selectedProject: AgentProject | undefined;
  workspace: AgentWorkspace;
  worktreeGroups: readonly AgentProjectWorktreeGroup[];
  orderedProjects: readonly AgentProject[];
  closedSessionIds: ReadonlySet<string>;
  hidden: boolean;
  boardSelected: boolean;
  isBusy: () => boolean;
  startServices: (
    projectId: string,
    services: readonly ProjectService[],
  ) => Promise<boolean>;
  restartService: (
    projectId: string,
    service: ProjectService,
  ) => Promise<boolean>;
  bumpRevision: (id: string) => void;
  setFailedConnectProjectId: (id: string | null) => void;
  setLaunchFailed: (id: string | null) => void;
  setFocusRequest: Dispatch<SetStateAction<number>>;
}) {
  const [serviceViews, setServiceViews] = useState(readServiceViews);
  const [trustRequest, setTrustRequest] = useState<ServiceTrustRequest | null>(
    null,
  );
  const [trustPending, setTrustPending] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const target = servicesScope(
    selectedProject,
    workspace.groups ?? [],
    worktreeGroups,
    orderedProjects,
  );
  const key = target?.key;
  const projectServices = useProjectServices(
    target?.projects ?? [],
    workspace.disconnectedProjectIds,
  );
  const error = target?.projects
    .map((project) => projectServices.stateOf(project).error)
    .find(Boolean);
  const sources: ServiceSource[] = (target?.projects ?? []).flatMap(
    (project) => {
      const state = projectServices.stateOf(project);
      const sessions = workspace.sessions.filter(
        (session) =>
          session.projectId === project.id &&
          session.kind === "service" &&
          !!session.serviceId &&
          !closedSessionIds.has(session.id),
      );
      const { services, launchableServiceIds } = agentServiceCatalog(
        state.manifest?.services ?? [],
        sessions,
        project.path,
      );
      return services.length > 0
        ? [
            {
              project,
              state,
              sessions,
              services,
              launchableServiceIds,
              disconnected: (workspace.disconnectedProjectIds ?? []).includes(
                project.id,
              ),
            },
          ]
        : [];
    },
  );
  const available = sources.length > 0;
  const view = key ? serviceViews[key] : undefined;
  const open = available && !!view?.open;
  const count = sources.reduce(
    (count, source) => count + source.services.length,
    0,
  );
  const runningCount = sources.reduce(
    (count, source) =>
      count +
      source.services.filter((service) =>
        source.sessions.some(
          (session) =>
            session.serviceId === service.id &&
            workspace.statuses.some(
              (status) =>
                status.sessionId === session.id && status.state === "running",
            ),
        ),
      ).length,
    0,
  );
  // Views stored before group scopes keep their service under the project's own key.
  const selectedProjectId = view?.projectId ?? key;
  const selectedSource =
    sources.find(
      (source) =>
        source.project.id === selectedProjectId &&
        source.services.some((service) => service.id === view?.serviceId),
    ) ?? sources[0];
  const selectedService =
    selectedSource?.services.find(
      (service) => service.id === view?.serviceId,
    ) ?? selectedSource?.services[0];
  const selectedSession = selectedSource?.sessions.find(
    (session) => session.serviceId === selectedService?.id,
  );
  const selectedStatus = workspace.statuses.find(
    (status) => status.sessionId === selectedSession?.id,
  );

  usePersistedValue(serviceViewsKey, serviceViews);

  const viewKey = available ? key : undefined;
  useEffect(() => {
    if (hidden || boardSelected || !viewKey) return;
    const toggledKey = viewKey;
    // Capture phase: a focused terminal would otherwise send the chord as input.
    function toggleServices(event: KeyboardEvent) {
      if (
        !isPanelToggleChord(event, "j", isMacOS) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (
        open &&
        document
          .getElementById("agent-services-dock")
          ?.contains(document.activeElement)
      )
        toggleRef.current?.focus();
      setServiceViews((current) => ({
        ...current,
        [toggledKey]: {
          ...(current[toggledKey] ?? { open: false }),
          open: !open,
        },
      }));
    }
    document.addEventListener("keydown", toggleServices, true);
    return () => document.removeEventListener("keydown", toggleServices, true);
  }, [hidden, boardSelected, viewKey, open]);

  function setView(changes: Partial<ServiceView>) {
    if (!key) return;
    setServiceViews((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? { open: false }),
        ...changes,
      },
    }));
  }

  async function run(request: ServiceTrustRequest) {
    const source = sources.find(
      (item) => item.project.id === request.projectId,
    );
    if (!source || source.disconnected || isBusy()) return false;
    setFailedConnectProjectId(null);
    setLaunchFailed(null);
    const existingSessionIds = request.services.flatMap((service) => {
      const session = source.sessions.find(
        (item) => item.serviceId === service.id,
      );
      return session ? [session.id] : [];
    });
    const succeeded =
      request.kind === "restart"
        ? await restartService(source.project.id, request.services[0])
        : await startServices(source.project.id, request.services);
    existingSessionIds.forEach(bumpRevision);
    if (succeeded) setFocusRequest((value) => value + 1);
    return succeeded;
  }

  function requestStart(request: ServiceTrustRequest) {
    const source = sources.find(
      (item) => item.project.id === request.projectId,
    );
    const trustIndex = source && serviceTrustIndex(source);
    if (
      !trustIndex ||
      source.disconnected ||
      isBusy() ||
      request.services.length === 0
    )
      return;
    if (readServiceTrust().has(trustIndex)) void run(request);
    else setTrustRequest(request);
  }

  async function confirmTrust() {
    const request = trustRequest;
    const source = sources.find(
      (item) => item.project.id === request?.projectId,
    );
    const trustIndex = source && serviceTrustIndex(source);
    if (!request || !trustIndex) return;
    setTrustPending(true);
    try {
      const approvals = readServiceTrust();
      approvals.add(trustIndex);
      writeStoredJson(serviceTrustKey, [...approvals].slice(-1024));
      setTrustRequest(null);
      await run(request);
    } finally {
      setTrustPending(false);
    }
  }

  function cancelTrust() {
    if (!trustPending) setTrustRequest(null);
  }

  return {
    key,
    error,
    retry: projectServices.retry,
    sources,
    available,
    open,
    count,
    runningCount,
    selectedSource,
    selectedService,
    selectedSession,
    selectedStatus,
    toggleRef,
    setView,
    requestStart,
    trustRequest,
    trustPending,
    confirmTrust,
    cancelTrust,
  };
}
