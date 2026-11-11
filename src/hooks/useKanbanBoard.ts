import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLinearApiKey,
  createKanbanIssue,
  createKanbanLabel,
  deleteKanbanIssue,
  listLinearWorkspaces,
  loadKanbanBoard,
  loadLinearKanbanBoard,
  setLinearApiKey,
  transferKanbanIssueToLinear,
  updateKanbanIssue,
} from "../data/kanbanApi";
import { isNewer } from "../domain/dateTime";
import {
  applyIssueUpdate,
  kanbanIssueInput,
  type KanbanBoard,
  type KanbanIssue,
  type KanbanIssueCreateInput,
  type KanbanIssuePatch,
  type KanbanIssueUpdate,
  type KanbanLabel,
  type KanbanSource,
  type LinearWorkspace,
} from "../domain/kanban";

const LINEAR_REFRESH_MS = 5 * 60 * 1000;
const REFRESH_COALESCE_MS = 5000;

type UpdateCaller = { resolve: () => void; reject: (error: unknown) => void };

type IssueTarget = Omit<KanbanIssuePatch, "labels"> & {
  // Toggled labels by id (null = removed), so labels added elsewhere are kept.
  labels?: ReadonlyMap<string, KanbanLabel | null>;
};

type IssueUpdate = {
  // Last server fields, from a response or a newer snapshot.
  confirmed: KanbanIssueUpdate;
  // Fields the user requested, merged across requests; untouched fields follow `confirmed`.
  target: IssueTarget;
  // Request time of the latest state change, so a moved card sorts as just updated.
  movedAt: string | null;
  // Callers whose target is not sent yet.
  callers: UpdateCaller[];
};

type CreatedIssue = { issue: KanbanIssue; request: number };

type CreatedLabel = { label: KanbanLabel; request: number };

