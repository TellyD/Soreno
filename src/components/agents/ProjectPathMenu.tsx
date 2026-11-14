import { ContextMenu } from "@base-ui/react/context-menu";
import { Copy, FilePen, FolderX, History, SquareTerminal } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { writeAgentTerminal } from "../../data/agentSessionsApi";
import { writeClipboardText } from "../../data/clipboard";
import type { AgentProject } from "../../domain/agentSessions";
import { shellArgument } from "../../domain/diffLineComment";
import { errorMessage } from "../../domain/errors";
import {
  absoluteProjectFilePath,
  projectPathFromGit,
} from "../../domain/projectFiles";
import { notifyInfo, useScopedNotification } from "../../notifications";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { AgentProviderIcon } from "./AgentProviderIcon";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "./contextMenuKeyboard";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import { useGitStrings } from "./gitStrings";

const controlCharacter = /[\u0000-\u001f\u007f]/;

type ProjectPathActions = {
  copy: (path: string) => Promise<void>;
  insert: (agent: GitDiffCommentTarget, path: string) => Promise<void>;
};

/** Call from a component that outlives the menu: its errors are withdrawn on unmount. */
export function useProjectPathActions(
  onAgentInput?: (sessionId: string) => void,
): ProjectPathActions {
  const s = useGitStrings();
  const notice = useScopedNotification("project-path");
  return {
    copy: async (path) => {
      try {
        await writeClipboardText(path);
        notifyInfo(s.pathCopied, { key: "project-path:copied" });
      } catch (reason) {
        notice.error(errorMessage(reason));
      }
    },
    insert: async (agent, path) => {
      try {
        await writeAgentTerminal(agent.sessionId, `${shellArgument(path)} `);
        onAgentInput?.(agent.sessionId);
      } catch (reason) {
        notice.error(errorMessage(reason));
      }
    },
  };
}

export function ProjectPathMenuItems({
  actions,
  agentTarget,
  path,
  project,
}: {
  actions: ProjectPathActions;
  agentTarget: GitDiffCommentTarget | null;
  /** Project-relative path. */
  path: string;
  project: AgentProject;
}) {
  const s = useGitStrings();
  return (
    <>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Copy />} />}
        onClick={() => void actions.copy(path)}
      >
        {s.copyRelativePath}
      </ContextMenu.Item>
      <ContextMenu.Item
        nativeButton
        render={<MenuItem leading={<Copy />} />}
        onClick={() =>
          void actions.copy(absoluteProjectFilePath(project.path, path))
        }
      >
        {s.copyAbsolutePath}
      </ContextMenu.Item>
      {agentTarget ? (
        <ContextMenu.Item
          nativeButton
          // Raw control characters would reach the agent PTY as keystrokes (Enter, Ctrl+C…).
          disabled={controlCharacter.test(path)}
          render={
            <MenuItem
              leading={
                <AgentProviderIcon executable={agentTarget.executable} />
              }
            />
          }
          onClick={() => void actions.insert(agentTarget, path)}
        >
          {s.insertPathInAgent}
        </ContextMenu.Item>
      ) : (
        <ContextMenu.Item
          nativeButton
          disabled
          render={<MenuItem leading={<SquareTerminal />} />}
        >
          {s.noActiveAgent}
        </ContextMenu.Item>
      )}
    </>
  );
}

export type GitFileMenu = {
  project: AgentProject;
  /** Project directory relative to the Git root (`""` or `dir/`); `null` until known. */
  prefix: string | null;
  agentTarget: GitDiffCommentTarget | null;
  onAgentInput?: (sessionId: string) => void;
  /** Resolves to whether the history filter was applied. */
  onShowHistory?: (path: string) => Promise<boolean>;
  onOpenFile?: (path: string) => void;
};

/** Path actions for rows marked with `data-git-path` (relative to the Git root) and optionally `data-git-deleted`. */
export function GitFileContextMenu({
  children,
  historyPath = null,
  menu,
  render,
}: {
  children: ReactNode;
  /** Project-relative path the shown history is already limited to. */
  historyPath?: string | null;
  menu?: GitFileMenu;
  render: ReactElement;
}) {
  const s = useGitStrings();
  const actions = useProjectPathActions(menu?.onAgentInput);
  const [target, setTarget] = useState<string | null>(null);
  const [targetDeleted, setTargetDeleted] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const leftRowRef = useRef(false);
  const projectPath =
    menu && target !== null && menu.prefix !== null
      ? projectPathFromGit(target, menu.prefix)
      : null;

  function captureTarget(event: SyntheticEvent<HTMLElement>) {
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-git-path]",
    );
    rowRef.current = row;
    leftRowRef.current = false;
    setTarget(row?.dataset.gitPath ?? null);
    setTargetDeleted(row?.dataset.gitDeleted !== undefined);
  }

  function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (!menu || !isContextMenuKey(event)) return;
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-git-path]",
    );
    if (row) openContextMenuFromKeyboard(event, row);
  }

  return (
    <ContextMenu.Root disabled={!menu}>
      <ContextMenu.Trigger
        render={render}
        onContextMenuCapture={captureTarget}
        // Base UI also opens the menu on touch long-press, without `contextmenu`.
        onTouchStartCapture={(event) => {
          if (event.touches.length === 1) captureTarget(event);
        }}
        onContextMenu={(event) => {
          if (!rowRef.current) event.preventBaseUIHandler();
        }}
        onTouchStart={(event) => {
          // Base UI must still see a second touch: it cancels the long press.
          if (event.touches.length === 1 && !rowRef.current)
            event.preventBaseUIHandler();
        }}
        onKeyDown={openFromKeyboard}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          className="agent-menu-positioner"
          collisionPadding={8}
        >
          <ContextMenu.Popup
            aria-label={target ?? s.fileActions}
            render={<MenuSurface className="agent-actions-menu" />}
            finalFocus={() =>
              leftRowRef.current ||
              document.querySelector('[aria-modal="true"]')
                ? false
                : (rowRef.current ?? true)
            }
          >
            {menu && projectPath !== null ? (
              <>
                <ProjectPathMenuItems
                  actions={actions}
                  agentTarget={menu.agentTarget}
                  path={projectPath}
                  project={menu.project}
                />
                {menu.onOpenFile ||
                (menu.onShowHistory && projectPath !== historyPath) ? (
                  <ContextMenu.Separator className="agent-menu-separator" />
                ) : null}
                {menu.onOpenFile ? (
                  <ContextMenu.Item
                    nativeButton
                    disabled={targetDeleted}
                    render={<MenuItem leading={<FilePen />} />}
                    onClick={() => {
                      // The explorer replaces the Git view and takes focus.
                      leftRowRef.current = true;
                      menu.onOpenFile?.(projectPath);
                    }}
                  >
                    {s.openFile}
                  </ContextMenu.Item>
                ) : null}
                {menu.onShowHistory && projectPath !== historyPath ? (
                  <ContextMenu.Item
                    nativeButton
                    render={<MenuItem leading={<History />} />}
                    onClick={() => {
                      // The history view takes focus; the row may be hidden or gone.
                      leftRowRef.current = true;
                      const row = rowRef.current;
                      void menu.onShowHistory?.(projectPath).then((shown) => {
                        if (!shown && row?.isConnected) row.focus();
                      });
                    }}
                  >
                    {s.showFileHistory}
                  </ContextMenu.Item>
                ) : null}
              </>
            ) : (
              <ContextMenu.Item
                nativeButton
                disabled
                render={<MenuItem leading={<FolderX />} />}
              >
                {s.outsideProject}
              </ContextMenu.Item>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
