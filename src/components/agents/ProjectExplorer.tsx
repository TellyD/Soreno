import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  ChevronsDownUp,
  ClipboardPaste,
  CopyPlus,
  Download,
  FileDiff,
  FilePlus,
  FolderPlus,
  History,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/projectFilesApi";
import type { AgentProject } from "../../domain/agentSessions";
import {
  isProjectFileWithin,
  movedProjectFilePath,
  projectFileAncestors,
  projectFileError,
  projectFileName,
  projectFileParent,
  type ProjectFileEntry,
  type ProjectFileGitChange,
  type ProjectFileGitStatus,
  type ProjectFileKind,
  type ProjectFileListing,
} from "../../domain/projectFiles";
import { gitPathParts } from "../../domain/projectGit";
import {
  forgetRecentProjectFile,
  forgetRecentProjectFiles,
  moveRecentProjectFiles,
  recordRecentProjectFile,
} from "../../domain/recentProjectFiles";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { LoadingState } from "../ui/LoadingState";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { useAgentStrings } from "./agentStrings";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "./contextMenuKeyboard";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import { useGitStrings } from "./gitStrings";
import { formatOperationError } from "./operationError";
import { ProjectFileEditorPane } from "./ProjectFileEditorPane";
import { type FileReveal, type OpenDocument } from "./ProjectCodeEditor";
import { ProjectPathMenuItems, useProjectPathActions } from "./ProjectPathMenu";
import { ProjectFilePathDialog } from "./ProjectFilePathDialog";
import { FileTree, type TreeLabels } from "./ProjectFileTree";
import { RailResizer } from "./RailResizer";
import { notifyInfo, useScopedNotification } from "../../notifications";
import "./ProjectExplorer.css";

const ratioStorageKey = "soreno:project-explorer-ratio";
const defaultRatio = 28;
const minRatio = 15;
const maxRatio = 65;

export type ProjectExplorerGuard = {
  cancel: () => void;
  discard: () => void;
  hasPendingWork: () => boolean;
  lock: () => void;
  prepare: () => Promise<boolean>;
};

export type ProjectFileOpenRequest = {
  id: number;
  path: string;
  projectId: string;
  selection?: { line: number; start: number; end: number };
};

function readRatio(): number {
  try {
    const value = Number(localStorage.getItem(ratioStorageKey));
    return Number.isFinite(value) && value >= minRatio && value <= maxRatio
      ? value
      : defaultRatio;
  } catch {
    return defaultRatio;
  }
}

type FileTarget = { path: string; kind: ProjectFileKind; symlink?: boolean };

function rowTarget(row: HTMLElement): FileTarget {
  return {
    path: row.dataset.entryPath!,
    kind: row.dataset.entryKind === "directory" ? "directory" : "file",
    symlink: row.dataset.entrySymlink === "true",
  };
}

function targetDirectory(target: FileTarget | null): string {
  if (!target) return "";
  return target.kind === "directory"
    ? target.path
    : projectFileParent(target.path);
}

type PathDialog =
  | { mode: "create"; kind: ProjectFileKind; directory: string }
  | { mode: "rename"; target: FileTarget };

