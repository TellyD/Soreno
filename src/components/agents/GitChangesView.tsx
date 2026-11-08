import {
  CheckCircle2,
  ChevronRight,
  FileCode2,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  canResolveGitFile,
  groupGitChanges,
  type GitChange,
  type GitChangeOrder,
  type GitGroup,
  type GitSide,
} from "../../domain/projectGit";
import { buildGitFileTree } from "../../domain/gitFileTree";
import type {
  GitChangesActions,
  GitChangesCommit,
} from "../../hooks/useGitChangesMutations";
import type { useProjectGit } from "../../hooks/useProjectGit";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import {
  GitBulkChangeActions,
  GitChangeActions,
  GitChangeRow,
  GitFileTree,
} from "./GitChangeList";
import { GitCommitComposer } from "./GitCommitComposer";
import {
  GitChangeOrderMenu,
  GitChangesDiffContent,
  GitChangesWorkspace,
  GitFileNavigation,
  GitFileViewToggle,
  useGitChangeOrderPreference,
  type GitFilePaneLayout,
} from "./GitChangesWorkspace";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import { useGitStrings } from "./gitStrings";
import { GitFileContextMenu, type GitFileMenu } from "./ProjectPathMenu";

type GitChangesFilePane = GitFilePaneLayout & {
  tree: boolean;
  onToggleTree: () => void;
};

type GitChangesViewProps = {
  active: boolean;
  actions: GitChangesActions;
  commit: GitChangesCommit;
  filePane: GitChangesFilePane;
  git: ReturnType<typeof useProjectGit>;
  projectId: string;
  onHistory: () => void;
  onPublishHostChange: (host: HTMLDivElement | null) => void;
  commentTargets?: readonly GitDiffCommentTarget[];
  fileMenu?: GitFileMenu;
};

function ChangeGroup({
  group,
  tree,
  order,
  selected,
  blocked,
  restoreBlocked,
  snapshotVersion,
  onSelect,
  onAction,
  onRestore,
  onResolve,
}: {
  group: GitGroup;
  tree: boolean;
  order: GitChangeOrder;
  selected: { path: string; side: GitSide } | null;
  blocked: boolean;
  restoreBlocked: boolean;
  snapshotVersion: string;
  onSelect: (change: GitChange) => void;
  onAction: (paths: string[], side: GitSide, version: string) => void;
  onRestore: (paths: string[], version: string) => void;
  onResolve: (paths: string[], version: string) => void;
}) {
  const s = useGitStrings();
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  if (!group.changes.length) return null;
  const side = group.key === "staged" ? "staged" : "unstaged";
  const additions = group.changes.reduce(
    (total, { file }) => total + (file.added ?? 0),
    0,
  );
  const deletions = group.changes.reduce(
    (total, { file }) => total + (file.deleted ?? 0),
    0,
  );
  const title = group.key === "unstaged" ? s.changesView : s[group.key];
  const rows = group.changes.map((change) => (
    <GitChangeRow
      key={`${change.file.path}:${change.side}`}
      change={change}
      tree={tree}
      selected={
        selected?.path === change.file.path && selected.side === change.side
      }
      blocked={blocked}
      restoreBlocked={restoreBlocked}
      snapshotVersion={snapshotVersion}
      onSelect={onSelect}
      onAction={onAction}
      onRestore={onRestore}
      onResolve={onResolve}
    />
  ));
  return (
    <section className={`git-change-group${tree ? " is-tree" : ""}`}>
      <header>
        <h3>
          <button
            className="git-change-group-toggle"
            type="button"
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronRight size={12} aria-hidden="true" />
            <span>{title}</span>
            <small>{group.changes.length}</small>
          </button>
        </h3>
        {group.key === "conflicts" ? (
          <Button
            size="small"
            disabled={
              blocked ||
              group.changes.some(({ file }) => !canResolveGitFile(file))
            }
            onClick={() =>
              onResolve(
                group.changes.map(({ file }) => file.path),
                snapshotVersion,
              )
            }
          >
            {s.resolveAll}
          </Button>
        ) : (
          <span
            className={`git-change-group-actions${group.key === "unstaged" ? " is-visible" : ""}`}
          >
            {group.key === "unstaged" && (additions > 0 || deletions > 0) ? (
              <span className="git-file-stats git-change-group-total">
                {additions > 0 ? (
                  <span className="git-lines-added">+{additions}</span>
                ) : null}
                {deletions > 0 ? (
                  <span className="git-lines-deleted">−{deletions}</span>
                ) : null}
              </span>
            ) : null}
            <GitBulkChangeActions
              changes={group.changes}
              side={side}
              snapshotVersion={snapshotVersion}
              blocked={blocked}
              restoreBlocked={restoreBlocked}
              onAction={onAction}
              onRestore={onRestore}
            />
          </span>
        )}
      </header>
      <div id={listId} hidden={collapsed}>
        {tree ? (
          <GitFileTree
            nodes={buildGitFileTree(
              group.changes.map(({ file }) => file.path),
              order,
            )}
            rows={
              new Map(
                group.changes.map(({ file }, index) => [
                  file.path,
                  rows[index],
                ]),
              )
            }
          />
        ) : (
          <ul>{rows}</ul>
        )}
      </div>
    </section>
  );
}

