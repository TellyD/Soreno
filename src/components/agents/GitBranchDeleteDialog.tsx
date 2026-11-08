import type { RefObject } from "react";
import type {
  GitBranch as GitBranchValue,
  GitWorktree,
} from "../../domain/projectGit";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { useGitStrings } from "./gitStrings";

export type GitBranchDeleteRequest =
  | {
      kind: "branch";
      projectId: string;
      scope: string;
      version: string;
      branch: GitBranchValue;
    }
  | {
      kind: "worktree";
      projectId: string;
      scope: string;
      worktree: GitWorktree;
    }
  | {
      kind: "merge";
      projectId: string;
      scope: string;
      worktree: GitWorktree & { branch: string };
      base: string;
    };

export function GitBranchDeleteDialog({
  request,
  runningSessions,
  returnFocusRef,
  pending,
  disabled,
  onCancel,
  onConfirm,
}: {
  request: GitBranchDeleteRequest;
  runningSessions: number;
  returnFocusRef: RefObject<HTMLElement | null>;
  pending: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useGitStrings();
  return (
    <ConfirmationDialog
      returnFocusRef={returnFocusRef}
      title={
        request.kind === "branch"
          ? s.deleteBranchTitle
          : request.kind === "merge"
            ? s.mergeWorktreeTitle(request.base)
            : s.deleteWorktreeTitle
      }
      description={
        <span className="git-commit-confirmation">
          <span>
            {request.kind === "branch"
              ? s.deleteBranchDescription
              : request.kind === "merge"
                ? s.mergeWorktreeDescription(
                    request.worktree.branch,
                    request.base,
                  )
                : s.deleteWorktreeDescription}
          </span>
          <span>
            <strong>
              {request.kind === "branch" ? s.worktreeBranch : s.worktreeFolder}:
            </strong>{" "}
            {request.kind === "branch"
              ? request.branch.name
              : request.worktree.path}
          </span>
          {runningSessions > 0 ? (
            <span>{s.worktreeSessionsWillStop(runningSessions)}</span>
          ) : null}
        </span>
      }
      cancelLabel={s.cancel}
      closeLabel={s.cancel}
      confirmLabel={
        request.kind === "branch"
          ? s.deleteBranch
          : runningSessions > 0
            ? request.kind === "merge"
              ? s.stopSessionsAndMerge
              : s.stopSessionsAndDelete
            : request.kind === "merge"
              ? s.mergeWorktreeConfirm
              : s.deleteWorktree
      }
      confirmPending={pending}
      confirmDisabled={disabled}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
