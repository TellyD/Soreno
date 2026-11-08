import { useEffect, useState } from "react";
import * as api from "../data/projectGitApi";
import {
  canResolveGitFile,
  canRestoreGitFile,
  groupGitChanges,
  hasGitConflictMarkers,
  isGitSnapshotCurrent,
  type GitMutationResult,
  type GitSide,
  type GitSnapshot,
} from "../domain/projectGit";
import type { useProjectGit } from "./useProjectGit";

type GitState = ReturnType<typeof useProjectGit>;

export type GitChangesCommitConfirmation = GitSnapshot & {
  merge: boolean;
  message: string;
};

type CommitConfirmation = GitChangesCommitConfirmation & {
  clearMessage: (message: string) => void;
};
type GitIdentityRequest = GitSnapshot;
type GitRestoreConfirmation = GitIdentityRequest & { paths: string[] };
type GitResolveConfirmation = GitRestoreConfirmation & {
  allowMarkers: boolean;
};
export type GitCommitWarning = {
  historyOid?: string | null;
  scope: string;
};

export type GitChangesActions = {
  blocked: boolean;
  restoreBlocked: boolean;
  onAction: (paths: string[], side: GitSide, version: string) => void;
  onResolve: (paths: string[], version: string) => void;
  onRestore: (paths: string[], version: string) => void;
};

export type GitChangesCommit = {
  blockedTitle?: string;
  changed: boolean;
  confirmation: GitChangesCommitConfirmation | null;
  disabled: boolean;
  generationDisabled: boolean;
  merge: boolean;
  open: boolean;
  onCancel: () => void;
  onCommit: () => void;
  onMessage: (message: string) => void;
  onToggle: () => void;
  quickDisabled: boolean;
  quickPending: boolean;
  onQuickCommit: () => void;
};

export type GitChangesConfirmationsState = {
  actionBlocked: boolean;
  busy: boolean;
  identity: GitIdentityRequest | null;
  identityChanged: boolean;
  identityEmail: string;
  identityGlobal: boolean;
  identityName: string;
  resolve: GitResolveConfirmation | null;
  resolveChanged: boolean;
  restore: GitRestoreConfirmation | null;
  restoreBlocked: boolean;
  restoreChanged: boolean;
  onCancelIdentity: () => void;
  onCancelResolve: () => void;
  onCancelRestore: () => void;
  onConfirmResolve: () => void;
  onConfirmRestore: () => void;
  onIdentityEmail: (value: string) => void;
  onIdentityGlobal: (value: boolean) => void;
  onIdentityName: (value: string) => void;
  onSaveIdentity: () => void;
};

type UseGitChangesMutationsOptions = {
  active: boolean;
  blockedTitles: {
    conflicts: string;
    detached: string;
    operation: string;
  };
  git: GitState;
  onCommitWarning: (warning: GitCommitWarning | null) => void;
  projectId?: string;
  scope?: string;
};

function errorCode(reason: unknown): string | null {
  return reason && typeof reason === "object" && "code" in reason
    ? String(reason.code)
    : null;
}

