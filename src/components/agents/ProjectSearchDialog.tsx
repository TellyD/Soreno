import {
  CaseSensitive,
  LoaderCircle,
  Regex,
  Search,
  WholeWord,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "../../data/projectFilesApi";
import { listNavigation } from "../../domain/keyboard";
import {
  mergeProjectTextSearches,
  projectFileError,
  projectFileName,
  projectFileParent,
  type ProjectFileError,
  type ProjectSearchRoot,
  type ProjectTextSearchHit,
  type ProjectTextSearchLine,
  type ProjectTextSearchOptions,
  type ProjectTextSearchHits,
} from "../../domain/projectFiles";
import { useNotification } from "../../notifications";
import { FileIcon } from "../FileIcon";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";
import "./ProjectSearchDialog.css";

const SEARCH_DELAY = 150;

export type ProjectSearchState = {
  query: string;
  options: ProjectTextSearchOptions;
};

type ProjectSearchSelection = {
  projectId: string;
  path: string;
  line: number;
  start: number;
  end: number;
};

type RequestScope = {
  roots: readonly ProjectSearchRoot[];
  active: boolean;
};

type SearchOption = {
  file: ProjectTextSearchHit;
  line: ProjectTextSearchLine;
};

const optionShortcuts: Record<string, keyof ProjectTextSearchOptions> = {
  KeyC: "caseSensitive",
  KeyW: "wholeWord",
  KeyR: "regex",
};

function highlight(preview: string, ranges: [number, number][]) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [rangeStart, rangeEnd] of ranges) {
    const start = Math.max(cursor, Math.min(rangeStart, preview.length));
    const end = Math.min(rangeEnd, preview.length);
    if (end <= start) continue;
    if (start > cursor) parts.push(preview.slice(cursor, start));
    parts.push(<mark key={start}>{preview.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < preview.length) parts.push(preview.slice(cursor));
  return parts;
}

export function ProjectSearchDialog({
  roots,
  initialQuery,
  initialOptions,
  onClose,
  onSelect,
  onStateChange,
}: {
  roots: readonly ProjectSearchRoot[];
  initialQuery: string;
  initialOptions: ProjectTextSearchOptions;
  onClose: () => void;
  onSelect: (selection: ProjectSearchSelection) => void;
  onStateChange: (state: ProjectSearchState) => void;
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
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState(initialOptions);
  const [resultState, setResultState] = useState<{
    roots: readonly ProjectSearchRoot[];
    value: ProjectTextSearchHits;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<{
    roots: readonly ProjectSearchRoot[];
    error: ProjectFileError;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const generation = useRef(0);
  const refresh = useRef(true);
  const requestScope = useRef<RequestScope>({
    roots: searchRoots,
    active: true,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, onClose);
  const result = resultState?.roots === searchRoots ? resultState.value : null;
  const error = errorState?.roots === searchRoots ? errorState.error : null;
  const invalidQuery = error?.code === "invalidQuery";
  useNotification(
    error && !invalidQuery
      ? {
          message: formatOperationError(agentStrings, {
            message: error.message,
            fileCode: error.code,
          }),
          key: `project-search:${rootsKey}`,
        }
      : null,
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    onStateChange({ query, options });
  }, [query, options, onStateChange]);

  useLayoutEffect(() => {
    requestScope.current.active = false;
    const scope = { roots: searchRoots, active: true };
    requestScope.current = scope;
    refresh.current = true;
    generation.current += 1;
    setResultState(null);
    setLoading(false);
    setErrorState(null);
    setActiveIndex(0);

    return () => {
      scope.active = false;
    };
  }, [searchRoots]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setActiveIndex(0);
    setErrorState(null);
    if (!query) {
      setResultState(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const scope = requestScope.current;
    const timeout = window.setTimeout(() => {
      if (!scope.active || requestScope.current !== scope) return;
      const shouldRefresh = refresh.current;
      refresh.current = false;
      void Promise.allSettled(
        scope.roots.map((root) =>
          api.searchProjectText(root.projectId, query, options, shouldRefresh),
        ),
      )
        .then((settled) => mergeProjectTextSearches(scope.roots, settled))
        .then((value) => {
          if (
            !scope.active ||
            requestScope.current !== scope ||
            currentGeneration !== generation.current
          ) {
            return;
          }
          setResultState({ roots: scope.roots, value });
          setLoading(false);
        })
        .catch((reason) => {
          if (
            !scope.active ||
            requestScope.current !== scope ||
            currentGeneration !== generation.current
          ) {
            return;
          }
          setErrorState({
            roots: scope.roots,
            error: projectFileError(reason),
          });
          setLoading(false);
        });
    }, SEARCH_DELAY);
    return () => window.clearTimeout(timeout);
  }, [query, options, searchRoots]);

  const files = result?.files ?? [];
  const entries: SearchOption[] = files.flatMap((file) =>
    file.lines.map((line) => ({ file, line })),
  );
  const listVisible = Boolean(query) && !error && entries.length > 0;
  const selectionLocked = loading || Boolean(error);
  const activeEntry = selectionLocked ? undefined : entries[activeIndex];

  useEffect(() => {
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, entries.length, listId]);

  function choose(entry: SearchOption | undefined) {
    if (!entry || selectionLocked) return;
    onClose();
    onSelect({
      projectId: entry.file.projectId,
      path: entry.file.projectPath,
      line: entry.line.line,
      start: entry.line.selection?.[0] ?? 0,
      end: entry.line.selection?.[1] ?? 0,
    });
  }

  const toggles: [keyof ProjectTextSearchOptions, string, ReactNode][] = [
    [
      "caseSensitive",
      s.projectSearchCaseSensitive,
      <CaseSensitive aria-hidden="true" />,
    ],
    ["wholeWord", s.projectSearchWholeWord, <WholeWord aria-hidden="true" />],
    ["regex", s.projectSearchRegex, <Regex aria-hidden="true" />],
  ];

  let optionIndex = 0;

  return (
    <DialogOverlay className="project-search-overlay">
      <DialogSurface
        aria-label={s.projectSearchTitle}
        className="project-search-dialog"
        ref={surfaceRef}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "f"
          ) {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }
        }}
      >
        <div className="project-search-bar">
          <Input
            autoComplete="off"
            aria-activedescendant={
              activeEntry ? `${listId}-option-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
            aria-controls={listVisible ? listId : undefined}
            aria-expanded={listVisible}
            autoFocus
            className="project-search-input"
            placeholder={s.projectSearchPlaceholder}
            ref={inputRef}
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
              const shortcut = optionShortcuts[event.nativeEvent.code];
              const move = selectionLocked
                ? null
                : listNavigation(event.key, entries.length);
              if (
                shortcut &&
                event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                setOptions((value) => ({
                  ...value,
                  [shortcut]: !value[shortcut],
                }));
              } else if (move) {
                event.preventDefault();
                setActiveIndex(move);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(activeEntry);
              }
            }}
          />
          {toggles.map(([option, label, icon]) => (
            <IconButton
              aria-label={label}
              aria-pressed={options[option]}
              key={option}
              selected={options[option]}
              size="small"
              title={label}
              onClick={() =>
                setOptions((value) => ({ ...value, [option]: !value[option] }))
              }
              onMouseDown={(event) => event.preventDefault()}
            >
              {icon}
            </IconButton>
          ))}
        </div>
        {query && result && !error && entries.length > 0 ? (
          <p className="project-search-summary" role="status">
            <span>
              {s.projectSearchSummary(result.lineCount, files.length)}
            </span>
            {result.truncated ? <span>{s.projectSearchTruncated}</span> : null}
          </p>
        ) : null}
        <div className="project-search-results">
          {invalidQuery ? (
            <p className="project-search-status" role="status">
              {s.projectSearchInvalidRegex}
            </p>
          ) : error ? null : loading && !result ? (
            <p className="project-search-status" role="status">
              <LoaderCircle
                className="app-loading-spinner"
                size={14}
                aria-hidden="true"
              />
              {s.projectSearchLoading}
            </p>
          ) : !query ? (
            <p className="project-search-status">{s.projectSearchHint}</p>
          ) : entries.length === 0 ? (
            <p className="project-search-status">{s.projectSearchNoResults}</p>
          ) : (
            <div
              aria-label={s.projectSearchTitle}
              className="project-search-list"
              id={listId}
              role="listbox"
            >
              {files.map((file) => {
                const parent = projectFileParent(file.path);
                return (
                  <div
                    aria-label={file.path}
                    key={`${file.projectId}:${file.path}`}
                    role="group"
                  >
                    <div className="project-search-file" role="presentation">
                      <FileIcon name={projectFileName(file.path)} size={14} />
                      <strong>{projectFileName(file.path)}</strong>
                      {parent ? <span>{parent}</span> : null}
                      <span className="project-search-file-count">
                        {s.projectSearchLineCount(file.lines.length)}
                      </span>
                    </div>
                    {file.lines.map((line) => {
                      const index = optionIndex++;
                      const entry = entries[index];
                      return (
                        <div
                          aria-disabled={loading || undefined}
                          aria-selected={
                            loading ? undefined : index === activeIndex
                          }
                          className="project-search-option"
                          id={`${listId}-option-${index}`}
                          key={`${line.line}:${index}`}
                          role="option"
                          onClick={() => choose(entry)}
                          onMouseEnter={() => {
                            if (!selectionLocked) setActiveIndex(index);
                          }}
                        >
                          <span className="project-search-line-number">
                            {line.line}
                          </span>
                          <span className="project-search-preview">
                            {highlight(line.preview, line.ranges)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
}
