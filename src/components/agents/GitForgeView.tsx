import { Menu } from "@base-ui/react/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Ellipsis,
  ExternalLink,
  FolderPlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  LogIn,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import * as forgeApi from "../../data/forgeApi";
import * as api from "../../data/projectGitApi";
import type { AgentProject } from "../../domain/agentSessions";
import { formatCompactDate } from "../../domain/dateTime";
import {
  currentBranchRequestFirst,
  forgeErrorCode,
  forgeStateError,
  mergeForgeRequests,
  type ForgeChanges,
  type ForgeCheckout,
  type ForgeFilter,
  type ForgeKind,
  type ForgeListedRequest,
  type ForgeMergeMethod,
  type ForgeRequestDetail,
  type ForgeStateError,
  type ForgeUpdateAction,
} from "../../domain/forge";
import { projectFileName, projectFileParent } from "../../domain/projectFiles";
import {
  gitErrorMessage,
  type GitComparison,
  type GitWorktree,
} from "../../domain/projectGit";
import { useFoldWhenTight } from "../../hooks/useFoldWhenTight";
import type { useProjectGit } from "../../hooks/useProjectGit";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { MarkdownContent } from "../MarkdownContent";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { SegmentedControl, SegmentedControlItem } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { useAgentStrings } from "./agentStrings";
import { GitFileStats } from "./GitChangeList";
import GitDiffView from "./GitDiffView";
import {
  GitWorktreeDialog,
  worktreeDefaults,
  type WorktreeRequest,
} from "./GitWorktreeDialog";
import { ForgeRequestHeader } from "./GitForgeRequestHeader";
import { ForgeRequestRow, ForgeStatusIcon } from "./GitForgeRequestRow";
import { useGitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";
import { RailResizer } from "./RailResizer";
import "./GitArchiveViews.css";
import "./GitForgeView.css";

type GitState = ReturnType<typeof useProjectGit>;
type DetailTab = "description" | "checks" | "commits" | "files";
const detailTabs: DetailTab[] = ["description", "checks", "commits", "files"];
const filters: ForgeFilter[] = ["open", "mine", "review", "closed"];
const railDefault = 34;
const railMin = 15;
const railMax = 85;
/** Width kept for the search field before the filters fold into a dropdown. */
const searchMinWidth = 180;

const cacheSize = 20;

/** Stores `value` as the newest entry, evicting the oldest past `cacheSize`. */
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
}

const withoutForge = (reason: unknown) => {
  const code = forgeStateError(reason);
  return (
    code === "noRemote" ||
    code === "unrecognizedRemote" ||
    code === "unsupportedForge"
  );
};

/** The failure worth showing when every project failed: one with a forge beats one without. */
function mainFailure(results: readonly PromiseSettledResult<unknown>[]) {
  const reasons = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  return reasons.find((reason) => !withoutForge(reason)) ?? reasons[0];
}

type GitForgeViewProps = {
  active: boolean;
  /** One repository, or a group overview's members listed together. */
  projects: readonly AgentProject[];
  /** The single repository's Git state; without it (group overview) checkout actions are hidden. */
  git?: GitState;
  readScope?: string;
  /** Bumped when a forge sign-in terminal exits successfully. */
  loginRevision?: number;
  onKind?: (kind: ForgeKind) => void;
  onLogin?: (kind: ForgeKind) => void;
  onWorktreeCreated?: (
    project: AgentProject,
    worktree: GitWorktree,
  ) => void | Promise<void>;
};

