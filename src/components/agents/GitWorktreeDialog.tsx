import { LoaderCircle, X } from "lucide-react";
import { useId, type ReactNode, type RefObject } from "react";
import type { AgentProject } from "../../domain/agentSessions";
import {
  isWindowsPath,
  type GitBranch,
  type GitRepository,
} from "../../domain/projectGit";
import { useNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useGitStrings, type GitStrings } from "./gitStrings";

export type WorktreeRequest = {
  id: string;
  name: string;
  parentPath: string;
  folderName: string;
  branch: GitBranch;
  createBranch: boolean;
  projectId: string;
  version: string;
};

function splitRoot(root: string): { parentPath: string; folderName: string } {
  const windows = isWindowsPath(root);
  const value = root.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const index = windows
    ? Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"))
    : value.lastIndexOf("/");
  const driveRoot = index === 2 && /^[A-Za-z]:/.test(value);
  return {
    parentPath: driveRoot
      ? value.slice(0, 3)
      : index <= 0
        ? value.slice(0, Math.max(1, index + 1))
        : value.slice(0, index),
    folderName: value.slice(index + 1),
  };
}

export function worktreeDefaults(
  project: AgentProject,
  root: string,
  branch: GitBranch,
): WorktreeRequest {
  const { parentPath, folderName } = splitRoot(root);
  const local = branch.remote
    ? branch.name.slice(branch.name.indexOf("/") + 1)
    : branch.name;
  const suffix =
    local
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .replace(/^-+|-+$/g, "") || "worktree";
  return {
    id: crypto.randomUUID(),
    name: `${project.name} · ${local || "worktree"}`.slice(0, 256),
    parentPath,
    folderName: `${folderName}-${suffix}`.slice(0, 240),
    branch,
    createBranch: false,
    projectId: project.id,
    version: "",
  };
}

export function worktreeRepositoryBlocker(
  g: GitStrings,
  repository: GitRepository,
): string | null {
  if (repository.availability === "notRepository") return g.notRepository;
  if (repository.availability === "bare") return g.bare;
  if (!repository.identity || !repository.head) return g.missing;
  if (repository.limited) return g.limited;
  if (repository.operation) return g.operationBlocksMutation;
  return null;
}

export function GitWorktreeDialog({
  request,
  busy,
  blocked = false,
  changed,
  description,
  onBranchChange,
  onChange,
  onCancel,
  onCreate,
  returnFocusRef,
}: {
  request: WorktreeRequest;
  busy: boolean;
  blocked?: boolean;
  changed: boolean;
  description?: ReactNode;
  onBranchChange?: (branch: string) => void;
  onChange: (request: WorktreeRequest) => void;
  onCancel: () => void;
  onCreate: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const s = useGitStrings();
  useNotification(
    changed
      ? {
          key: "git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );
  const titleId = useId();
  const branchId = useId();
  const parentId = useId();
  const folderId = useId();
  const ref = useDismissibleLayer<HTMLElement>(true, () => {
    if (!busy) onCancel();
  });
  const separator =
    request.parentPath.includes("\\") && !request.parentPath.includes("/")
      ? "\\"
      : "/";
  const destination = `${request.parentPath.replace(/[\\/]+$/, "")}${separator}${request.folderName}`;
  const disabled =
    busy ||
    blocked ||
    changed ||
    (onBranchChange !== undefined && !request.branch.name.trim()) ||
    !request.parentPath.trim() ||
    !request.folderName.trim();
  return (
    <DialogOverlay className="git-dialog-overlay">
      <DialogSurface
        className="form-dialog git-worktree-dialog"
        ref={ref}
        returnFocusRef={returnFocusRef}
        aria-labelledby={titleId}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled) onCreate();
          }}
        >
          <header>
            <div>
              <h2 id={titleId}>{s.createWorktree}</h2>
              <p>
                {description ?? `${s.worktreeBranch}: ${request.branch.name}`}
              </p>
            </div>
            <IconButton
              aria-label={s.cancel}
              disabled={busy}
              onClick={onCancel}
            >
              <X />
            </IconButton>
          </header>
          <fieldset
            className="form-dialog-body"
            disabled={busy || blocked || changed}
          >
            {onBranchChange ? (
              <>
                <label htmlFor={branchId}>{s.worktreeBranch}</label>
                <Input
                  id={branchId}
                  autoFocus
                  spellCheck={false}
                  value={request.branch.name}
                  onChange={(event) =>
                    onBranchChange(event.currentTarget.value)
                  }
                />
              </>
            ) : null}
            <label htmlFor={parentId}>{s.worktreeParent}</label>
            <Input
              id={parentId}
              spellCheck={false}
              value={request.parentPath}
              onChange={(event) =>
                onChange({ ...request, parentPath: event.currentTarget.value })
              }
            />
            <label htmlFor={folderId}>{s.worktreeFolder}</label>
            <Input
              id={folderId}
              autoFocus={!onBranchChange}
              spellCheck={false}
              value={request.folderName}
              onChange={(event) =>
                onChange({ ...request, folderName: event.currentTarget.value })
              }
            />
            <p className="git-worktree-destination" title={destination}>
              {destination}
            </p>
          </fieldset>
          <footer>
            <Button disabled={busy} onClick={onCancel}>
              {s.cancel}
            </Button>
            <Button
              aria-busy={busy || undefined}
              type="submit"
              variant="primary"
              disabled={disabled}
              startIcon={
                busy ? (
                  <LoaderCircle className="app-loading-spinner" />
                ) : undefined
              }
            >
              {s.createWorktree}
            </Button>
          </footer>
        </form>
      </DialogSurface>
    </DialogOverlay>
  );
}
