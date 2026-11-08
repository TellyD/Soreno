import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  List,
  ListTree,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRight,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { DiffLineSelection } from "../../domain/diffLineComment";
import {
  clampGitPanelRatio,
  gitChangeOrders,
  isGitChangeOrder,
  parseGitPanelRatio,
  type GitChangeOrder,
  type GitComparison,
  type GitFile,
  type GitSide,
} from "../../domain/projectGit";
import { useStoredPreference } from "../../hooks/useStoredPreference";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import {
  GitDiffLineComment,
  type GitDiffCommentTarget,
} from "./GitDiffLineComment";
import GitDiffView from "./GitDiffView";
import { LoadingState } from "../ui/LoadingState";
import { useGitStrings } from "./gitStrings";
import {
  isRailResizeKey,
  railKeyboardRatio,
  railResizeRatio,
  startRailResize,
  stopRailResize,
  type RailAxis,
  type RailResizeSession,
} from "./railResize";

const gitFileTreeStorageKey = "soreno:git-file-tree";
const gitFileTreeChangeEvent = "soreno:git-file-tree-change";
const gitChangeOrderStorageKey = "soreno:git-change-order";
const gitChangeOrderChangeEvent = "soreno:git-change-order-change";
const gitFilesRatioStorageKey = "soreno:git-files-ratio";
const gitFilesRatioChangeEvent = "soreno:git-files-ratio-change";
const gitFilesVisibleStorageKey = "soreno:git-files-visible";
const gitFilesVisibleChangeEvent = "soreno:git-files-visible-change";

const parseGitFileTree = (stored: string | null) => stored === "true";
const parseGitChangeOrder = (stored: string | null): GitChangeOrder =>
  isGitChangeOrder(stored) ? stored : "path";
const parseGitFilesVisible = (stored: string | null) => stored !== "false";

function readGitFilesRatioPreference(
  defaultRatio: number,
  minRatio: number,
  maxRatio: number,
) {
  try {
    return parseGitPanelRatio(
      localStorage.getItem(gitFilesRatioStorageKey),
      defaultRatio,
      minRatio,
      maxRatio,
    );
  } catch {
    return defaultRatio;
  }
}

export function useGitFilesRatioPreference(
  defaultRatio: number,
  minRatio: number,
  maxRatio: number,
) {
  const [ratio, setRatio] = useState(() =>
    readGitFilesRatioPreference(defaultRatio, minRatio, maxRatio),
  );

  useEffect(() => {
    const syncCustomEvent = (event: Event) =>
      setRatio(
        clampGitPanelRatio(
          (event as CustomEvent<number>).detail,
          minRatio,
          maxRatio,
        ),
      );
    const syncStorage = (event: StorageEvent) => {
      if (event.key === gitFilesRatioStorageKey)
        setRatio(
          parseGitPanelRatio(event.newValue, defaultRatio, minRatio, maxRatio),
        );
    };
    window.addEventListener(gitFilesRatioChangeEvent, syncCustomEvent);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(gitFilesRatioChangeEvent, syncCustomEvent);
      window.removeEventListener("storage", syncStorage);
    };
  }, [defaultRatio, minRatio, maxRatio]);

  const changeRatio = useCallback(
    (nextRatio: number) => {
      const next = clampGitPanelRatio(nextRatio, minRatio, maxRatio);
      setRatio(next);
      try {
        localStorage.setItem(gitFilesRatioStorageKey, String(next));
      } catch {
        /* Optional preference. */
      }
      window.dispatchEvent(
        new CustomEvent<number>(gitFilesRatioChangeEvent, { detail: next }),
      );
    },
    [minRatio, maxRatio],
  );

  return [ratio, changeRatio] as const;
}

export function useGitFileTreePreference() {
  const [tree, setTree] = useStoredPreference(
    gitFileTreeStorageKey,
    gitFileTreeChangeEvent,
    parseGitFileTree,
  );
  const toggleTree = useCallback(() => setTree(!tree), [tree, setTree]);
  return [tree, toggleTree] as const;
}

export function useGitChangeOrderPreference() {
  return useStoredPreference(
    gitChangeOrderStorageKey,
    gitChangeOrderChangeEvent,
    parseGitChangeOrder,
  );
}

