import { LayoutList, LoaderCircle, Pin, Plus, Search } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { formatCompactDate, formatShortDateTime } from "../domain/dateTime";
import {
  isNoteLibraryView,
  noteLibraryViews,
  noteTypeIdForView,
  type NoteCollectionView,
  type NoteLibraryView,
} from "../domain/library";
import { findNoteType, type NoteType } from "../domain/noteTypes";
import type { Note, NoteSortOrder } from "../domain/notes";
import { useI18n, type TranslationKey } from "../i18n";
import { EmptyState } from "./ui/EmptyState";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Input";
import { NoteSortPicker } from "./NoteSortPicker";
import {
  getNoteTypeAppearance,
  noteTypeStyleVars,
} from "./note-types/noteTypeMeta";
import { noteDragMimeType } from "./noteDrag";
import "./NoteBrowser.css";

type NoteBrowserProps = {
  activeView: NoteCollectionView;
  isCreateNoteDisabled: boolean;
  isLoading: boolean;
  noteTypes: NoteType[];
  notes: Note[];
  onChangeSortOrder: (sortOrder: NoteSortOrder) => void;
  onCreateNote: () => void;
  onSearchChange: (query: string) => void;
  onSelectNote: (note: Note) => void;
  searchQuery: string;
  selectedNoteId: string | null;
  sortOrder: NoteSortOrder;
};

const viewLabelKeys: Record<NoteLibraryView, TranslationKey> =
  Object.fromEntries(
    noteLibraryViews.map((view) => [view, `views.${view}`]),
  ) as Record<NoteLibraryView, TranslationKey>;

export function NoteBrowser({
  activeView,
  isCreateNoteDisabled,
  isLoading,
  noteTypes,
  notes,
  onChangeSortOrder,
  onCreateNote,
  onSearchChange,
  onSelectNote,
  searchQuery,
  selectedNoteId,
  sortOrder,
}: NoteBrowserProps) {
  const { t } = useI18n();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const title = getViewTitle(activeView, noteTypes, t);
  const onSelectNoteRef = useRef(onSelectNote);
  useLayoutEffect(() => {
    onSelectNoteRef.current = onSelectNote;
  }, [onSelectNote]);
  const selectNote = useCallback(
    (note: Note) => onSelectNoteRef.current(note),
    [],
  );

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isSearchOpen]);

  function closeSearch() {
    onSearchChange("");
    setIsSearchOpen(false);
  }

  function handleToggleSearch() {
    if (isSearchOpen) {
      closeSearch();
      return;
    }

    setIsSearchOpen(true);
  }

  return (
    <section className="note-browser" aria-label={t("notes.listAria")}>
      <header className="browser-toolbar">
        <div className="browser-toolbar-main">
          <div className="browser-title">
            <h1>{title}</h1>
          </div>
          <div className="browser-actions">
            <NoteSortPicker order={sortOrder} onChange={onChangeSortOrder} />
            <IconButton
              aria-label={
                isSearchOpen ? t("notes.searchHide") : t("notes.search")
              }
              aria-pressed={isSearchOpen}
              className="note-search-control"
              selected={isSearchOpen}
              title={isSearchOpen ? t("notes.searchHide") : t("notes.search")}
              onClick={handleToggleSearch}
            >
              <Search />
            </IconButton>
            <IconButton
              aria-label={t("notes.new")}
              disabled={isCreateNoteDisabled}
              onClick={onCreateNote}
            >
              <Plus />
            </IconButton>
          </div>
        </div>
        {isSearchOpen ? (
          <Input
            aria-label={t("notes.search")}
            className="search-field"
            ref={searchInputRef}
            size="medium"
            startIcon={<Search size={15} aria-hidden="true" />}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeSearch();
              }
            }}
            placeholder={t("notes.searchPlaceholder")}
          />
        ) : null}
      </header>

      <div className="note-list">
        {isLoading ? (
          <p className="empty-state">
            <LoaderCircle size={16} /> {t("notes.loading")}
          </p>
        ) : notes.length > 0 ? (
          notes.map((note) => (
            <NoteListItem
              isSelected={note.id === selectedNoteId}
              key={note.id}
              note={note}
              noteTypes={noteTypes}
              onSelect={selectNote}
            />
          ))
        ) : (
          <EmptyList searching={searchQuery.trim() !== ""} />
        )}
      </div>
    </section>
  );
}

const NoteListItem = memo(function NoteListItem({
  isSelected,
  note,
  noteTypes,
  onSelect,
}: {
  isSelected: boolean;
  note: Note;
  noteTypes: NoteType[];
  onSelect: (note: Note) => void;
}) {
  const { locale, t } = useI18n();
  const typeDecoration = getNoteTypeAppearance(
    findNoteType(noteTypes, note.kind),
  );
  const TypeIcon = typeDecoration.icon;
  const modified = formatCompactDate(note.updatedAt, locale);

  return (
    <button
      className={`note-list-item ${isSelected ? "selected" : ""}`}
      style={
        noteTypeStyleVars(findNoteType(noteTypes, note.kind)) as CSSProperties
      }
      type="button"
      title={[
        t("notes.modifiedOn", {
          date: formatShortDateTime(note.updatedAt, locale),
        }),
        t("notes.createdOn", {
          date: formatShortDateTime(note.createdAt, locale),
        }),
      ].join("\n")}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(noteDragMimeType, note.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onSelect(note)}
    >
      <span className="note-item-heading">
        <span className="note-item-title">
          {note.pinned ? (
            <span
              className="note-item-pin"
              aria-label={t("notes.pinned")}
              role="img"
              title={t("notes.pinned")}
            >
              <Pin size={13} aria-hidden="true" />
            </span>
          ) : null}
          <span className="note-item-name">{note.title}</span>
        </span>
        <span className="note-item-icons">
          <TypeIcon
            className="note-item-kind-icon"
            size={14}
            aria-hidden="true"
          />
        </span>
      </span>
      <span className="note-item-meta">
        {modified ? (
          <time dateTime={note.updatedAt}>
            {t(
              modified.kind === "time"
                ? "notes.modifiedAt"
                : modified.kind === "relative"
                  ? "notes.modifiedRelative"
                  : "notes.modifiedOn",
              { date: modified.value },
            )}
          </time>
        ) : null}
      </span>
    </button>
  );
});

function getViewTitle(
  view: NoteCollectionView,
  noteTypes: NoteType[],
  t: (key: TranslationKey) => string,
): string {
  const typeId = noteTypeIdForView(view);

  if (typeId) {
    return findNoteType(noteTypes, typeId)?.name ?? t("views.all");
  }

  return isNoteLibraryView(view) ? t(viewLabelKeys[view]) : t("views.all");
}

function EmptyList({ searching }: { searching: boolean }) {
  const { t } = useI18n();

  return (
    <EmptyState
      className="note-list-empty"
      description={t(searching ? "notes.empty.search" : "notes.empty.view")}
      icon={<LayoutList />}
      size="compact"
    />
  );
}