function withLabel(
  labels: readonly KanbanLabel[],
  label: KanbanLabel,
): KanbanLabel[] {
  return [...labels, label].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

function issueUpdateFrom(issue: KanbanIssue): KanbanIssueUpdate {
  return {
    id: issue.id,
    title: issue.title,
    stateId: issue.stateId,
    priority: issue.priority,
    project: issue.project,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    ...(issue.source === "linear" && {
      assignee: issue.assignee,
      linearProject: issue.linearProject,
    }),
  };
}

function requestedPatch({ confirmed, target }: IssueUpdate): KanbanIssuePatch {
  const { labels: toggles, ...fields } = target;
  if (!toggles) return fields;
  const kept = confirmed.labels.filter(({ id }) => toggles.get(id) !== null);
  const added = [...toggles.values()].filter(
    (label): label is KanbanLabel =>
      label !== null && !kept.some(({ id }) => id === label.id),
  );
  return { ...fields, labels: [...kept, ...added] };
}

function pendingIssue(update: IssueUpdate): KanbanIssueUpdate {
  const { confirmed, movedAt } = update;
  return {
    ...confirmed,
    ...requestedPatch(update),
    updatedAt:
      movedAt !== null && isNewer({ updatedAt: movedAt }, confirmed)
        ? movedAt
        : confirmed.updatedAt,
  };
}

function toggledLabels(
  toggles: ReadonlyMap<string, KanbanLabel | null> | undefined,
  shown: readonly KanbanLabel[],
  requested: readonly KanbanLabel[],
): ReadonlyMap<string, KanbanLabel | null> {
  const next = new Map(toggles);
  for (const label of requested) {
    if (!shown.some(({ id }) => id === label.id)) next.set(label.id, label);
  }
  for (const { id } of shown) {
    if (!requested.some((label) => label.id === id)) next.set(id, null);
  }
  return next;
}

// A snapshot read before an update settled must not undo it; pending updates keep their target.
function reconcileLoadedBoard<B extends KanbanBoard>(
  loaded: B,
  confirmed: ReadonlyMap<string, KanbanIssueUpdate>,
  pending: KanbanIssueUpdate[],
): B {
  const settled = loaded.issues.flatMap((issue) => {
    const update = confirmed.get(issue.id);
    return update && isNewer(update, issue) ? [update] : [];
  });
  return [...settled, ...pending].reduce<B>(applyIssueUpdate, loaded);
}

/** One source's board with its optimistic updates; `loadSnapshot` must be stable. */
function useSourceBoard<B extends KanbanBoard>(
  source: KanbanSource,
  loadSnapshot: () => Promise<B>,
) {
  const [board, setBoard] = useState<B | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  // Bumped on every request so late responses from older ones are dropped.
  const requestRef = useRef(0);
  // Bumped by `reset` so responses for a dropped board are not applied to the next one.
  const epochRef = useRef(0);
  // One in-flight Kanban update per issue; later requests merge into its target.
  const updatesRef = useRef(new Map<string, IssueUpdate>());
  // Server fields returned by successful updates, kept until a snapshot catches up.
  const confirmedRef = useRef(new Map<string, KanbanIssueUpdate>());
  // Created issues, with the last request started before the backend confirmed them.
  const createdRef = useRef(new Map<string, CreatedIssue>());
  // Deleted issue ids, with the last request started before the backend confirmed the deletion.
  const deletedRef = useRef(new Map<string, number>());
  // Created labels, with the last request started before the backend confirmed them.
  const createdLabelsRef = useRef(new Map<string, CreatedLabel>());

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await loadSnapshot();
      if (request !== requestRef.current) return;
      const deleted = deletedRef.current;
      for (const [id, deletedAt] of deleted) {
        // A snapshot requested after the deletion is authoritative.
        if (request > deletedAt) deleted.delete(id);
      }
      const listed = new Set(snapshot.issues.map(({ id }) => id));
      const missing: KanbanIssue[] = [];
      for (const [id, created] of createdRef.current) {
        // A snapshot requested after the creation is authoritative.
        if (listed.has(id) || request > created.request) {
          createdRef.current.delete(id);
        } else {
          missing.unshift(created.issue);
        }
      }
      let labels = snapshot.labels;
      for (const [id, created] of createdLabelsRef.current) {
        if (
          labels.some((label) => label.id === id) ||
          request > created.request
        ) {
          createdLabelsRef.current.delete(id);
        } else {
          labels = withLabel(labels, created.label);
        }
      }
      const nextBoard: B = {
        ...snapshot,
        labels,
        issues: [
          ...missing,
          ...snapshot.issues.filter(({ id }) => !deleted.has(id)),
        ],
      };
      const updates = updatesRef.current;
      const confirmed = confirmedRef.current;
      for (const loaded of nextBoard.issues) {
        const change = confirmed.get(loaded.id);
        if (change && !isNewer(change, loaded)) confirmed.delete(loaded.id);
        const update = updates.get(loaded.id);
        if (update && isNewer(loaded, update.confirmed)) {
          update.confirmed = issueUpdateFrom(loaded);
        }
      }
      setBoard(
        reconcileLoadedBoard(
          nextBoard,
          confirmed,
          [...updates.values()].map(pendingIssue),
        ),
      );
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(loadError);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [loadSnapshot]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  // Drops the board and every response still in flight for it; queued updates keep draining in order.
  const reset = useCallback(() => {
    requestRef.current += 1;
    epochRef.current += 1;
    confirmedRef.current.clear();
    createdRef.current.clear();
    deletedRef.current.clear();
    createdLabelsRef.current.clear();
    setBoard(null);
    setError(null);
    setLoading(false);
  }, []);

  const drainUpdate = useCallback(
    async (update: IssueUpdate) => {
      const { id } = update.confirmed;
      for (;;) {
        const sent = update.target;
        const input = kanbanIssueInput(
          requestedPatch(update),
          update.confirmed,
        );
        const callers = update.callers.splice(0);
        let failure: { error: unknown } | null = null;
        if (Object.keys(input).length > 0) {
          try {
            const response = await updateKanbanIssue(source, id, input);
            // A reload may already have seen a newer server state than this response.
            if (!isNewer(update.confirmed, response)) {
              update.confirmed = response;
              confirmedRef.current.set(id, response);
            }
          } catch (error) {
            failure = { error };
          }
        }
        // The issue was deleted meanwhile: its outcome no longer matters to callers.
        if (updatesRef.current.get(id) !== update) {
          confirmedRef.current.delete(id);
          for (const caller of callers) caller.resolve();
          return;
        }
        // A newer target is still unsent: show it over the latest confirmed fields and send it next.
        if (update.target !== sent) {
          const shown = pendingIssue(update);
          setBoard((current) => current && applyIssueUpdate(current, shown));
          for (const caller of callers) caller.resolve();
          continue;
        }
        updatesRef.current.delete(id);
        const settled = update.confirmed;
        setBoard((current) => current && applyIssueUpdate(current, settled));
        callers.forEach((caller, index) => {
          if (failure && index === callers.length - 1) {
            caller.reject(failure.error);
          } else {
            caller.resolve();
          }
        });
        return;
      }
    },
    [source],
  );

  const updateIssue = useCallback(
    (issue: KanbanIssue, patch: KanbanIssuePatch) =>
      new Promise<void>((resolve, reject) => {
        const updates = updatesRef.current;
        const queued = updates.get(issue.id);
        const update: IssueUpdate = queued ?? {
          confirmed: issueUpdateFrom(issue),
          target: {},
          movedAt: null,
          callers: [],
        };
        const { labels, ...fields } = patch;
        update.target = {
          ...update.target,
          ...fields,
          ...(labels && {
            labels: toggledLabels(
              update.target.labels,
              pendingIssue(update).labels,
              labels,
            ),
          }),
        };
        if (patch.stateId !== undefined) {
          update.movedAt = new Date().toISOString();
        }
        update.callers.push({ resolve, reject });
        const shown = pendingIssue(update);
        setBoard((current) => current && applyIssueUpdate(current, shown));
        if (queued) return;
        updates.set(issue.id, update);
        void drainUpdate(update);
      }),
    [drainUpdate],
  );

  // An update Soreno made outside the board settles like a response to one of its own.
  const applyServerUpdate = useCallback((response: KanbanIssueUpdate) => {
    const pending = updatesRef.current.get(response.id);
    if (pending) {
      if (!isNewer(pending.confirmed, response)) {
        pending.confirmed = response;
        confirmedRef.current.set(response.id, response);
      }
      const shown = pendingIssue(pending);
      setBoard((current) => current && applyIssueUpdate(current, shown));
      return;
    }
    const known = confirmedRef.current.get(response.id);
    if (known && isNewer(known, response)) return;
    confirmedRef.current.set(response.id, response);
    setBoard((current) =>
      current?.issues.some(
        (issue) => issue.id === response.id && !isNewer(issue, response),
      )
        ? applyIssueUpdate(current, response)
        : current,
    );
  }, []);

  // Captured before the request starts; the returned callback shows its created issue.
  const trackCreation = useCallback(() => {
    const epoch = epochRef.current;
    return (issue: KanbanIssue) => {
      if (epoch !== epochRef.current) return;
      createdRef.current.set(issue.id, { issue, request: requestRef.current });
      // A reload finished during the request may already list the issue.
      setBoard((current) =>
        current && !current.issues.some(({ id }) => id === issue.id)
          ? { ...current, issues: [issue, ...current.issues] }
          : current,
      );
    };
  }, []);

  const createIssue = useCallback(
    async (input: KanbanIssueCreateInput) => {
      const created = trackCreation();
      const issue = await createKanbanIssue(source, input);
      created(issue);
      return issue;
    },
    [source, trackCreation],
  );

  // Creating an existing name returns that label, so it is only added once.
  const createLabel = useCallback(
    async (teamId: string, name: string) => {
      const epoch = epochRef.current;
      const label = await createKanbanLabel(source, teamId, name);
      if (epoch !== epochRef.current) return label;
      createdLabelsRef.current.set(label.id, {
        label,
        request: requestRef.current,
      });
      setBoard(
        (current) =>
          current && {
            ...current,
            labels: current.labels.some(({ id }) => id === label.id)
              ? current.labels
              : withLabel(current.labels, label),
          },
      );
      return label;
    },
    [source],
  );

  // Captured before the request starts; the returned callback removes the deleted issue.
  const trackDeletion = useCallback((issue: KanbanIssue) => {
    const epoch = epochRef.current;
    return () => {
      if (epoch !== epochRef.current) return;
      deletedRef.current.set(issue.id, requestRef.current);
      createdRef.current.delete(issue.id);
      confirmedRef.current.delete(issue.id);
      const update = updatesRef.current.get(issue.id);
      if (update) {
        updatesRef.current.delete(issue.id);
        for (const caller of update.callers.splice(0)) caller.resolve();
      }
      setBoard(
        (current) =>
          current && {
            ...current,
            issues: current.issues.filter(({ id }) => id !== issue.id),
          },
      );
    };
  }, []);

  const deleteIssue = useCallback(
    async (issue: KanbanIssue) => {
      const deleted = trackDeletion(issue);
      await deleteKanbanIssue(source, issue.id);
      deleted();
    },
    [source, trackDeletion],
  );

  const actions = useMemo(
    () => ({
      applyServerUpdate,
      createIssue,
      createLabel,
      deleteIssue,
      trackCreation,
      trackDeletion,
      updateIssue,
    }),
    [
      applyServerUpdate,
      createIssue,
      createLabel,
      deleteIssue,
      trackCreation,
      trackDeletion,
      updateIssue,
    ],
  );

  return { actions, board, error, load, loading, reset };
}

export function useKanbanBoard({
  linearTeamId,
  visible,
}: {
  linearTeamId: string | null;
  visible: boolean;
}) {
  const local = useSourceBoard("local", loadKanbanBoard);
  // Team of the next Linear load; set by the effect that loads it.
  const teamIdRef = useRef(linearTeamId);
  const loadLinearSnapshot = useCallback(
    () => loadLinearKanbanBoard(teamIdRef.current),
    [],
  );
  const linear = useSourceBoard("linear", loadLinearSnapshot);
  const [linearWorkspaces, setLinearWorkspaces] = useState<LinearWorkspace[]>(
    [],
  );
  const linearConnected = linearWorkspaces.length > 0;
  const [keyError, setKeyError] = useState<unknown>(null);
  const { load: loadLocal } = local;
  const { load: loadLinear, reset: resetLinear } = linear;
  const linearTeamLoaded = linear.board?.team.id;
  // Set while the board is shown; Linear is only read then, with the window visible.
  const shownRef = useRef(false);
  // A Linear read was skipped while hidden; it runs once shown again.
  const staleRef = useRef(false);
  const readLinear = useCallback(() => {
    staleRef.current =
      !shownRef.current || document.visibilityState !== "visible";
    if (!staleRef.current) void loadLinear();
  }, [loadLinear]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  useEffect(() => {
    let current = true;
    listLinearWorkspaces().then(
      (workspaces) => current && setLinearWorkspaces(workspaces),
      (error: unknown) => current && setKeyError(error),
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    teamIdRef.current = linearTeamId;
    // A null team loads the first one; remembering that team afterwards must not reload it,
    // so the loaded team is read but left out of the dependencies.
    if (!linearConnected || linearTeamId === linearTeamLoaded) return;
    resetLinear();
    readLinear();
  }, [linearConnected, linearTeamId, readLinear, resetLinear]);

  useEffect(() => {
    if (!visible || !linearConnected) return;
    shownRef.current = true;
    let timer = 0;
    // Restoring a minimized window fires both `visibilitychange` and `focus`.
    let lastRefresh = -Infinity;
    const stop = () => window.clearInterval(timer);
    const schedule = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      timer = window.setInterval(readLinear, LINEAR_REFRESH_MS);
    };
    const refresh = () => {
      if (document.visibilityState !== "visible") {
        lastRefresh = -Infinity;
      } else if (Date.now() - lastRefresh < REFRESH_COALESCE_MS) {
        return;
      } else {
        lastRefresh = Date.now();
      }
      readLinear();
      schedule();
    };
    if (staleRef.current) readLinear();
    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      shownRef.current = false;
      // Hidden boards are not polled, so the next show must reload.
      staleRef.current = true;
      stop();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [linearConnected, readLinear, visible]);

  // Without a source, both reload.
  const reload = useCallback(
    (source?: KanbanSource) => {
      if (source !== "linear") void loadLocal();
      if (source === "local") return;
      if (linearConnected) {
        readLinear();
      } else if (keyError !== null) {
        // Once connected, the team effect loads Linear.
        listLinearWorkspaces().then(
          (workspaces) => {
            setKeyError(null);
            setLinearWorkspaces(workspaces);
          },
          (error: unknown) => setKeyError(error),
        );
      }
    },
    [keyError, linearConnected, loadLocal, readLinear],
  );

  // The team effect loads the board once connected; another workspace adds its teams on reload.
  const connectLinear = useCallback(
    async (apiKey: string) => {
      await setLinearApiKey(apiKey);
      const workspaces = await listLinearWorkspaces();
      setKeyError(null);
      setLinearWorkspaces(workspaces);
      if (linearConnected) readLinear();
    },
    [linearConnected, readLinear],
  );

  const disconnectLinear = useCallback(
    async (workspaceId: string) => {
      await clearLinearApiKey(workspaceId);
      setKeyError(null);
      resetLinear();
      const remaining = linearWorkspaces.filter(({ id }) => id !== workspaceId);
      setLinearWorkspaces(remaining);
      if (remaining.length > 0) readLinear();
    },
    [linearWorkspaces, readLinear, resetLinear],
  );

  const routes = useMemo(() => {
    const sources = { local: local.actions, linear: linear.actions };
    return {
      applyServerUpdate: (source: KanbanSource, update: KanbanIssueUpdate) =>
        sources[source].applyServerUpdate(update),
      createIssue: (source: KanbanSource, input: KanbanIssueCreateInput) =>
        sources[source].createIssue(input),
      createLabel: (source: KanbanSource, teamId: string, name: string) =>
        sources[source].createLabel(teamId, name),
      deleteIssue: (issue: KanbanIssue) =>
        sources[issue.source].deleteIssue(issue),
      updateIssue: (issue: KanbanIssue, patch: KanbanIssuePatch) =>
        sources[issue.source].updateIssue(issue, patch),
      // Removes the local issue and lists the Linear one it became.
      transferIssue: async (
        issue: KanbanIssue,
        input: KanbanIssueCreateInput,
        comments: { id: string; body: string }[],
        sourceDescription: string | null,
      ) => {
        const deleted = local.actions.trackDeletion(issue);
        const created = linear.actions.trackCreation();
        const linearIssue = await transferKanbanIssueToLinear(
          issue.id,
          input,
          comments,
          sourceDescription,
        );
        deleted();
        created(linearIssue);
        return linearIssue;
      },
    };
  }, [local.actions, linear.actions]);

  const issues = useMemo(
    () => [...(local.board?.issues ?? []), ...(linear.board?.issues ?? [])],
    [local.board, linear.board],
  );

  return {
    ...routes,
    board: local.board,
    connectLinear,
    disconnectLinear,
    error: local.error,
    issues,
    linear: linear.board,
    linearConnected,
    linearWorkspaces,
    linearError: linear.error ?? keyError,
    loading: local.loading || linear.loading,
    reload,
  };
}