export function useGitChangesMutations({
  active,
  blockedTitles,
  git,
  onCommitWarning,
  projectId,
  scope,
}: UseGitChangesMutationsOptions) {
  const [commitConfirmation, setCommitConfirmation] =
    useState<CommitConfirmation | null>(null);
  const [commitComposerOpen, setCommitComposerOpen] = useState(false);
  const [quickPending, setQuickPending] = useState(false);
  const [identityRequest, setIdentityRequest] =
    useState<GitIdentityRequest | null>(null);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [identityGlobal, setIdentityGlobal] = useState(true);
  const [restoreConfirmation, setRestoreConfirmation] =
    useState<GitRestoreConfirmation | null>(null);
  const [resolveConfirmation, setResolveConfirmation] =
    useState<GitResolveConfirmation | null>(null);

  useEffect(() => {
    if (
      git.hasFreshStatus &&
      git.repo?.operation === "merge" &&
      git.repo.mergeMessage &&
      !git.draft.message.trim()
    )
      git.updateDraft({ message: git.repo.mergeMessage });
  }, [
    projectId,
    git.hasFreshStatus,
    git.repo?.operation,
    git.repo?.mergeMessage,
  ]);

  const groups = groupGitChanges(git.repo?.files ?? []);
  const conflicts = groups[0].changes;
  const unstaged = groups[1].changes;
  const staged = groups[2].changes;
  const incompatibleOperation =
    !!git.repo?.operation && git.repo.operation !== "merge";
  const mutationBlocked = git.busy || !!git.error?.uncertain;
  const actionBlocked =
    git.busy ||
    !!git.error ||
    git.stale ||
    !!git.repo?.limited ||
    incompatibleOperation;
  const restoreBlocked =
    actionBlocked ||
    !git.repo?.head ||
    !!git.repo?.operation ||
    !!conflicts.length;
  const mergeCommit = git.repo?.operation === "merge" && !!git.repo.head;
  const commitDisabled =
    mutationBlocked ||
    !git.repo ||
    (!mergeCommit && (!git.repo.branch || !staged.length)) ||
    git.repo.limited ||
    !!conflicts.length ||
    git.stale ||
    incompatibleOperation;
  const commitBlockedTitle = incompatibleOperation
    ? blockedTitles.operation
    : !mergeCommit && !git.repo?.branch
      ? blockedTitles.detached
      : conflicts.length
        ? blockedTitles.conflicts
        : undefined;
  const quickDisabled =
    !active ||
    actionBlocked ||
    !git.repo?.branch ||
    !!git.repo.operation ||
    !!conflicts.length ||
    (!staged.length && !unstaged.length) ||
    unstaged.some(({ file }) => !file.actionable);
  const currentSnapshot =
    projectId && scope !== undefined && git.repo
      ? { projectId, scope, version: git.repo.version }
      : null;

  async function requestAction(
    paths: string[],
    side: GitSide,
    version: string,
  ) {
    if (
      !active ||
      !projectId ||
      scope === undefined ||
      !git.repo ||
      git.repo.version !== version ||
      actionBlocked ||
      git.isBusy()
    )
      return;
    await git.mutate(() =>
      side === "staged"
        ? api.unstageGitFiles(projectId, paths, version)
        : api.stageGitFiles(projectId, paths, version),
    );
  }

  function requestRestore(paths: string[], version: string) {
    if (
      !active ||
      !projectId ||
      scope === undefined ||
      !git.repo ||
      git.repo.version !== version ||
      restoreBlocked ||
      paths.length === 0
    )
      return;
    const files = new Map(git.repo.files.map((file) => [file.path, file]));
    if (paths.some((path) => !canRestoreGitFile(files.get(path)))) return;
    setRestoreConfirmation({ paths, projectId, scope, version });
  }

  async function confirmRestore() {
    const confirmation = restoreConfirmation;
    if (
      !active ||
      !confirmation ||
      !isGitSnapshotCurrent(confirmation, currentSnapshot) ||
      restoreBlocked ||
      git.isBusy()
    )
      return;
    setRestoreConfirmation(null);
    await git.mutate(() =>
      api.restoreGitFiles(
        confirmation.projectId,
        confirmation.paths,
        confirmation.version,
      ),
    );
  }

  function requestResolve(paths: string[], version: string) {
    if (
      !active ||
      !projectId ||
      scope === undefined ||
      !git.repo ||
      git.repo.version !== version ||
      actionBlocked ||
      !paths.length
    )
      return;
    const files = new Map(git.repo.files.map((file) => [file.path, file]));
    if (paths.some((path) => !canResolveGitFile(files.get(path)))) return;
    const allowMarkers = paths.some(
      (path) =>
        git.diff?.path === path && hasGitConflictMarkers(git.diff.after.text),
    );
    setResolveConfirmation({
      allowMarkers,
      paths,
      projectId,
      scope,
      version,
    });
  }

  async function confirmResolve() {
    const confirmation = resolveConfirmation;
    if (
      !active ||
      !confirmation ||
      !isGitSnapshotCurrent(confirmation, currentSnapshot) ||
      actionBlocked ||
      git.isBusy()
    )
      return;
    setResolveConfirmation(null);
    await git.mutate(() =>
      api.resolveGitFiles(
        confirmation.projectId,
        confirmation.paths,
        confirmation.version,
        confirmation.allowMarkers,
      ),
    );
  }

  function toggleCommitComposer() {
    if (commitComposerOpen && commitConfirmation?.scope === scope) {
      setCommitComposerOpen(false);
      return;
    }
    if (
      !active ||
      !projectId ||
      scope === undefined ||
      !git.repo ||
      commitDisabled
    )
      return;
    setCommitConfirmation({
      merge: mergeCommit,
      message: git.draft.message,
      projectId,
      scope,
      version: git.repo.version,
      clearMessage: git.clearCommittedMessage,
    });
    setCommitComposerOpen(true);
  }

  async function confirmCommit() {
    const confirmation = commitConfirmation;
    if (
      !active ||
      !confirmation ||
      commitDisabled ||
      !confirmation.message.trim() ||
      !isGitSnapshotCurrent(confirmation, currentSnapshot) ||
      git.isBusy() ||
      (confirmation.merge && !git.repo?.head)
    )
      return;
    setCommitComposerOpen(false);
    setCommitConfirmation(null);
    onCommitWarning(null);
    const result = await git.mutate(async () => {
      try {
        const committed = await api.commitGitChanges(
          confirmation.projectId,
          confirmation.message,
          confirmation.version,
        );
        if (committed.oid) confirmation.clearMessage(confirmation.message);
        return committed;
      } catch (reason) {
        if (errorCode(reason) === "identity")
          setIdentityRequest({
            projectId: confirmation.projectId,
            scope: confirmation.scope,
            version: confirmation.version,
          });
        throw reason;
      }
    });
    if (result?.warning)
      onCommitWarning({
        historyOid: result.oid,
        scope: confirmation.scope,
      });
  }

  async function quickCommit() {
    if (
      quickDisabled ||
      !projectId ||
      scope === undefined ||
      !git.repo ||
      git.isBusy()
    )
      return;
    const target = { projectId, scope, version: git.repo.version };
    const paths = unstaged.map(({ file }) => file.path);
    setCommitComposerOpen(false);
    setCommitConfirmation(null);
    onCommitWarning(null);
    setQuickPending(true);
    const result = await git.mutate(async () => {
      try {
        return await api.quickCommitGitChanges(
          target.projectId,
          paths,
          target.version,
        );
      } catch (reason) {
        if (errorCode(reason) === "identity") setIdentityRequest(target);
        throw reason;
      }
    });
    setQuickPending(false);
    if (result?.warning)
      onCommitWarning({ historyOid: result.oid, scope: target.scope });
  }

  async function saveIdentity() {
    const request = identityRequest;
    if (
      !active ||
      !request ||
      !isGitSnapshotCurrent(request, currentSnapshot) ||
      git.isBusy()
    )
      return;
    const result: GitMutationResult | undefined = await git.mutate(() =>
      api.setGitIdentity(
        request.projectId,
        identityName.trim(),
        identityEmail.trim(),
        identityGlobal,
        request.version,
      ),
    );
    if (result !== undefined) setIdentityRequest(null);
  }

  const activeCommitConfirmation =
    commitConfirmation &&
    scope !== undefined &&
    commitConfirmation.scope === scope
      ? commitConfirmation
      : null;
  const activeRestoreConfirmation =
    restoreConfirmation &&
    scope !== undefined &&
    restoreConfirmation.scope === scope
      ? restoreConfirmation
      : null;
  const activeResolveConfirmation =
    resolveConfirmation &&
    scope !== undefined &&
    resolveConfirmation.scope === scope
      ? resolveConfirmation
      : null;
  const activeIdentityRequest =
    identityRequest && scope !== undefined && identityRequest.scope === scope
      ? identityRequest
      : null;
  const commitChanged =
    !!activeCommitConfirmation &&
    !isGitSnapshotCurrent(activeCommitConfirmation, currentSnapshot);
  const restoreChanged =
    !!activeRestoreConfirmation &&
    !isGitSnapshotCurrent(activeRestoreConfirmation, currentSnapshot);
  const resolveChanged =
    !!activeResolveConfirmation &&
    !isGitSnapshotCurrent(activeResolveConfirmation, currentSnapshot);
  const identityChanged =
    !!activeIdentityRequest &&
    !isGitSnapshotCurrent(activeIdentityRequest, currentSnapshot);

  const actions: GitChangesActions = {
    blocked: actionBlocked,
    restoreBlocked,
    onAction: requestAction,
    onResolve: requestResolve,
    onRestore: requestRestore,
  };
  const commit: GitChangesCommit = {
    blockedTitle: commitBlockedTitle,
    changed: commitChanged,
    confirmation: activeCommitConfirmation,
    disabled: commitDisabled,
    generationDisabled: !active || commitDisabled || !staged.length,
    merge: mergeCommit,
    open: commitComposerOpen,
    onCancel: () => setCommitComposerOpen(false),
    onCommit: () => void confirmCommit(),
    onMessage: (message) => {
      if (!activeCommitConfirmation || commitChanged) return;
      setCommitConfirmation({ ...activeCommitConfirmation, message });
      git.updateDraft({ message });
    },
    onToggle: toggleCommitComposer,
    quickDisabled,
    quickPending,
    onQuickCommit: () => void quickCommit(),
  };
  const confirmations: GitChangesConfirmationsState = {
    actionBlocked,
    busy: git.busy,
    identity: activeIdentityRequest,
    identityChanged,
    identityEmail,
    identityGlobal,
    identityName,
    resolve: activeResolveConfirmation,
    resolveChanged,
    restore: activeRestoreConfirmation,
    restoreBlocked,
    restoreChanged,
    onCancelIdentity: () => {
      if (!git.busy) setIdentityRequest(null);
    },
    onCancelResolve: () => {
      if (!git.busy) setResolveConfirmation(null);
    },
    onCancelRestore: () => {
      if (!git.busy) setRestoreConfirmation(null);
    },
    onConfirmResolve: () => void confirmResolve(),
    onConfirmRestore: () => void confirmRestore(),
    onIdentityEmail: setIdentityEmail,
    onIdentityGlobal: setIdentityGlobal,
    onIdentityName: setIdentityName,
    onSaveIdentity: () => void saveIdentity(),
  };

  return { actions, commit, confirmations, incompatibleOperation };
}
