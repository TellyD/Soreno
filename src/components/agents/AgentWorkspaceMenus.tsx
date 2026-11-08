import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  GitBranch,
  ListFilter,
  Pencil,
  Plus,
  SquareSplitHorizontal,
  Star,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  agentPresets,
  visibleAgentPresets,
  type AgentSession,
} from "../../domain/agentSessions";
import { useAppSettings } from "../../settings";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { useAgentStrings } from "./agentStrings";
import { AgentProviderIcon } from "./AgentProviderIcon";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "./contextMenuKeyboard";

// Rows can number in the hundreds: menu items are only built while the popup is mounted.
function RowContextMenuActions({ render }: { render: () => ReactNode }) {
  return render();
}

export function RowContextMenu({
  children,
  actions,
  disabled,
  returnFocusRef,
  className,
}: {
  children: ReactNode;
  actions: () => ReactNode;
  disabled: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const target = () =>
    row.current?.querySelector<HTMLElement>(
      ".nav-item, .agent-session-tab, .agent-project-group-toggle",
    ) ?? null;
  return (
    <ContextMenu.Root
      disabled={disabled}
      onOpenChange={(open) => {
        if (open) returnFocusRef.current = target();
      }}
    >
      <ContextMenu.Trigger
        ref={row}
        className={className}
        onKeyDown={(event) => {
          if (isContextMenuKey(event))
            openContextMenuFromKeyboard(event, row.current!);
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          className="agent-menu-positioner"
          collisionPadding={8}
        >
          <ContextMenu.Popup
            render={<MenuSurface className="agent-actions-menu" />}
            finalFocus={() =>
              document.querySelector(
                '[aria-modal="true"], [data-agent-project-appearance]',
              )
                ? false
                : target()
            }
          >
            <RowContextMenuActions render={actions} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ProjectViewControls({
  filterDisabled,
  collapseDisabled,
  allCollapsed,
  onlyWithAgents,
  onOnlyWithAgentsChange,
  onToggleCollapseAll,
}: {
  filterDisabled: boolean;
  collapseDisabled: boolean;
  allCollapsed: boolean;
  onlyWithAgents: boolean;
  onOnlyWithAgentsChange: (value: boolean) => void;
  onToggleCollapseAll: () => void;
}) {
  const s = useAgentStrings();
  const collapseLabel = allCollapsed
    ? s.expandAllProjects
    : s.collapseAllProjects;
  return (
    <>
      <IconButton
        aria-label={s.onlyProjectsWithAgents}
        aria-pressed={onlyWithAgents}
        title={s.onlyProjectsWithAgents}
        disabled={filterDisabled}
        selected={onlyWithAgents}
        onClick={() => onOnlyWithAgentsChange(!onlyWithAgents)}
      >
        <ListFilter aria-hidden="true" />
      </IconButton>
      <IconButton
        aria-label={collapseLabel}
        title={collapseLabel}
        disabled={collapseDisabled}
        onClick={onToggleCollapseAll}
      >
        {allCollapsed ? (
          <ChevronsUpDown aria-hidden="true" />
        ) : (
          <ChevronsDownUp aria-hidden="true" />
        )}
      </IconButton>
    </>
  );
}

export function NewProjectMenu({
  disabled,
  onOpen,
  onClone,
  onGroup,
  hasProjects,
  returnFocusRef,
  triggerRef,
}: {
  disabled: boolean;
  onOpen: () => void;
  onClone: () => void;
  onGroup: () => void;
  hasProjects: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const s = useAgentStrings();
  return (
    <Menu.Root
      disabled={disabled}
      modal={false}
      onOpenChange={(open) => {
        if (open) returnFocusRef.current = triggerRef.current;
      }}
    >
      <Menu.Trigger
        ref={triggerRef}
        render={
          <IconButton
            className="agent-add-project"
            aria-label={s.addProject}
            title={s.addProject}
            disabled={disabled}
          >
            <Plus strokeWidth={1.6} />
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
            render={<MenuSurface className="agent-launcher-menu" />}
            finalFocus={() => !document.querySelector('[aria-modal="true"]')}
          >
            <Menu.Item
              nativeButton
              disabled={!hasProjects}
              render={<MenuItem leading={<FolderPlus />} />}
              onClick={onGroup}
            >
              {s.newGroup}
            </Menu.Item>
            <Menu.Item
              nativeButton
              render={<MenuItem leading={<Folder />} />}
              onClick={onOpen}
            >
              {s.openRepository}
            </Menu.Item>
            <Menu.Item
              nativeButton
              render={<MenuItem leading={<GitBranch />} />}
              onClick={onClone}
            >
              {s.cloneRepository}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function NewSessionMenu({
  projectName,
  disabled,
  onPreset,
  split,
  prominent = false,
  size = "medium",
  returnFocusRef,
  triggerRef,
}: {
  projectName: string;
  disabled: boolean;
  onPreset: (preset: (typeof agentPresets)[number]) => void;
  /** Split actions for the selected session, below the presets; `onDetach` is set while it is split. */
  split?: {
    onPreset: (preset: (typeof agentPresets)[number]) => void;
    onDetach: (() => void) | null;
  };
  prominent?: boolean;
  size?: "small" | "medium";
  returnFocusRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const s = useAgentStrings();
  const { settings } = useAppSettings();
  const trigger = triggerRef;
  // Detaching focuses the remaining terminal: the closing menu must not take it back.
  const detached = useRef(false);
  const label = `${s.newSession} · ${projectName}`;
  const presets = visibleAgentPresets(settings.hiddenAgentPresets);
  return (
    <Menu.Root
      // Detaching only changes the local layout: it stays offered while the project is unavailable.
      disabled={disabled && !split?.onDetach}
      modal={false}
      onOpenChange={(open) => {
        if (!open) return;
        detached.current = false;
        returnFocusRef.current = trigger.current;
      }}
    >
      <Menu.Trigger
        ref={trigger}
        render={
          prominent ? (
            <Button variant="primary" startIcon={<Plus />}>
              {s.newSession}
            </Button>
          ) : (
            <IconButton
              size={size}
              className="agent-project-add"
              aria-label={label}
              title={s.newSession}
            >
              <Plus strokeWidth={1.6} />
            </IconButton>
          )
        }
        aria-label={label}
      />
      <Menu.Portal>
        <Menu.Positioner
          className="agent-menu-positioner"
          sideOffset={6}
          align={prominent ? "center" : "start"}
          collisionPadding={8}
        >
          <Menu.Popup
            render={<MenuSurface className="agent-launcher-menu" />}
            finalFocus={() =>
              !detached.current &&
              !document.querySelector('[aria-modal="true"]')
            }
          >
            {presets.map((preset) => (
              <Menu.Item
                disabled={disabled}
                nativeButton
                key={preset.executable}
                render={<MenuItem />}
                onClick={() => onPreset(preset)}
              >
                {preset.name}
              </Menu.Item>
            ))}
            {split ? (
              <>
                <Menu.Separator className="agent-menu-separator" />
                {split.onDetach ? (
                  <Menu.Item
                    nativeButton
                    render={<MenuItem leading={<SquareSplitHorizontal />} />}
                    onClick={() => {
                      detached.current = true;
                      split.onDetach?.();
                    }}
                  >
                    {s.detachSplitTerminal}
                  </Menu.Item>
                ) : (
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger
                      nativeButton
                      render={
                        <MenuItem
                          leading={<SquareSplitHorizontal />}
                          trailing={<ChevronRight />}
                        />
                      }
                    >
                      {s.splitTerminal}
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                      <Menu.Positioner
                        className="agent-menu-positioner"
                        alignOffset={-4}
                        collisionPadding={8}
                      >
                        <Menu.Popup
                          render={
                            <MenuSurface className="agent-launcher-menu" />
                          }
                        >
                          {presets.map((preset) => (
                            <Menu.Item
                              nativeButton
                              key={preset.executable}
                              render={<MenuItem />}
                              onClick={() => split.onPreset(preset)}
                            >
                              {preset.name}
                            </Menu.Item>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
                )}
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function FavoriteSessionsMenu({
  projectName,
  sessions,
  disabled,
  sessionName,
  returnFocusRef,
  onOpen,
  onRename,
  onRemove,
}: {
  projectName: string;
  sessions: readonly AgentSession[];
  disabled: boolean;
  sessionName: (session: AgentSession) => string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onOpen: (session: AgentSession) => void;
  onRename: (session: AgentSession) => void;
  onRemove: (session: AgentSession) => void;
}) {
  const s = useAgentStrings();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = `${s.favoriteSessions} · ${projectName}`;
  const closeThen =
    (action: (session: AgentSession) => void, session: AgentSession) => () => {
      setOpen(false);
      action(session);
    };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) returnFocusRef.current = trigger.current;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        ref={trigger}
        disabled={disabled}
        render={
          <IconButton
            className="agent-favorites-trigger"
            aria-label={label}
            title={s.favoriteSessions}
          >
            <Star strokeWidth={1.6} />
          </IconButton>
        }
      />
      <Popover.Portal>
        <Popover.Positioner
          className="agent-menu-positioner"
          // Below the toolbar border, the same 8px gap as its left padding.
          sideOffset={16}
          align="start"
          collisionPadding={8}
        >
          <Popover.Popup
            render={
              <MenuSurface
                className="agent-favorites-menu"
                role="dialog"
                aria-label={label}
              />
            }
            finalFocus={() => !document.querySelector('[aria-modal="true"]')}
          >
            <div className="agent-menu-group-label">{s.favoriteSessions}</div>
            {sessions.length === 0 ? (
              <EmptyState
                className="agent-favorites-empty"
                description={s.favoriteSessionsEmpty}
                layout="inline"
                size="compact"
              />
            ) : (
              sessions.map((session) => {
                const name = sessionName(session);
                return (
                  <div key={session.id} className="agent-favorite-row">
                    <MenuItem
                      role="button"
                      title={name}
                      leading={
                        <AgentProviderIcon executable={session.executable} />
                      }
                      onClick={closeThen(onOpen, session)}
                    >
                      {name}
                    </MenuItem>
                    <IconButton
                      size="small"
                      aria-label={`${s.rename} · ${name}`}
                      title={s.rename}
                      onClick={closeThen(onRename, session)}
                    >
                      <Pencil aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      className="agent-favorite-remove"
                      size="small"
                      aria-label={`${s.removeSessionFavorite} · ${name}`}
                      title={s.removeSessionFavorite}
                      onClick={() => onRemove(session)}
                    >
                      <X strokeWidth={1.6} aria-hidden="true" />
                    </IconButton>
                  </div>
                );
              })
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
