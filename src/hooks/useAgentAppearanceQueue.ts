import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  updateAgentProjectAppearance,
  updateAgentProjectGroupAppearance,
} from "../data/agentSessionsApi";
import type {
  AgentProjectAppearance,
  AgentWorkspace,
} from "../domain/agentSessions";
import { asError } from "../domain/errors";

export type AppearanceTarget = "projects" | "groups";

export function useAgentAppearanceQueue({
  desktop,
  mounted,
  workspaceRef,
  setWorkspace,
  setError,
  appearanceRevision,
  confirmedAppearance,
}: {
  desktop: boolean;
  mounted: RefObject<boolean>;
  workspaceRef: RefObject<AgentWorkspace>;
  setWorkspace: Dispatch<SetStateAction<AgentWorkspace>>;
  setError: Dispatch<SetStateAction<Error | null>>;
  appearanceRevision: RefObject<number>;
  confirmedAppearance: RefObject<
    Map<string, { appearance: AgentProjectAppearance; revision: number }>
  >;
}) {
  // Appearance only: no global busy state, so the workspace does not flash on each pick.
  // Picks are merged per project or group and sent as deltas by a single serialized drain, so the latest pick persists last.
  const pendingAppearance = useRef(
    new Map<
      string,
      {
        target: AppearanceTarget;
        id: string;
        change: AgentProjectAppearance;
        settle: ((saved: boolean) => void)[];
      }
    >(),
  );
  const appearanceDraining = useRef(false);
  const appearanceIdle = useRef<(() => void)[]>([]);
  const saveAppearance = useCallback(
    (target: AppearanceTarget, id: string, change: AgentProjectAppearance) => {
      if (!desktop) return Promise.resolve(false);
      const key = `${target}:${id}`;
      const saved = new Promise<boolean>((resolve) => {
        const batch = pendingAppearance.current.get(key);
        if (batch) {
          batch.change = { ...batch.change, ...change };
          batch.settle.push(resolve);
        } else
          pendingAppearance.current.set(key, {
            target,
            id,
            change: { ...change },
            settle: [resolve],
          });
      });
      if (appearanceDraining.current) return saved;
      appearanceDraining.current = true;
      void (async () => {
        if (mounted.current) setError(null);
        try {
          // Entries re-added for a target while its batch is in flight are visited again.
          for (const [key, batch] of pendingAppearance.current) {
            pendingAppearance.current.delete(key);
            let succeeded = false;
            try {
              const { icon, color, iconDataUrl } = await (
                batch.target === "projects"
                  ? updateAgentProjectAppearance
                  : updateAgentProjectGroupAppearance
              )(batch.id, batch.change);
              const appearance = { icon, color, iconDataUrl };
              appearanceRevision.current += 1;
              confirmedAppearance.current.set(key, {
                appearance,
                revision: appearanceRevision.current,
              });
              // Only appearance: other fields may come from a newer full save.
              const patch = <T extends { id: string }>(items: T[]) =>
                items.map((item) =>
                  item.id === batch.id ? { ...item, ...appearance } : item,
                );
              const replace = (current: AgentWorkspace) =>
                batch.target === "projects"
                  ? { ...current, projects: patch(current.projects) }
                  : {
                      ...current,
                      groups: current.groups && patch(current.groups),
                    };
              workspaceRef.current = replace(workspaceRef.current);
              if (mounted.current) setWorkspace(replace);
              succeeded = true;
            } catch (reason) {
              if (mounted.current) setError(asError(reason));
            }
            for (const settle of batch.settle) settle(succeeded);
          }
        } finally {
          appearanceDraining.current = false;
          for (const resolve of appearanceIdle.current.splice(0)) resolve();
        }
      })();
      return saved;
    },
    [desktop],
  );
  const saveProjectAppearance = useCallback(
    (projectId: string, change: AgentProjectAppearance) =>
      saveAppearance("projects", projectId, change),
    [saveAppearance],
  );
  const saveGroupAppearance = useCallback(
    (groupId: string, change: AgentProjectAppearance) =>
      saveAppearance("groups", groupId, change),
    [saveAppearance],
  );
  // Resolves with the hook's own snapshot: React may not have rendered the last saved appearance yet.
  const waitForProjectAppearance = useCallback(async () => {
    while (appearanceDraining.current)
      await new Promise<void>((resolve) =>
        appearanceIdle.current.push(resolve),
      );
    return workspaceRef.current;
  }, []);
  const hasPendingProjectAppearance = useCallback(
    () => appearanceDraining.current,
    [],
  );
  return {
    saveProjectAppearance,
    saveGroupAppearance,
    waitForProjectAppearance,
    hasPendingProjectAppearance,
  };
}
