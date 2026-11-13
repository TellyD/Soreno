import {
  CheckCircle2,
  LoaderCircle,
  Plus,
  Sparkles,
  Unplug,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  createGitReadCache,
  gitReadKeys,
  gitReadScope,
  readPersistedGitRepository,
  writePersistedGitRepository,
} from "../../data/gitReadCache";
import * as forgeApi from "../../data/forgeApi";
import * as api from "../../data/projectGitApi";
import type { AgentProject } from "../../domain/agentSessions";
import type { ForgeKind } from "../../domain/forge";
import { errorMessage } from "../../domain/errors";
import {
  canResolveGitFile,
  canRestoreGitFile,
  gitErrorMessage,
  gitErrorUncertain,
  groupGitChanges,
  hasGitConflictMarkers,
  isGitSnapshotCurrent,
  type GitComparison,
  type GitMutationResult,
  type GitRepository,
  type GitSide,
  type GitSnapshot,
} from "../../domain/projectGit";
import {
  notifyError,
  notifyWarning,
  useNotification,
} from "../../notifications";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import {
  GitResolveConfirmationDialog,
  GitRestoreConfirmationDialog,
} from "./GitChangesConfirmations";
import { GitChangeActions } from "./GitChangeList";
import {
  GitChangeOrderMenu,
  GitChangesDiffContent,
  GitChangesWorkspace,
  GitFileNavigation,
  GitFileViewToggle,
  GitPanelHeaderActions,
  GitPanelViewSwitch,
  useGitChangeOrderPreference,
  useGitFilesRatioPreference,
  useGitFileTreePreference,
  useGitFilesVisiblePreference,
} from "./GitChangesWorkspace";
import { GitForgeView } from "./GitForgeView";
import { ProjectGroupMemberChanges } from "./ProjectGroupMemberChanges";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import { LoadingState } from "../ui/LoadingState";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";
import "./GitPanel.css";
import "./ProjectGroupPanel.css";

type MemberRead = {
  scope: string;
  repo?: GitRepository;
  error?: string;
  loading: boolean;
};
type Selection = { projectId: string; path: string; side: GitSide };
type DiffState = {
  key: string;
  comparison?: GitComparison;
  error?: string;
  loading: boolean;
};
type MutationTarget = GitSnapshot & { name: string };
type PathMutationTarget = MutationTarget & { paths: string[] };
type ResolveTarget = PathMutationTarget & { allowMarkers: boolean };

type ProjectGroupPanelProps = {
  groupName: string;
  members: AgentProject[];
  disconnectedProjectIds: string[];
  /** Connects a disconnected member's SSH project. */
  connectAction?: (projectId: string, size?: "small") => ReactNode;
  workingSessions: { id: string; projectId: string }[];
  visible: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onClose: () => void;
  onMutation?: () => void;
  onBranchRead?: (projectId: string, branch: string, startedAt: number) => void;
  onSelectProject: (projectId: string) => void;
  /** Running agents of the group project and its members; each diff offers the group's and its repository's. */
  commentTargets?: readonly GitDiffCommentTarget[];
  /** Opens a terminal signing the forge CLI in. */
  onForgeLogin?: (kind: ForgeKind) => void;
  /** Bumped when a forge sign-in succeeded: the requests tab reads again. */
  forgeLoginRevision?: number;
};

const groupReadCache = createGitReadCache({ maxScopes: 64 });
function cachedRepository(member: AgentProject) {
  const scope = gitReadScope(member);
  return (
    groupReadCache.peek<GitRepository>(scope, gitReadKeys.repository) ??
    (member.environment.kind === "ssh"
      ? readPersistedGitRepository(member.id, scope)
      : undefined)
  );
}

const selectionKey = (selection: Selection, scope: string, version: string) =>
  JSON.stringify([
    scope,
    selection.projectId,
    selection.side,
    selection.path,
    version,
  ]);

