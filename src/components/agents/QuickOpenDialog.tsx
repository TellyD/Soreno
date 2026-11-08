import { LoaderCircle, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as api from "../../data/projectFilesApi";
import { interleaveMentionPaths } from "../../domain/agentConversationMentions";
import { listNavigation } from "../../domain/keyboard";
import {
  mergeProjectFileSearches,
  projectFileError,
  projectFileName,
  projectFileParent,
  projectSearchHit,
  type ProjectFileSearchHit,
  type ProjectFileSearchHits,
  type ProjectSearchRoot,
} from "../../domain/projectFiles";
import { readRecentProjectFiles } from "../../domain/recentProjectFiles";
import { useNotification } from "../../notifications";
import { FileIcon } from "../FileIcon";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";
import "./QuickOpenDialog.css";

const INITIAL_SEARCH_DELAY = 120;
const WARM_SEARCH_DELAY = 35;

type RequestScope = {
  roots: readonly ProjectSearchRoot[];
  active: boolean;
};

export function QuickOpenDialog({
  roots,
  onClose,
  onSelect,
}: {
  roots: readonly ProjectSearchRoot[];
  onClose: () => void;
  onSelect: (projectId: string, path: string) => void;
}) {
  const s = useGitStrings();
  const agentStrings = useAgentStrings();
  const listId = useId();
  // Callers rebuild the list on each render: key the searches on its content.
  const rootsKey = JSON.stringify(roots);
  const searchRoots = useMemo(
    () => JSON.parse(rootsKey) as ProjectSearchRoot[],
    [rootsKey],
  );
  const [query, setQuery] = useState("");
  const [resultState, setResultState] = useState<{
    roots: readonly ProjectSearchRoot[];
    value: ProjectFileSearchHits;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<{
    roots: readonly ProjectSearchRoot[];
    error: ReturnType<typeof projectFileError>;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const generation = useRef(0);
  const refresh = useRef(true);
  const refreshInFlight = useRef(false);
  const prewarmTimer = useRef<number | null>(null);
  const startRefreshImmediately = useRef(false);
  const requestScope = useRef<RequestScope>({
    roots: searchRoots,
    active: true,
  });
  const selectionLocked = useRef(false);
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, onClose);
  const normalizedQuery = query.trim();
  const latestQuery = useRef(normalizedQuery);
  latestQuery.current = normalizedQuery;
  const result = resultState?.roots === searchRoots ? resultState.value : null;
  const error = errorState?.roots === searchRoots ? errorState.error : null;
  useNotification(
    error
      ? {
          message: formatOperationError(agentStrings, {
            message: error.message,
            fileCode: error.code,
          }),
          key: `quick-open:${rootsKey}`,
        }
      : null,
  );

  useLayoutEffect(() => {
    requestScope.current.active = false;
    const scope = { roots: searchRoots, active: true };
    requestScope.current = scope;
    refresh.current = true;
    refreshInFlight.current = false;
    startRefreshImmediately.current = false;
    generation.current += 1;
    setResultState(null);
    setLoading(false);
    setErrorState(null);
    setActiveIndex(0);

    return () => {
      scope.active = false;
    };
  }, [searchRoots]);

  function search(
    requestQuery: string,
    requestGeneration: number,
    shouldRefresh: boolean,
    scope: RequestScope,
  ) {
    void Promise.resolve()
      .then(() =>
        Promise.allSettled(
          scope.roots.map((root) =>
            api.searchProjectFiles(
              root.projectId,
              requestQuery,
              shouldRefresh,
              readRecentProjectFiles(root.projectId),
            ),
          ),
        ),
      )
      .then((settled) => mergeProjectFileSearches(scope.roots, settled))
      .then((value) => {
        if (!scope.active || requestScope.current !== scope) return;

        if (!shouldRefresh) {
          if (
            requestGeneration === generation.current &&
            requestQuery === latestQuery.current
          ) {
            setResultState({ roots: scope.roots, value });
            setLoading(false);
          }
          return;
        }

        // shortcut: a member whose refresh failed while others succeeded keeps its older cached inventory until reopening; track refresh per root if it bites.
        refresh.current = false;
        refreshInFlight.current = false;
        const currentQuery = latestQuery.current;
        if (!currentQuery) return;
        if (currentQuery === requestQuery) {
          setResultState({ roots: scope.roots, value });
          setLoading(false);
          return;
        }

        search(currentQuery, generation.current, false, scope);
      })
      .catch((reason) => {
        if (!scope.active || requestScope.current !== scope) return;

        if (shouldRefresh) {
          refreshInFlight.current = false;
          if (latestQuery.current) {
            setErrorState({
              roots: scope.roots,
              error: projectFileError(reason),
            });
            setLoading(false);
          }
        } else if (
          requestGeneration === generation.current &&
          requestQuery === latestQuery.current
        ) {
          setErrorState({
            roots: scope.roots,
            error: projectFileError(reason),
          });
          setLoading(false);
        }
      });
  }

  useEffect(() => {
    const scope = requestScope.current;
    const timeout = window.setTimeout(() => {
      if (prewarmTimer.current === timeout) prewarmTimer.current = null;
      if (
        !scope.active ||
        requestScope.current !== scope ||
        refreshInFlight.current ||
        !refresh.current
      ) {
        return;
      }
      refreshInFlight.current = true;
      search("", generation.current, true, scope);
    }, 0);
    prewarmTimer.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (prewarmTimer.current === timeout) prewarmTimer.current = null;
    };
  }, [searchRoots]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setActiveIndex(0);
    setErrorState(null);
    if (!normalizedQuery) {
      setResultState(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    if (refreshInFlight.current) return;

    if (refresh.current && prewarmTimer.current !== null) {
      window.clearTimeout(prewarmTimer.current);
      prewarmTimer.current = null;
      startRefreshImmediately.current = true;
    }
    const delay = refresh.current
      ? startRefreshImmediately.current
        ? 0
        : INITIAL_SEARCH_DELAY
      : WARM_SEARCH_DELAY;
    const scope = requestScope.current;
    const timeout = window.setTimeout(() => {
      if (!scope.active || requestScope.current !== scope) return;
      const shouldRefresh = refresh.current;
      if (shouldRefresh) {
        refreshInFlight.current = true;
        startRefreshImmediately.current = false;
      }
      search(normalizedQuery, currentGeneration, shouldRefresh, scope);
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [normalizedQuery, searchRoots]);

  const recentEntries = useMemo(
    () =>
      interleaveMentionPaths(
        searchRoots.map((root) =>
          readRecentProjectFiles(root.projectId).map((path) =>
            projectSearchHit(root, {
              name: projectFileName(path),
              path,
              kind: "file" as const,
              editable: true,
            }),
          ),
        ),
        Infinity,
      ),
    [searchRoots],
  );
  const entries = normalizedQuery ? (result?.entries ?? []) : recentEntries;
  const recentCount = normalizedQuery
    ? (result?.recentCount ?? 0)
    : recentEntries.length;
  const pending = Boolean(normalizedQuery) && loading && !result;
  const listVisible = !error && !pending && entries.length > 0;
  selectionLocked.current = loading || Boolean(error);
  const activeEntry = selectionLocked.current
    ? undefined
    : entries[activeIndex];

  useEffect(() => {
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, entries.length, listId]);

  function choose(entry: ProjectFileSearchHit | undefined) {
    if (!entry || selectionLocked.current) return;
    onClose();
    onSelect(entry.projectId, entry.projectPath);
  }

  return (
    <DialogOverlay className="quick-open-overlay">
      <DialogSurface
        aria-label={s.quickOpenTitle}
        className="quick-open-dialog"
        ref={surfaceRef}
      >
        <Input
          autoComplete="off"
          aria-activedescendant={
            activeEntry ? `${listId}-option-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={listVisible ? listId : undefined}
          aria-expanded={listVisible}
          autoFocus
          className="quick-open-input"
          placeholder={s.searchFiles}
          role="combobox"
          endIcon={
            loading ? (
              <LoaderCircle
                className="app-loading-spinner"
                aria-hidden="true"
              />
            ) : undefined
          }
          spellCheck={false}
          startIcon={<Search aria-hidden="true" />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              event.stopPropagation();
              return;
            }
            const move = selectionLocked.current
              ? null
              : listNavigation(event.key, entries.length);
            if (move) {
              event.preventDefault();
              setActiveIndex(move);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(activeEntry);
            }
          }}
        />
        <div className="quick-open-results">
          {error ? null : pending ? (
            <p className="quick-open-status" role="status">
              <LoaderCircle
                className="app-loading-spinner"
                size={14}
                aria-hidden="true"
              />
              {s.loadingFiles}
            </p>
          ) : entries.length === 0 ? (
            <p className="quick-open-status">
              {normalizedQuery ? s.noSearchResults : s.quickOpenHint}
            </p>
          ) : (
            <ul id={listId} className="quick-open-list" role="listbox">
              {entries.map((entry, index) => {
                const parent = projectFileParent(entry.path);
                return (
                  <li
                    aria-disabled={loading || undefined}
                    aria-selected={loading ? undefined : index === activeIndex}
                    className="quick-open-option"
                    id={`${listId}-option-${index}`}
                    key={`${entry.projectId}:${entry.path}`}
                    role="option"
                    onClick={() => choose(entry)}
                    onMouseEnter={() => {
                      if (!selectionLocked.current) setActiveIndex(index);
                    }}
                  >
                    <FileIcon name={entry.name} size={14} />
                    <strong>{entry.name}</strong>
                    {parent ? <span>{parent}</span> : null}
                    {index < recentCount ? (
                      <span className="quick-open-recent">
                        {s.recentlyOpened}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {result?.truncated ? (
            <p className="quick-open-limit" role="status">
              {s.searchTruncated}
            </p>
          ) : null}
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
}
