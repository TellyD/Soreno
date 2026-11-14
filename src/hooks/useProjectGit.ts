import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../data/projectGitApi";
import {
  createGitReadCache,
  gitReadKeys,
  readMutableGit,
  type GitReadCache,
} from "../data/gitReadCache";
import type { AgentEnvironment } from "../domain/agentSessions";
import {
  gitErrorCode,
  gitErrorMessage,
  gitErrorUncertain,
  type GitComparison,
  type GitRepository,
  type GitSide,
} from "../domain/projectGit";

type GitView = "changes" | "history" | "branches" | "requests";
type GitDraft = {
  view: GitView;
  message: string;
  selection: { path: string; side: GitSide } | null;
};
const emptyDraft: GitDraft = {
  view: "changes",
  message: "",
  selection: null,
};
const localPollInterval = 3_000;
const sshPollInterval = 10_000;

export function useProjectGit(
  projectId: string | undefined,
  visible: boolean,
  onMutation?: (projectId?: string, branch?: string | null) => void,
  readCache?: GitReadCache,
  readScope?: string,
  environmentKind: AgentEnvironment["kind"] = "local",
  initialRepository?: GitRepository,
  suspended = false,
) {
  const [desktop] = useState(isTauri);
  const fallbackReadCache = useRef<GitReadCache | null>(null);
  const cache =
    readCache ??
    (fallbackReadCache.current ??= createGitReadCache({ maxEntries: 32 }));
  const scopeId = projectId ? (readScope ?? projectId) : undefined;
  const [drafts, setDrafts] = useState<Record<string, GitDraft>>({});
  const draft = (projectId && drafts[projectId]) || emptyDraft;
  const selectionPath = draft.selection?.path;
  const selectionSide = draft.selection?.side;
  const [repository, setRepository] = useState<{
    scope: string;
    value: GitRepository;
  } | null>(() =>
    scopeId && initialRepository
      ? { scope: scopeId, value: initialRepository }
      : null,
  );
  const [freshStatusScope, setFreshStatusScope] = useState<string>();
  // Only reads that reached the repository: a cached status may predate a newer branch.
  const [branchRead, setBranchRead] = useState<{
    projectId: string;
    branch: string;
    startedAt: number;
  } | null>(null);
  // Like VS Code's git.statusLimit: huge worktrees are only reread on explicit requests.
  const [pausedScope, setPausedScope] = useState<string>();
  const pausedScopeRef = useRef(pausedScope);
  const pauseAutoRefresh = useCallback((scope: string, paused: boolean) => {
    const next = paused
      ? scope
      : pausedScopeRef.current === scope
        ? undefined
        : pausedScopeRef.current;
    pausedScopeRef.current = next;
    setPausedScope(next);
  }, []);
  const [comparison, setComparison] = useState<{
    project: string;
    scope: string;
    value: GitComparison;
    side: GitSide;
  } | null>(null);
  const [errors, setErrors] = useState<
    Record<
      string,
      {
        message: string;
        uncertain: boolean;
        source: "read" | "mutation";
        readError?: string;
      }
    >
  >({});
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const currentId = useRef(projectId);
  const currentScope = useRef(scopeId);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const previousSuspended = useRef(suspended);
  const connectionChanged =
    currentId.current !== projectId || currentScope.current !== scopeId;
  currentId.current = projectId;
  currentScope.current = scopeId;
  const repositoryRef = useRef(repository);
  repositoryRef.current = repository;
  const freshStatusScopeRef = useRef(freshStatusScope);
  freshStatusScopeRef.current = connectionChanged
    ? undefined
    : freshStatusScope;
  useEffect(() => {
    freshStatusScopeRef.current = undefined;
    setFreshStatusScope(undefined);
  }, [projectId, scopeId]);
  useEffect(
    () => () => {
      if (scopeId) cache.invalidatePending(scopeId, gitReadKeys.repository);
    },
    [cache, scopeId],
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const alive = useRef(true);
  const mutation = useRef(false);
  const closingGate = useRef(false);
  const reading = useRef(false);
  const comparisonFailed = useRef(false);
  const statusGeneration = useRef(0);
  const diffGeneration = useRef(0);
  const refreshRef = useRef<
    (
      locked?: boolean,
      force?: boolean,
      supersede?: boolean,
    ) => Promise<GitRepository | undefined>
  >(async () => undefined);
  const loadComparisonRef = useRef<(force?: boolean) => Promise<void>>(
    async () => {},
  );
  const onMutationRef = useRef(onMutation);
  onMutationRef.current = onMutation;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      statusGeneration.current++;
      diffGeneration.current++;
    };
  }, []);

  const updateDraft = useCallback(
    (patch: Partial<GitDraft>) => {
      if (!projectId) return;
      setDrafts((all) => ({
        ...all,
        [projectId]: { ...(all[projectId] ?? emptyDraft), ...patch },
      }));
      const selection = patch.selection;
      const currentSelection = draftRef.current.selection;
      if (
        currentId.current === projectId &&
        selection &&
        currentSelection &&
        comparisonFailed.current &&
        selection.path === currentSelection.path &&
        selection.side === currentSelection.side
      )
        void loadComparisonRef.current(false);
    },
    [projectId],
  );
  const clearCommittedMessage = useCallback(
    (expectedMessage: string) => {
      if (projectId)
        setDrafts((all) => {
          const current = all[projectId];
          if (!current || current.message !== expectedMessage) return all;
          return { ...all, [projectId]: { ...current, message: "" } };
        });
    },
    [projectId],
  );
  const report = useCallback(
    (reason: unknown) => {
      if (
        alive.current &&
        currentId.current === projectId &&
        currentScope.current === scopeId &&
        !suspendedRef.current &&
        scopeId
      ) {
        setErrors((all) => {
          const current = all[scopeId];
          const message = gitErrorMessage(reason);
          return {
            ...all,
            [scopeId]:
              current?.source === "mutation"
                ? { ...current, readError: message }
                : {
                    message,
                    uncertain: gitErrorUncertain(reason),
                    source: "read",
                  },
          };
        });
      }
    },
    [projectId, scopeId],
  );
  const refresh = useCallback(
    async (
      locked = false,
      force = false,
      supersede = false,
    ): Promise<GitRepository | undefined> => {
      if (
        !desktop ||
        !projectId ||
        !scopeId ||
        suspendedRef.current ||
        (!locked && mutation.current) ||
        (reading.current && !supersede)
      )
        return;
      const generation = ++statusGeneration.current;
      reading.current = true;
      setLoading(true);
      let startedAt: number | undefined;
      const load = () => {
        startedAt = Date.now();
        return api.readGitRepository(projectId);
      };
      try {
        const value = await readMutableGit(
          readCache,
          scopeId,
          gitReadKeys.repository,
          load,
          force,
        );
        if (
          !alive.current ||
          currentId.current !== projectId ||
          currentScope.current !== scopeId ||
          suspendedRef.current ||
          generation !== statusGeneration.current
        )
          return;
        setRepository((previous) =>
          previous?.scope === scopeId &&
          JSON.stringify(previous.value) === JSON.stringify(value)
            ? previous
            : { scope: scopeId, value },
        );
        freshStatusScopeRef.current = scopeId;
        setFreshStatusScope(scopeId);
        const branch = value.branch;
        if (startedAt !== undefined && branch)
          setBranchRead({ projectId, branch, startedAt });
        pauseAutoRefresh(scopeId, value.truncated);
        // A successful read does not erase a failed mutation, even after navigation.
        setErrors((all) => {
          const current = all[scopeId];
          if (!current) return all;
          if (current.source === "read") {
            const next = { ...all };
            delete next[scopeId];
            return next;
          }
          if (!current.readError) return all;
          return {
            ...all,
            [scopeId]: {
              message: current.message,
              uncertain: current.uncertain,
              source: current.source,
            },
          };
        });
        return value;
      } catch (reason) {
        if (generation === statusGeneration.current) {
          if (
            alive.current &&
            currentScope.current === scopeId &&
            gitErrorCode(gitErrorMessage(reason)) === "outputTooLarge"
          )
            pauseAutoRefresh(scopeId, true);
          report(reason);
        }
      } finally {
        if (generation === statusGeneration.current) {
          reading.current = false;
          if (alive.current) setLoading(false);
        }
      }
    },
    [desktop, pauseAutoRefresh, projectId, readCache, report, scopeId],
  );
  refreshRef.current = refresh;
  const requestRefresh = useCallback(
    async (locked = false) => {
      if (
        !desktop ||
        !projectId ||
        !scopeId ||
        suspendedRef.current ||
        (!locked && mutation.current)
      )
        return;
      cache.invalidateMutable(scopeId);
      const value = await refresh(locked, true, true);
      if (
        value &&
        alive.current &&
        currentId.current === projectId &&
        currentScope.current === scopeId
      )
        setRevision((current) => current + 1);
    },
    [cache, desktop, projectId, refresh, scopeId],
  );

  useEffect(() => {
    if (scopeId && initialRepository) {
      setRepository((current) =>
        current?.scope === scopeId
          ? current
          : { scope: scopeId, value: initialRepository },
      );
    }
  }, [initialRepository, scopeId]);

  useEffect(() => {
    const resumed = previousSuspended.current && !suspended;
    previousSuspended.current = suspended;
    statusGeneration.current++;
    diffGeneration.current++;
    reading.current = false;
    setLoading(false);
    setDiffLoading(false);
    if (suspended && scopeId) cache.invalidateMutable(scopeId);
    if (!desktop || !projectId || suspended) return;
    if (resumed) void refresh(false, true);
    if (!visible) {
      if (
        !resumed &&
        freshStatusScopeRef.current !== scopeId &&
        document.visibilityState !== "hidden"
      )
        void refresh();
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let initial = true;
    const poll = async () => {
      clearTimeout(timer);
      if (
        document.visibilityState !== "hidden" &&
        (initial || pausedScopeRef.current !== scopeId)
      )
        // A paused or truncated cached scope must be reread on reopen.
        await refresh(
          false,
          !initial ||
            pausedScopeRef.current === scopeId ||
            (!!scopeId &&
              cache.peek<GitRepository>(scopeId, gitReadKeys.repository)
                ?.truncated === true),
        );
      initial = false;
      if (!disposed) {
        clearTimeout(timer);
        timer = setTimeout(
          () => void poll(),
          environmentKind === "ssh" ? sshPollInterval : localPollInterval,
        );
      }
    };
    const wake = () => {
      initial = false;
      if (!disposed) void poll();
    };
    void poll();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(timer);
      statusGeneration.current++;
      reading.current = false;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [
    desktop,
    environmentKind,
    projectId,
    scopeId,
    visible,
    refresh,
    suspended,
    cache,
  ]);

  const loadComparison = useCallback(
    async (force = true) => {
      comparisonFailed.current = false;
      const generation = ++diffGeneration.current;
      if (
        !desktop ||
        !visible ||
        !projectId ||
        suspendedRef.current ||
        selectionPath === undefined ||
        selectionSide === undefined
      ) {
        setDiffLoading(false);
        return;
      }
      if (mutation.current) {
        setDiffLoading(false);
        return;
      }
      const comparisonScope = scopeId ?? projectId;
      const storedRepository = repositoryRef.current;
      const cachedRepository = cache.peek<GitRepository>(
        comparisonScope,
        gitReadKeys.repository,
      );
      const currentRepository =
        storedRepository?.scope === comparisonScope
          ? storedRepository.value
          : cachedRepository;
      const version = currentRepository?.version ?? null;
      const key = gitReadKeys.comparison(selectionPath, selectionSide, version);
      const cached = cache.peek<GitComparison>(comparisonScope, key);
      if (!force && cached?.path === selectionPath) {
        setComparison({
          project: projectId,
          scope: comparisonScope,
          value: cached,
          side: selectionSide,
        });
        setDiffLoading(false);
        return;
      }
      setDiffLoading(true);
      try {
        const value = await cache.read(
          comparisonScope,
          key,
          () =>
            api.readGitComparison(
              projectId,
              selectionPath,
              selectionSide,
              version ?? undefined,
            ),
          { force },
        );
        if (
          alive.current &&
          currentId.current === projectId &&
          currentScope.current === scopeId &&
          !suspendedRef.current &&
          generation === diffGeneration.current
        )
          setComparison({
            project: projectId,
            scope: comparisonScope,
            value,
            side: selectionSide,
          });
      } catch (reason) {
        if (!suspendedRef.current && generation === diffGeneration.current) {
          const stalePath =
            !!reason &&
            typeof reason === "object" &&
            "code" in reason &&
            reason.code === "stalePath";
          comparisonFailed.current = true;
          if (stalePath) {
            const prefix = gitReadKeys.comparisonPrefix(
              selectionPath,
              selectionSide,
            );
            cache.invalidate(comparisonScope, (cacheKey) =>
              cacheKey.startsWith(prefix),
            );
            setComparison(null);
            // The file left the changes: a newer status, not an error, reconciles the selection.
            void refreshRef.current(false, true);
          } else {
            setComparison((current) =>
              current?.project !== projectId ||
              current.scope !== comparisonScope ||
              current.value.path !== selectionPath ||
              current.side !== selectionSide
                ? null
                : current,
            );
            report(reason);
          }
        }
      } finally {
        if (alive.current && generation === diffGeneration.current)
          setDiffLoading(false);
      }
    },
    [
      desktop,
      visible,
      projectId,
      cache,
      scopeId,
      selectionPath,
      selectionSide,
      report,
    ],
  );
  loadComparisonRef.current = loadComparison;
  const comparisonRepositoryVersion =
    repository && repository.scope === scopeId
      ? repository.value.version
      : scopeId
        ? cache.peek<GitRepository>(scopeId, gitReadKeys.repository)?.version
        : undefined;
  useEffect(() => {
    void loadComparison(false);
    return () => {
      diffGeneration.current++;
      if (scopeId && selectionPath !== undefined && selectionSide !== undefined)
        cache.invalidatePending(
          scopeId,
          gitReadKeys.comparison(
            selectionPath,
            selectionSide,
            comparisonRepositoryVersion ?? null,
          ),
        );
    };
  }, [
    busy,
    cache,
    comparisonRepositoryVersion,
    loadComparison,
    scopeId,
    selectionPath,
    selectionSide,
  ]);
  const requestComparison = useCallback(async () => {
    await loadComparison(true);
  }, [loadComparison]);

  const mutate = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      if (
        !desktop ||
        !projectId ||
        suspendedRef.current ||
        mutation.current ||
        closingGate.current
      )
        return;
      if (!scopeId) return;
      const origin =
        repositoryRef.current?.scope === scopeId
          ? repositoryRef.current.value
          : cache.peek<GitRepository>(scopeId, gitReadKeys.repository);
      cache.invalidateMutable(scopeId);
      mutation.current = true;
      statusGeneration.current++;
      diffGeneration.current++;
      reading.current = false;
      setBusy(true);
      setLoading(false);
      setDiffLoading(false);
      setErrors((all) => {
        const next = { ...all };
        delete next[scopeId];
        return next;
      });
      let succeeded = false;
      try {
        const result = await work();
        succeeded = true;
        return result;
      } catch (reason) {
        if (alive.current)
          setErrors((all) => ({
            ...all,
            [scopeId]: {
              message: gitErrorMessage(reason),
              uncertain: gitErrorUncertain(reason),
              source: "mutation",
            },
          }));
        return undefined;
      } finally {
        cache.invalidateMutable(scopeId);
        const refreshed = alive.current
          ? await refreshRef.current(true, true, true)
          : undefined;
        if (succeeded && alive.current) {
          setRevision((value) => value + 1);
          if (
            !origin ||
            currentId.current !== projectId ||
            !refreshed ||
            origin.branch !== refreshed.branch ||
            (!origin.branch &&
              !refreshed.branch &&
              origin.head !== refreshed.head)
          )
            onMutationRef.current?.(
              projectId,
              currentId.current === projectId ? refreshed?.branch : undefined,
            );
        }
        mutation.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [cache, desktop, projectId, scopeId],
  );
  const hasPendingMutation = useCallback(() => mutation.current, []);
  const prepareClose = useCallback(() => {
    if (mutation.current) return false;
    closingGate.current = true;
    return true;
  }, []);
  const cancelClose = useCallback(() => {
    closingGate.current = false;
  }, []);
  const isBusy = useCallback(() => mutation.current || closingGate.current, []);
  const cachedRepository = scopeId
    ? cache.peek<GitRepository>(scopeId, gitReadKeys.repository)
    : undefined;
  const repo =
    repository && repository.scope === scopeId
      ? repository.value
      : (cachedRepository ?? (scopeId ? initialRepository : undefined) ?? null);
  const comparisonScope = scopeId ?? projectId;
  const cached =
    comparisonScope &&
    selectionPath !== undefined &&
    selectionSide !== undefined
      ? cache.peekLatest<GitComparison>(
          comparisonScope,
          gitReadKeys.comparisonPrefix(selectionPath, selectionSide),
        )
      : undefined;
  const selectedComparison =
    comparison &&
    comparison.project === projectId &&
    comparison.scope === comparisonScope &&
    comparison.value.path === selectionPath &&
    comparison.side === selectionSide
      ? comparison.value
      : null;
  const diff =
    selectedComparison ??
    (cached && cached.path === selectionPath ? cached : null);
  const error = scopeId ? (errors[scopeId] ?? null) : null;
  const autoRefreshPaused = !!scopeId && pausedScope === scopeId;
  // A paused scope without snapshot waits for an explicit refresh instead of spinning.
  const repositoryLoading =
    loading ||
    (desktop &&
      visible &&
      !!projectId &&
      !suspended &&
      !repo &&
      !error &&
      !autoRefreshPaused);
  return {
    desktop,
    draft,
    updateDraft,
    clearCommittedMessage,
    repo,
    hasFreshStatus:
      !connectionChanged && !!scopeId && freshStatusScope === scopeId,
    branchRead,
    autoRefreshPaused,
    diff,
    stale: !!diff && diff.version !== repo?.version,
    error,
    revalidating: loading && !!repo,
    dismissError: () => {
      if (scopeId)
        setErrors((all) => {
          const current = all[scopeId];
          if (current?.source === "mutation" && current.readError) {
            return {
              ...all,
              [scopeId]: {
                message: current.readError,
                uncertain: false,
                source: "read",
              },
            };
          }
          const next = { ...all };
          delete next[scopeId];
          return next;
        });
    },
    loading: repositoryLoading,
    diffLoading,
    busy,
    isBusy,
    hasPendingMutation,
    prepareClose,
    cancelClose,
    mutate,
    refresh: requestRefresh,
    loadComparison: requestComparison,
    revision,
  };
}
