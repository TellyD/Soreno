import { Palette, Pencil, Trash2 } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  noteTypeView,
  type LibraryView,
  type ViewCounts,
} from "../../domain/library";
import {
  findNoteType,
  nextAvailableNoteTypeName,
  validateNoteTypeName,
  type NoteType,
  type NoteTypeId,
  type NoteTypeNameValidationError,
} from "../../domain/noteTypes";
import { paletteColorOptions } from "../../domain/palette";
import { useI18n, type TranslationKey } from "../../i18n";
import { notifyError, useNotification } from "../../notifications";
import {
  AppearanceCustomizer,
  appearancePopoverSize,
} from "../AppearanceCustomizer";
import { appearanceIconOptions } from "../appearanceIcons";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { NoteTypeNavItem } from "./NoteTypeNavItem";
import { NavSection } from "../SidebarNav";
import { useNoteTypeReorder } from "./useNoteTypeReorder";

const menuMargin = 8;

type RenameState = {
  id: NoteTypeId;
  name: string;
};

type ContextMenuState = {
  noteTypeId: NoteTypeId;
  x: number;
  y: number;
};

type CustomizerState = {
  color: string;
  icon: string;
  noteTypeId: NoteTypeId;
  x: number;
  y: number;
};

type NoteTypeSectionProps = {
  activeView: LibraryView;
  counts: ViewCounts;
  isExpanded: boolean;
  noteTypes: NoteType[];
  onCreateNoteType: (
    name: string,
    icon: string,
    color: string,
  ) => Promise<NoteType>;
  onDeleteNoteType: (id: NoteTypeId) => Promise<void>;
  onDropNote: (noteId: string, kind: NoteTypeId) => void;
  onExpandedChange: (isExpanded: boolean) => void;
  onReorderNoteTypes: (ids: NoteTypeId[]) => Promise<void>;
  onSelectView: (view: LibraryView) => void;
  onUpdateNoteType: (
    id: NoteTypeId,
    name: string,
    icon: string,
    color: string,
  ) => Promise<NoteType>;
};

const noteTypeValidationErrorKeys: Record<
  NoteTypeNameValidationError,
  TranslationKey
> = {
  duplicate: "noteTypes.error.duplicate",
  empty: "noteTypes.error.emptyName",
  "too-long": "noteTypes.error.nameTooLong",
};