export function ProjectExplorer({
  agentTarget = null,
  gitStatus = null,
  historyAvailable = false,
  openFileRequest,
  project,
  registerGuard,
  onAgentInput,
  onFilesChanged,
  onOpenFileRequestHandled,
  onShowChanges,
  onShowHistory,
}: {
  /** Running agent of the active terminal pane that receives inserted paths. */
  agentTarget?: GitDiffCommentTarget | null;
  gitStatus?: ProjectFileGitStatus | null;
  historyAvailable?: boolean;
  openFileRequest?: ProjectFileOpenRequest | null;
  project: AgentProject;
  registerGuard?: (guard: ProjectExplorerGuard) => () => void;
  onAgentInput?: (sessionId: string) => void;
  onFilesChanged?: () => void;
  onOpenFileRequestHandled?: (id: number) => void;
  onShowChanges?: (change: ProjectFileGitChange) => void;
  onShowHistory?: (path: string) => void;
}) {
  const s = useGitStrings();
  const agentStrings = useAgentStrings();
  const notice = useScopedNotification("project-explorer");
  const pathActions = useProjectPathActions(onAgentInput);
  const stringsRef = useRef({ s, agentStrings });
  stringsRef.current = { s, agentStrings };
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const [listings, setListings] = useState<Map<string, ProjectFileListing>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    () => new Set(),
  );
  const [document, setDocument] = useState<OpenDocument | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closeLocked, setCloseLocked] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [ratio, setRatio] = useState(readRatio);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<FileReveal | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  const [menuTarget, setMenuTarget] = useState<FileTarget | null>(null);
  const [pathDialog, setPathDialog] = useState<PathDialog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileTarget | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{
    path: string;
    toolbarFallback?: boolean;
    scrollOnly?: boolean;
  } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const menuRowRef = useRef<HTMLElement | null>(null);
  // Source of truth for listings: written synchronously so mutations that
  // finish before the next render still see every accepted listing.
  const listingsRef = useRef(listings);
  const commitListings = useCallback(
    (
      update: (
        value: Map<string, ProjectFileListing>,
      ) => Map<string, ProjectFileListing>,
    ) => {
      listingsRef.current = update(listingsRef.current);
      setListings(listingsRef.current);
    },
    [],
  );
  const consumedOpenRequest = useRef(0);
  const pendingDiscard = useRef<{
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
  } | null>(null);
  const listGeneration = useRef(0);
  // Latest request per directory: an older listing must not overwrite a newer one.
  const directoryTokens = useRef(new Map<string, number>());
  // Directories whose latest request is still in flight, mirrored synchronously
  // so mutations can supersede first loads that have no listing yet.
  const pendingDirectories = useRef(new Set<string>());
  const fileGeneration = useRef(0);
  const loadingFile = useRef<string | null>(null);
  const loadId = useRef(0);
  const alive = useRef(true);
  const current = useRef({ dirty: false, locked: false, saving: false });
  const dirty = !!document && document.value !== document.original;
  current.current = {
    dirty,
    locked: fileLoading || closeLocked || operationPending,
    saving,
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listGeneration.current++;
      fileGeneration.current++;
      pendingDiscard.current?.resolve(false);
      pendingDiscard.current = null;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ratioStorageKey, String(ratio));
    } catch {
      /* Optional preference. */
    }
  }, [ratio]);

  function reportError(reason: unknown) {
    const { code, message } = projectFileError(reason);
    const strings = stringsRef.current;
    notice.error(
      code === "stranded"
        ? strings.s.renameStranded(message)
        : formatOperationError(strings.agentStrings, {
            message,
            fileCode: code,
          }),
      code === "conflict"
        ? {
            label: strings.s.reloadFile,
            onAction: () => void reloadRef.current(),
          }
        : undefined,
    );
  }

  const loadDirectory = useCallback(
    async (directory: string, generation = listGeneration.current) => {
      const token = (directoryTokens.current.get(directory) ?? 0) + 1;
      directoryTokens.current.set(directory, token);
      pendingDirectories.current.add(directory);
      const latest = () =>
        alive.current &&
        generation === listGeneration.current &&
        directoryTokens.current.get(directory) === token;
      setLoadingDirectories((value) => new Set(value).add(directory));
      notice.clear();
      try {
        const listing = await api.listProjectFiles(project.id, directory);
        if (latest())
          commitListings((value) => new Map(value).set(directory, listing));
      } catch (reason) {
        if (!latest()) return;
        const { code } = projectFileError(reason);
        // A folder deleted or replaced outside the explorer just leaves the tree.
        if (directory && (code === "notFound" || code === "notDirectory"))
          forgetTree(directory);
        else reportError(reason);
      } finally {
        if (directoryTokens.current.get(directory) === token)
          pendingDirectories.current.delete(directory);
        if (latest())
          setLoadingDirectories((value) => {
            const next = new Set(value);
            next.delete(directory);
            return next;
          });
      }
    },
    [commitListings, project.id],
  );

  useEffect(() => {
    const generation = ++listGeneration.current;
    commitListings(() => new Map());
    pendingDirectories.current.clear();
    setExpanded(new Set());
    setDocument(null);
    notice.clear();
    void loadDirectory("", generation);
  }, [commitListings, loadDirectory]);

  const finishDiscard = useCallback((result: boolean) => {
    const pending = pendingDiscard.current;
    pendingDiscard.current = null;
    setDiscardOpen(false);
    pending?.resolve(result);
  }, []);

  const prepare = useCallback((): Promise<boolean> => {
    if (current.current.saving) {
      notice.error(s.fileSaveInProgress);
      return Promise.resolve(false);
    }
    if (!current.current.dirty) return Promise.resolve(true);
    if (pendingDiscard.current) return pendingDiscard.current.promise;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    pendingDiscard.current = { promise, resolve };
    setDiscardOpen(true);
    return promise;
  }, [s.fileSaveInProgress]);

  const discard = useCallback(() => {
    setDocument((value) =>
      value ? { ...value, value: value.original } : value,
    );
    notice.clear();
  }, []);

  const cancel = useCallback(() => {
    finishDiscard(false);
    current.current.locked = false;
    setCloseLocked(false);
  }, [finishDiscard]);

  const lock = useCallback(() => {
    current.current.locked = true;
    setCloseLocked(true);
  }, []);

  useEffect(
    () =>
      registerGuard?.({
        cancel,
        discard,
        hasPendingWork: () => current.current.dirty || current.current.saving,
        lock,
        prepare,
      }),
    [cancel, discard, lock, prepare, registerGuard],
  );

  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      const generation = ++fileGeneration.current;
      loadingFile.current = path;
      current.current.locked = true;
      setFileLoading(true);
      notice.clear();
      try {
        const value = await api.readProjectFile(project.id, path);
        if (alive.current && generation === fileGeneration.current) {
          recordRecentProjectFile(project.id, path);
          setDocument({
            ...value,
            loadId: ++loadId.current,
            original: value.content,
            value: value.content,
          });
          return true;
        }
      } catch (reason) {
        const { code } = projectFileError(reason);
        // A vanished file leaves the history; a transient failure keeps it.
        if (code === "notFound" || code === "notFile")
          forgetRecentProjectFile(project.id, path);
        if (alive.current && generation === fileGeneration.current)
          reportError(reason);
      } finally {
        if (alive.current && generation === fileGeneration.current) {
          loadingFile.current = null;
          current.current.locked = closeLocked;
          setFileLoading(false);
        }
      }
      return false;
    },
    [closeLocked, project.id],
  );

  /** Drops a pending read of a file that was just moved or deleted. */
  function cancelFileLoad(path: string) {
    if (
      loadingFile.current === null ||
      !isProjectFileWithin(loadingFile.current, path)
    )
      return;
    fileGeneration.current++;
    loadingFile.current = null;
    current.current.locked = closeLocked;
    setFileLoading(false);
  }

  async function selectFile(entry: ProjectFileEntry): Promise<boolean> {
    if (!entry.editable && !entry.previewable) return false;
    if (document?.path === entry.path) return true;
    if (!(await prepare())) return false;
    discard();
    return openFile(entry.path);
  }

  function openFromExplorer(entry: ProjectFileEntry) {
    setReveal(null);
    void selectFile(entry);
  }

  useEffect(() => {
    if (
      !openFileRequest ||
      openFileRequest.projectId !== project.id ||
      consumedOpenRequest.current === openFileRequest.id
    ) {
      return;
    }
    const request = openFileRequest;
    consumedOpenRequest.current = request.id;
    setReveal(
      request.selection
        ? { id: request.id, path: request.path, ...request.selection }
        : null,
    );
    // A selection is revealed in the source editor.
    if (request.selection) setMarkdownPreview(false);
    void selectFile({
      editable: true,
      kind: "file",
      name: projectFileName(request.path),
      path: request.path,
    })
      .then((opened) => {
        // The editor keeps the focus; the tree only scrolls to the file.
        // shortcut: a slow reveal finishing after a newer request scrolls back to the older file; track the request if remote listings make it visible.
        if (opened) void revealPath(request.path, true);
      })
      .finally(() => onOpenFileRequestHandled?.(request.id));
  }, [openFileRequest?.id, onOpenFileRequestHandled, project.id]);

  async function reloadFile() {
    if (!document || !(await prepare())) return;
    const path = document.path;
    discard();
    await openFile(path);
  }
  reloadRef.current = reloadFile;

  async function saveFile() {
    const opened = document;
    if (
      !opened ||
      opened.value === opened.original ||
      current.current.locked ||
      saving
    )
      return;
    setSaving(true);
    notice.clear();
    try {
      const result = await api.writeProjectFile(
        project.id,
        opened.path,
        opened.value,
        opened.version,
      );
      if (!alive.current) return;
      setDocument((value) =>
        value?.path === opened.path
          ? { ...value, original: opened.value, version: result.version }
          : value,
      );
      onFilesChanged?.();
    } catch (reason) {
      if (alive.current) reportError(reason);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function toggleDirectory(path: string) {
    if (expanded.has(path)) {
      setExpanded((value) => {
        const next = new Set(value);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((value) => new Set(value).add(path));
    if (!listings.has(path) && !loadingDirectories.has(path))
      void loadDirectory(path);
  }

  function refreshTree() {
    onFilesChanged?.();
    const generation = ++listGeneration.current;
    const directories = new Set(["", ...listings.keys(), ...expanded]);
    setLoadingDirectories(new Set());
    directories.forEach(
      (directory) => void loadDirectory(directory, generation),
    );
  }

  /** Reloads the loaded or loading directories between the root and each path, outside `removed`. */
  function reloadAround(paths: string[], removed?: string) {
    const directories = new Set<string>();
    for (const path of paths)
      for (const directory of ["", ...projectFileAncestors(path)])
        if (
          (listingsRef.current.has(directory) ||
            pendingDirectories.current.has(directory)) &&
          !(removed && isProjectFileWithin(directory, removed))
        )
          directories.add(directory);
    return Promise.all(
      [...directories].map((directory) => loadDirectory(directory)),
    );
  }

  function forgetTree(path: string, movedTo?: string) {
    for (const [directory, token] of directoryTokens.current)
      if (isProjectFileWithin(directory, path))
        directoryTokens.current.set(directory, token + 1);
    for (const directory of pendingDirectories.current)
      if (isProjectFileWithin(directory, path))
        pendingDirectories.current.delete(directory);
    setLoadingDirectories(
      (value) =>
        new Set(
          [...value].filter(
            (directory) => !isProjectFileWithin(directory, path),
          ),
        ),
    );
    commitListings(
      (value) =>
        new Map(
          [...value].filter(
            ([directory]) => !isProjectFileWithin(directory, path),
          ),
        ),
    );
    setExpanded(
      (value) =>
        new Set(
          [...value].flatMap((directory) => {
            const moved =
              movedTo === undefined
                ? null
                : movedProjectFilePath(directory, path, movedTo);
            return (
              moved ?? (isProjectFileWithin(directory, path) ? [] : directory)
            );
          }),
        ),
    );
  }

  async function revealPath(path: string, scrollOnly = false) {
    const ancestors = projectFileAncestors(path);
    const parent = listingsRef.current.get(projectFileParent(path));
    setExpanded((value) => new Set([...value, ...ancestors]));
    // A cached parent may predate the file (e.g. created by an agent): reload the known chain then.
    const parentStale = !parent?.entries.some((entry) => entry.path === path);
    const directories = ["", ...ancestors].filter((directory) => {
      const known =
        listingsRef.current.has(directory) ||
        pendingDirectories.current.has(directory);
      return known ? parentStale : true;
    });
    await Promise.all(directories.map((directory) => loadDirectory(directory)));
    if (alive.current) setFocusRequest({ path, scrollOnly });
  }

  useEffect(() => {
    if (focusRequest === null) return;
    const row = [
      ...(treeRef.current?.querySelectorAll<HTMLElement>("[data-entry-path]") ??
        []),
    ].find((element) => element.dataset.entryPath === focusRequest.path);
    if (!row && loadingDirectories.size > 0) return;
    setFocusRequest(null);
    const target =
      row ?? (focusRequest.toolbarFallback ? refreshRef.current : null);
    if (!target) return;
    row?.scrollIntoView?.({ block: "nearest" });
    if (
      !focusRequest.scrollOnly &&
      !window.document.querySelector('[aria-modal="true"]')
    )
      target.focus({ preventScroll: true });
  }, [expanded, focusRequest, listings, loadingDirectories]);

  async function runOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    setOperationPending(true);
    notice.clear();
    try {
      return await operation();
    } catch (reason) {
      if (alive.current) reportError(reason);
      return undefined;
    } finally {
      if (alive.current) setOperationPending(false);
    }
  }

  async function createEntry(path: string, kind: ProjectFileKind) {
    const entry = await runOperation(() =>
      api.createProjectFile(project.id, path, kind),
    );
    if (!entry || !alive.current) return;
    setPathDialog(null);
    onFilesChanged?.();
    await reloadAround([entry.path]);
    await revealPath(entry.path);
    if (entry.editable || entry.previewable) {
      setReveal(null);
      await selectFile(entry);
    }
  }

  async function renameEntry(target: FileTarget, to: string) {
    if (saving && document && isProjectFileWithin(document.path, target.path)) {
      notice.error(s.fileSaveInProgress);
      return;
    }
    let stranded: unknown;
    const entry = await runOperation(() =>
      api
        .renameProjectFile(project.id, target.path, to)
        .catch((reason: unknown) => {
          if (projectFileError(reason).code !== "stranded") throw reason;
          stranded = reason;
          return undefined;
        }),
    );
    // An interrupted rename left the entry under a temporary sibling name: follow it there.
    const destination = entry
      ? to
      : stranded === undefined
        ? undefined
        : projectFileError(stranded).message;
    if (destination === undefined || !alive.current) return;
    setPathDialog(null);
    // Same bytes under a new name: the open buffer and its version stay valid.
    setDocument((value) => {
      const moved =
        value && movedProjectFilePath(value.path, target.path, destination);
      return value && moved ? { ...value, path: moved } : value;
    });
    setReveal(null);
    const movedDirectories = [...expanded].flatMap(
      (directory) =>
        movedProjectFilePath(directory, target.path, destination) ?? [],
    );
    cancelFileLoad(target.path);
    moveRecentProjectFiles(project.id, target.path, destination);
    forgetTree(target.path, destination);
    onFilesChanged?.();
    await reloadAround([target.path, to, destination], target.path);
    await Promise.all(
      movedDirectories.map((directory) => loadDirectory(directory)),
    );
    await revealPath(destination);
    // Directory loads clear the notice, so the interruption is reported once the tree is current.
    if (stranded !== undefined && alive.current) reportError(stranded);
  }

  async function deleteEntry(target: FileTarget) {
    if (saving && document && isProjectFileWithin(document.path, target.path)) {
      notice.error(s.fileSaveInProgress);
      return;
    }
    const deleted = await runOperation(() =>
      api.deleteProjectFile(project.id, target.path).then(() => true),
    );
    if (!deleted || !alive.current) return;
    setDeleteTarget(null);
    // The confirmed row disappears: land on its parent row, else the toolbar.
    setFocusRequest({
      path: projectFileParent(target.path),
      toolbarFallback: true,
    });
    setDocument((value) =>
      value && isProjectFileWithin(value.path, target.path) ? null : value,
    );
    cancelFileLoad(target.path);
    forgetRecentProjectFiles(project.id, target.path);
    forgetTree(target.path);
    onFilesChanged?.();
    await reloadAround([target.path], target.path);
  }

  async function duplicateEntry(target: FileTarget) {
    const entry = await runOperation(() =>
      api.duplicateProjectFile(project.id, target.path),
    );
    if (!entry || !alive.current) return;
    onFilesChanged?.();
    await reloadAround([entry.path]);
    await revealPath(entry.path);
  }

  async function downloadEntry(target: FileTarget) {
    const saved = await runOperation(() =>
      api.downloadProjectFile(project.id, target.path),
    );
    if (saved) notifyInfo(s.fileDownloaded, { key: "project-file:downloaded" });
  }

  async function pasteFiles(directory: string) {
    let failure: unknown;
    const entries = await runOperation(() =>
      api
        .pasteProjectFiles(project.id, directory)
        .catch((reason: unknown): ProjectFileEntry[] => {
          failure = reason;
          return [];
        }),
    );
    if (!entries || !alive.current) return;
    // Files copied before a failure stay: list them, then report it (loads clear the notice).
    onFilesChanged?.();
    const last = entries[entries.length - 1];
    if (last) {
      await reloadAround(entries.map((entry) => entry.path));
      await revealPath(last.path);
    } else if (
      listingsRef.current.has(directory) ||
      pendingDirectories.current.has(directory)
    ) {
      await loadDirectory(directory);
    }
    if (failure !== undefined && alive.current) reportError(failure);
  }

  function captureMenuTarget(event: React.SyntheticEvent<HTMLElement>) {
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-entry-path]",
    );
    // The empty tree is itself the focus target, so focus returns there.
    menuRowRef.current =
      row ?? (event.currentTarget.tabIndex === 0 ? event.currentTarget : null);
    setMenuTarget(row ? rowTarget(row) : null);
  }

  function openMenuFromKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
    if (!isContextMenuKey(event)) return;
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-entry-path]",
    );
    const container = event.currentTarget;
    if (!row && event.target !== container) return;
    openContextMenuFromKeyboard(event, row ?? container);
  }

  function pasteFromKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.shiftKey ||
      !(event.ctrlKey || event.metaKey) ||
      event.key.toLowerCase() !== "v"
    )
      return;
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-entry-path]",
    );
    if (!row && event.target !== event.currentTarget) return;
    event.preventDefault();
    if (!operationPending)
      void pasteFiles(targetDirectory(row ? rowTarget(row) : null));
  }

  function actionItem(
    key: string,
    label: string,
    icon: ReactNode,
    onClick: () => void,
    { danger = false, disabled = false } = {},
  ) {
    return (
      <Menu.Item
        key={key}
        nativeButton
        disabled={disabled}
        render={<MenuItem danger={danger} leading={icon} />}
        onClick={onClick}
      >
        {label}
      </Menu.Item>
    );
  }

  function fileActions(target: FileTarget | null): ReactNode {
    const directory = targetDirectory(target);
    const creation = [
      actionItem(
        "new-file",
        s.newFile,
        <FilePlus />,
        () => setPathDialog({ mode: "create", kind: "file", directory }),
        { disabled: operationPending },
      ),
      actionItem(
        "new-folder",
        s.newFolder,
        <FolderPlus />,
        () => setPathDialog({ mode: "create", kind: "directory", directory }),
        { disabled: operationPending },
      ),
      actionItem(
        "paste",
        s.pasteFiles,
        <ClipboardPaste />,
        () => void pasteFiles(directory),
        { disabled: operationPending },
      ),
    ];
    if (!target) return creation;
    const change =
      target.kind === "file" ? gitStatus?.files.get(target.path) : undefined;
    return (
      <>
        <ProjectPathMenuItems
          actions={pathActions}
          agentTarget={agentTarget}
          path={target.path}
          project={project}
        />
        {target.kind === "file" || (historyAvailable && onShowHistory) ? (
          <Menu.Separator className="agent-menu-separator" />
        ) : null}
        {change && onShowChanges
          ? actionItem("changes", s.showFileChanges, <FileDiff />, () =>
              onShowChanges(change),
            )
          : null}
        {historyAvailable && onShowHistory
          ? actionItem("history", s.showFileHistory, <History />, () =>
              onShowHistory(target.path),
            )
          : null}
        {target.kind === "file"
          ? actionItem(
              "download",
              s.downloadFile,
              <Download />,
              () => void downloadEntry(target),
              { disabled: operationPending || target.symlink },
            )
          : null}
        <Menu.Separator className="agent-menu-separator" />
        {creation}
        {/* The backend refuses to rename, duplicate or delete through a link. */}
        {actionItem(
          "rename",
          s.renameFile,
          <Pencil />,
          () => setPathDialog({ mode: "rename", target }),
          { disabled: operationPending || target.symlink },
        )}
        {actionItem(
          "duplicate",
          s.duplicateFile,
          <CopyPlus />,
          () => void duplicateEntry(target),
          { disabled: operationPending || target.symlink },
        )}
        {actionItem(
          "delete",
          s.deleteFile,
          <Trash2 />,
          () => setDeleteTarget(target),
          { danger: true, disabled: operationPending || target.symlink },
        )}
      </>
    );
  }

  const root = listings.get("");
  const rootPath = gitPathParts(
    project.path.replace(/[\\/]+$/, "") || project.path,
  );
  const selectedPath = document?.path ?? null;
  const truncated = [...listings.values()].some((listing) => listing.truncated);
  const treeLabels: TreeLabels = {
    unsupported: s.unsupportedFile,
    symlink: s.symbolicLink,
    folderChanges: s.folderHasChanges,
    badges: {
      M: s.modified,
      A: s.added,
      D: s.deleted,
      R: s.renamed,
      U: s.unmerged,
      "?": s.untracked,
    },
  };
  const deleteAffectsDirtyFile =
    !!deleteTarget &&
    dirty &&
    !!document &&
    isProjectFileWithin(document.path, deleteTarget.path);

  return (
    <div
      className="project-explorer"
      aria-busy={fileLoading || loadingDirectories.size > 0}
      onKeyDown={(event) => {
        // The editor handles its own Ctrl+F; this covers focus in the tree or the toolbar.
        if (
          event.nativeEvent.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.shiftKey ||
          !(event.ctrlKey || event.metaKey) ||
          event.key.toLowerCase() !== "f" ||
          !document ||
          document.mediaType ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        setMarkdownPreview(false);
        setSearchRequested(true);
      }}
    >
      <div
        className="project-explorer-workspace"
        ref={workspaceRef}
        style={
          {
            "--project-tree-size": `${ratio}fr`,
            "--project-editor-size": `${100 - ratio}fr`,
          } as CSSProperties
        }
      >
        <aside className="project-explorer-tree" aria-label={s.explorer}>
          <div className="project-explorer-tree-toolbar">
            <div className="project-explorer-root" title={project.path}>
              {rootPath.parent ? <span>{rootPath.parent}</span> : null}
              <strong>{rootPath.name}</strong>
            </div>
            <div className="project-explorer-tree-actions">
              <IconButton
                ref={refreshRef}
                size="small"
                aria-label={s.refreshFiles}
                title={s.refreshFiles}
                onClick={refreshTree}
              >
                <RefreshCw
                  className={
                    loadingDirectories.has("")
                      ? "app-loading-spinner"
                      : undefined
                  }
                />
              </IconButton>
              <IconButton
                size="small"
                aria-label={s.collapseAll}
                title={s.collapseAll}
                disabled={expanded.size === 0}
                onClick={() => setExpanded(new Set())}
              >
                <ChevronsDownUp />
              </IconButton>
            </div>
          </div>
          <ContextMenu.Root>
            <ContextMenu.Trigger
              className="project-explorer-tree-scroll"
              ref={treeRef}
              onContextMenuCapture={captureMenuTarget}
              // Base UI also opens the menu on touch long-press, without `contextmenu`.
              onTouchStartCapture={captureMenuTarget}
              onKeyDown={(event) => {
                openMenuFromKeyboard(event);
                pasteFromKeyboard(event);
              }}
              // Only the empty tree needs a tab stop; rows are focusable otherwise.
              tabIndex={root && root.entries.length === 0 ? 0 : undefined}
            >
              {!root && loadingDirectories.has("") ? (
                <LoadingState
                  className="project-explorer-tree-status"
                  spinnerSize={13}
                >
                  {s.loadingFiles}
                </LoadingState>
              ) : root && root.entries.length === 0 ? (
                <EmptyState description={s.noProjectFiles} size="compact" />
              ) : root ? (
                <FileTree
                  directory=""
                  expanded={expanded}
                  gitStatus={gitStatus}
                  labels={treeLabels}
                  listings={listings}
                  loading={loadingDirectories}
                  selectedPath={selectedPath}
                  onDirectory={toggleDirectory}
                  onFile={openFromExplorer}
                />
              ) : null}
              {truncated ? (
                <p className="project-explorer-limit" role="status">
                  {s.directoryTruncated}
                </p>
              ) : null}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner
                className="agent-menu-positioner"
                collisionPadding={8}
              >
                <ContextMenu.Popup
                  aria-label={menuTarget?.path ?? s.fileActions}
                  render={<MenuSurface className="agent-actions-menu" />}
                  finalFocus={() =>
                    window.document.querySelector('[aria-modal="true"]')
                      ? false
                      : (menuRowRef.current ?? true)
                  }
                >
                  {fileActions(menuTarget)}
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </aside>
        <RailResizer
          axis="x"
          className="project-explorer-resizer is-wide"
          container={workspaceRef}
          defaultRatio={defaultRatio}
          label={s.resizeExplorer}
          max={maxRatio}
          min={minRatio}
          ratio={ratio}
          onRatioChange={setRatio}
        />
        <RailResizer
          axis="y"
          className="project-explorer-resizer is-narrow"
          container={workspaceRef}
          defaultRatio={defaultRatio}
          label={s.resizeExplorer}
          max={maxRatio}
          min={minRatio}
          ratio={ratio}
          onRatioChange={setRatio}
        />
        <ProjectFileEditorPane
          closeLocked={closeLocked}
          dirty={dirty}
          document={document}
          fileLoading={fileLoading}
          markdownPreview={markdownPreview}
          reveal={reveal}
          saving={saving}
          searchRequested={searchRequested}
          onChange={(value) =>
            setDocument((current) =>
              current ? { ...current, value } : current,
            )
          }
          onRevealed={(id) =>
            setReveal((value) => (value?.id === id ? null : value))
          }
          onSave={() => void saveFile()}
          onSearchOpened={() => setSearchRequested(false)}
          onToggleMarkdownPreview={() => setMarkdownPreview((value) => !value)}
        />
      </div>
      {discardOpen
        ? createPortal(
            <ConfirmationDialog
              title={s.discardFileTitle}
              description={s.discardFileDescription}
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.discardFileConfirm}
              onCancel={() => finishDiscard(false)}
              onConfirm={() => finishDiscard(true)}
            />,
            window.document.body,
          )
        : null}
      {pathDialog
        ? createPortal(
            pathDialog.mode === "create" ? (
              <ProjectFilePathDialog
                title={
                  pathDialog.kind === "file" ? s.newFileTitle : s.newFolderTitle
                }
                initialValue={
                  pathDialog.directory ? `${pathDialog.directory}/` : ""
                }
                confirmLabel={s.createFileConfirm}
                pending={operationPending}
                onCancel={() => setPathDialog(null)}
                returnFocusRef={menuRowRef}
                onSubmit={(path) => void createEntry(path, pathDialog.kind)}
              />
            ) : (
              <ProjectFilePathDialog
                title={s.renameFileTitle}
                description={pathDialog.target.path}
                initialValue={pathDialog.target.path}
                confirmLabel={s.renameFileConfirm}
                pending={operationPending}
                onCancel={() => setPathDialog(null)}
                returnFocusRef={menuRowRef}
                onSubmit={(path) => void renameEntry(pathDialog.target, path)}
              />
            ),
            window.document.body,
          )
        : null}
      {deleteTarget
        ? createPortal(
            <ConfirmationDialog
              title={s.deleteFileTitle(projectFileName(deleteTarget.path))}
              description={[
                s.deleteFileDescription(
                  deleteTarget.path,
                  deleteTarget.kind === "directory",
                ),
                deleteAffectsDirtyFile ? s.deleteUnsavedFile : "",
              ]
                .filter(Boolean)
                .join(" ")}
              cancelDisabled={operationPending}
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmDisabled={operationPending}
              confirmLabel={s.deleteFileConfirm}
              confirmPending={operationPending}
              onCancel={() => setDeleteTarget(null)}
              returnFocusRef={menuRowRef}
              onConfirm={() => void deleteEntry(deleteTarget)}
            />,
            window.document.body,
          )
        : null}
    </div>
  );
}
