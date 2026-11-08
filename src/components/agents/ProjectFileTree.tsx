import {
  ChevronRight,
  FileSymlink,
  FolderSymlink,
  LoaderCircle,
} from "lucide-react";
import type {
  ProjectFileEntry,
  ProjectFileGitBadge,
  ProjectFileGitStatus,
  ProjectFileListing,
} from "../../domain/projectFiles";
import { FileIcon } from "../FileIcon";

export type TreeLabels = {
  unsupported: string;
  symlink: string;
  folderChanges: string;
  badges: Record<ProjectFileGitBadge, string>;
};

type FileTreeProps = {
  directory: string;
  expanded: Set<string>;
  gitStatus: ProjectFileGitStatus | null;
  labels: TreeLabels;
  listings: Map<string, ProjectFileListing>;
  loading: Set<string>;
  selectedPath: string | null;
  onDirectory: (path: string) => void;
  onFile: (entry: ProjectFileEntry) => void;
};

function FileRow({
  entry,
  gitStatus,
  labels,
  selectedPath,
  onFile,
}: {
  entry: ProjectFileEntry;
  gitStatus: ProjectFileGitStatus | null;
  labels: TreeLabels;
  selectedPath: string | null;
  onFile: (entry: ProjectFileEntry) => void;
}) {
  const openable = entry.editable || entry.previewable;
  const badge = gitStatus?.files.get(entry.path)?.badge;
  const SymlinkIcon = entry.kind === "directory" ? FolderSymlink : FileSymlink;
  return (
    // aria-disabled keeps unsupported files focusable for their context menu.
    <button
      className={`project-file-tree-row is-file${selectedPath === entry.path ? " is-selected" : ""}`}
      type="button"
      aria-disabled={openable ? undefined : true}
      aria-current={selectedPath === entry.path ? "page" : undefined}
      data-entry-kind="file"
      data-entry-path={entry.path}
      data-entry-symlink={entry.symlink ? "true" : undefined}
      onClick={() => {
        if (openable) onFile(entry);
      }}
      title={
        openable
          ? entry.path
          : `${entry.path} · ${entry.symlink ? labels.symlink : labels.unsupported}`
      }
    >
      <span className="project-file-tree-spacer" aria-hidden="true" />
      {entry.symlink ? (
        <SymlinkIcon size={14} aria-hidden="true" />
      ) : (
        <FileIcon name={entry.name} size={14} />
      )}
      <span>{entry.name}</span>
      {badge ? (
        <span
          className="git-file-status project-file-git-status"
          data-status={badge}
          title={labels.badges[badge]}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function FileTree({
  directory,
  expanded,
  gitStatus,
  labels,
  listings,
  loading,
  selectedPath,
  onDirectory,
  onFile,
}: FileTreeProps) {
  const entries = listings.get(directory)?.entries ?? [];
  return (
    <ul className="project-file-tree-list">
      {entries.map((entry) =>
        entry.kind === "directory" && !entry.symlink ? (
          <li key={entry.path}>
            <button
              className="project-file-tree-row is-directory"
              type="button"
              aria-expanded={expanded.has(entry.path)}
              data-entry-kind="directory"
              data-entry-path={entry.path}
              onClick={() => onDirectory(entry.path)}
              title={entry.path}
            >
              <ChevronRight
                className="project-file-chevron"
                size={12}
                aria-hidden="true"
              />
              <FileIcon
                name={entry.name}
                kind="directory"
                expanded={expanded.has(entry.path)}
                size={14}
              />
              <span>{entry.name}</span>
              {loading.has(entry.path) ? (
                <LoaderCircle
                  size={12}
                  className="app-loading-spinner"
                  aria-label={entry.name}
                />
              ) : gitStatus?.directories.has(entry.path) ? (
                <span
                  className="project-file-git-changes"
                  role="img"
                  aria-label={labels.folderChanges}
                  title={labels.folderChanges}
                />
              ) : null}
            </button>
            {expanded.has(entry.path) ? (
              listings.has(entry.path) ? (
                <FileTree
                  directory={entry.path}
                  expanded={expanded}
                  gitStatus={gitStatus}
                  labels={labels}
                  listings={listings}
                  loading={loading}
                  selectedPath={selectedPath}
                  onDirectory={onDirectory}
                  onFile={onFile}
                />
              ) : null
            ) : null}
          </li>
        ) : (
          <li key={entry.path}>
            <FileRow
              entry={entry}
              gitStatus={gitStatus}
              labels={labels}
              selectedPath={selectedPath}
              onFile={onFile}
            />
          </li>
        ),
      )}
    </ul>
  );
}
