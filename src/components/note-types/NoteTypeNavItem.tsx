import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { NoteType } from "../../domain/noteTypes";
import { CountBadge } from "../ui/CountBadge";
import { Input } from "../ui/Input";
import { getNoteTypeAppearance, noteTypeStyleVars } from "./noteTypeMeta";
import { NavItem } from "../SidebarNav";
import { noteDragMimeType } from "../noteDrag";

type NoteTypeNavItemProps = {
  count: number;
  isDragging: boolean;
  isDropDisabled: boolean;
  isRenaming: boolean;
  isReorderDisabled: boolean;
  isSaving: boolean;
  isSelected: boolean;
  noteType: NoteType;
  renameValue: string;
  onCancelRename: () => void;
  onChangeRename: (name: string) => void;
  onCommitRename: () => void;
  onContextMenu: (x: number, y: number) => void;
  onDropNote: (noteId: string) => void;
  onReorderPointerDown: (pointerId: number, startY: number) => void;
  onSelect: () => void;
};

export const NoteTypeNavItem = forwardRef<HTMLDivElement, NoteTypeNavItemProps>(
  function NoteTypeNavItem(
    {
      count,
      isDragging,
      isDropDisabled,
      isRenaming,
      isReorderDisabled,
      isSaving,
      isSelected,
      noteType,
      renameValue,
      onCancelRename,
      onChangeRename,
      onCommitRename,
      onContextMenu,
      onDropNote,
      onReorderPointerDown,
      onSelect,
    },
    ref,
  ) {
    const appearance = getNoteTypeAppearance(noteType);
    const TypeIcon = appearance.icon;
    const renameInputRef = useRef<HTMLInputElement>(null);
    const style = noteTypeStyleVars(noteType) as CSSProperties;
    const [isDropTarget, setIsDropTarget] = useState(false);
    const dragDepth = useRef(0);

    function clearDropTarget() {
      dragDepth.current = 0;
      setIsDropTarget(false);
    }

    function acceptsNote(event: DragEvent<HTMLDivElement>) {
      return (
        !isDropDisabled && event.dataTransfer.types.includes(noteDragMimeType)
      );
    }

    useEffect(() => {
      if (!isDropTarget) return;
      if (isDropDisabled) {
        clearDropTarget();
        return;
      }
      function cancelOnEscape(event: globalThis.KeyboardEvent) {
        if (event.key === "Escape") clearDropTarget();
      }
      // Only the hovered target listens for a drag ending elsewhere.
      document.addEventListener("dragend", clearDropTarget);
      document.addEventListener("drop", clearDropTarget);
      document.addEventListener("keydown", cancelOnEscape);
      return () => {
        document.removeEventListener("dragend", clearDropTarget);
        document.removeEventListener("drop", clearDropTarget);
        document.removeEventListener("keydown", cancelOnEscape);
      };
    }, [isDropTarget, isDropDisabled]);

    useEffect(() => {
      if (!isRenaming) {
        return;
      }

      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, [isRenaming]);

    function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
      if (
        isReorderDisabled ||
        event.button !== 0 ||
        (event.target instanceof HTMLElement &&
          event.target.closest(".type-nav-name-input"))
      ) {
        return;
      }

      onReorderPointerDown(event.pointerId, event.clientY);
    }

    function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".type-nav-name-input")
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onContextMenu(event.clientX, event.clientY);
    }

    function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.key === "Enter") {
        event.preventDefault();
        onCommitRename();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRename();
      }
    }

    return (
      <div
        className={[
          "type-nav-row",
          isSelected ? "selected" : null,
          isDragging ? "dragging" : null,
          isDropTarget && !isDropDisabled ? "note-drop-target" : null,
          isReorderDisabled ? null : "reorderable",
        ]
          .filter(Boolean)
          .join(" ")}
        data-custom-context-menu="true"
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onDragEnter={(event) => {
          if (!acceptsNote(event)) return;
          dragDepth.current += 1;
          setIsDropTarget(true);
        }}
        onDragOver={(event) => {
          if (!acceptsNote(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setIsDropTarget(true);
        }}
        onDragLeave={(event) => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (
            dragDepth.current === 0 &&
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          )
            clearDropTarget();
        }}
        onDrop={(event) => {
          clearDropTarget();
          if (!acceptsNote(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const noteId = event.dataTransfer.getData(noteDragMimeType);
          if (noteId.trim()) onDropNote(noteId);
        }}
        ref={ref}
        style={style}
      >
        {isRenaming ? (
          <div className="type-nav-rename-row">
            <span className="nav-icon" style={{ color: appearance.accent }}>
              <TypeIcon size={15} aria-hidden="true" />
            </span>
            <Input
              aria-label={noteType.name}
              autoFocus
              className="type-nav-name-input"
              disabled={isSaving}
              onBlur={onCommitRename}
              onChange={(event) => onChangeRename(event.currentTarget.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={handleRenameKeyDown}
              ref={renameInputRef}
              size="small"
              value={renameValue}
            />
            <CountBadge
              accentColor={isSelected ? appearance.accent : undefined}
              count={count}
            />
          </div>
        ) : (
          <NavItem
            accentColor={appearance.accent}
            className="type-nav-item"
            count={count}
            icon={<TypeIcon size={15} />}
            isSelected={isSelected}
            label={noteType.name}
            onSelect={onSelect}
            style={style}
          />
        )}
      </div>
    );
  },
);
