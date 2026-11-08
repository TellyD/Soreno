import { useCallback, useEffect, useRef, useState } from "react";
import { listAgentServiceBranches } from "../data/agentSessionsApi";
import { readProjectFile } from "../data/projectFilesApi";
import { projectFileError } from "../domain/projectFiles";
import {
  parseProjectServicesManifest,
  PROJECT_SERVICES_MANIFEST_PATH,
  type ProjectServicesManifest,
} from "../domain/projectServices";
import { sshProjectScope, type AgentProject } from "../domain/agentSessions";

export type ProjectServicesState = {
  scope: string | null;
  manifest: ProjectServicesManifest | null;
  version: string | null;
  serviceBranches: Record<string, string | null>;
  loading: boolean;
  missing: boolean;
  error: string | null;
};

const empty = (scope: string | null): ProjectServicesState => ({
  scope,
  manifest: null,
  version: null,
  serviceBranches: {},
  loading: scope !== null,
  missing: false,
  error: null,
});

type Target = [projectId: string, scope: string, disconnected: boolean];

export function useProjectServices(
  projects: readonly AgentProject[],
  disconnectedProjectIds: readonly string[] = [],
) {
  const targets: Target[] = projects.flatMap((project) => {
    const scope = sshProjectScope(project);
    return scope
      ? [[project.id, scope, disconnectedProjectIds.includes(project.id)]]
      : [];
  });
  const targetsKey = JSON.stringify(targets);
  const cache = useRef(new Map<string, ProjectServicesState>());
  const [states, setStates] = useState<Record<string, ProjectServicesState>>(
    {},
  );
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const targets = JSON.parse(targetsKey) as Target[];
    let cancelled = false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const update = (state: ProjectServicesState) => {
      if (!cancelled)
        setStates((current) => ({ ...current, [state.scope!]: state }));
    };
    setStates(
      Object.fromEntries(
        targets.map(([, scope, disconnected]) => {
          const cached = cache.current.get(scope);
          return [
            scope,
            disconnected
              ? (cached ?? { ...empty(scope), loading: false })
              : cached
                ? { ...cached, loading: true, error: null }
                : empty(scope),
          ];
        }),
      ),
    );
    for (const [projectId, scope, disconnected] of targets) {
      if (disconnected) continue;
      const cached = cache.current.get(scope);
      const load = async (retryTransport: boolean) => {
        try {
          const file = await readProjectFile(
            projectId,
            PROJECT_SERVICES_MANIFEST_PATH,
          );
          const manifest = parseProjectServicesManifest(file.content);
          if (cancelled) return;
          const next = {
            scope,
            manifest,
            version: file.version,
            serviceBranches: cached?.serviceBranches ?? {},
            loading: false,
            missing: false,
            error: null,
          };
          cache.current.set(scope, next);
          update(next);
          void listAgentServiceBranches(
            projectId,
            manifest.services.map(({ id, cwd }) => ({ serviceId: id, cwd })),
          )
            .then((branches) => {
              if (cancelled) return;
              const complete = {
                ...next,
                serviceBranches: Object.fromEntries(
                  branches.map(({ serviceId, branch }) => [serviceId, branch]),
                ),
              };
              cache.current.set(scope, complete);
              update(complete);
            })
            .catch(() => {});
        } catch (reason) {
          if (cancelled) return;
          const failure = projectFileError(reason);
          const transportFailure =
            failure.code === "ssh" || failure.code === "project";
          if (retryTransport && transportFailure) {
            retryTimers.push(setTimeout(() => void load(false), 500));
            return;
          }
          if (cached && transportFailure) {
            update({ ...cached, loading: false, error: failure.message });
            return;
          }
          cache.current.delete(scope);
          update({
            scope,
            manifest: null,
            version: null,
            serviceBranches: {},
            loading: false,
            missing: failure.code === "notFound",
            error: failure.code === "notFound" ? null : failure.message,
          });
        }
      };
      void load(true);
    }
    return () => {
      cancelled = true;
      retryTimers.forEach(clearTimeout);
    };
  }, [revision, targetsKey]);

  const stateOf = (project: AgentProject): ProjectServicesState => {
    const scope = sshProjectScope(project);
    return scope
      ? (states[scope] ?? cache.current.get(scope) ?? empty(scope))
      : empty(null);
  };
  return { stateOf, retry };
}