export function useGitFilesVisiblePreference() {
  return useStoredPreference(
    gitFilesVisibleStorageKey,
    gitFilesVisibleChangeEvent,
    parseGitFilesVisible,
  );
}

export function GitPanelHeaderActions({
  busy = false,
  busyLabel,
  filesVisible,
  listId,
  showFilesToggle,
  expanded = false,
  onExpandedChange,
  onToggleFiles,
  onClose,
}: {
  busy?: boolean;
  busyLabel?: string;
  filesVisible: boolean;
  listId: string;
  showFilesToggle: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onToggleFiles: () => void;
  onClose: () => void;
}) {
  const s = useGitStrings();
  const operationLabel = busyLabel ?? s.operationInProgress;
  return (
    <div className="git-panel-header-actions">
      {busy ? (
        <span
          className="git-operation-progress"
          role="status"
          aria-label={operationLabel}
          title={operationLabel}
        >
          <LoaderCircle
            size={13}
            className="app-loading-spinner"
            aria-hidden="true"
          />
        </span>
      ) : null}
      {showFilesToggle ? (
        <IconButton
          size="small"
          aria-label={filesVisible ? s.hideFiles : s.showFiles}
          title={filesVisible ? s.hideFiles : s.showFiles}
          aria-expanded={filesVisible}
          aria-controls={listId}
          onClick={onToggleFiles}
        >
          <PanelRight className="git-files-toggle-icon" />
        </IconButton>
      ) : null}
      {onExpandedChange ? (
        <IconButton
          size="small"
          data-git-expand
          aria-label={expanded ? s.collapse : s.expand}
          title={expanded ? s.collapse : s.expand}
          aria-pressed={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
      ) : null}
      <IconButton
        className="git-panel-close"
        size="small"
        aria-label={s.closeProjectTools}
        title={s.closeProjectTools}
        onClick={onClose}
      >
        <X />
      </IconButton>
    </div>
  );
}

export function GitFileViewToggle({
  tree,
  onToggle,
}: {
  tree: boolean;
  onToggle: () => void;
}) {
  const s = useGitStrings();
  return (
    <IconButton
      size="small"
      aria-label={tree ? s.viewAsList : s.viewAsTree}
      title={tree ? s.viewAsList : s.viewAsTree}
      onClick={onToggle}
    >
      {tree ? <List aria-hidden="true" /> : <ListTree aria-hidden="true" />}
    </IconButton>
  );
}

export function GitChangeOrderMenu({
  order,
  onChange,
}: {
  order: GitChangeOrder;
  onChange: (order: GitChangeOrder) => void;
}) {
  const s = useGitStrings();
  const label = `${s.changeOrder} · ${s.changeOrders[order]}`;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        render={
          <IconButton
            size="small"
            aria-label={label}
            title={label}
            selected={order !== "path"}
          >
            <ArrowUpDown aria-hidden="true" />
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
            render={<MenuSurface className="git-change-order-menu" />}
          >
            <Menu.RadioGroup
              aria-label={s.changeOrder}
              value={order}
              onValueChange={(value) => {
                if (isGitChangeOrder(value)) onChange(value);
              }}
            >
              {gitChangeOrders.map((option) => (
                <Menu.RadioItem
                  key={option}
                  nativeButton
                  closeOnClick
                  value={option}
                  render={
                    <MenuItem
                      selected={order === option}
                      trailing={
                        order === option ? <Check aria-hidden="true" /> : null
                      }
                    />
                  }
                >
                  {s.changeOrders[option]}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export type GitFilePaneLayout = {
  defaultRatio: number;
  listId: string;
  maxRatio: number;
  minRatio: number;
  ratio: number;
  visible: boolean;
  onRatioChange: (ratio: number) => void;
};

export function GitFileNavigation({
  count,
  index,
  onSelect,
}: {
  count: number;
  index: number;
  onSelect: (index: number) => void;
}) {
  const s = useGitStrings();
  if (count <= 1) return null;
  return (
    <>
      <IconButton
        size="small"
        aria-label={s.previousFile}
        title={`${s.previousFile} · ${index + 1}/${count}`}
        disabled={index <= 0}
        onClick={() => onSelect(index - 1)}
      >
        <ChevronLeft />
      </IconButton>
      <IconButton
        size="small"
        aria-label={s.nextFile}
        title={`${s.nextFile} · ${index + 1}/${count}`}
        disabled={index >= count - 1}
        onClick={() => onSelect(index + 1)}
      >
        <ChevronRight />
      </IconButton>
    </>
  );
}

type CommentComparison = {
  path?: string;
  side?: GitSide;
  gitRoot?: string;
  repository?: { path: string };
};

/** A comment belongs to one file of one side of one repository; its draft never crosses to another. */
function sameCommentComparison(a: CommentComparison, b: CommentComparison) {
  return (
    a.path === b.path &&
    a.side === b.side &&
    a.gitRoot === b.gitRoot &&
    a.repository?.path === b.repository?.path
  );
}

export function GitChangesDiffContent({
  children,
  comparison,
  loading,
  fileActions,
  navigation,
  showMinimap = false,
  side,
  commentTargets,
  commentRepository,
  commentGitRoot,
  commentFiles,
}: {
  children: ReactNode;
  comparison?: GitComparison | null;
  loading: boolean;
  /** Actions on the shown file, offered here while the file list is hidden. */
  fileActions?: ReactNode;
  navigation: ReactNode;
  showMinimap?: boolean;
  side?: GitSide;
  /** Running agents of the project; enables commenting selected diff lines. */
  commentTargets?: readonly GitDiffCommentTarget[];
  /** Repository of the shown file when agents may run outside it (group panel). */
  commentRepository?: DiffLineSelection["repository"];
  /** Git root the diff paths are relative to, when known. */
  commentGitRoot?: string;
  /** Changed files of the repository, to tell untracked ones apart. */
  commentFiles?: readonly GitFile[];
}) {
  const s = useGitStrings();
  const [commented, setCommented] = useState<{
    selection: DiffLineSelection;
    comparisonVersion: string;
    draft: string;
  } | null>(null);
  const shownComparison = {
    path: comparison?.path,
    side,
    gitRoot: commentGitRoot,
    repository: commentRepository,
  };
  const comment =
    commented && sameCommentComparison(commented.selection, shownComparison)
      ? commented
      : null;
  return (
    <div className="git-diff-content">
      {navigation ||
      (comparison && (loading || side === "staged" || fileActions)) ? (
        <div className="git-file-navigation">
          {comparison && loading ? (
            <span
              role="status"
              aria-label={s.loadingDiff}
              title={s.loadingDiff}
            >
              <LoaderCircle
                size={14}
                className="app-loading-spinner"
                aria-hidden="true"
              />
            </span>
          ) : null}
          {comparison && side === "staged" ? (
            <span className="git-diff-side">{s.staged}</span>
          ) : null}
          {comparison && fileActions ? (
            <span className="git-diff-file-actions">{fileActions}</span>
          ) : null}
          {navigation}
        </div>
      ) : null}
      {comparison ? (
        <GitDiffView
          comparison={comparison}
          showMinimap={showMinimap}
          lineComments={
            commentTargets && side
              ? {
                  side,
                  onComment: (selection) =>
                    setCommented((previous) => {
                      const next = {
                        ...selection,
                        gitRoot: commentGitRoot,
                        untracked: commentFiles?.some(
                          (file) =>
                            file.path === selection.path &&
                            file.worktreeStatus === "?",
                        ),
                        repository: commentRepository,
                      };
                      return {
                        selection: next,
                        comparisonVersion: comparison.version,
                        draft:
                          previous &&
                          sameCommentComparison(previous.selection, next)
                            ? previous.draft
                            : "",
                      };
                    }),
                }
              : undefined
          }
          footer={
            comment && commentTargets ? (
              <GitDiffLineComment
                selection={comment.selection}
                draft={comment.draft}
                stale={comment.comparisonVersion !== comparison.version}
                targets={commentTargets}
                onDraftChange={(draft) =>
                  setCommented((previous) => previous && { ...previous, draft })
                }
                onSent={(sent) =>
                  setCommented((previous) =>
                    previous &&
                    previous.draft === sent.draft &&
                    sameCommentComparison(previous.selection, sent.selection)
                      ? { ...previous, draft: "" }
                      : previous,
                  )
                }
                onClose={() => setCommented(null)}
              />
            ) : null
          }
        />
      ) : loading ? (
        <LoadingState className="git-panel-centered-status">
          {s.loadingDiff}
        </LoadingState>
      ) : (
        children
      )}
    </div>
  );
}

export function GitChangesWorkspace({
  children,
  filePane,
  sidebar,
  sidebarLabel,
}: {
  children: ReactNode;
  filePane: GitFilePaneLayout;
  sidebar: ReactNode;
  sidebarLabel: string;
}) {
  const s = useGitStrings();
  const resizeSessionRef = useRef<RailResizeSession | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  // CSS min-width can render the rail wider than the stored ratio.
  function shownFilesRatio() {
    const available =
      (workspaceRef.current?.getBoundingClientRect().width ?? 0) - 1;
    const rail = sidebarRef.current?.getBoundingClientRect().width ?? 0;
    if (available <= 0) return filePane.ratio;
    return Math.max(filePane.ratio, (rail / available) * 100);
  }

  function resizeFiles(event: React.PointerEvent<HTMLElement>) {
    const ratio = railResizeRatio(
      resizeSessionRef.current,
      event,
      filePane.minRatio,
      filePane.maxRatio,
    );
    if (ratio !== null) filePane.onRatioChange(ratio);
  }

  function stopFileResize(event: React.PointerEvent<HTMLElement>) {
    stopRailResize(resizeSessionRef, event);
  }

  function resizeFilesWithKeyboard(
    event: React.KeyboardEvent<HTMLElement>,
    axis: RailAxis,
  ) {
    if (!isRailResizeKey(event.key, axis)) return;
    event.preventDefault();
    filePane.onRatioChange(
      railKeyboardRatio(
        event.key,
        axis,
        axis === "x" ? shownFilesRatio() : filePane.ratio,
        filePane.minRatio,
        filePane.maxRatio,
      ),
    );
  }

  return (
    <div
      className={`git-review-workspace${filePane.visible ? "" : " files-hidden"}`}
      ref={workspaceRef}
      style={
        {
          "--git-files-size": `${filePane.ratio}fr`,
          "--git-diff-size": `${100 - filePane.ratio}fr`,
        } as CSSProperties
      }
    >
      <aside
        className="git-review-sidebar"
        ref={sidebarRef}
        id={filePane.listId}
        hidden={!filePane.visible}
        aria-label={sidebarLabel}
      >
        {sidebar}
      </aside>
      <div
        className="git-files-resizer git-files-resizer-narrow"
        hidden={!filePane.visible}
        role="separator"
        tabIndex={0}
        aria-controls={filePane.listId}
        aria-label={s.resizeFiles}
        aria-orientation="horizontal"
        aria-valuemin={filePane.minRatio}
        aria-valuemax={filePane.maxRatio}
        aria-valuenow={Math.round(filePane.ratio)}
        onPointerDown={(event) =>
          startRailResize(
            event,
            resizeSessionRef,
            workspaceRef.current,
            "y",
            filePane.ratio,
          )
        }
        onPointerMove={resizeFiles}
        onPointerUp={stopFileResize}
        onPointerCancel={stopFileResize}
        onLostPointerCapture={stopFileResize}
        onKeyDown={(event) => resizeFilesWithKeyboard(event, "y")}
        onDoubleClick={() => filePane.onRatioChange(filePane.defaultRatio)}
      />
      <div
        className="git-files-resizer git-files-resizer-wide"
        hidden={!filePane.visible}
        role="separator"
        tabIndex={0}
        aria-controls={filePane.listId}
        aria-label={s.resizeFiles}
        aria-orientation="vertical"
        aria-valuemin={filePane.minRatio}
        aria-valuemax={filePane.maxRatio}
        aria-valuenow={Math.round(filePane.ratio)}
        onPointerDown={(event) =>
          startRailResize(
            event,
            resizeSessionRef,
            workspaceRef.current,
            "x",
            shownFilesRatio(),
          )
        }
        onPointerMove={resizeFiles}
        onPointerUp={stopFileResize}
        onPointerCancel={stopFileResize}
        onLostPointerCapture={stopFileResize}
        onKeyDown={(event) => resizeFilesWithKeyboard(event, "x")}
        onDoubleClick={() => filePane.onRatioChange(filePane.defaultRatio)}
      />
      {children}
    </div>
  );
}
