import { Popover } from "@base-ui/react/popover";
import { Check, FileText, Link2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../../domain/notes";
import { useI18n } from "../../i18n";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { MenuItem, MenuSurface } from "../ui/Menu";

type TaskNotePickerProps = {
  attachedNote: Note | null;
  isEditing: boolean;
  isOpen: boolean;
  notes: Note[];
  onOpenChange: (isOpen: boolean) => void;
  onUpdateAttachedNote: (noteId: string | null) => void;
  selectedNoteId: string | null;
};

export function TaskNotePicker({
  attachedNote,
  isEditing,
  isOpen,
  notes,
  onOpenChange,
  onUpdateAttachedNote,
  selectedNoteId,
}: TaskNotePickerProps) {
  const { locale, t } = useI18n();
  const [noteQuery, setNoteQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filteredNotes = useMemo(
    () => filterNotesForMenu(notes, noteQuery, locale),
    [locale, noteQuery, notes],
  );

  useEffect(() => {
    if (!isOpen) setNoteQuery("");
  }, [isOpen]);

  function handleAttachedNoteSelect(noteId: string | null) {
    onUpdateAttachedNote(noteId);
    onOpenChange(false);
  }

  const label = attachedNote
    ? t("tasks.note.change", { title: attachedNote.title })
    : t("tasks.note.attach");

  return (
    <div className="task-note-picker" data-task-no-drag>
      <Popover.Root open={isOpen} onOpenChange={onOpenChange}>
        <Popover.Trigger
          render={
            <IconButton
              className="task-note-button"
              aria-label={label}
              selected={Boolean(attachedNote)}
              size="small"
              title={label}
              onMouseDown={(event) => {
                if (isEditing) event.preventDefault();
              }}
            >
              <Link2 aria-hidden="true" />
            </IconButton>
          }
        />
        <Popover.Portal
          data-task-no-drag
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Popover.Positioner
            className="task-menu-positioner"
            align="end"
            collisionPadding={8}
            positionMethod="fixed"
            sideOffset={5}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Popover.Popup
              initialFocus={searchInputRef}
              render={
                <MenuSurface
                  className="task-note-menu"
                  role="dialog"
                  aria-label={t("tasks.note.search")}
                />
              }
            >
              <div className="task-note-search">
                <Input
                  aria-label={t("tasks.note.search")}
                  placeholder={t("tasks.note.searchPlaceholder")}
                  ref={searchInputRef}
                  size="small"
                  startIcon={<Search size={13} aria-hidden="true" />}
                  value={noteQuery}
                  onChange={(event) => setNoteQuery(event.currentTarget.value)}
                />
              </div>

              {attachedNote ? (
                <MenuItem
                  className="task-note-menu-detach"
                  role="button"
                  leading={<X size={14} aria-hidden="true" />}
                  onClick={() => handleAttachedNoteSelect(null)}
                >
                  {t("tasks.note.detach")}
                </MenuItem>
              ) : null}

              <div className="task-note-menu-list">
                {filteredNotes.length > 0 ? (
                  filteredNotes.map((note) => {
                    const isSelected = note.id === selectedNoteId;

                    return (
                      <MenuItem
                        aria-pressed={isSelected}
                        role="button"
                        key={note.id}
                        leading={<FileText size={14} aria-hidden="true" />}
                        selected={isSelected}
                        trailing={
                          isSelected ? (
                            <Check size={13} aria-hidden="true" />
                          ) : null
                        }
                        onClick={() => handleAttachedNoteSelect(note.id)}
                      >
                        {note.title}
                      </MenuItem>
                    );
                  })
                ) : (
                  <EmptyState
                    className="task-note-menu-empty"
                    description={t("tasks.note.empty")}
                    layout="inline"
                    size="compact"
                  />
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function filterNotesForMenu(
  notes: Note[],
  query: string,
  locale: string,
): Note[] {
  const needle = query.trim().toLocaleLowerCase(locale);

  if (!needle) return notes.slice(0, 12);

  return notes
    .filter((note) => note.title.toLocaleLowerCase(locale).includes(needle))
    .slice(0, 12);
}