export function NoteTypeSection({
  activeView,
  counts,
  isExpanded,
  noteTypes,
  onCreateNoteType,
  onDeleteNoteType,
  onDropNote,
  onExpandedChange,
  onReorderNoteTypes,
  onSelectView,
  onUpdateNoteType,
}: NoteTypeSectionProps) {
  const { locale, t } = useI18n();
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [customizer, setCustomizer] = useState<CustomizerState | null>(null);
  const [renameErrorKey, setRenameErrorKey] = useState<TranslationKey | null>(
    null,
  );
  const [isSavingType, setIsSavingType] = useState(false);
  const [isReorderingTypes, setIsReorderingTypes] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const customizerRef = useRef<HTMLDivElement>(null);
  const isBusy = isSavingType || isReorderingTypes;
  const noteTypeReorder = useNoteTypeReorder({
    isDisabled: isBusy || renameState !== null,
    noteTypes,
    onDragStart: clearFloatingTypeSurfaces,
    onReorder: persistReorder,
  });
  useNotification(
    renameState && renameErrorKey
      ? { key: "note-type-rename", message: t(renameErrorKey) }
      : null,
  );

  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }

    const menu = contextMenuRef.current;

    if (!menu) {
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const nextX = clamp(
      contextMenu.x,
      menuMargin,
      window.innerWidth - menuRect.width - menuMargin,
    );
    const nextY = clamp(
      contextMenu.y,
      menuMargin,
      window.innerHeight - menuRect.height - menuMargin,
    );

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu({ ...contextMenu, x: nextX, y: nextY });
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu && !customizer) {
      return;
    }

    function closeFloatingSurfaces(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        (contextMenuRef.current?.contains(event.target) ||
          customizerRef.current?.contains(event.target))
      ) {
        return;
      }

      setContextMenu(null);
      setCustomizer(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
        setCustomizer(null);
      }
    }

    document.addEventListener("pointerdown", closeFloatingSurfaces);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeFloatingSurfaces);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu, customizer]);

  async function handleCreateType() {
    if (isBusy) {
      return;
    }

    setRenameErrorKey(null);
    setIsSavingType(true);

    try {
      const createdType = await onCreateNoteType(
        nextAvailableNoteTypeName(
          noteTypes,
          t("noteTypes.defaultName"),
          locale,
        ),
        appearanceIconOptions[0].id,
        paletteColorOptions[0].color,
      );

      onExpandedChange(true);
      setRenameState({ id: createdType.id, name: createdType.name });
    } catch {
      // The note type controller reports the failure.
    } finally {
      setIsSavingType(false);
    }
  }

  function startRename(noteType: NoteType) {
    setContextMenu(null);
    setCustomizer(null);
    setRenameErrorKey(null);
    setRenameState({ id: noteType.id, name: noteType.name });
  }

  async function commitRename() {
    if (!renameState || isBusy) {
      return;
    }

    const noteType = findNoteType(noteTypes, renameState.id);

    if (!noteType) {
      setRenameState(null);
      return;
    }

    const validationError = validateNoteTypeName(
      renameState.name,
      noteTypes,
      renameState.id,
    );

    if (validationError) {
      setRenameErrorKey(noteTypeValidationErrorKeys[validationError]);
      return;
    }

    const nextName = renameState.name.trim();

    if (nextName === noteType.name) {
      setRenameState(null);
      return;
    }

    setIsSavingType(true);
    setRenameErrorKey(null);

    try {
      await onUpdateNoteType(
        noteType.id,
        nextName,
        noteType.icon,
        noteType.color,
      );
      setRenameState(null);
    } catch {
      // The note type controller reports the failure.
    } finally {
      setIsSavingType(false);
    }
  }

  function cancelRename() {
    setRenameState(null);
    setRenameErrorKey(null);
  }

  function openContextMenu(noteType: NoteType, x: number, y: number) {
    setContextMenu({
      noteTypeId: noteType.id,
      x: clamp(x, menuMargin, window.innerWidth - menuMargin),
      y: clamp(y, menuMargin, window.innerHeight - menuMargin),
    });
    setCustomizer(null);
  }

  function openCustomizer(noteType: NoteType) {
    const sourceX = contextMenu?.x ?? window.innerWidth / 2;
    const sourceY = contextMenu?.y ?? window.innerHeight / 2;

    setCustomizer({
      color: noteType.color,
      icon: noteType.icon,
      noteTypeId: noteType.id,
      x: clamp(
        sourceX + 18,
        menuMargin,
        window.innerWidth - appearancePopoverSize.width - menuMargin,
      ),
      y: clamp(
        sourceY + 28,
        menuMargin,
        window.innerHeight - appearancePopoverSize.height - menuMargin,
      ),
    });
    setContextMenu(null);
  }

  async function updateCustomizerSelection(
    noteType: NoteType,
    nextValues: Pick<CustomizerState, "color" | "icon">,
  ) {
    if (isBusy) {
      return;
    }

    setIsSavingType(true);
    setCustomizer((currentCustomizer) =>
      currentCustomizer?.noteTypeId === noteType.id
        ? { ...currentCustomizer, ...nextValues }
        : currentCustomizer,
    );

    try {
      await onUpdateNoteType(
        noteType.id,
        noteType.name,
        nextValues.icon,
        nextValues.color,
      );
    } catch {
      setCustomizer((currentCustomizer) =>
        currentCustomizer?.noteTypeId === noteType.id
          ? { ...currentCustomizer, color: noteType.color, icon: noteType.icon }
          : currentCustomizer,
      );
    } finally {
      setIsSavingType(false);
    }
  }

  async function persistReorder(ids: NoteTypeId[]) {
    if (isBusy) {
      return;
    }

    setIsReorderingTypes(true);

    try {
      await onReorderNoteTypes(ids);
    } catch {
      // The note type controller reports the failure.
    } finally {
      setIsReorderingTypes(false);
    }
  }

  function clearFloatingTypeSurfaces() {
    setContextMenu(null);
    setCustomizer(null);
  }

  function selectNoteType(noteType: NoteType) {
    if (noteTypeReorder.shouldSkipSelect()) {
      return;
    }

    onSelectView(noteTypeView(noteType.id));
  }

  async function handleDeleteType(noteType: NoteType) {
    setContextMenu(null);
    setCustomizer(null);

    if ((counts.byType[noteType.id] ?? 0) > 0) {
      notifyError(t("noteTypes.error.deleteUsed"));
      return;
    }

    if (noteTypes.length <= 1) {
      notifyError(t("noteTypes.error.deleteLast"));
      return;
    }

    try {
      await onDeleteNoteType(noteType.id);
      if (renameState?.id === noteType.id) {
        cancelRename();
      }
    } catch {
      // The note type controller reports the failure.
    }
  }

  const contextNoteType = findNoteType(
    noteTypes,
    contextMenu?.noteTypeId ?? null,
  );
  const customizerNoteType = findNoteType(
    noteTypes,
    customizer?.noteTypeId ?? null,
  );

  return (
    <>
      <NavSection
        addLabel={t("noteTypes.create")}
        isExpanded={isExpanded}
        onAdd={() => void handleCreateType()}
        onExpandedChange={onExpandedChange}
        title={t("sidebar.section.types")}
      >
        <div
          className={[
            "nav-group",
            noteTypeReorder.isReordering ? "type-nav-reordering" : null,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {noteTypes.map((noteType) => (
            <Fragment key={noteType.id}>
              {noteTypeReorder.dropBeforeId === noteType.id ? (
                <div className="type-nav-drop-indicator" />
              ) : null}
              <NoteTypeNavItem
                count={counts.byType[noteType.id] ?? 0}
                isDragging={noteTypeReorder.isDragging(noteType.id)}
                isDropDisabled={
                  isBusy ||
                  noteTypeReorder.isReordering ||
                  renameState?.id === noteType.id
                }
                isRenaming={renameState?.id === noteType.id}
                isReorderDisabled={noteTypeReorder.isReorderDisabled}
                isSaving={isBusy}
                isSelected={activeView === noteTypeView(noteType.id)}
                noteType={noteType}
                ref={noteTypeReorder.registerItemRef(noteType.id)}
                renameValue={
                  renameState?.id === noteType.id
                    ? renameState.name
                    : noteType.name
                }
                onCancelRename={cancelRename}
                onChangeRename={(name) => {
                  setRenameErrorKey(null);
                  setRenameState((currentState) =>
                    currentState?.id === noteType.id
                      ? { ...currentState, name }
                      : currentState,
                  );
                }}
                onCommitRename={() => void commitRename()}
                onContextMenu={(x, y) => openContextMenu(noteType, x, y)}
                onDropNote={(noteId) => onDropNote(noteId, noteType.id)}
                onReorderPointerDown={(pointerId, startY) =>
                  noteTypeReorder.startDrag(noteType.id, pointerId, startY)
                }
                onSelect={() => selectNoteType(noteType)}
              />
            </Fragment>
          ))}
          {noteTypeReorder.shouldShowDropAtEnd ? (
            <div className="type-nav-drop-indicator" />
          ) : null}
        </div>
      </NavSection>

      {contextMenu && contextNoteType ? (
        <MenuSurface
          className="note-type-context-menu"
          ref={contextMenuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <MenuItem
            leading={<Pencil size={14} />}
            onClick={() => startRename(contextNoteType)}
            onMouseDown={(event) => event.preventDefault()}
          >
            {t("noteTypes.renameContext")}
          </MenuItem>
          <MenuItem
            leading={<Palette size={14} />}
            onClick={() => openCustomizer(contextNoteType)}
            onMouseDown={(event) => event.preventDefault()}
          >
            {t("noteTypes.customize")}
          </MenuItem>
          <MenuItem
            danger
            leading={<Trash2 size={14} />}
            onClick={() => void handleDeleteType(contextNoteType)}
            onMouseDown={(event) => event.preventDefault()}
          >
            {t("noteTypes.delete")}
          </MenuItem>
        </MenuSurface>
      ) : null}

      {customizer && customizerNoteType ? (
        <section
          aria-label={t("noteTypes.customize")}
          className="appearance-customizer-popover"
          ref={customizerRef}
          style={{ left: customizer.x, top: customizer.y }}
        >
          <AppearanceCustomizer
            color={customizer.color}
            disabled={isSavingType}
            icon={customizer.icon}
            onSelectColor={(color) =>
              void updateCustomizerSelection(customizerNoteType, {
                color,
                icon: customizer.icon,
              })
            }
            onSelectIcon={(icon) =>
              void updateCustomizerSelection(customizerNoteType, {
                color: customizer.color,
                icon,
              })
            }
          />
        </section>
      ) : null}
    </>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
