import { Menu } from "@base-ui/react/menu";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudUpload,
  Ellipsis,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/projectGitApi";
import {
  gitReadKeys,
  readMutableGit,
  type GitReadCache,
} from "../../data/gitReadCache";
import type { GitRemote } from "../../domain/projectGit";
import type { useProjectGit } from "../../hooks/useProjectGit";
import { useNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { useGitStrings } from "./gitStrings";

type GitState = ReturnType<typeof useProjectGit>;
type GitRemoteActionsProps = {
  active: boolean;
  git: GitState;
  projectId: string;
  toolbarContainer?: HTMLElement | null;
  onRunningChange?: (running: boolean) => void;
  readCache?: GitReadCache;
  readScope?: string;
};

function matchingGitRemotes(remotes: GitRemote[], upstream: string) {
  return remotes.filter(({ name }) => upstream.startsWith(`${name}/`));
}

export function defaultGitRemote(
  remotes: GitRemote[],
  upstream: string | null,
): string {
  if (upstream) {
    const matches = matchingGitRemotes(remotes, upstream);
    return matches.length === 1 ? matches[0].name : "";
  }
  return (
    remotes.find(({ name }) => name === "origin")?.name ??
    (remotes.length === 1 ? remotes[0].name : "")
  );
}

export function defaultPushBranch(
  upstream: string | null,
  remote: string,
  branch: string | null,
  remotes: GitRemote[],
): string {
  if (!upstream) return branch ?? "";
  const matches = matchingGitRemotes(remotes, upstream);
  if (matches.length > 1) return "";
  return matches[0]?.name === remote
    ? upstream.slice(remote.length + 1)
    : (branch ?? "");
}

export function validGitBranch(value: string): boolean {
  return (
    !!value &&
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\\]/u.test(value) &&
    !value
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}

export function GitRemoteActions({
  active,
  git,
  projectId,
  toolbarContainer,
  onRunningChange,
  readCache,
  readScope,
}: GitRemoteActionsProps) {
  const s = useGitStrings();
  const scope = readScope ?? projectId;
  const generation = useRef(0);
  const pendingRead = useRef<{
    scope: string;
    promise: Promise<GitRemote[]>;
  } | null>(null);
  const [state, setState] = useState<{
    scope: string;
    values: GitRemote[];
  } | null>(null);
  const [selection, setSelection] = useState<{
    scope: string;
    name: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<{
    scope: string;
    action: "fetch" | "pull" | "push";
  } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const cached = readCache
    ? readCache.peek<GitRemote[]>(scope, gitReadKeys.remotes)
    : undefined;
  const remotes = state?.scope === scope ? state.values : (cached ?? []);
  const remoteReadKnown = state?.scope === scope || cached !== undefined;
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    setReadFailed(false);
  }, [scope]);

  const refresh = useCallback(
    async (force = false) => {
      if (!active) return;
      const request = ++generation.current;
      setLoading(true);
      setReadFailed(false);
      let promise =
        !force && pendingRead.current?.scope === scope
          ? pendingRead.current.promise
          : null;
      if (!promise) {
        promise = readMutableGit(
          readCache,
          scope,
          gitReadKeys.remotes,
          () => api.readGitRemotes(projectId),
          force,
        );
        pendingRead.current = { scope, promise };
      }
      try {
        const values = await promise;
        if (request !== generation.current) return;
        setState({ scope, values });
        setSelection((current) =>
          current?.scope === scope &&
          values.some(({ name }) => name === current.name)
            ? current
            : {
                scope,
                name:
                  defaultGitRemote(values, git.repo?.upstream ?? null) ||
                  defaultGitRemote(values, null),
              },
        );
        return values;
      } catch {
        if (request === generation.current) {
          if (force)
            setState((current) => (current?.scope === scope ? null : current));
          setReadFailed(true);
        }
      } finally {
        if (pendingRead.current?.promise === promise)
          pendingRead.current = null;
        if (request === generation.current) setLoading(false);
      }
    },
    [active, projectId, git.repo?.upstream, readCache, scope],
  );

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  const selectedName = selection?.scope === scope ? selection.name : "";
  const selected = remotes.find(({ name }) => name === selectedName);
  const upstreamMatches = git.repo?.upstream
    ? matchingGitRemotes(remotes, git.repo.upstream)
    : [];
  const upstreamRemote =
    upstreamMatches.length === 1 ? upstreamMatches[0].name : "";
  const upstreamAmbiguous = upstreamMatches.length > 1;
  const repositoryBlockedReason = !active
    ? s.remoteActionsInactive
    : git.busy
      ? s.remoteActionBusy
      : readFailed
        ? s.gitErrorBlocksAction
        : git.error?.uncertain
          ? s.uncertain
          : git.error?.readError || git.error?.source === "read"
            ? s.gitErrorBlocksAction
            : !git.repo
              ? s.missing
              : git.repo.availability === "notRepository"
                ? s.notRepository
                : git.repo.availability === "bare"
                  ? s.bare
                  : git.repo.limited
                    ? s.limited
                    : undefined;
  const remoteBlockedReason = !remotes.length
    ? s.noRemotes
    : !selected
      ? s.chooseRemote
      : selected.ambiguous
        ? s.ambiguousRemote
        : undefined;
  const generalBlockedReason = repositoryBlockedReason ?? remoteBlockedReason;
  const operationBlockedReason =
    generalBlockedReason ??
    (git.repo?.operation ? s.operationBlocksMutation : undefined);
  const fetchBlockedReason =
    repositoryBlockedReason ??
    (git.repo?.operation ? s.operationBlocksMutation : undefined) ??
    (remoteReadKnown ? remoteBlockedReason : undefined);
  const pullPrerequisiteBlockedReason =
    operationBlockedReason ??
    (upstreamAmbiguous
      ? s.ambiguousUpstream
      : !git.repo?.head
        ? s.headRequired
        : !git.repo.branch
          ? s.pullNoBranch
          : !git.repo.upstream
            ? s.pullNoUpstream
            : upstreamRemote !== selectedName
              ? s.pullRemoteMismatch
              : undefined);
  const pullBlockedReason =
    pullPrerequisiteBlockedReason ??
    (git.repo?.files.some(({ conflict }) => conflict)
      ? s.pullConflicts
      : git.repo?.trackingKnown && git.repo.ahead && git.repo.behind
        ? s.pullDiverged
        : undefined);
  const rebaseBlockedReason =
    pullPrerequisiteBlockedReason ??
    (git.repo?.files.length ? s.rebaseDirty : undefined);
  // Last known counts stay visible while actions are blocked; the buttons carry the block.
  const hasReliableTracking =
    !!git.repo?.head &&
    !!git.repo.branch &&
    !!git.repo.upstream &&
    !upstreamAmbiguous &&
    upstreamRemote === selectedName &&
    git.repo.trackingKnown === true;
  const pushBlockedReason =
    operationBlockedReason ??
    (upstreamAmbiguous
      ? s.ambiguousUpstream
      : !git.repo?.head
        ? s.headRequired
        : !git.repo.branch
          ? s.pushNoBranch
          : hasReliableTracking && git.repo.behind && !selected?.pushUrl
            ? s.pushBehind
            : undefined);
  const fetchBlocked = !!fetchBlockedReason;
  const pullBlocked = !!pullBlockedReason;
  const rebaseBlocked = !!rebaseBlockedReason;
  const pushBlocked = !!pushBlockedReason;
  const currentFetchState = useRef({
    active,
    projectId,
    scope,
    version: git.repo?.version,
    repositoryBlocked: !!repositoryBlockedReason,
    operation: git.repo?.operation,
    isBusy: git.isBusy,
  });
  currentFetchState.current = {
    active,
    projectId,
    scope,
    version: git.repo?.version,
    repositoryBlocked: !!repositoryBlockedReason,
    operation: git.repo?.operation,
    isBusy: git.isBusy,
  };
  const runningAction = running?.scope === scope ? running.action : null;
  useEffect(() => {
    onRunningChange?.(!!runningAction);
    return () => onRunningChange?.(false);
  }, [onRunningChange, runningAction]);

  async function run(
    action: "fetch" | "pull" | "push",
    task: () => Promise<unknown>,
  ) {
    setRunning({ scope, action });
    try {
      await git.mutate(task);
    } finally {
      setRunning((current) =>
        current?.scope === scope && current.action === action ? null : current,
      );
    }
  }

  async function fetchRemote() {
    if (!active || !git.repo || fetchBlocked || git.isBusy()) return;
    const { upstream, version } = git.repo;
    const values = selected ? remotes : await refresh();
    const current = currentFetchState.current;
    if (
      !values ||
      !current.active ||
      current.projectId !== projectId ||
      current.scope !== scope ||
      current.version !== version ||
      current.repositoryBlocked ||
      current.operation ||
      current.isBusy()
    )
      return;
    const remoteName =
      selected?.name ||
      defaultGitRemote(values, upstream) ||
      defaultGitRemote(values, null);
    const remote = values.find(({ name }) => name === remoteName);
    if (!remote || remote.ambiguous) return;
    await run("fetch", () =>
      api.fetchGitRemote(projectId, remote.name, remote.url, version),
    );
  }

  async function pushRemote() {
    if (!active || !selected || !git.repo || pushBlocked || git.isBusy())
      return;
    const branch = defaultPushBranch(
      git.repo.upstream,
      selected.name,
      git.repo.branch,
      remotes,
    );
    if (!validGitBranch(branch)) return;
    await run("push", () =>
      api.pushGitRemote(
        projectId,
        selected.name,
        branch,
        selected.pushUrl || selected.url,
        git.repo!.version,
      ),
    );
  }

  async function pullRemote(rebase: boolean) {
    const blocked = rebase ? rebaseBlocked : pullBlocked;
    if (!active || !selected || !git.repo || blocked || git.isBusy()) return;
    if (!validGitBranch(git.repo.branch ?? "")) return;
    await run("pull", () =>
      api.pullGitRemote(
        projectId,
        selected.name,
        selected.url,
        git.repo!.version,
        rebase,
      ),
    );
  }
  const ahead = hasReliableTracking ? git.repo!.ahead : 0;
  const behind = hasReliableTracking ? git.repo!.behind : 0;
  const noRemote = remoteReadKnown && !remotes.length;
  const primary = git.repo?.operation ? (
    <span className="git-sync-status">
      {git.repo.operation === "merge"
        ? s.mergeInProgress
        : s.operationInProgress}
    </span>
  ) : noRemote ? (
    <span className="git-sync-status">{s.noRemote}</span>
  ) : runningAction === "pull" || runningAction === "push" ? (
    <Button
      size="small"
      disabled
      startIcon={<LoaderCircle className="app-loading-spinner" />}
    >
      <span className="git-sync-label">{`${runningAction === "pull" ? s.pull : s.push}…`}</span>
    </Button>
  ) : git.repo?.branch && !git.repo.upstream ? (
    <Button
      size="small"
      disabled={pushBlocked}
      aria-description={pushBlockedReason}
      title={pushBlockedReason}
      startIcon={<CloudUpload />}
      onClick={() => void pushRemote()}
    >
      <span className="git-sync-label">{s.publish}</span>
    </Button>
  ) : behind ? (
    <>
      {ahead ? (
        <span
          className="git-sync-status"
          title={s.trackingStatus(ahead, behind)}
        >
          <ArrowUp size={12} aria-hidden="true" />
          {ahead}
        </span>
      ) : null}
      {/* Diverged: only a rebase can integrate the remote commits. */}
      <Button
        size="small"
        disabled={ahead ? rebaseBlocked : pullBlocked}
        aria-description={ahead ? rebaseBlockedReason : pullBlockedReason}
        title={
          ahead ? (rebaseBlockedReason ?? s.pullWithRebase) : pullBlockedReason
        }
        startIcon={<ArrowDown />}
        onClick={() => void pullRemote(!!ahead)}
      >
        <span className="git-sync-label">{s.pull}</span>{" "}
        <span className="git-sync-count">{behind}</span>
      </Button>
    </>
  ) : ahead ? (
    <Button
      size="small"
      disabled={pushBlocked}
      aria-description={pushBlockedReason}
      title={pushBlockedReason}
      startIcon={<ArrowUp />}
      onClick={() => void pushRemote()}
    >
      <span className="git-sync-label">{s.push}</span>{" "}
      <span className="git-sync-count">{ahead}</span>
    </Button>
  ) : hasReliableTracking ? (
    <span className="git-sync-status">
      <Check size={12} aria-hidden="true" />
      {s.upToDate}
    </span>
  ) : null;
  const toolbar = (
    <div className="git-remote-toolbar">
      {git.repo?.branch ? (
        <span
          className="git-sync-branch"
          title={
            hasReliableTracking ? s.trackingStatus(ahead, behind) : undefined
          }
        >
          <GitBranch size={14} aria-hidden="true" />
          <span className="git-sync-ref">{git.repo.branch}</span>
          {git.repo.upstream ? (
            <span className="git-sync-ref git-sync-upstream">
              → {git.repo.upstream}
            </span>
          ) : null}
        </span>
      ) : git.repo?.head ? (
        <span className="git-sync-branch">
          <GitCommitHorizontal size={14} aria-hidden="true" />
          <span className="git-sync-ref">{git.repo.head.slice(0, 7)}</span>
          <span className="git-sync-ref git-sync-upstream">
            {s.detachedHead}
          </span>
        </span>
      ) : null}
      {primary ? <div className="git-sync-primary">{primary}</div> : null}
      {noRemote ? null : (
        <IconButton
          size="small"
          disabled={fetchBlocked}
          aria-label={s.fetch}
          aria-description={fetchBlockedReason}
          title={fetchBlockedReason ?? s.fetch}
          onClick={() => void fetchRemote()}
        >
          {runningAction === "fetch" ? (
            <LoaderCircle className="app-loading-spinner" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </IconButton>
      )}
      <Menu.Root
        modal={false}
        onOpenChange={(open) => {
          if (open) void refresh(true);
        }}
      >
        <Menu.Trigger
          render={
            <IconButton
              size="small"
              aria-label={s.moreActions}
              title={s.moreActions}
            >
              <Ellipsis aria-hidden="true" />
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
              render={<MenuSurface className="git-remote-actions-menu" />}
            >
              <Menu.Item
                nativeButton
                disabled={pullBlocked}
                render={
                  <MenuItem
                    leading={<ArrowDown />}
                    aria-description={pullBlockedReason}
                    title={pullBlockedReason}
                  />
                }
                onClick={() => void pullRemote(false)}
              >
                {s.pull}
              </Menu.Item>
              <Menu.Item
                nativeButton
                disabled={rebaseBlocked}
                render={
                  <MenuItem
                    leading={<ArrowDown />}
                    aria-description={rebaseBlockedReason}
                    title={rebaseBlockedReason}
                  />
                }
                onClick={() => void pullRemote(true)}
              >
                {s.pullWithRebase}
              </Menu.Item>
              <Menu.Item
                nativeButton
                disabled={pushBlocked}
                render={
                  <MenuItem
                    leading={<ArrowUp />}
                    aria-description={pushBlockedReason}
                    title={pushBlockedReason}
                  />
                }
                onClick={() => void pushRemote()}
              >
                {s.push}
              </Menu.Item>
              {remotes.length > 1 ? (
                <div className="git-remote-caption">{s.remoteRepository}</div>
              ) : null}
              {remotes.length > 1 ? (
                <Menu.RadioGroup
                  aria-label={s.remoteRepository}
                  value={selectedName}
                  onValueChange={(name) => setSelection({ scope, name })}
                >
                  {remotes.map((remote) => (
                    <Menu.RadioItem
                      nativeButton
                      key={remote.name}
                      value={remote.name}
                      disabled={loading}
                      render={
                        <MenuItem selected={remote.name === selectedName} />
                      }
                    >
                      {remote.name}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );

  useNotification(
    active && readFailed
      ? {
          key: `git-remotes:${scope}`,
          message: s.remotesReadError,
          action: { label: s.retry, onAction: () => void refresh(true) },
        }
      : null,
  );
  useNotification(
    active && selected?.ambiguous
      ? {
          key: `git-remote-ambiguous:${scope}`,
          message: s.ambiguousRemote,
          tone: "warning",
        }
      : null,
  );

  return toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar;
}