export function GitChangesView({
  active,
  actions,
  commit,
  filePane,
  git,
  projectId,
  onHistory,
  onPublishHostChange,
  commentTargets,
  fileMenu,
}: GitChangesViewProps) {
  const s = useGitStrings();
  const [order, setOrder] = useGitChangeOrderPreference();
  const commitTriggerRef = useRef<HTMLButtonElement>(null);
  const commitComposerId = `${filePane.listId}-commit`;
  const commitComposerVisible = commit.open && !!commit.confirmation;
  const allGroups = groupGitChanges(git.repo?.files ?? [], order);
  const displayedGroups = [...allGroups].sort(
    (a, b) => Number(b.key === "staged") - Number(a.key === "staged"),
  );
  const shownChanges = allGroups.flatMap((group) => group.changes);
  const totalCount = shownChanges.length;
  const firstChange = shownChanges[0];
  const selectionIndex = shownChanges.findIndex(
    ({ file, side }) =>
      file.path === git.draft.selection?.path &&
      side === git.draft.selection.side,
  );
  const selectionExists = selectionIndex >= 0;
  const selectedChange = shownChanges[selectionIndex];

  useEffect(() => {
    if (
      !active ||
      git.draft.view !== "changes" ||
      git.repo?.availability !== "ready" ||
      git.loading ||
      git.busy ||
      selectionExists
    )
      return;
    if (firstChange)
      git.updateDraft({
        selection: { path: firstChange.file.path, side: firstChange.side },
      });
    else if (git.draft.selection) git.updateDraft({ selection: null });
  }, [
    active,
    git.draft.view,
    git.repo,
    git.loading,
    git.busy,
    selectionExists,
    firstChange?.file.path,
    firstChange?.side,
    git.draft.selection,
    git.updateDraft,
  ]);

  const fileNavigation =
    shownChanges.length > 1 ? (
      <GitFileNavigation
        count={shownChanges.length}
        index={selectionIndex}
        onSelect={(index) => {
          const change = shownChanges[index];
          git.updateDraft({
            selection: { path: change.file.path, side: change.side },
          });
        }}
      />
    ) : null;

  return (
    <div
      hidden={git.draft.view !== "changes"}
      style={{
        display: git.draft.view === "changes" ? "contents" : "none",
      }}
    >
      <GitChangesWorkspace
        filePane={filePane}
        sidebarLabel={s.files}
        sidebar={
          <div className="git-change-list">
            <div ref={onPublishHostChange} />
            <div className="git-file-list-toolbar">
              <div className="git-commit-actions">
                <Button
                  className="git-quick-commit-button"
                  size="small"
                  disabled={commit.quickDisabled}
                  aria-label={
                    commit.quickPending ? s.quickCommitting : s.quickCommit
                  }
                  title={
                    commit.quickPending
                      ? s.quickCommitting
                      : (commit.blockedTitle ?? s.quickCommit)
                  }
                  startIcon={
                    commit.quickPending ? (
                      <LoaderCircle className="app-loading-spinner" />
                    ) : (
                      <Sparkles />
                    )
                  }
                  onClick={commit.onQuickCommit}
                >
                  {null}
                </Button>
                <Button
                  ref={commitTriggerRef}
                  className="git-commit-toggle"
                  size="small"
                  disabled={!commitComposerVisible && commit.disabled}
                  title={commit.blockedTitle}
                  aria-expanded={commitComposerVisible}
                  aria-controls={commitComposerId}
                  onClick={commit.onToggle}
                >
                  {commit.merge ? s.mergeCommit : s.commit}
                </Button>
              </div>
              <span className="git-file-list-actions">
                <GitChangeOrderMenu order={order} onChange={setOrder} />
                <GitFileViewToggle
                  tree={filePane.tree}
                  onToggle={filePane.onToggleTree}
                />
              </span>
            </div>
            {commit.confirmation ? (
              <GitCommitComposer
                key={`${commit.confirmation.scope}:${commit.confirmation.version}`}
                id={commitComposerId}
                open={commit.open}
                projectId={commit.confirmation.projectId}
                version={commit.confirmation.version}
                generationDisabled={commit.generationDisabled}
                merge={commit.confirmation.merge}
                message={commit.confirmation.message}
                busy={git.busy}
                changed={commit.changed}
                disabled={
                  commit.disabled ||
                  commit.changed ||
                  !commit.confirmation.message.trim()
                }
                warning={
                  commit.blockedTitle ??
                  (git.error?.uncertain
                    ? s.uncertain
                    : git.repo?.limited
                      ? s.limited
                      : git.stale
                        ? s.stale
                        : undefined)
                }
                onMessage={commit.onMessage}
                onCancel={() => {
                  if (!git.busy) {
                    commit.onCancel();
                    commitTriggerRef.current?.focus();
                  }
                }}
                onCommit={commit.onCommit}
              />
            ) : null}
            <GitFileContextMenu
              menu={fileMenu}
              render={
                <div className="git-change-groups" aria-busy={git.busy} />
              }
            >
              {displayedGroups.map((group) => (
                <ChangeGroup
                  key={`${projectId}:${group.key}`}
                  group={group}
                  tree={filePane.tree}
                  order={order}
                  selected={git.draft.selection}
                  blocked={actions.blocked}
                  restoreBlocked={actions.restoreBlocked}
                  snapshotVersion={git.repo!.version}
                  onAction={actions.onAction}
                  onRestore={actions.onRestore}
                  onResolve={actions.onResolve}
                  onSelect={({ file, side }) =>
                    git.updateDraft({ selection: { path: file.path, side } })
                  }
                />
              ))}
              {!totalCount ? (
                <EmptyState description={s.noChanges} size="compact" />
              ) : null}
            </GitFileContextMenu>
          </div>
        }
      >
        <div
          className="git-diff-area"
          role="region"
          aria-busy={git.busy || git.diffLoading}
          aria-label={
            git.draft.selection?.side === "staged" ? s.staged : s.unstaged
          }
        >
          {git.stale && !git.diffLoading && !git.busy ? (
            <div className="git-panel-notice is-stale" role="status">
              <span>{s.stale}</span>
              <Button
                size="small"
                disabled={git.diffLoading}
                onClick={() => void git.loadComparison()}
              >
                {s.refreshDiff}
              </Button>
            </div>
          ) : null}
          <GitChangesDiffContent
            comparison={git.diff}
            loading={git.diffLoading}
            fileActions={
              !filePane.visible && selectedChange && git.repo ? (
                <GitChangeActions
                  change={selectedChange}
                  blocked={actions.blocked}
                  restoreBlocked={actions.restoreBlocked}
                  snapshotVersion={git.repo.version}
                  onAction={actions.onAction}
                  onRestore={actions.onRestore}
                  onResolve={actions.onResolve}
                />
              ) : null
            }
            navigation={fileNavigation}
            showMinimap
            side={git.draft.selection?.side}
            commentTargets={commentTargets}
            commentGitRoot={git.repo?.identity?.root}
            commentFiles={git.repo?.files}
          >
            {!totalCount ? (
              <EmptyState
                actions={
                  <Button size="small" onClick={onHistory}>
                    {s.history}
                  </Button>
                }
                description={s.cleanDescription}
                fill
                headingLevel={3}
                icon={<CheckCircle2 />}
                title={s.cleanTitle}
              />
            ) : (
              <EmptyState
                description={s.chooseFile}
                fill
                icon={<FileCode2 />}
                title={s.changesView}
              />
            )}
          </GitChangesDiffContent>
        </div>
      </GitChangesWorkspace>
    </div>
  );
}