export function GitForgeView({
  active,
  projects,
  git,
  readScope,
  loginRevision,
  onKind,
  onLogin,
  onWorktreeCreated,
}: GitForgeViewProps) {
  const s = useGitStrings();
  const agentStrings = useAgentStrings();
  const { locale } = useI18n();
  const projectsKey = projects.map((project) => project.id).join("\n");
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // Checkout and worktree target; only used with `git`, which comes with a single repository.
  const project = projects[0];
  const scope = readScope ?? projectsKey;
  const remoteGeneration = useRef(0);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const changesGeneration = useRef(0);
  const diffGeneration = useRef(0);
  const onKindRef = useRef(onKind);
  onKindRef.current = onKind;
  // Earlier answers per [scope, list key] and [scope, project, number], shown while re-reading.
  const listCache = useRef(new Map<string, ForgeListedRequest[]>());
  const detailCache = useRef(new Map<string, ForgeRequestDetail>());
  // Files and diffs per [scope, key], with the refresh/login revision they were read in.
  const changesCache = useRef(
    new Map<string, { revision: string; value: ForgeChanges }>(),
  );
  const comparisonCache = useRef(
    new Map<string, { revision: string; value: GitComparison }>(),
  );
  const [filter, setFilter] = useState<ForgeFilter>("open");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [remote, setRemote] = useState<{
    scope: string;
    kind: ForgeKind;
  } | null>(null);
  const [list, setList] = useState<{
    scope: string;
    key: string;
    requests: ForgeListedRequest[];
  } | null>(null);
  const [failure, setFailure] = useState<{
    scope: string;
    code: ForgeStateError;
  } | null>(null);
  const [notice, setNotice] = useState<{
    scope: string;
    code: "rateLimited" | "network";
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<{
    scope: string;
    key: string;
  } | null>(null);
  const [selection, setSelection] = useState<{
    scope: string;
    projectId: string;
    number: number;
  } | null>(null);
  const [detail, setDetail] = useState<{
    scope: string;
    projectId: string;
    revision: string;
    read: number;
    value: ForgeRequestDetail;
  } | null>(null);
  const [detailReadId, setDetailReadId] = useState(0);
  const [detailFailedRead, setDetailFailedRead] = useState(-1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<DetailTab>("description");
  const [changes, setChanges] = useState<{
    scope: string;
    key: string;
    value: ForgeChanges;
  } | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{
    scope: string;
    key: string;
    value: GitComparison;
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [mergeRequest, setMergeRequest] = useState<{
    scope: string;
    projectId: string;
    repository: string;
    number: number;
    headOid: string;
    method: ForgeMergeMethod;
  } | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<{
    scope: string;
    kind: "worktree" | "switch";
    checkout: ForgeCheckout;
  } | null>(null);
  const [worktreeRequest, setWorktreeRequest] =
    useState<WorktreeRequest | null>(null);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [railRatio, setRailRatio] = useState(railDefault);
  const listId = useId();
  const mainRef = useRef<HTMLDivElement>(null);

  const kind = remote?.scope === scope ? remote.kind : null;
  const listKey = JSON.stringify([filter, search]);
  const shownRequests =
    list?.scope === scope && list.key === listKey
      ? list.requests
      : (listCache.current.get(JSON.stringify([scope, listKey])) ?? null);
  const hasListRef = useRef(false);
  hasListRef.current = shownRequests !== null;
  const branch = git?.repo?.branch ?? null;
  const ordered = useMemo(
    () => currentBranchRequestFirst(shownRequests ?? [], branch),
    [branch, shownRequests],
  );
  const stateError = failure?.scope === scope ? failure.code : null;
  const listFailed = listError?.scope === scope && listError.key === listKey;
  const shownNotice = notice?.scope === scope ? notice.code : null;
  const selectedNumber = selection?.scope === scope ? selection.number : null;
  const selectedProjectId =
    selection?.scope === scope ? selection.projectId : null;
  const revision = `${refreshToken}:${loginRevision}`;
  const detailRead =
    detail?.scope === scope &&
    detail.projectId === selectedProjectId &&
    detail.value.number === selectedNumber;
  const shownDetail = detailRead
    ? detail.value
    : (detailCache.current.get(
        JSON.stringify([scope, selectedProjectId, selectedNumber]),
      ) ?? null);
  // Merging acts on what the dialog shows, so it needs the latest successful read, not the cache.
  const detailFresh =
    detailRead && detail.revision === revision && detail.read === detailReadId;
  const changesKey = shownDetail
    ? JSON.stringify([
        selectedProjectId,
        shownDetail.number,
        shownDetail.baseOid,
        shownDetail.headOid,
      ])
    : null;
  const changesCacheKey = JSON.stringify([scope, changesKey]);
  const changesShown = changes?.scope === scope && changes.key === changesKey;
  const shownChanges = changesShown
    ? changes.value
    : (changesCache.current.get(changesCacheKey)?.value ?? null);
  const shownDetailRef = useRef(shownDetail);
  shownDetailRef.current = shownDetail;
  const selectedPath =
    shownChanges?.files.find((file) => file.path === filePath)?.path ??
    shownChanges?.files[0]?.path ??
    null;
  const diffKey =
    shownChanges && selectedPath
      ? JSON.stringify([
          selectedProjectId,
          shownChanges.base,
          shownChanges.head,
          selectedPath,
        ])
      : null;
  const diffBase = shownChanges?.base;
  const diffHead = shownChanges?.head;
  const comparisonCacheKey = JSON.stringify([scope, diffKey]);
  const comparisonShown =
    comparison?.scope === scope && comparison.key === diffKey;
  const shownComparison = comparisonShown
    ? comparison.value
    : (comparisonCache.current.get(comparisonCacheKey)?.value ?? null);

  function errorText(reason: unknown) {
    const state = forgeStateError(reason);
    if (state) return s.forgeStateErrors(kind)[state].description;
    if (
      forgeErrorCode(reason) === "forge" &&
      reason &&
      typeof reason === "object" &&
      "message" in reason &&
      typeof reason.message === "string"
    )
      return reason.message;
    return formatOperationError(agentStrings, {
      message: gitErrorMessage(reason),
    });
  }
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;
  // Rate limits and outages keep the last known state behind a banner.
  // Returns true when the error was only notified, with nothing shown in place.
  function report(reason: unknown, listing: boolean) {
    const code = forgeStateError(reason);
    if (
      (code === "rateLimited" || code === "network") &&
      (!listing || hasListRef.current)
    )
      setNotice({ scope, code });
    else if (code && listing) setFailure({ scope, code });
    else {
      notifyError(errorTextRef.current(reason), { key: `git-forge:${scope}` });
      return true;
    }
    return false;
  }
  const reportRef = useRef(report);
  reportRef.current = report;

  // Alt-tabbing back within 30 s of the last read keeps the forge's rate limit for real changes.
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!active) return;
    const wake = () => {
      if (Date.now() - lastRefresh.current >= 30_000)
        setRefreshToken((value) => value + 1);
    };
    window.addEventListener("focus", wake);
    return () => window.removeEventListener("focus", wake);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const request = ++remoteGeneration.current;
    void Promise.allSettled(
      projectsRef.current.map((project) =>
        forgeApi.readForgeRemote(project.id),
      ),
    ).then((results) => {
      if (request !== remoteGeneration.current) return;
      const kinds = new Set(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.kind] : [],
        ),
      );
      // Mixed forges keep the generic labels.
      // shortcut: in a mixed GitHub/GitLab group, errors name gh and hide the sign-in button; keep each member's kind with its failure if such groups appear.
      if (kinds.size === 1) {
        const [value] = kinds;
        setRemote({ scope, kind: value });
        onKindRef.current?.(value);
        return;
      }
      const reason = kinds.size ? null : mainFailure(results);
      // Other failures recur in the list read, which re-detects the remote and reports them.
      if (reason && forgeStateError(reason)) reportRef.current(reason, true);
    });
    return () => {
      remoteGeneration.current++;
    };
  }, [active, loginRevision, projectsKey, refreshToken, scope]);

  useEffect(() => {
    if (!active) return;
    lastRefresh.current = Date.now();
    const request = ++listGeneration.current;
    const sources = projectsRef.current;
    setLoading(true);
    setListError(null);
    void (async () => {
      try {
        const results = await Promise.allSettled(
          sources.map((project) =>
            forgeApi.readForgeRequests(project.id, filter, search),
          ),
        );
        if (request !== listGeneration.current) return;
        const lists = results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [{ projectId: sources[index].id, requests: result.value }]
            : [],
        );
        if (sources.length && !lists.length) throw mainFailure(results);
        // A member without a forge remote simply has nothing to list.
        results.forEach((result, index) => {
          if (result.status === "rejected" && !withoutForge(result.reason))
            notifyError(
              `${sources[index].name}: ${errorTextRef.current(result.reason)}`,
              { key: `git-forge:${scope}:${sources[index].id}` },
            );
        });
        const requests = mergeForgeRequests(lists);
        remember(listCache.current, JSON.stringify([scope, listKey]), requests);
        setList({ scope, key: listKey, requests });
        setFailure(null);
        // shortcut: a detail read failing in the same refresh loses its banner; track the notice per read if users report stale details.
        setNotice(null);
      } catch (reason) {
        if (
          request === listGeneration.current &&
          reportRef.current(reason, true)
        )
          setListError({ scope, key: listKey });
      } finally {
        if (request === listGeneration.current) setLoading(false);
      }
    })();
    return () => {
      listGeneration.current++;
    };
  }, [
    active,
    filter,
    listKey,
    loginRevision,
    projectsKey,
    refreshToken,
    scope,
    search,
  ]);

  useEffect(() => {
    setSelection(null);
  }, [listKey, scope]);

  useEffect(() => {
    const first = ordered.requests[0];
    if (!active || !first) return;
    setSelection((current) =>
      current?.scope === scope
        ? current
        : { scope, projectId: first.projectId, number: first.number },
    );
  }, [active, ordered.requests, scope]);

  useEffect(() => {
    if (!active || selectedNumber === null || selectedProjectId === null)
      return;
    const request = ++detailGeneration.current;
    setDetailReadId(request);
    setDetailLoading(true);
    forgeApi
      .readForgeRequest(selectedProjectId, selectedNumber)
      .then(
        (value) => {
          if (request !== detailGeneration.current) return;
          remember(
            detailCache.current,
            JSON.stringify([scope, selectedProjectId, value.number]),
            value,
          );
          setDetail({
            scope,
            projectId: selectedProjectId,
            revision,
            read: request,
            value,
          });
        },
        (reason) => {
          if (request !== detailGeneration.current) return;
          setDetailFailedRead(request);
          reportRef.current(reason, false);
        },
      )
      .finally(() => {
        if (request === detailGeneration.current) setDetailLoading(false);
      });
    return () => {
      detailGeneration.current++;
    };
  }, [active, revision, scope, selectedNumber, selectedProjectId]);

  useEffect(() => {
    const detail = shownDetailRef.current;
    // shortcut: the shown Files are not re-read on refresh: a base..head diff only changes with local attributes (.gitattributes); re-read on refresh if users report stale counts.
    if (
      !active ||
      tab !== "files" ||
      !detail ||
      selectedProjectId === null ||
      changesKey === null ||
      changesShown ||
      changesCache.current.get(changesCacheKey)?.revision === revision
    ) {
      setChangesLoading(false);
      return;
    }
    const request = ++changesGeneration.current;
    setChangesLoading(true);
    forgeApi
      .readForgeChanges(selectedProjectId, detail)
      .then(
        (value) => {
          if (request !== changesGeneration.current) return;
          remember(changesCache.current, changesCacheKey, { revision, value });
          setChanges({ scope, key: changesKey, value });
        },
        (reason) => {
          if (request === changesGeneration.current)
            reportRef.current(reason, false);
        },
      )
      .finally(() => {
        if (request === changesGeneration.current) setChangesLoading(false);
      });
    return () => {
      changesGeneration.current++;
    };
  }, [
    active,
    changesCacheKey,
    changesKey,
    changesShown,
    selectedProjectId,
    revision,
    scope,
    tab,
  ]);

  useEffect(() => {
    if (
      !active ||
      tab !== "files" ||
      diffBase === undefined ||
      diffHead === undefined ||
      !selectedPath ||
      selectedProjectId === null ||
      diffKey === null ||
      comparisonShown ||
      comparisonCache.current.get(comparisonCacheKey)?.revision === revision
    ) {
      setDiffLoading(false);
      return;
    }
    const request = ++diffGeneration.current;
    setDiffLoading(true);
    forgeApi
      .readForgeComparison(selectedProjectId, diffBase, diffHead, selectedPath)
      .then(
        (value) => {
          if (request !== diffGeneration.current) return;
          remember(comparisonCache.current, comparisonCacheKey, {
            revision,
            value,
          });
          setComparison({ scope, key: diffKey, value });
        },
        (reason) => {
          if (request === diffGeneration.current)
            reportRef.current(reason, false);
        },
      )
      .finally(() => {
        if (request === diffGeneration.current) setDiffLoading(false);
      });
    return () => {
      diffGeneration.current++;
    };
  }, [
    active,
    comparisonCacheKey,
    comparisonShown,
    diffBase,
    diffHead,
    diffKey,
    selectedProjectId,
    revision,
    scope,
    selectedPath,
    tab,
  ]);

  useEffect(() => {
    if (!pendingCheckout || !git || git.busy) return;
    setPendingCheckout(null);
    const repo = git.repo;
    if (pendingCheckout.scope !== scope || !repo) return;
    const { checkout } = pendingCheckout;
    if (pendingCheckout.kind === "switch") {
      void git.mutate(() =>
        api.switchGitBranch(
          project.id,
          checkout.name,
          checkout.remote,
          repo.version,
        ),
      );
      return;
    }
    const root = repo.identity?.root;
    if (root)
      setWorktreeRequest({
        ...worktreeDefaults(project, root, {
          name: checkout.name,
          oid: checkout.oid,
          remote: checkout.remote,
          current: false,
          upstream: null,
        }),
        version: repo.version,
      });
  }, [git, pendingCheckout, project, scope]);

  useEffect(() => {
    if (!active && !git?.busy) {
      setMergeRequest(null);
      setWorktreeRequest(null);
    }
  }, [active, git?.busy]);

  const refresh = () => setRefreshToken((value) => value + 1);

  async function runAction(work: () => Promise<unknown>) {
    if (acting) return;
    setActing(true);
    try {
      await work();
      return true;
    } catch (reason) {
      reportRef.current(reason, false);
      return false;
    } finally {
      setActing(false);
      refresh();
    }
  }

  async function confirmMerge() {
    const request = mergeRequest;
    if (!request || request.scope !== scope) return;
    await runAction(() =>
      forgeApi.mergeForgeRequest(
        request.projectId,
        request.repository,
        request.number,
        request.method,
        request.headOid,
      ),
    );
    setMergeRequest(null);
  }

  function update(request: ForgeRequestDetail, action: ForgeUpdateAction) {
    const projectId = selectedProjectId;
    if (projectId === null) return;
    void runAction(() =>
      forgeApi.updateForgeRequest(
        projectId,
        request.repository,
        request.number,
        action,
      ),
    );
  }

  async function checkout(
    request: ForgeRequestDetail,
    target: "worktree" | "switch",
  ) {
    const repo = git?.repo;
    if (!git || !repo || git.isBusy()) return;
    let forgeFailure: unknown = null;
    const result = await git.mutate(async () => {
      try {
        return await forgeApi.checkoutForgeRequest(
          project.id,
          request,
          repo.version,
        );
      } catch (reason) {
        // Git failures keep the panel's mutation handling; forge ones need their own text.
        if (forgeErrorCode(reason) !== "forge" && !forgeStateError(reason))
          throw reason;
        forgeFailure = reason;
        return null;
      }
    });
    if (forgeFailure) reportRef.current(forgeFailure, false);
    if (result) setPendingCheckout({ scope, kind: target, checkout: result });
  }

  const worktreeBlocked =
    !git ||
    git.busy ||
    !!git.error?.uncertain ||
    !!git.repo?.limited ||
    !!git.repo?.operation ||
    !git.repo?.head;
  const worktreeChanged =
    !!worktreeRequest &&
    (worktreeRequest.projectId !== project?.id ||
      worktreeRequest.version !== git?.repo?.version);

  async function createWorktree() {
    const request = worktreeRequest;
    if (
      !git ||
      !request ||
      request.projectId !== project.id ||
      request.version !== git.repo?.version ||
      worktreeBlocked ||
      git.isBusy() ||
      creatingWorktree
    )
      return;
    setCreatingWorktree(true);
    try {
      const created = await git.mutate(() =>
        api.createGitWorktree(project.id, {
          id: request.id,
          name: request.name,
          parentPath: request.parentPath.trim(),
          folderName: request.folderName.trim(),
          branch: request.branch.name,
          remote: request.branch.remote,
          createBranch: request.createBranch,
          version: request.version,
        }),
      );
      if (created) {
        setWorktreeRequest(null);
        await onWorktreeCreated?.(created, {
          path: created.path,
          head: request.branch.oid,
          branch: request.branch.remote
            ? request.branch.name.slice(request.branch.name.indexOf("/") + 1)
            : request.branch.name,
        });
      }
    } finally {
      setCreatingWorktree(false);
    }
  }

  function openInBrowser(url: string) {
    void openUrl(url).catch(() => notifyError(agentStrings.urlOpenError));
  }

  const switchBlocker = git?.repo?.operation
    ? s.operationBlocksMutation
    : git?.busy
      ? s.operationPending
      : null;
  const mainStyle = {
    "--history-diff-size": `${100 - railRatio}fr`,
    "--history-rail-size": `${railRatio}fr`,
  } as CSSProperties;
  // Memoized so rail drags and search typing don't rebuild every file and request row.
  const fileList = useMemo(
    () =>
      shownChanges?.files.length ? (
        <div className="git-history-files git-forge-files">
          <ul>
            {shownChanges.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  aria-label={file.path}
                  title={
                    file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
                  }
                  aria-pressed={selectedPath === file.path}
                  className={selectedPath === file.path ? "is-selected" : ""}
                  onClick={() => setFilePath(file.path)}
                >
                  <span className="git-file-path">
                    <span>{projectFileName(file.path)}</span>
                    {file.path.includes("/") ? (
                      <small>{projectFileParent(file.path)}</small>
                    ) : null}
                  </span>
                  <GitFileStats added={file.added} deleted={file.deleted} />
                  <span
                    className="git-history-file-status"
                    data-status={file.indexStatus}
                  >
                    {file.indexStatus}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null,
    [selectedPath, shownChanges],
  );
  // Rows name their project once several are listed together.
  const projectNamesKey =
    projects.length > 1
      ? JSON.stringify(projects.map((project) => [project.id, project.name]))
      : "";
  const requestRows = useMemo(() => {
    const names = projectNamesKey
      ? new Map(
          projectsRef.current.map((project) => [project.id, project.name]),
        )
      : null;
    return (
      <ul>
        {ordered.requests.map((request) => (
          <li key={`${request.projectId}:${request.number}`}>
            <ForgeRequestRow
              request={request}
              project={names?.get(request.projectId)}
              current={request.number === ordered.current}
              selected={
                request.projectId === selectedProjectId &&
                request.number === selectedNumber
              }
              date={formatCompactDate(request.createdAt, locale)?.value ?? ""}
              onSelect={() =>
                setSelection({
                  scope,
                  projectId: request.projectId,
                  number: request.number,
                })
              }
            />
          </li>
        ))}
      </ul>
    );
  }, [
    locale,
    ordered,
    projectNamesKey,
    scope,
    selectedNumber,
    selectedProjectId,
  ]);
  const stateMessage = stateError ? s.forgeStateErrors(kind)[stateError] : null;
  const tabCounts: Partial<Record<DetailTab, number>> | null = shownDetail
    ? {
        checks: shownDetail.checkRuns.length,
        commits: shownDetail.commits.length,
        files: shownDetail.changedFiles,
      }
    : null;
  const activeMerge =
    mergeRequest?.scope === scope &&
    mergeRequest.projectId === selectedProjectId
      ? mergeRequest
      : null;

  const barRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const tabsFolded = useFoldWhenTight(
    barRef,
    tabsRef,
    [actionsRef],
    0,
    !stateError && shownDetail !== null,
  );
  const toolbarRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const filtersFolded = useFoldWhenTight(
    toolbarRef,
    filtersRef,
    [searchToggleRef, refreshRef],
    searchOpen ? searchMinWidth : 0,
    true,
  );
  function closeSearch() {
    setSearchOpen(false);
    setSearchDraft("");
    setSearch("");
  }
  const checks = shownDetail?.checks;
  const unverifiedChecks =
    checks === "failure" || checks === "pending" ? checks : null;
  // No list yet, a loading one or a pending auto-selection shows nothing rather than flashing the empty state.
  const selectionPending =
    loading ||
    !shownRequests ||
    (selectedNumber === null && ordered.requests.length > 0);
  const mergeBlockedReason = shownDetail?.mergeBlockers.length
    ? s.forgeMergeBlocked(
        shownDetail.mergeBlockers
          .map((blocker) => s.forgeBlockers[blocker])
          .join(", "),
      )
    : undefined;

  return (
    <div className="git-history-view git-forge-view">
      <div
        className="git-view-toolbar git-forge-toolbar"
        ref={toolbarRef}
        data-folded={filtersFolded || undefined}
      >
        {/* Kept laid out while folded: its width decides when it fits again. */}
        <div
          className="git-forge-tabs"
          role="group"
          aria-label={s.forgeFilterLabel}
          aria-hidden={filtersFolded || undefined}
          ref={filtersRef}
        >
          {filters.map((value) => (
            <button
              key={value}
              type="button"
              className="git-forge-tab-button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {s.forgeFilters[value]}
            </button>
          ))}
        </div>
        {filtersFolded ? (
          <Select
            size="small"
            aria-label={s.forgeFilterLabel}
            popupClassName="git-forge-filter-popup"
            value={filter}
            options={filters.map((value) => ({
              value,
              label: s.forgeFilters[value],
            }))}
            onValueChange={(value) => setFilter(value as ForgeFilter)}
          />
        ) : null}
        {searchOpen ? (
          <form
            className="git-forge-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <Input
              size="small"
              type="search"
              aria-label={s.forgeSearch}
              placeholder={s.forgeSearchPlaceholder}
              startIcon={<Search />}
              autoFocus
              value={searchDraft}
              onChange={(event) => {
                setSearchDraft(event.target.value);
                // The field's clear button only empties it: drop the applied search too.
                if (!event.target.value) setSearch("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch();
              }}
            />
          </form>
        ) : null}
        <IconButton
          ref={searchToggleRef}
          className="git-forge-search-toggle"
          size="small"
          aria-label={searchOpen ? s.forgeSearchHide : s.forgeSearch}
          title={searchOpen ? s.forgeSearchHide : s.forgeSearch}
          aria-pressed={searchOpen}
          selected={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <Search />
        </IconButton>
        <IconButton
          ref={refreshRef}
          size="small"
          aria-label={s.refreshForge}
          title={s.refreshForge}
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw className={loading ? "app-loading-spinner" : undefined} />
        </IconButton>
      </div>
      {shownNotice ? (
        <div className="git-panel-notice" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {shownNotice === "rateLimited"
              ? s.forgeRateLimitedNotice
              : s.forgeNetworkNotice}
          </span>
          <Button size="small" disabled={loading} onClick={refresh}>
            {s.retry}
          </Button>
        </div>
      ) : null}
      {stateError && stateMessage ? (
        <EmptyState
          fill
          headingLevel={3}
          icon={<GitPullRequest />}
          title={stateMessage.title}
          description={stateMessage.description}
          actions={
            <>
              {(stateError === "cliMissing" ||
                stateError === "unauthenticated") &&
              kind &&
              onLogin ? (
                <Button
                  variant="primary"
                  startIcon={<LogIn />}
                  onClick={() => onLogin(kind)}
                >
                  {s.forgeLogin(kind)}
                </Button>
              ) : null}
              <Button disabled={loading} onClick={refresh}>
                {s.retry}
              </Button>
            </>
          }
        />
      ) : (
        <div className="git-history-main" ref={mainRef} style={mainStyle}>
          <aside className="git-history-detail" id={listId}>
            <div className="git-history-list" aria-busy={loading}>
              {!shownRequests && (loading || !listFailed) ? (
                <LoadingState className="git-panel-centered-status">
                  {s.forgeLoading}
                </LoadingState>
              ) : !shownRequests ? (
                <EmptyState
                  className="git-history-list-empty"
                  description={s.forgeListReadError(kind)}
                  size="compact"
                  actions={
                    <Button size="small" onClick={refresh}>
                      {s.retry}
                    </Button>
                  }
                />
              ) : ordered.requests.length ? (
                requestRows
              ) : (
                <EmptyState
                  className="git-history-list-empty"
                  description={s.forgeEmpty(kind)}
                  size="compact"
                />
              )}
            </div>
          </aside>
          <RailResizer
            axis="x"
            className="git-history-resizer"
            container={mainRef}
            controls={listId}
            defaultRatio={railDefault}
            label={s.resizeHistory}
            max={railMax}
            min={railMin}
            ratio={railRatio}
            onRatioChange={setRailRatio}
          />
          <div
            className="git-history-diff git-forge-detail"
            aria-busy={detailLoading}
          >
            {shownDetail ? (
              <>
                <ForgeRequestHeader detail={shownDetail} />
                <div
                  className="git-forge-bar"
                  ref={barRef}
                  data-folded={tabsFolded || undefined}
                >
                  {/* Kept laid out while folded: its width decides when it fits again. */}
                  <div
                    className="git-forge-tabs"
                    role="group"
                    aria-label={s.forgeDetailTabs}
                    aria-hidden={tabsFolded || undefined}
                    ref={tabsRef}
                  >
                    {detailTabs.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="git-forge-tab-button"
                        aria-pressed={tab === value}
                        onClick={() => setTab(value)}
                      >
                        {s.forgeTabs[value]}
                        {tabCounts?.[value] !== undefined ? (
                          <span className="git-forge-count">
                            {tabCounts[value]}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {tabsFolded ? (
                    <Select
                      className="git-forge-tab-select"
                      size="small"
                      aria-label={s.forgeDetailTabs}
                      popupClassName="git-forge-filter-popup git-forge-tab-popup"
                      value={tab}
                      options={detailTabs.map((value) => ({
                        value,
                        label: s.forgeTabs[value],
                        hint: tabCounts?.[value]?.toString(),
                      }))}
                      onValueChange={(value) => setTab(value as DetailTab)}
                    />
                  ) : null}
                  <div className="git-forge-actions" ref={actionsRef}>
                    {shownDetail.state === "open" ? (
                      <Button
                        size="small"
                        variant="primary"
                        startIcon={<GitMerge />}
                        title={mergeBlockedReason}
                        aria-description={mergeBlockedReason}
                        disabled={
                          acting ||
                          !detailFresh ||
                          shownDetail.mergeBlockers.length > 0 ||
                          !shownDetail.mergeMethods.length
                        }
                        onClick={() => {
                          if (selectedProjectId !== null)
                            setMergeRequest({
                              scope,
                              projectId: selectedProjectId,
                              repository: shownDetail.repository,
                              number: shownDetail.number,
                              headOid: shownDetail.headOid,
                              method: shownDetail.mergeMethods[0],
                            });
                        }}
                      >
                        {s.forgeMerge}
                      </Button>
                    ) : null}
                    {shownDetail.draft && shownDetail.state === "open" ? (
                      <Button
                        size="small"
                        disabled={acting}
                        onClick={() => update(shownDetail, "ready")}
                      >
                        {s.forgeReady}
                      </Button>
                    ) : null}
                    <span className="git-forge-actions-end">
                      <IconButton
                        size="small"
                        aria-label={s.forgeOpenBrowser}
                        title={s.forgeOpenBrowser}
                        onClick={() => openInBrowser(shownDetail.url)}
                      >
                        <ExternalLink />
                      </IconButton>
                      {shownDetail.state !== "merged" ? (
                        <Menu.Root modal={false}>
                          <Menu.Trigger
                            render={
                              <IconButton
                                size="small"
                                aria-label={s.moreActions}
                                title={s.moreActions}
                              >
                                <Ellipsis />
                              </IconButton>
                            }
                          />
                          <Menu.Portal>
                            <Menu.Positioner
                              className="agent-menu-positioner"
                              sideOffset={4}
                              align="end"
                              collisionPadding={8}
                            >
                              <Menu.Popup
                                render={
                                  <MenuSurface className="git-forge-menu" />
                                }
                              >
                                {shownDetail.state === "open" && git ? (
                                  <>
                                    <Menu.Item
                                      nativeButton
                                      disabled={worktreeBlocked}
                                      render={
                                        <MenuItem leading={<FolderPlus />} />
                                      }
                                      onClick={() =>
                                        void checkout(shownDetail, "worktree")
                                      }
                                    >
                                      {s.forgeCheckoutWorktree}
                                    </Menu.Item>
                                    <Menu.Item
                                      nativeButton
                                      disabled={
                                        worktreeBlocked || !!switchBlocker
                                      }
                                      render={
                                        <MenuItem
                                          leading={<GitBranch />}
                                          aria-description={
                                            switchBlocker ?? undefined
                                          }
                                          title={switchBlocker ?? undefined}
                                        />
                                      }
                                      onClick={() =>
                                        void checkout(shownDetail, "switch")
                                      }
                                    >
                                      {s.forgeCheckoutHere}
                                    </Menu.Item>
                                    <Menu.Separator className="agent-menu-separator" />
                                  </>
                                ) : null}
                                <Menu.Item
                                  nativeButton
                                  disabled={acting}
                                  render={
                                    <MenuItem
                                      leading={
                                        shownDetail.state === "open" ? (
                                          <GitPullRequestClosed />
                                        ) : (
                                          <GitPullRequest />
                                        )
                                      }
                                    />
                                  }
                                  onClick={() =>
                                    update(
                                      shownDetail,
                                      shownDetail.state === "open"
                                        ? "close"
                                        : "reopen",
                                    )
                                  }
                                >
                                  {shownDetail.state === "open"
                                    ? s.forgeClose
                                    : s.forgeReopen}
                                </Menu.Item>
                              </Menu.Popup>
                            </Menu.Positioner>
                          </Menu.Portal>
                        </Menu.Root>
                      ) : null}
                    </span>
                  </div>
                </div>
                <div className="git-forge-tab" data-tab={tab}>
                  {tab === "description" ? (
                    shownDetail.body.trim() ? (
                      <MarkdownContent
                        className="project-file-markdown git-forge-body"
                        content={shownDetail.body}
                      />
                    ) : (
                      <EmptyState
                        size="compact"
                        description={s.forgeNoDescription}
                      />
                    )
                  ) : tab === "checks" ? (
                    shownDetail.checkRuns.length ? (
                      <ul className="git-forge-items">
                        {shownDetail.checkRuns.map((check, index) => (
                          <li key={`${index}:${check.name}`}>
                            <ForgeStatusIcon status={check.status} />
                            {check.url ? (
                              <button
                                type="button"
                                className="git-forge-link"
                                onClick={() => openInBrowser(check.url!)}
                              >
                                {check.name}
                              </button>
                            ) : (
                              <span>{check.name}</span>
                            )}
                            <small>{s.forgeCheckStatus[check.status]}</small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyState
                        size="compact"
                        description={s.forgeNoChecks}
                      />
                    )
                  ) : tab === "commits" ? (
                    shownDetail.commits.length ? (
                      <ul className="git-forge-items">
                        {shownDetail.commits.map((commit) => (
                          <li key={commit.oid}>
                            <code title={commit.oid}>
                              {commit.oid.slice(0, 8)}
                            </code>
                            <span>{commit.title}</span>
                            <small>{commit.author}</small>
                            <time dateTime={commit.date}>
                              {formatCompactDate(commit.date, locale)?.value}
                            </time>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyState
                        size="compact"
                        description={s.forgeNoCommits}
                      />
                    )
                  ) : !shownChanges ? (
                    changesLoading ? (
                      <LoadingState className="git-panel-centered-status">
                        {s.forgeChangesLoading}
                      </LoadingState>
                    ) : null
                  ) : shownChanges.files.length ? (
                    <>
                      {fileList}
                      <div className="git-forge-diff" aria-busy={diffLoading}>
                        {shownComparison ? (
                          <GitDiffView
                            comparison={shownComparison}
                            showMinimap
                          />
                        ) : diffLoading ? (
                          <LoadingState className="git-panel-centered-status">
                            {s.loadingDiff}
                          </LoadingState>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <EmptyState size="compact" description={s.forgeNoFiles} />
                  )}
                </div>
              </>
            ) : selectedNumber !== null && detailFailedRead !== detailReadId ? (
              <LoadingState className="git-panel-centered-status">
                {s.forgeLoading}
              </LoadingState>
            ) : selectionPending ? null : (
              <EmptyState
                description={
                  shownRequests?.length === 0
                    ? s.forgeEmpty(kind)
                    : s.forgeChoose(kind)
                }
                fill
                icon={<GitPullRequest />}
                title={s.forgeRequests(kind)}
              />
            )}
          </div>
        </div>
      )}
      {activeMerge && active && shownDetail?.number === activeMerge.number
        ? createPortal(
            <ConfirmationDialog
              title={s.forgeMergeTitle(activeMerge.number)}
              confirmVariant="primary"
              description={s.forgeMergeDescription(
                shownDetail.sourceBranch,
                shownDetail.targetBranch,
                shownDetail.deleteSourceBranch,
              )}
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={
                unverifiedChecks ? s.forgeMergeUnverifiedConfirm : s.forgeMerge
              }
              confirmPending={acting}
              cancelDisabled={acting}
              // shortcut: a dialog left open while the request turns draft/conflicting/closed (same head) stays confirmable; the forge refuses that merge. Reapply mergeBlockers here if users hit it.
              confirmDisabled={
                acting ||
                !detailFresh ||
                shownDetail.headOid !== activeMerge.headOid
              }
              onCancel={() => {
                if (!acting) setMergeRequest(null);
              }}
              onConfirm={() => void confirmMerge()}
            >
              {unverifiedChecks ? (
                <div className="git-forge-merge-warning" role="note">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>{s.forgeMergeUnverified(unverifiedChecks)}</span>
                </div>
              ) : null}
              {shownDetail.mergeMethods.length > 1 ? (
                <SegmentedControl
                  className="git-forge-merge-methods"
                  aria-label={s.forgeMergeMethod}
                >
                  {shownDetail.mergeMethods.map((method) => (
                    <SegmentedControlItem
                      key={method}
                      selected={activeMerge.method === method}
                      onClick={() =>
                        setMergeRequest({ ...activeMerge, method })
                      }
                    >
                      {s.forgeMergeMethods[method]}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              ) : null}
            </ConfirmationDialog>,
            document.body,
          )
        : null}
      {worktreeRequest && active && git
        ? createPortal(
            <GitWorktreeDialog
              request={worktreeRequest}
              busy={git.busy || creatingWorktree}
              blocked={worktreeBlocked}
              changed={worktreeChanged}
              onChange={setWorktreeRequest}
              onCancel={() => {
                if (!git.busy && !creatingWorktree) setWorktreeRequest(null);
              }}
              onCreate={() => void createWorktree()}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
