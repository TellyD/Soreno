import { useState } from "react";
import type { Note } from "../../domain/notes";
import type { NoteEncryption } from "../../hooks/useNoteEncryption";
import type { NoteType, NoteTypeId } from "../../domain/noteTypes";
import { useI18n } from "../../i18n";
import { EditorPane } from "../EditorPane";
import "./TaskLinkedNoteEditor.css";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";

type TaskLinkedNoteEditorProps = {
  content: string;
  encryption?: NoteEncryption;
  note: Note;
  noteTypes: NoteType[];
  onChangeNoteType: (kind: NoteTypeId) => void;
  onClose: () => void;
  onContentChange: (content: string) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  onToggleNoteArchived: (noteId: string, archived: boolean) => void;
  onToggleNotePinned: (noteId: string, pinned: boolean) => void;
  onToggleNoteFavorite: (noteId: string, favorite: boolean) => void;
};

export function TaskLinkedNoteEditor({
  content,
  encryption,
  note,
  noteTypes,
  onChangeNoteType,
  onClose,
  onContentChange,
  onCreateNote,
  onDeleteNote,
  onToggleNoteArchived,
  onToggleNotePinned,
  onToggleNoteFavorite,
}: TaskLinkedNoteEditorProps) {
  const { t } = useI18n();
  const [isClosing, setIsClosing] = useState(false);
  const requestClose = () => setIsClosing(true);
  const panelRef = useDismissibleLayer<HTMLDivElement>(
    !isClosing,
    requestClose,
  );

  return (
    <div
      className="task-linked-note-editor"
      data-closing={isClosing}
      inert={isClosing}
      ref={panelRef}
      onAnimationEnd={(event) => {
        if (
          isClosing &&
          event.target === event.currentTarget &&
          event.animationName === "task-linked-note-editor-slide-out"
        ) {
          onClose();
        }
      }}
    >
      <EditorPane
        backAction={{ label: t("editor.backToTasks"), onClick: requestClose }}
        content={content}
        encryption={encryption}
        noteTypes={noteTypes}
        onChangeNoteType={onChangeNoteType}
        onContentChange={onContentChange}
        onCreateNote={onCreateNote}
        onDeleteNote={onDeleteNote}
        onToggleNoteArchived={onToggleNoteArchived}
        onToggleNotePinned={onToggleNotePinned}
        onToggleNoteFavorite={onToggleNoteFavorite}
        selectedNote={note}
      />
    </div>
  );
}
