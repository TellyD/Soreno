import {
  ChevronRight,
  FileCode2,
  Folder,
  Minus,
  Plus,
  SquareDot,
  SquareMinus,
  SquarePlus,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { projectFileName, projectFileParent } from "../../domain/projectFiles";
import {
  canResolveGitFile,
  canRestoreGitFile,
  type GitChange,
  type GitSide,
} from "../../domain/projectGit";
import type { GitFileTreeNode } from "../../domain/gitFileTree";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { useGitStrings, type GitStrings } from "./gitStrings";

function gitStatusIcon(status: string) {
  return status === "M"
    ? SquareDot
    : status === "A" || status === "?"
      ? SquarePlus
      : status === "D"
        ? SquareMinus
        : FileCode2;
}

function statusName(status: string, s: GitStrings): string {
  return (
    (
      {
        ".": s.unchanged,
        "?": s.untracked,
        A: s.added,
        M: s.modified,
        D: s.deleted,
        R: s.renamed,
        C: s.copied,
        T: s.typeChanged,
        U: s.unmerged,
      } as Record<string, string>
    )[status] ?? status
  );
}

export function GitFileStats({
  added,
  deleted,
}: {
  added: number | null;
  deleted: number | null;
}) {
  return (
    <span className="git-file-stats">
      {added !== null && added > 0 ? (
        <span className="git-lines-added">+{added}</span>
      ) : null}
      {deleted !== null && deleted > 0 ? (
        <span className="git-lines-deleted">−{deleted}</span>
      ) : null}
    </span>
  );
}

export function GitFileTree({
  nodes,
  rows,
}: {
  nodes: GitFileTreeNode[];
  rows: Map<string, ReactNode>;
}) {
  return (
    <ul>
      {nodes.map((node) =>
        node.children ? (
          <li className="git-tree-directory" key={`directory:${node.path}`}>
            <details open>
              <summary title={node.path}>
                <ChevronRight size={12} aria-hidden="true" />
                <Folder size={13} aria-hidden="true" />
                <span>{node.name}</span>
                <small>{node.count}</small>
              </summary>
              <GitFileTree nodes={node.children} rows={rows} />
            </details>
          </li>
        ) : (
          rows.get(node.path)
        ),
      )}
    </ul>
  );
}

export function GitBulkChangeActions({
  changes,
  side,
  snapshotVersion,
  blocked,
  restoreBlocked,
  ariaPrefix,
  onAction,
  onRestore,
}: {
  changes: GitChange[];
  side: GitSide;
  snapshotVersion: string;
  blocked: boolean;
  restoreBlocked: boolean;
  ariaPrefix?: string;
  onAction: (paths: string[], side: GitSide, version: string) => void;
  onRestore: (paths: string[], version: string) => void;
}) {
  const s = useGitStrings();
  if (!changes.length) return null;
  const paths = changes.map(({ file }) => file.path);
  const actionLabel = side === "staged" ? s.unstageAll : s.stageAll;
  const accessibleLabel = (label: string) =>
    `${ariaPrefix ? `${ariaPrefix} · ` : ""}${label}`;
  const actionUnavailable = changes.some(({ file }) => !file.actionable);
  const restoreUnavailable = changes.some(
    ({ file }) => !canRestoreGitFile(file),
  );

  return (
    <>
      {side === "unstaged" ? (
        <IconButton
          size="small"
          aria-label={accessibleLabel(s.restoreAll)}
          title={restoreUnavailable ? s.actionUnavailable : s.restoreAll}
          disabled={restoreBlocked || restoreUnavailable}
          onClick={() => onRestore(paths, snapshotVersion)}
        >
          <Undo2 />
        </IconButton>
      ) : null}
      <IconButton
        size="small"
        aria-label={accessibleLabel(actionLabel)}
        title={actionUnavailable ? s.actionUnavailable : actionLabel}
        disabled={blocked || actionUnavailable}
        onClick={() => onAction(paths, side, snapshotVersion)}
      >
        {side === "staged" ? <Minus /> : <Plus />}
      </IconButton>
    </>
  );
}

export function GitChangeRow({
  change,
  tree,
  selected,
  blocked,
  restoreBlocked,
  snapshotVersion,
  ariaPrefix,
  showStatus = false,
  onSelect,
  onAction,
  onRestore,
  onResolve,
}: {
  change: GitChange;
  tree: boolean;
  selected: boolean;
  blocked: boolean;
  restoreBlocked: boolean;
  snapshotVersion: string;
  ariaPrefix?: string;
  showStatus?: boolean;
  onSelect: (change: GitChange) => void;
  onAction: (paths: string[], side: GitSide, version: string) => void;
  onRestore: (paths: string[], version: string) => void;
  onResolve: (paths: string[], version: string) => void;
}) {
  const s = useGitStrings();
  const { file, side } = change;
  const status = file.conflict
    ? `${file.indexStatus}${file.worktreeStatus}`
    : side === "staged"
      ? file.indexStatus
      : file.worktreeStatus;
  const ChangeIcon = gitStatusIcon(status);

  return (
    <li className="git-change-item">
      <button
        aria-label={`${ariaPrefix ? `${ariaPrefix} · ` : ""}${file.path} · ${side === "staged" ? s.selectedStaged : s.selectedUnstaged} · ${statusName(status, s)}`}
        aria-pressed={selected}
        className={`git-change-row${selected ? " is-selected" : ""}`}
        data-git-path={file.path}
        // shortcut: a "both deleted" (DD) conflict stays openable and fails to load in Files; check it if such conflicts get common.
        data-git-deleted={
          !file.conflict &&
          (file.indexStatus === "D" || file.worktreeStatus === "D")
            ? ""
            : undefined
        }
        onClick={() => onSelect(change)}
        type="button"
      >
        <ChangeIcon
          className="git-change-icon"
          data-status={status}
          size={13}
          aria-hidden="true"
        />
        <span
          className="git-file-path"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          <span>{projectFileName(file.path)}</span>
          {!tree && file.path.includes("/") ? (
            <small>{projectFileParent(file.path)}</small>
          ) : null}
        </span>
        <GitFileStats added={file.added} deleted={file.deleted} />
        {!showStatus &&
        (status === "A" ||
          status === "M" ||
          status === "D" ||
          status === "?") ? null : (
          <span
            className={`git-file-status status-${file.conflict ? "conflict" : "changed"}`}
            data-status={status}
            title={statusName(status, s)}
          >
            {status}
          </span>
        )}
      </button>
      <span className="git-change-actions">
        <GitChangeActions
          change={change}
          blocked={blocked}
          restoreBlocked={restoreBlocked}
          snapshotVersion={snapshotVersion}
          onAction={onAction}
          onRestore={onRestore}
          onResolve={onResolve}
        />
      </span>
    </li>
  );
}

export function GitChangeActions({
  change: { file, side },
  blocked,
  restoreBlocked,
  snapshotVersion,
  onAction,
  onRestore,
  onResolve,
}: {
  change: GitChange;
  blocked: boolean;
  restoreBlocked: boolean;
  snapshotVersion: string;
  onAction: (paths: string[], side: GitSide, version: string) => void;
  onRestore: (paths: string[], version: string) => void;
  onResolve: (paths: string[], version: string) => void;
}) {
  const s = useGitStrings();
  const actionLabel = side === "staged" ? s.unstage : s.stage;
  if (file.conflict)
    return (
      <Button
        size="small"
        disabled={blocked || !canResolveGitFile(file)}
        onClick={() => onResolve([file.path], snapshotVersion)}
      >
        {s.resolve}
      </Button>
    );
  return (
    <>
      {side === "unstaged" ? (
        <IconButton
          size="small"
          aria-label={`${s.restore} · ${file.path}`}
          title={s.restore}
          disabled={restoreBlocked || !canRestoreGitFile(file)}
          onClick={() => onRestore([file.path], snapshotVersion)}
        >
          <Undo2 />
        </IconButton>
      ) : null}
      <IconButton
        size="small"
        aria-label={`${actionLabel} · ${file.path}`}
        title={file.actionable ? actionLabel : s.actionUnavailable}
        disabled={blocked || !file.actionable}
        onClick={() => onAction([file.path], side, snapshotVersion)}
      >
        {side === "staged" ? <Minus /> : <Plus />}
      </IconButton>
    </>
  );
}
