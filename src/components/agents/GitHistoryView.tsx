import {
  History as HistoryIcon,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as api from "../../data/projectGitApi";
import {
  gitReadKeys,
  readMutableGit,
  type GitReadCache,
} from "../../data/gitReadCache";
import {
  buildGitGraphRows,
  gitReferenceBadges,
  parseGitPanelRatio,
  type GitCommitDetail,
  type GitComparison,
  type GitGraphLine,
  type GitGraphRow,
  type GitHistory,
} from "../../domain/projectGit";
import { projectFileName, projectFileParent } from "../../domain/projectFiles";
import { useNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { LoadingState } from "../ui/LoadingState";
import { GitFileStats } from "./GitChangeList";
import { useGitStrings } from "./gitStrings";
import { GitFileContextMenu, type GitFileMenu } from "./ProjectPathMenu";
import { RailResizer } from "./RailResizer";
import "./GitArchiveViews.css";

import GitDiffView from "./GitDiffView";
const historyPageSize = 50;
const historyRailStorageKey = "soreno:git-history-rail-ratio";
const historyRailDefault = 30;
const historyRailMin = 15;
const historyRailMax = 85;

function graphPath(
  line: GitGraphLine,
  x: (lane: number) => number,
  fromY: number,
  toY: number,
) {
  const middle = (fromY + toY) / 2;
  return `M ${x(line.from)} ${fromY} C ${x(line.from)} ${middle}, ${x(line.to)} ${middle}, ${x(line.to)} ${toY}`;
}

function graphThroughPath(
  line: GitGraphLine,
  x: (lane: number) => number,
  height: number,
) {
  const middle = height / 2;
  const bend = (middle + height) / 2;
  return `M ${x(line.from)} 0 L ${x(line.from)} ${middle} C ${x(line.from)} ${bend}, ${x(line.to)} ${bend}, ${x(line.to)} ${height}`;
}

function GitCommitGraph({
  height,
  lanes,
  row,
  width,
}: {
  height: number;
  lanes: number;
  row: GitGraphRow;
  width: number;
}) {
  const middle = height / 2;
  const laneSpacing = lanes === 1 ? width : (width - 8) / (lanes - 1);
  const scale = Math.min(1, laneSpacing / 6.5);
  const nodeRadius = 3.25 * scale;
  const lineWidth = 1.5 * scale;
  const x = (lane: number) =>
    lanes === 1 ? width / 2 : 4 + lane * laneSpacing;
  const colorClass = (color: number) => `git-history-graph-color-${color % 6}`;
  return (
    <svg
      className="git-history-graph"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      data-node-lane={row.nodeLane}
    >
      {row.through.map((line, index) => (
        <path
          className={`git-history-graph-line is-through ${colorClass(line.color)}`}
          d={graphThroughPath(line, x, height)}
          data-from={line.from}
          data-to={line.to}
          key={`through:${index}`}
          strokeWidth={lineWidth}
        />
      ))}
      {row.incoming ? (
        <path
          className={`git-history-graph-line is-incoming ${colorClass(row.incoming.color)}`}
          d={graphPath(row.incoming, x, 0, middle)}
          data-from={row.incoming.from}
          data-to={row.incoming.to}
          strokeWidth={lineWidth}
        />
      ) : null}
      {row.outgoing.map((line, index) => (
        <path
          className={`git-history-graph-line is-outgoing ${colorClass(line.color)}`}
          d={graphPath(line, x, middle, height)}
          data-from={line.from}
          data-to={line.to}
          key={`outgoing:${index}`}
          strokeWidth={lineWidth}
        />
      ))}
      <circle
        className={`git-history-graph-node ${colorClass(row.nodeColor)}`}
        cx={x(row.nodeLane)}
        cy={middle}
        r={nodeRadius}
      />
    </svg>
  );
}

function readHistoryRailRatio() {
  try {
    return parseGitPanelRatio(
      localStorage.getItem(historyRailStorageKey),
      historyRailDefault,
      historyRailMin,
      historyRailMax,
    );
  } catch {
    return historyRailDefault;
  }
}

type HistoryReadOperation =
  | {
      kind: "refresh";
      scope: string;
      head: string | null;
      roots: string[] | null;
      offset: number;
    }
  | { kind: "loadMore"; scope: string; roots: string[]; offset: number }
  | { kind: "detail"; scope: string; oid: string }
  | { kind: "diff"; scope: string; oid: string; path: string };
type HistoryReadError = { operation: HistoryReadOperation };

function sameOperation(
  left: HistoryReadOperation,
  right: HistoryReadOperation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type GitHistoryViewProps = {
  active: boolean;
  head?: string | null;
  projectId: string;
  /** Project-relative path limiting the history (`git log -- path`). */
  path?: string | null;
  /** The same path relative to the Git root, preselected in commit files. */
  gitPath?: string | null;
  requestedOid?: string | null;
  requestToken?: object;
  revision: number;
  readCache?: GitReadCache;
  readScope?: string;
  onClearPath?: () => void;
  /** One-shot request to focus the clear-filter button. */
  filterFocusRequest?: object | null;
  onFilterFocusHandled?: () => void;
  fileMenu?: GitFileMenu;
};

export function GitHistoryView({
  active,
  head = null,
  projectId,
  path = null,
  gitPath = null,
  requestedOid,
  requestToken,
  revision,
  readCache,
  readScope,
  onClearPath,
  filterFocusRequest = null,
  onFilterFocusHandled,
  fileMenu,
}: GitHistoryViewProps) {
  const s = useGitStrings();
  const scope = readScope ?? projectId;
  // Pages of a filtered history must never be mistaken for the full one.
  const listScope = path === null ? scope : JSON.stringify([scope, path]);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const diffGeneration = useRef(0);
  const detailRequest = useRef<{
    scope: string;
    oid: string;
    revision: number;
    promise: Promise<boolean>;
  } | null>(null);
  const consumedRequests = useRef(new Map<string, object | string>());
  const [history, setHistory] = useState<{
    scope: string;
    value: GitHistory;
  } | null>(null);
  const [selection, setSelection] = useState<{
    scope: string;
    oid: string;
    path: string | null;
  } | null>(null);
  const [detail, setDetail] = useState<{
    scope: string;
    oid: string;
    value: GitCommitDetail;
  } | null>(null);
  const [comparison, setComparison] = useState<{
    scope: string;
    oid: string;
    path: string;
    value: GitComparison;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setDetailLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<HistoryReadError | null>(null);
  const [railRatio, setRailRatio] = useState(readHistoryRailRatio);
  const detailId = useId();
  const mainRef = useRef<HTMLDivElement>(null);

  const cachedPage = readCache?.peek<GitHistory>(
    scope,
    gitReadKeys.history(head, 0, path),
  );
  const commitSelection = selection?.scope === scope ? selection : null;
  const page =
    history?.scope === listScope ? history.value : (cachedPage ?? null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const graphRows = useMemo(
    () => buildGitGraphRows(page?.commits ?? []),
    [page?.commits],
  );
  const graphLaneCount = Math.max(1, ...graphRows.map((row) => row.laneCount));
  const graphWidth = Math.min(72, Math.max(28, graphLaneCount * 12 + 8));
  const cachedDetail = commitSelection?.oid
    ? readCache?.peek<GitCommitDetail>(
        scope,
        gitReadKeys.commitDetail(commitSelection.oid),
      )
    : undefined;
  const selectedDetail =
    detail?.scope === scope && detail.oid === commitSelection?.oid
      ? detail.value
      : (cachedDetail ?? null);
  const selected = commitSelection
    ? {
        ...commitSelection,
        path:
          commitSelection.path ??
          (gitPath === null
            ? undefined
            : selectedDetail?.files.find((file) =>
                [file.path, file.oldPath].some(
                  (candidate) =>
                    candidate === gitPath ||
                    candidate?.startsWith(`${gitPath}/`),
                ),
              )?.path) ??
          selectedDetail?.files[0]?.path ??
          null,
      }
    : null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedCommit = page?.commits.find(
    (commit) => commit.oid === selected?.oid,
  );
  const cachedComparison =
    selected?.oid && selected.path
      ? readCache?.peek<GitComparison>(
          scope,
          gitReadKeys.commitComparison(selected.oid, selected.path),
        )
      : undefined;
  const selectedComparison =
    comparison?.scope === scope &&
    comparison.oid === selected?.oid &&
    comparison.path === selected?.path
      ? comparison.value
      : (cachedComparison ?? null);
  useEffect(() => {
    try {
      localStorage.setItem(historyRailStorageKey, String(railRatio));
    } catch {
      /* Optional preference. */
    }
  }, [railRatio]);

  const relevantError =
    error &&
    error.operation.scope ===
      (error.operation.kind === "refresh" || error.operation.kind === "loadMore"
        ? listScope
        : scope) &&
    ((error.operation.kind === "refresh" && error.operation.head === head) ||
      (error.operation.kind === "loadMore" &&
        JSON.stringify(page?.roots) === JSON.stringify(error.operation.roots) &&
        page?.commits.length === error.operation.offset) ||
      (error.operation.kind === "detail" &&
        selected?.oid === error.operation.oid) ||
      (error.operation.kind === "diff" &&
        selected?.oid === error.operation.oid &&
        selected.path === error.operation.path))
      ? error
      : null;

  const readDetail = useCallback(
    async (oid: string, force = false) => {
      if (!active) return false;
      const operation: HistoryReadOperation = { kind: "detail", scope, oid };
      const request = ++detailGeneration.current;
      setDetailLoading(true);
      setError((current) =>
        current && sameOperation(current.operation, operation) ? null : current,
      );
      try {
        const value = await readMutableGit(
          readCache,
          scope,
          gitReadKeys.commitDetail(oid),
          () => api.readGitCommitDetail(projectId, oid),
          force,
        );
        if (request === detailGeneration.current)
          setDetail({ scope, oid, value });
        return request === detailGeneration.current;
      } catch {
        if (request === detailGeneration.current) setError({ operation });
        return false;
      } finally {
        if (request === detailGeneration.current) setDetailLoading(false);
      }
    },
    [active, projectId, readCache, scope],
  );
  const loadDetail = useCallback(
    (oid: string, force = false) => {
      const promise = readDetail(oid, force);
      detailRequest.current = { scope, oid, revision, promise };
      return promise;
    },
    [readDetail, revision, scope],
  );

  const loadDiff = useCallback(
    async (oid: string, path: string, force = false) => {
      if (!active) return;
      const operation: HistoryReadOperation = {
        kind: "diff",
        scope,
        oid,
        path,
      };
      const request = ++diffGeneration.current;
      setDiffLoading(true);
      setError((current) =>
        current && sameOperation(current.operation, operation) ? null : current,
      );
      try {
        const value = await readMutableGit(
          readCache,
          scope,
          gitReadKeys.commitComparison(oid, path),
          () => api.readGitCommitComparison(projectId, oid, path),
          force,
        );
        if (request === diffGeneration.current)
          setComparison({ scope, oid, path, value });
      } catch {
        if (request === diffGeneration.current) setError({ operation });
      } finally {
        if (request === diffGeneration.current) setDiffLoading(false);
      }
    },
    [active, projectId, readCache, scope],
  );

  const readPage = useCallback(
    (
      roots: string[] | null,
      offset: number,
      force: boolean,
      cacheSnapshot: string | string[] | null = roots,
    ) =>
      readMutableGit(
        readCache,
        scope,
        gitReadKeys.history(cacheSnapshot, offset, path),
        () => api.readGitHistory(projectId, roots, offset, path),
        force,
      ),
    [path, projectId, readCache, scope],
  );

  const refresh = useCallback(
    async (force = false) => {
      if (!active) return;
      if (force)
        readCache?.invalidate(scope, (key) =>
          key.startsWith("mutable:history:"),
        );
      const request = ++listGeneration.current;
      const targetCount = pageRef.current?.commits.length ?? 0;
      let operation: HistoryReadOperation = {
        kind: "refresh",
        scope: listScope,
        head,
        roots: null,
        offset: 0,
      };
      setLoading(true);
      setError((current) =>
        current?.operation.kind === "refresh" &&
        current.operation.scope === listScope &&
        current.operation.head === head
          ? null
          : current,
      );
      try {
        const first = await readPage(null, 0, force, head);
        if (request !== listGeneration.current) return;
        const commits = [...first.commits];
        let hasMore = first.hasMore;
        for (
          let offset = historyPageSize;
          offset < targetCount && hasMore;
          offset += historyPageSize
        ) {
          operation = {
            kind: "refresh",
            scope: listScope,
            head,
            roots: first.roots,
            offset,
          };
          const next = await readPage(first.roots, offset, force);
          if (request !== listGeneration.current) return;
          commits.push(...next.commits);
          hasMore = next.hasMore;
        }
        setHistory({
          scope: listScope,
          value: { roots: first.roots, commits, hasMore },
        });
      } catch {
        if (request === listGeneration.current) setError({ operation });
      } finally {
        if (request === listGeneration.current) setLoading(false);
      }
    },
    [active, head, listScope, readCache, readPage, scope],
  );

  useEffect(() => {
    void refresh();
    return () => {
      listGeneration.current++;
    };
  }, [refresh, revision]);

  // Declared before the request effect: when the filter and an explicit
  // request change together, the reset must run first so it cannot wipe
  // the requested selection.
  const shownList = useRef(listScope);
  useEffect(() => {
    if (shownList.current === listScope) return;
    shownList.current = listScope;
    setSelection(null);
  }, [listScope]);

  const clearFilterRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!filterFocusRequest) return;
    clearFilterRef.current?.focus();
    onFilterFocusHandled?.();
  }, [filterFocusRequest, onFilterFocusHandled]);

  useEffect(() => {
    if (!active || !requestedOid) return;
    const token = requestToken ?? requestedOid;
    if (consumedRequests.current.get(scope) === token) return;
    consumedRequests.current.set(scope, token);
    setSelection((current) =>
      current?.scope === scope && current.oid === requestedOid
        ? current
        : { scope, oid: requestedOid, path: null },
    );
  }, [active, requestedOid, requestToken, scope]);

  useEffect(() => {
    const latest = page?.commits[0];
    if (!active || requestedOid || !latest) return;
    setSelection((current) =>
      current?.scope === scope
        ? current
        : { scope, oid: latest.oid, path: null },
    );
  }, [active, page?.commits, requestedOid, scope]);

  useEffect(() => {
    if (!active || !selected?.oid) return;
    void loadDetail(selected.oid);
    return () => {
      detailGeneration.current++;
    };
  }, [active, loadDetail, selected?.oid]);

  useEffect(() => {
    if (!active || !selected?.oid || !selected.path) return;
    const target = { scope, oid: selected.oid, path: selected.path, revision };
    let cancelled = false;
    void (async () => {
      const pending = detailRequest.current;
      if (
        pending?.scope === scope &&
        pending.oid === target.oid &&
        pending.revision === revision &&
        !(await pending.promise)
      )
        return;
      if (!cancelled) await loadDiff(target.oid, target.path);
    })();
    return () => {
      cancelled = true;
      diffGeneration.current++;
    };
  }, [active, loadDiff, revision, scope, selected?.oid, selected?.path]);

  async function loadMore(force = false) {
    if (!active || !page?.hasMore || loading) return;
    const operation: Extract<HistoryReadOperation, { kind: "loadMore" }> = {
      kind: "loadMore",
      scope: listScope,
      roots: page.roots,
      offset: page.commits.length,
    };
    const request = ++listGeneration.current;
    setLoading(true);
    setError((current) =>
      current && sameOperation(current.operation, operation) ? null : current,
    );
    try {
      const next = await readPage(operation.roots, operation.offset, force);
      if (request === listGeneration.current)
        setHistory({
          scope: listScope,
          value: {
            roots: operation.roots,
            commits: [...page.commits, ...next.commits],
            hasMore: next.hasMore,
          },
        });
    } catch {
      if (request === listGeneration.current) setError({ operation });
    } finally {
      if (request === listGeneration.current) setLoading(false);
    }
  }

  function refreshAll() {
    const tasks: Promise<unknown>[] = [refresh(true)];
    if (selected?.oid) {
      const { oid, path } = selected;
      const diffRequest = diffGeneration.current;
      const detail = loadDetail(oid, true);
      tasks.push(detail);
      if (path)
        tasks.push(
          detail.then((current) =>
            current && diffRequest === diffGeneration.current
              ? loadDiff(oid, path, true)
              : undefined,
          ),
        );
    }
    void Promise.all(tasks);
  }

  function retry() {
    const operation = relevantError?.operation;
    if (!operation) return;
    if (operation.kind === "diff")
      void loadDiff(operation.oid, operation.path, true);
    else if (operation.kind === "detail") {
      const target = selectedRef.current;
      const generation = diffGeneration.current;
      void loadDetail(operation.oid, true).then((fresh) => {
        const current = selectedRef.current;
        if (
          fresh &&
          target?.path &&
          generation === diffGeneration.current &&
          current?.scope === target.scope &&
          current.oid === target.oid &&
          current.path === target.path
        ) {
          return loadDiff(target.oid, target.path, true);
        }
      });
    } else if (
      operation.kind === "loadMore" &&
      page &&
      JSON.stringify(page.roots) === JSON.stringify(operation.roots) &&
      page.commits.length === operation.offset
    )
      void loadMore(true);
    else void refresh(true);
  }

  const mainStyle = {
    "--history-diff-size": `${100 - railRatio}fr`,
    "--history-rail-size": `${railRatio}fr`,
  } as CSSProperties;
  useNotification(
    active && relevantError
      ? {
          key: `git-history:${scope}`,
          message: s.historyReadError,
          action: { label: s.retry, onAction: retry },
        }
      : null,
  );

  return (
    <div className="git-history-view">
      <div className="git-view-toolbar">
        <div className="git-history-heading">
          <span className="git-history-title">
            <strong>{s.history}</strong>
            {path !== null ? (
              <span
                className="git-history-filter"
                title={s.historyFilter(path)}
              >
                {path}
              </span>
            ) : null}
          </span>
          {path !== null && onClearPath ? (
            <IconButton
              ref={clearFilterRef}
              size="small"
              aria-label={s.clearHistoryFilter}
              title={s.clearHistoryFilter}
              onClick={onClearPath}
            >
              <X />
            </IconButton>
          ) : null}
        </div>
        <IconButton
          size="small"
          aria-label={s.refreshHistory}
          title={s.refreshHistory}
          disabled={loading}
          onClick={refreshAll}
        >
          <RefreshCw className={loading ? "app-loading-spinner" : undefined} />
        </IconButton>
      </div>
      <div className="git-history-main" ref={mainRef} style={mainStyle}>
        <aside className="git-history-detail" id={detailId}>
          <div className="git-history-list" aria-busy={loading}>
            {!page && loading ? (
              <LoadingState className="git-panel-centered-status">
                {s.historyLoading}
              </LoadingState>
            ) : page?.commits.length ? (
              <>
                <ul>
                  {page.commits.map((commit, index) => {
                    const badges = gitReferenceBadges(commit.references);
                    const rowHeight = 30;
                    const description = [
                      commit.subject,
                      badges.length
                        ? s.historyReferences(
                            badges.map((badge) => badge.title).join(", "),
                          )
                        : null,
                      commit.parents.length
                        ? s.historyParents(commit.parents.join(", "))
                        : s.rootCommit,
                      `${commit.author} · ${s.historyDate(commit.date)}`,
                      commit.oid,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <li key={commit.oid}>
                        <button
                          type="button"
                          title={description}
                          aria-label={description}
                          aria-pressed={selected?.oid === commit.oid}
                          className={
                            selected?.oid === commit.oid ? "is-selected" : ""
                          }
                          onClick={() =>
                            setSelection({ scope, oid: commit.oid, path: null })
                          }
                          style={
                            {
                              "--git-history-graph-width": `${graphWidth}px`,
                              "--git-history-row-height": `${rowHeight}px`,
                            } as CSSProperties
                          }
                        >
                          <GitCommitGraph
                            height={rowHeight}
                            lanes={graphLaneCount}
                            row={graphRows[index]}
                            width={graphWidth}
                          />
                          <span className="git-history-commit-summary">
                            {badges.length ? (
                              <span className="git-history-references">
                                {badges.map((badge) => (
                                  <span
                                    className={`git-history-reference git-history-graph-color-${graphRows[index].nodeColor % 6}`}
                                    data-kind={badge.kind}
                                    key={badge.title}
                                    title={badge.title}
                                  >
                                    {badge.label}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            <strong>{commit.subject}</strong>
                          </span>
                          <span
                            className="git-history-list-author"
                            title={commit.author}
                          >
                            {commit.author}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {page.hasMore ? (
                  <Button
                    className="git-history-load-more"
                    size="small"
                    disabled={loading}
                    onClick={() => void loadMore()}
                  >
                    {loading ? s.historyLoading : s.loadMore}
                  </Button>
                ) : null}
              </>
            ) : (
              <EmptyState
                className="git-history-list-empty"
                description={s.historyEmpty}
                size="compact"
              />
            )}
          </div>
          {selected ? (
            selectedDetail ? (
              <>
                <header className="git-archive-selection-header">
                  <span className="git-history-commit-meta">
                    {selectedCommit ? (
                      <>
                        <span
                          className="git-archive-author"
                          title={selectedCommit.author}
                        >
                          {selectedCommit.author}
                        </span>
                        <time dateTime={selectedCommit.date}>
                          {s.historyDate(selectedCommit.date)}
                        </time>
                      </>
                    ) : null}
                    <code title={selectedDetail.oid}>
                      {selectedDetail.oid.slice(0, 8)}
                    </code>
                  </span>
                </header>
                <div className="git-history-files">
                  <h3>
                    {s.files}
                    <span>{selectedDetail.files.length}</span>
                  </h3>
                  <GitFileContextMenu
                    historyPath={path}
                    menu={fileMenu}
                    render={<ul />}
                  >
                    {selectedDetail.files.map((file) => (
                      <li key={file.path}>
                        <button
                          type="button"
                          aria-label={file.path}
                          title={
                            file.oldPath
                              ? `${file.oldPath} → ${file.path}`
                              : file.path
                          }
                          aria-pressed={selected.path === file.path}
                          className={
                            selected.path === file.path ? "is-selected" : ""
                          }
                          data-git-path={file.path}
                          onClick={() =>
                            setSelection({ ...selected, path: file.path })
                          }
                        >
                          <span className="git-file-path">
                            <span>{projectFileName(file.path)}</span>
                            {file.path.includes("/") ? (
                              <small>{projectFileParent(file.path)}</small>
                            ) : null}
                          </span>
                          <GitFileStats
                            added={file.added}
                            deleted={file.deleted}
                          />
                          <span
                            className="git-history-file-status"
                            data-status={file.indexStatus}
                          >
                            {file.indexStatus}
                          </span>
                        </button>
                      </li>
                    ))}
                  </GitFileContextMenu>
                </div>
              </>
            ) : null
          ) : null}
        </aside>
        <RailResizer
          axis="x"
          className="git-history-resizer"
          container={mainRef}
          controls={detailId}
          defaultRatio={historyRailDefault}
          label={s.resizeHistory}
          max={historyRailMax}
          min={historyRailMin}
          ratio={railRatio}
          onRatioChange={setRailRatio}
        />
        <div className="git-history-diff" aria-busy={diffLoading}>
          {selectedComparison ? (
            <GitDiffView
              comparison={selectedComparison}
              showMinimap
              toolbarActions={
                diffLoading ? (
                  <span role="status" aria-label={s.loadingDiff}>
                    <LoaderCircle
                      size={14}
                      className="app-loading-spinner"
                      aria-hidden="true"
                    />
                  </span>
                ) : undefined
              }
            />
          ) : selected &&
            relevantError?.operation.kind !== "detail" &&
            relevantError?.operation.kind !== "diff" &&
            (!selectedDetail || selected.path) ? (
            // A newly selected commit reads its files, then its first diff: no empty state in between.
            // shortcut: errors share one slot, so a failed diff then a failed "load more" shows loading until another file or commit is picked; keep the diff error apart if users hit it.
            <LoadingState className="git-panel-centered-status">
              {s.loadingDiff}
            </LoadingState>
          ) : (
            <EmptyState
              description={
                selected
                  ? s.historyChooseFile
                  : page?.commits.length === 0
                    ? s.historyEmpty
                    : s.historyChoose
              }
              fill
              icon={<HistoryIcon />}
              title={s.history}
            />
          )}
        </div>
      </div>
    </div>
  );
}
