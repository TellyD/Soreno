import { Archive, FileText, Star } from "lucide-react";
import { useEffect, useState } from "react";
import type { LibraryView, ViewCounts } from "../domain/library";
import type { NoteType, NoteTypeId } from "../domain/noteTypes";
import { useI18n } from "../i18n";
import { NoteTypeSection } from "./note-types/NoteTypeSection";
import { NavItem } from "./SidebarNav";
import {
  normalizeSidebarSectionState,
  type SidebarSectionId,
  type SidebarSectionState,
} from "./sidebarSectionState";
import "./Sidebar.css";

const sidebarSectionsStorageKey = "soreno:sidebar-sections";

type SidebarProps = {
  activeView: LibraryView;
  counts: ViewCounts;
  noteTypes: NoteType[];
  onCreateNoteType: (
    name: string,
    icon: string,
    color: string,
  ) => Promise<NoteType>;
  onDeleteNoteType: (id: NoteTypeId) => Promise<void>;
  onDropNote: (noteId: string, kind: NoteTypeId) => void;
  onReorderNoteTypes: (ids: NoteTypeId[]) => Promise<void>;
  onSelectView: (view: LibraryView) => void;
  onUpdateNoteType: (
    id: NoteTypeId,
    name: string,
    icon: string,
    color: string,
  ) => Promise<NoteType>;
};

export function Sidebar({
  activeView,
  counts,
  noteTypes,
  onCreateNoteType,
  onDeleteNoteType,
  onDropNote,
  onReorderNoteTypes,
  onSelectView,
  onUpdateNoteType,
}: SidebarProps) {
  const { t } = useI18n();
  const [sectionState, setSectionState] = useState(
    readSavedSidebarSectionState,
  );

  useEffect(() => {
    saveSidebarSectionState(sectionState);
  }, [sectionState]);

  function updateSectionState(
    sectionId: SidebarSectionId,
    isExpanded: boolean,
  ) {
    setSectionState((currentState) => ({
      ...currentState,
      [sectionId]: isExpanded,
    }));
  }

  return (
    <aside className="vault-sidebar" aria-label={t("sidebar.navigationAria")}>
      <div className="nav-group primary-nav">
        <NavItem
          count={counts.all}
          icon={<FileText size={15} />}
          isSelected={activeView === "all"}
          label={t("views.all")}
          onSelect={() => onSelectView("all")}
        />
        <NavItem
          count={counts.archive}
          icon={<Archive size={15} />}
          isSelected={activeView === "archive"}
          label={t("views.archive")}
          onSelect={() => onSelectView("archive")}
        />
        <NavItem
          count={counts.favorites}
          icon={<Star size={15} />}
          isSelected={activeView === "favorites"}
          label={t("views.favorites")}
          onSelect={() => onSelectView("favorites")}
        />
      </div>

      <NoteTypeSection
        activeView={activeView}
        counts={counts}
        isExpanded={sectionState.types}
        noteTypes={noteTypes}
        onCreateNoteType={onCreateNoteType}
        onDeleteNoteType={onDeleteNoteType}
        onDropNote={onDropNote}
        onExpandedChange={(isExpanded) =>
          updateSectionState("types", isExpanded)
        }
        onReorderNoteTypes={onReorderNoteTypes}
        onSelectView={onSelectView}
        onUpdateNoteType={onUpdateNoteType}
      />
    </aside>
  );
}

function readSavedSidebarSectionState(): SidebarSectionState {
  if (typeof window === "undefined") {
    return normalizeSidebarSectionState(null);
  }

  try {
    const savedState = window.localStorage.getItem(sidebarSectionsStorageKey);

    return normalizeSidebarSectionState(
      savedState ? JSON.parse(savedState) : null,
    );
  } catch {
    return normalizeSidebarSectionState(null);
  }
}

function saveSidebarSectionState(sectionState: SidebarSectionState) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      sidebarSectionsStorageKey,
      JSON.stringify(sectionState),
    );
  } catch {
    // Sidebar persistence is a convenience; the app should still run without it.
  }
}