export function ProjectGroupPanel({
  groupName,
  members,
  disconnectedProjectIds,
  connectAction,
  workingSessions,
  visible,
  expanded = false,
  onExpandedChange,
  onClose,
  onMutation,
  onBranchRead,
  onSelectProject,
  commentTargets,
  onForgeLogin,
  forgeLoginRevision,
}: ProjectGroupPanelProps) {
  const s = useAgentStrings();
  const g = useGitStrings();
  const fileListId = useId();
  const [view, setView] = useState<"changes" | "requests">("changes");
  // The requests view mounts on first use, then keeps its list and selection.
  const [requestsOpened, setRequestsOpened] = useState(false);
  const [forgeKind, setForgeKind] = useState<ForgeKind | null>(null);
  const [storedReads, setReads] = useState<Record<string, MemberRead>>(() =>
    Object.fromEntries(
      members.flatMap((member) => {
        const scope = gitReadScope(member);
        const repo = cachedRepository(member);
        return repo ? [[member.id, { scope, repo, loading: false }]] : [];
      }),
    ),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [chosen, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [diffRetry, setDiffRetry] = useState<{ key: string } | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [filesRatio, setFilesRatio] = useGitFilesRatioPreference(40, 15, 80);
  const [filesVisible, setFilesVisible] = useGitFilesVisiblePreference();
  const [tree, toggleFileLayout] = useGitFileTreePreference();
  const [order, setOrder] = useGitChangeOrderPreference();
  const [restoreTarget, setRestoreTarget] = useState<PathMutationTarget | null>(
    null,
  );
  const [resolveTarget, setResolveTarget] = useState<ResolveTarget | null>(
    null,
  );
  const mutationRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshId = useRef(0);
  const activeScopesRef = useRef(new Set<string>());
  const membersRef = useRef(members);
  const disconnectedRef = useRef(disconnectedProjectIds);
  membersRef.current = members;
  disconnectedRef.current = disconnectedProjectIds;
  const onBranchReadRef = useRef(onBranchRead);
  onBranchReadRef.current = onBranchRead;
  const reads = Object.fromEntries(
    members.flatMap((member) => {
      const read = storedReads[member.id];
      return read?.scope === gitReadScope(member) ? [[member.id, read]] : [];
    }),
  ) as Record<string, MemberRead>;
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const connected = members.filter(
    (member) => !disconnectedProjectIds.includes(member.id),
  );
  const disconnectedMembers = members.filter((member) =>
    disconnectedProjectIds.includes(member.id),
  );
  const connectedKey = JSON.stringify(
    connected.map((member) => [member.id, gitReadScope(member)]),
  );

  // ponytail: reads on open, focus, demand and agent turn end; poll if mid-turn updates matter.
  const refresh = useCallback(
    (allowDuringMutation = false) => {
      if (!mountedRef.current || (mutationRef.current && !allowDuringMutation))
        return Promise.resolve(false);
      const id = ++refreshId.current;
      const targets = membersRef.current.filter(
        (member) => !disconnectedRef.current.includes(member.id),
      );
      const targetScopes = new Set(targets.map(gitReadScope));
      for (const scope of activeScopesRef.current)
        if (!targetScopes.has(scope)) groupReadCache.invalidate(scope);
      activeScopesRef.current = targetScopes;
      setReads((current) => {
        const next = { ...current };
        for (const member of targets) {
          const scope = gitReadScope(member);
          const previous =
            current[member.id]?.scope === scope
              ? current[member.id]
              : undefined;
          next[member.id] = {
            scope,
            repo: previous?.repo ?? cachedRepository(member),
            loading: true,
          };
        }
        return next;
      });
      const pending = targets.map((member) => {
        const scope = gitReadScope(member);
        let startedAt = 0;
        return groupReadCache
          .read(
            scope,
            gitReadKeys.repository,
            () => {
              startedAt = Date.now();
              return api.readGitRepository(member.id);
            },
            { force: true },
          )
          .then(
            (repo) => {
              const currentMember = membersRef.current.find(
                (current) => current.id === member.id,
              );
              if (
                refreshId.current !== id ||
                !currentMember ||
                disconnectedRef.current.includes(member.id) ||
                gitReadScope(currentMember) !== scope
              )
                return false;
              if (member.environment.kind === "ssh")
                writePersistedGitRepository(member.id, scope, repo);
              setReads((current) => ({
                ...current,
                [member.id]: { scope, repo, loading: false },
              }));
              if (repo.branch)
                onBranchReadRef.current?.(member.id, repo.branch, startedAt);
              return true;
            },
            (error: unknown) => {
              const currentMember = membersRef.current.find(
                (current) => current.id === member.id,
              );
              if (
                refreshId.current !== id ||
                !currentMember ||
                disconnectedRef.current.includes(member.id) ||
                gitReadScope(currentMember) !== scope
              )
                return false;
              setReads((current) => ({
                ...current,
                [member.id]: {
                  scope,
                  repo:
                    current[member.id]?.scope === scope
                      ? current[member.id].repo
                      : undefined,
                  error: formatOperationError(s, {
                    message: errorMessage(error),
                  }),
                  loading: false,
                },
              }));
              return true;
            },
          );
      });
      return Promise.all(pending).then(
        (published) =>
          mountedRef.current &&
          refreshId.current === id &&
          published.every(Boolean),
      );
    },
    [connectedKey, s],
  );

  useEffect(() => {
    const scopes = new Set(connected.map(gitReadScope));
    refreshId.current++;
    for (const scope of activeScopesRef.current)
      if (!scopes.has(scope)) groupReadCache.invalidate(scope);
    activeScopesRef.current = scopes;
  }, [connectedKey]);
  // The requests tab is named after the members' forge before it is opened.
  // shortcut: this read failing after the opened view's read succeeded resets the label to the generic one; drop it once the view publishes if that shows up.
  useEffect(() => {
    let current = true;
    void Promise.allSettled(
      connected.map((member) => forgeApi.readForgeRemote(member.id)),
    ).then((results) => {
      const kinds = new Set(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.kind] : [],
        ),
      );
      if (current) setForgeKind(kinds.size === 1 ? [...kinds][0] : null);
    });
    return () => {
      current = false;
    };
  }, [connectedKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshId.current++;
      for (const scope of activeScopesRef.current)
        groupReadCache.invalidatePending(scope, gitReadKeys.repository);
    };
  }, []);

  const workingKey = workingSessions.map((session) => session.id).join("\n");
  const previousWorking = useRef(workingKey);
  useEffect(() => {
    const ended = previousWorking.current
      .split("\n")
      .some((id) => id && !workingKey.split("\n").includes(id));
    previousWorking.current = workingKey;
    if (ended && visible) void refresh();
  }, [refresh, visible, workingKey]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refresh, visible]);

  const groupsByProject = new Map(
    members.map((member) => {
      const repo = reads[member.id]?.repo;
      return [
        member.id,
        repo?.availability === "ready"
          ? groupGitChanges(repo.files, order)
          : [],
      ] as const;
    }),
  );
  const groupsOf = (projectId: string) => groupsByProject.get(projectId) ?? [];
  const changesByProject = new Map(
    [...groupsByProject].map(([projectId, groups]) => [
      projectId,
      groups.flatMap((group) => group.changes),
    ]),
  );
  const changesOf = (projectId: string) =>
    changesByProject.get(projectId) ?? [];
  const errorMembers = connected.filter((member) => reads[member.id]?.error);
  const visibleMembers = connected.filter(
    (member) => reads[member.id]?.error || changesOf(member.id).length > 0,
  );
  const changedMembers = visibleMembers.filter(
    (member) => !reads[member.id]?.error && changesOf(member.id).length > 0,
  );
  const firstSelection =
    changedMembers.flatMap((member) =>
      changesOf(member.id)
        .slice(0, 1)
        .map(({ file, side }) => ({
          projectId: member.id,
          path: file.path,
          side,
        })),
    )[0] ?? null;
  const selection =
    chosen &&
    changedMembers.some((member) => member.id === chosen.projectId) &&
    changesOf(chosen.projectId).some(
      ({ file, side }) => file.path === chosen.path && side === chosen.side,
    )
      ? chosen
      : firstSelection;
  const selectedMember = selection
    ? members.find((member) => member.id === selection.projectId)
    : undefined;
  const selectedScope = selectedMember
    ? gitReadScope(selectedMember)
    : undefined;
  const selectedRepo = selectedMember
    ? reads[selectedMember.id]?.repo
    : undefined;
  // Diff paths are relative to the Git root, which may sit above the member path.
  const selectedGitRoot = selectedMember
    ? (selectedRepo?.identity?.root ?? selectedMember.path)
    : undefined;
  const selectedVersion = selection
    ? reads[selection.projectId]?.repo?.version
    : undefined;
  const selectedProjectId = selection?.projectId;
  const selectedPath = selection?.path;
  const selectedSide = selection?.side;
  useEffect(() => {
    if (
      !selectedProjectId ||
      !selectedScope ||
      !selectedPath ||
      !selectedSide ||
      !selectedVersion
    )
      return;
    const target = {
      projectId: selectedProjectId,
      path: selectedPath,
      side: selectedSide,
    };
    const key = selectionKey(target, selectedScope, selectedVersion);
    const cacheKey = gitReadKeys.comparison(
      selectedPath,
      selectedSide,
      selectedVersion,
    );
    const force = diffRetry?.key === key;
    const cached = groupReadCache.peek<GitComparison>(selectedScope, cacheKey);
    const previous =
      cached ??
      groupReadCache.peekLatest<GitComparison>(
        selectedScope,
        gitReadKeys.comparisonPrefix(selectedPath, selectedSide),
      );
    setDiff({ key, comparison: previous, loading: !cached || force });
    if (cached && !force) return;
    let current = true;
    let settled = false;
    groupReadCache
      .read(
        selectedScope,
        cacheKey,
        () =>
          api.readGitComparison(
            selectedProjectId,
            selectedPath,
            selectedSide,
            selectedVersion,
          ),
        { force },
      )
      .then(
        (comparison) => {
          settled = true;
          if (current) {
            setDiff({ key, comparison, loading: false });
            setDiffRetry(null);
          }
        },
        (error: unknown) => {
          settled = true;
          if (current)
            setDiff({
              key,
              error: formatOperationError(s, { message: errorMessage(error) }),
              loading: false,
            });
        },
      );
    return () => {
      current = false;
      if (!settled) groupReadCache.invalidate(selectedScope, cacheKey);
    };
  }, [
    diffRetry,
    s,
    selectedProjectId,
    selectedScope,
    selectedPath,
    selectedSide,
    selectedVersion,
  ]);

  const activeKey =
    selection && selectedScope && selectedVersion
      ? selectionKey(selection, selectedScope, selectedVersion)
      : null;
  const shownDiff: DiffState | null = !activeKey
    ? null
    : diff?.key === activeKey
      ? diff
      : {
          key: activeKey,
          comparison:
            selectedScope && selectedPath && selectedSide
              ? groupReadCache.peekLatest<GitComparison>(
                  selectedScope,
                  gitReadKeys.comparisonPrefix(selectedPath, selectedSide),
                )
              : undefined,
          loading: true,
        };
  const selectedDiffStale =
    !!selection &&
    !!shownDiff?.comparison &&
    shownDiff.comparison.version !== selectedVersion;
  useEffect(() => {
    if (!mutationBusy && selectedDiffStale && shownDiff?.loading === false)
      void refresh();
  }, [mutationBusy, refresh, selectedDiffStale, shownDiff?.loading]);
  const loading = connected.some((member) => reads[member.id]?.loading);
  const waiting = connected.some(
    (member) => !reads[member.id]?.repo && !reads[member.id]?.error,
  );
  const totalChanges = changedMembers.flatMap((member) =>
    changesOf(member.id).map((change) => ({
      ...change,
      projectId: member.id,
    })),
  );
  const selectionIndex = totalChanges.findIndex(
    ({ file, projectId, side }) =>
      projectId === selection?.projectId &&
      file.path === selection?.path &&
      side === selection?.side,
  );
  const fileNavigation =
    totalChanges.length > 1 ? (
      <GitFileNavigation
        count={totalChanges.length}
        index={selectionIndex}
        onSelect={(index) => {
          const change = totalChanges[index];
          setSelection({
            projectId: change.projectId,
            path: change.file.path,
            side: change.side,
          });
        }}
      />
    ) : null;
  const selectedChange = totalChanges[selectionIndex];
  const fileActions =
    !filesVisible &&
    selectedChange &&
    selectedMember &&
    selectedRepo?.availability === "ready" ? (
      <GitChangeActions
        change={selectedChange}
        blocked={actionBlockedFor(selectedMember.id)}
        restoreBlocked={restoreBlockedFor(selectedMember.id)}
        snapshotVersion={selectedRepo.version}
        onAction={(paths, side, version) =>
          requestAction(selectedMember, paths, side, version)
        }
        onRestore={(paths, version) =>
          requestRestore(selectedMember, paths, version)
        }
        onResolve={(paths, version) =>
          requestResolve(selectedMember, paths, version)
        }
      />
    ) : null;
  const changedFiles = new Map(
    totalChanges.map(({ file, projectId }) => [
      JSON.stringify([projectId, file.path]),
      file,
    ]),
  ).values();
  let additions = 0;
  let deletions = 0;
  for (const file of changedFiles) {
    additions += file.added ?? 0;
    deletions += file.deleted ?? 0;
  }
  const commitTargets = changedMembers.flatMap((member) => {
    const repo = reads[member.id]?.repo;
    return repo?.availability === "ready"
      ? [
          {
            name: member.name,
            projectId: member.id,
            scope: gitReadScope(member),
            version: repo.version,
            paths: groupsOf(member.id)
              .filter(({ key }) => key === "unstaged")
              .flatMap(({ changes }) => changes)
              .map(({ file }) => file.path),
          },
        ]
      : [];
  });
  const stageTargets = commitTargets.filter(({ paths }) => paths.length);
  const hasUnactionableChanges = (projectId: string) =>
    groupsOf(projectId)
      .filter(({ key }) => key === "unstaged")
      .flatMap(({ changes }) => changes)
      .some(({ file }) => !file.actionable);
  const stageBlocked = stageTargets.some(
    ({ projectId }) =>
      actionBlockedFor(projectId) || hasUnactionableChanges(projectId),
  );
  let commitBlockedTitle;
  if (
    commitTargets.some(
      ({ projectId }) => groupsOf(projectId)[0]?.changes.length,
    )
  )
    commitBlockedTitle = g.conflictsBlockCommit;
  else if (
    commitTargets.some(({ projectId }) => reads[projectId]?.repo?.operation)
  )
    commitBlockedTitle = g.operationBlocksMutation;
  else if (
    commitTargets.some(
      ({ projectId }) =>
        reads[projectId]?.error ||
        reads[projectId]?.repo?.limited ||
        hasUnactionableChanges(projectId),
    )
  )
    commitBlockedTitle = g.actionUnavailable;
  else if (
    commitTargets.some(({ projectId }) => !reads[projectId]?.repo?.branch)
  )
    commitBlockedTitle = g.detached;
  const commitBlocked =
    commitTargets.length === 0 ||
    commitTargets.some(({ projectId }) => {
      const repo = reads[projectId]?.repo;
      return (
        actionBlockedFor(projectId) ||
        !repo?.branch ||
        !!repo.operation ||
        !!groupsOf(projectId)[0]?.changes.length ||
        hasUnactionableChanges(projectId)
      );
    });
  const restoreChanged =
    !!restoreTarget && !mutationTargetIsCurrent(restoreTarget);
  const resolveChanged =
    !!resolveTarget && !mutationTargetIsCurrent(resolveTarget);
  useNotification(
    visible && (restoreChanged || resolveChanged)
      ? {
          key: "group-git:repository-changed",
          message: g.repositoryChanged,
          tone: "warning",
        }
      : null,
  );
  useNotification(
    visible && resolveTarget?.allowMarkers
      ? {
          key: "group-git:conflict-markers",
          message: g.markerWarning,
          tone: "warning",
        }
      : null,
  );

  function currentSnapshotFor(projectId: string): GitSnapshot | null {
    const member = membersRef.current.find(
      (current) => current.id === projectId,
    );
    const repo = readsRef.current[projectId]?.repo;
    return member &&
      !disconnectedRef.current.includes(projectId) &&
      repo?.availability === "ready"
      ? {
          projectId,
          scope: gitReadScope(member),
          version: repo.version,
        }
      : null;
  }

  function mutationTargetIsCurrent(target: MutationTarget) {
    return isGitSnapshotCurrent(target, currentSnapshotFor(target.projectId));
  }

  function actionBlockedFor(projectId: string) {
    const read = reads[projectId];
    const repo = read?.repo;
    return (
      mutationBusy ||
      (projectId === selection?.projectId && selectedDiffStale) ||
      disconnectedProjectIds.includes(projectId) ||
      !!read?.error ||
      repo?.availability !== "ready" ||
      repo.limited ||
      (!!repo.operation && repo.operation !== "merge")
    );
  }
  function restoreBlockedFor(projectId: string) {
    const repo = reads[projectId]?.repo;
    return (
      actionBlockedFor(projectId) ||
      !repo?.head ||
      !!repo.operation ||
      !!groupsOf(projectId)[0]?.changes.length
    );
  }

  async function mutateProjects<T extends MutationTarget>(
    operation: "commit" | "stage" | "unstage" | "restore" | "resolve",
    targets: T[],
    mutate: (target: T) => Promise<GitMutationResult>,
  ) {
    if (
      mutationRef.current ||
      targets.length === 0 ||
      targets.some((target) => !mutationTargetIsCurrent(target))
    )
      return null;
    mutationRef.current = true;
    refreshId.current++;
    for (const target of targets)
      groupReadCache.invalidateMutable(target.scope);
    setMutationBusy(true);
    try {
      const results: PromiseSettledResult<GitMutationResult>[] = [];
      let interrupted = false;
      for (const target of targets) {
        if (!mutationTargetIsCurrent(target)) {
          interrupted = true;
          break;
        }
        try {
          results.push({ status: "fulfilled", value: await mutate(target) });
        } catch (reason) {
          results.push({ status: "rejected", reason });
        }
      }
      results.forEach((result, index) => {
        const target = targets[index];
        if (result.status === "rejected")
          notifyError(
            `${target.name}: ${formatOperationError(s, {
              message: gitErrorMessage(result.reason),
              warning: gitErrorUncertain(result.reason)
                ? g.uncertain
                : undefined,
            })}`,
            {
              key: `group-git:${operation}:${target.projectId}`,
              action: {
                label: s.openGroupMember(target.name),
                onAction: () => onSelectProject(target.projectId),
              },
            },
          );
        else if (result.value.warning)
          notifyWarning(`${target.name}: ${g.operationCompletedWithWarning}`, {
            key: `group-git:${operation}:${target.projectId}:warning`,
          });
      });
      return interrupted ? null : results;
    } finally {
      for (const target of targets)
        groupReadCache.invalidateMutable(target.scope);
      while (mountedRef.current && !(await refresh(true))) {}
      mutationRef.current = false;
      if (mountedRef.current) {
        onMutation?.();
        setMutationBusy(false);
      }
    }
  }

  const stageAll = () =>
    mutateProjects("stage", stageTargets, (target) =>
      api.stageGitFiles(target.projectId, target.paths, target.version),
    );

  function requestAction(
    member: AgentProject,
    paths: string[],
    side: GitSide,
    version: string,
  ) {
    const repo = reads[member.id]?.repo;
    if (
      actionBlockedFor(member.id) ||
      repo?.version !== version ||
      paths.length === 0 ||
      paths.some(
        (path) => !repo.files.find((file) => file.path === path)?.actionable,
      )
    )
      return;
    const target: PathMutationTarget = {
      name: member.name,
      projectId: member.id,
      scope: gitReadScope(member),
      version,
      paths,
    };
    void mutateProjects(
      side === "staged" ? "unstage" : "stage",
      [target],
      (current) =>
        side === "staged"
          ? api.unstageGitFiles(
              current.projectId,
              current.paths,
              current.version,
            )
          : api.stageGitFiles(
              current.projectId,
              current.paths,
              current.version,
            ),
    );
  }

  function requestRestore(
    member: AgentProject,
    paths: string[],
    version: string,
  ) {
    const repo = reads[member.id]?.repo;
    if (
      restoreBlockedFor(member.id) ||
      repo?.version !== version ||
      paths.length === 0 ||
      paths.some(
        (path) =>
          !canRestoreGitFile(
            repo.files.find((current) => current.path === path),
          ),
      )
    )
      return;
    setRestoreTarget({
      name: member.name,
      projectId: member.id,
      scope: gitReadScope(member),
      version,
      paths,
    });
  }

  function requestResolve(
    member: AgentProject,
    paths: string[],
    version: string,
  ) {
    const repo = reads[member.id]?.repo;
    if (
      actionBlockedFor(member.id) ||
      repo?.version !== version ||
      paths.length === 0 ||
      paths.some(
        (path) =>
          !canResolveGitFile(
            repo.files.find((current) => current.path === path),
          ),
      )
    )
      return;
    setResolveTarget({
      allowMarkers: paths.some(
        (path) =>
          selection?.projectId === member.id &&
          selection.path === path &&
          !shownDiff?.loading &&
          shownDiff?.comparison?.version === version &&
          hasGitConflictMarkers(shownDiff.comparison.after.text),
      ),
      name: member.name,
      projectId: member.id,
      scope: gitReadScope(member),
      version,
      paths,
    });
  }

  async function confirmRestore() {
    const target = restoreTarget;
    if (!target || restoreChanged || restoreBlockedFor(target.projectId))
      return;
    setRestoreTarget(null);
    await mutateProjects("restore", [target], (current) =>
      api.restoreGitFiles(current.projectId, current.paths, current.version),
    );
  }

  async function confirmResolve() {
    const target = resolveTarget;
    if (!target || resolveChanged || actionBlockedFor(target.projectId)) return;
    setResolveTarget(null);
    await mutateProjects("resolve", [target], (current) =>
      api.resolveGitFiles(
        current.projectId,
        current.paths,
        current.version,
        current.allowMarkers,
      ),
    );
  }

  async function commitAll() {
    if (commitBlocked) return;
    setCommitting(true);
    try {
      // shortcut: a missing Codex CLI or Git identity notifies once per repository, without the identity dialog; stop the batch on those codes if it gets noisy.
      await mutateProjects("commit", commitTargets, (target) =>
        api.quickCommitGitChanges(
          target.projectId,
          target.paths,
          target.version,
        ),
      );
    } finally {
      if (mountedRef.current) setCommitting(false);
    }
  }

  return (
    <>
      <section
        className="agent-git-panel project-group-panel"
        hidden={!visible}
        aria-label={`${s.groupOverview} · ${groupName}`}
        aria-busy={mutationBusy || undefined}
      >
        <header className="agent-git-panel-header">
          <div className="git-panel-heading">
            <GitPanelViewSwitch
              views={["changes", "requests"] as const}
              active={view}
              label={(current) =>
                current === "changes"
                  ? g.changesView
                  : g.forgeRequests(forgeKind)
              }
              onSelect={(next) => {
                setView(next);
                if (next === "requests") setRequestsOpened(true);
              }}
            />
            <p title={groupName}>{groupName}</p>
          </div>
          <GitPanelHeaderActions
            busy={
              view === "changes" &&
              (loading || mutationBusy) &&
              !waiting &&
              // The commit button already spins next to its action.
              !(committing && filesVisible)
            }
            busyLabel={g.operationPending}
            filesVisible={filesVisible}
            listId={fileListId}
            showFilesToggle={view === "changes"}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onToggleFiles={() => setFilesVisible(!filesVisible)}
            onClose={onClose}
          />
        </header>
        {requestsOpened ? (
          <div
            hidden={view !== "requests"}
            style={{ display: view === "requests" ? "contents" : "none" }}
          >
            <GitForgeView
              active={visible && view === "requests"}
              projects={connected}
              readScope={connectedKey}
              loginRevision={forgeLoginRevision}
              onKind={setForgeKind}
              onLogin={onForgeLogin}
            />
          </div>
        ) : null}
        <div
          hidden={view !== "changes"}
          style={{ display: view === "changes" ? "contents" : "none" }}
        >
          {members.length > 0 && connected.length === 0 ? (
            <EmptyState
              actions={connectAction?.(members[0].id)}
              description={s.groupDisconnectedBody}
              fill
              headingLevel={3}
              icon={<Unplug />}
              role="status"
              title={s.groupDisconnectedTitle}
            />
          ) : waiting ? (
            <LoadingState className="git-panel-centered-status">
              {s.groupRepositoriesLoading}
            </LoadingState>
          ) : (
            <>
              {disconnectedMembers.length ? (
                <div className="git-panel-notice" role="status">
                  <Unplug size={14} aria-hidden="true" />
                  <span>
                    {s.groupDisconnected(
                      disconnectedMembers
                        .map((member) => member.name)
                        .join(", "),
                    )}
                  </span>
                  {/* shortcut: connects one SSH connection per click; members on another host stay listed until connected too. */}
                  {connectAction?.(disconnectedMembers[0].id, "small")}
                </div>
              ) : null}
              <GitChangesWorkspace
                filePane={{
                  defaultRatio: 40,
                  listId: fileListId,
                  maxRatio: 80,
                  minRatio: 15,
                  ratio: filesRatio,
                  visible: filesVisible,
                  onRatioChange: setFilesRatio,
                }}
                sidebarLabel={s.groupRepositories}
                sidebar={
                  <div className="git-change-list">
                    <div className="git-file-list-toolbar">
                      <div className="git-commit-actions">
                        <Button
                          className="git-commit-toggle"
                          size="small"
                          disabled={mutationBusy || commitBlocked}
                          aria-label={`${g.commit} · ${groupName}`}
                          title={
                            committing
                              ? g.quickCommitting
                              : (commitBlockedTitle ?? g.groupQuickCommit)
                          }
                          startIcon={
                            committing ? (
                              <LoaderCircle className="app-loading-spinner" />
                            ) : (
                              <Sparkles />
                            )
                          }
                          onClick={() => void commitAll()}
                        >
                          {g.commit}
                        </Button>
                      </div>
                      <span className="git-file-list-actions">
                        <GitChangeOrderMenu order={order} onChange={setOrder} />
                        <GitFileViewToggle
                          tree={tree}
                          onToggle={toggleFileLayout}
                        />
                      </span>
                    </div>
                    {totalChanges.length ? (
                      <div className="project-group-changes-summary">
                        <strong>
                          {g.changesView} {totalChanges.length}
                        </strong>
                        <span className="git-change-group-actions is-visible">
                          <span className="git-file-stats git-change-group-total">
                            {additions > 0 ? (
                              <span className="git-lines-added">
                                +{additions}
                              </span>
                            ) : null}
                            {deletions > 0 ? (
                              <span className="git-lines-deleted">
                                −{deletions}
                              </span>
                            ) : null}
                          </span>
                          {stageTargets.length ? (
                            <IconButton
                              size="small"
                              disabled={mutationBusy || stageBlocked}
                              aria-label={`${g.stageAll} · ${groupName}`}
                              title={
                                stageBlocked ? g.actionUnavailable : g.stageAll
                              }
                              onClick={() => void stageAll()}
                            >
                              <Plus />
                            </IconButton>
                          ) : null}
                        </span>
                      </div>
                    ) : null}
                    <div className="git-change-groups">
                      {visibleMembers.length === 0 ? (
                        <EmptyState
                          description={
                            members.length === 0 ? s.groupEmpty : g.noChanges
                          }
                          size="compact"
                        />
                      ) : null}
                      {visibleMembers.map((member) => (
                        <ProjectGroupMemberChanges
                          key={member.id}
                          member={member}
                          read={reads[member.id]}
                          memberChanges={changesOf(member.id)}
                          groups={groupsOf(member.id)}
                          agents={
                            workingSessions.filter(
                              (session) => session.projectId === member.id,
                            ).length
                          }
                          tree={tree}
                          order={order}
                          selection={selection}
                          isCollapsed={collapsed.has(member.id)}
                          actionBlocked={actionBlockedFor(member.id)}
                          restoreBlocked={restoreBlockedFor(member.id)}
                          setSelection={setSelection}
                          setCollapsed={setCollapsed}
                          requestAction={requestAction}
                          requestRestore={requestRestore}
                          requestResolve={requestResolve}
                          onSelectProject={onSelectProject}
                        />
                      ))}
                    </div>
                  </div>
                }
              >
                <div
                  className="git-diff-area"
                  role="region"
                  aria-label={g.files}
                >
                  <GitChangesDiffContent
                    comparison={shownDiff?.comparison}
                    loading={shownDiff?.loading ?? false}
                    fileActions={fileActions}
                    navigation={fileNavigation}
                    side={selection?.side}
                    commentTargets={commentTargets?.filter(
                      (target) =>
                        target.projectId === selectedMember?.id ||
                        !members.some(
                          (member) => member.id === target.projectId,
                        ),
                    )}
                    commentRepository={
                      selectedMember && selectedGitRoot
                        ? { name: selectedMember.name, path: selectedGitRoot }
                        : undefined
                    }
                    commentGitRoot={selectedGitRoot}
                    commentFiles={selectedRepo?.files}
                  >
                    {shownDiff?.error ? (
                      <EmptyState
                        actions={
                          <Button
                            size="small"
                            onClick={() => setDiffRetry({ key: shownDiff.key })}
                          >
                            {g.retry}
                          </Button>
                        }
                        description={shownDiff.error}
                        fill
                        role="alert"
                      />
                    ) : errorMembers.length ? (
                      <EmptyState
                        actions={
                          <Button size="small" onClick={() => void refresh()}>
                            {g.retry}
                          </Button>
                        }
                        description={reads[errorMembers[0].id]?.error}
                        fill
                        role="alert"
                      />
                    ) : (
                      <EmptyState
                        fill
                        icon={<CheckCircle2 />}
                        title={g.cleanTitle}
                      />
                    )}
                  </GitChangesDiffContent>
                </div>
              </GitChangesWorkspace>
            </>
          )}
        </div>
      </section>
      {visible && restoreTarget
        ? createPortal(
            <GitRestoreConfirmationDialog
              busy={mutationBusy}
              changed={restoreChanged}
              paths={restoreTarget.paths}
              blocked={restoreBlockedFor(restoreTarget.projectId)}
              onCancel={() => {
                if (!mutationBusy) setRestoreTarget(null);
              }}
              onConfirm={() => void confirmRestore()}
            />,
            document.body,
          )
        : null}
      {visible && resolveTarget
        ? createPortal(
            <GitResolveConfirmationDialog
              busy={mutationBusy}
              changed={resolveChanged}
              paths={resolveTarget.paths}
              blocked={actionBlockedFor(resolveTarget.projectId)}
              onCancel={() => {
                if (!mutationBusy) setResolveTarget(null);
              }}
              onConfirm={() => void confirmResolve()}
            />,
            document.body,
          )
        : null}
    </>
  );
}
