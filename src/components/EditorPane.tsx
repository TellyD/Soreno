import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Code2,
  FileText,
  Lock,
  LockOpen,
  PanelLeft,
  Pin,
  PinOff,
  Star,
  Trash2,
} from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { Note } from "../domain/notes";
import {
  findNoteType,
  getFallbackNoteType,
  type NoteType,
  type NoteTypeId,
} from "../domain/noteTypes";
import type { NoteEncryption } from "../hooks/useNoteEncryption";
import { useI18n } from "../i18n";
import { notifyError } from "../notifications";
import {
  uploadAttachmentImage,
  uploadEncryptedAttachmentImage,
} from "./markdown-editor/fileUpload";
import { MarkdownEditor } from "./markdown-editor/MarkdownEditor";
import { Button } from "./ui/Button";
import { ConfirmationDialog } from "./ui/ConfirmationDialog";
import { EmptyState } from "./ui/EmptyState";
import { DeleteNoteDialog } from "./DeleteNoteDialog";
import { IconButton } from "./ui/IconButton";
import { NotePassphraseDialog } from "./NotePassphraseDialog";
import { NoteTypePicker } from "./note-types/NoteTypePicker";
import {
  getNoteTypeAppearance,
  noteTypeStyleVars,
} from "./note-types/noteTypeMeta";
import "./EditorPane.css";

type EditorPaneProps = {
  backAction?: EditorPaneBackAction;
  content: string;
  encryption?: NoteEncryption;
  readOnly?: boolean;
  editorFocusRequest?: number;
  isCreateNoteDisabled?: boolean;
  isNoteBrowserVisible?: boolean;
  onToggleNoteBrowser?: () => void;
  noteTypes: NoteType[];
  onChangeNoteType: (kind: NoteTypeId) => void;
  onContentChange: (content: string) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  onEditorFocusRequestHandled?: (request: number) => void;
  onToggleNoteArchived: (noteId: string, archived: boolean) => void;
  onToggleNotePinned: (noteId: string, pinned: boolean) => void;
  onToggleNoteFavorite: (noteId: string, favorite: boolean) => void;
  selectedNote: Note | null;
};

type EditorPaneBackAction = {
  label: string;
  onClick: () => void;
};

export function EditorPane({
  backAction,
  content,
  encryption,
  readOnly = false,
  editorFocusRequest = 0,
  isCreateNoteDisabled = false,
  isNoteBrowserVisible = true,
  onToggleNoteBrowser,
  noteTypes,
  onChangeNoteType,
  onContentChange,
  onCreateNote,
  onDeleteNote,
  onEditorFocusRequestHandled,
  onToggleNoteArchived,
  onToggleNotePinned,
  onToggleNoteFavorite,
  selectedNote,
}: EditorPaneProps) {
  const { t } = useI18n();
  const browserToggleLabel = t(
    isNoteBrowserVisible ? "workspace.hideNotes" : "workspace.showNotes",
  );
  const [notePendingDeletionId, setNotePendingDeletionId] = useState<
    string | null
  >(null);
  // Resolved from the current note so an auto-lock never leaves the decrypted title displayed.
  const notePendingDeletion =
    selectedNote?.id === notePendingDeletionId ? selectedNote : null;
  if (notePendingDeletionId !== null && !notePendingDeletion) {
    setNotePendingDeletionId(null);
  }
  const selectedNoteType = selectedNote
    ? (findNoteType(noteTypes, selectedNote.kind) ??
      getFallbackNoteType(noteTypes))
    : null;
  const titleAppearance = getNoteTypeAppearance(selectedNoteType);
  const TitleIcon = selectedNoteType ? titleAppearance.icon : FileText;
  const archiveLabel = selectedNote?.archived
    ? t("editor.title.restore")
    : t("editor.title.archive");
  const archiveAriaLabel = selectedNote?.archived
    ? t("editor.title.restoreAria")
    : t("editor.title.archiveAria");
  const ArchiveIcon = selectedNote?.archived ? ArchiveRestore : Archive;
  const pinLabel = selectedNote?.pinned
    ? t("editor.title.unpin")
    : t("editor.title.pin");
  const pinAriaLabel = selectedNote?.pinned
    ? t("editor.title.unpinAria")
    : t("editor.title.pinAria");
  const PinIcon = selectedNote?.pinned ? PinOff : Pin;
  const favoriteLabel = selectedNote?.favorite
    ? t("editor.title.unfavorite")
    : t("editor.title.favorite");
  const [isRawMode, setIsRawMode] = useState(false);
  const rawModeLabel = isRawMode
    ? t("editor.title.rich")
    : t("editor.title.raw");
  const rawModeAriaLabel = isRawMode
    ? t("editor.title.richAria")
    : t("editor.title.rawAria");
  const [passphraseRequest, setPassphraseRequest] = useState<{
    mode: "create" | "unlock";
    encryptNoteId: string | null;
  } | null>(null);
  const [noteToDecryptId, setNoteToDecryptId] = useState<string | null>(null);
  // Only the note still open and unlocked: auto-lock may have replaced it meanwhile.
  const noteToDecrypt =
    selectedNote?.id === noteToDecryptId &&
    selectedNote.encryption === "unlocked"
      ? selectedNote
      : null;
  if (noteToDecryptId !== null && !noteToDecrypt) setNoteToDecryptId(null);
  // A clear image still uploading would escape the conversion.
  const [uploadCount, setUploadCount] = useState(0);
  const isLocked = selectedNote?.encryption === "locked";
  const isEncryptionBusy = Boolean(
    selectedNote && encryption?.busyNoteId === selectedNote.id,
  );
  const isEncryptionDisabled =
    !selectedNote ||
    readOnly ||
    uploadCount > 0 ||
    (encryption?.busyNoteId ?? null) !== null;

  function handleRequestDeleteNote() {
    if (!selectedNote) {
      return;
    }

    setNotePendingDeletionId(selectedNote.id);
  }

  function handleToggleArchivedNote() {
    if (!selectedNote) {
      return;
    }

    onToggleNoteArchived(selectedNote.id, !selectedNote.archived);
  }

  function handleTogglePinnedNote() {
    if (!selectedNote) {
      return;
    }

    onToggleNotePinned(selectedNote.id, !selectedNote.pinned);
  }

  function handleCancelDeleteNote() {
    setNotePendingDeletionId(null);
  }

  function handleConfirmDeleteNote() {
    const noteId = notePendingDeletion?.id;

    setNotePendingDeletionId(null);

    if (noteId) {
      onDeleteNote(noteId);
    }
  }

  async function handleEncryptNote() {
    if (!selectedNote || !encryption) return;
    const noteId = selectedNote.id;
    let status;
    try {
      status = await encryption.resolveKeyStatus();
    } catch {
      notifyError(t("errors.noteKey"));
      return;
    }
    if (status === "unlocked") {
      await encryption.encryptNote(noteId);
    } else {
      setPassphraseRequest({
        mode: status === "none" ? "create" : "unlock",
        encryptNoteId: noteId,
      });
    }
  }

  async function handleSubmitPassphrase(passphrase: string) {
    if (!encryption || !passphraseRequest) return;
    if (passphraseRequest.mode === "create") {
      await encryption.createPassphrase(passphrase);
    } else {
      await encryption.unlock(passphrase);
    }
    setPassphraseRequest(null);
    if (passphraseRequest.encryptNoteId) {
      await encryption.encryptNote(passphraseRequest.encryptNoteId);
    }
  }

  return (
    <section className="editor-pane" aria-label={t("editor.ariaLabel")}>
      <header className="editor-toolbar">
        {onToggleNoteBrowser ? (
          <IconButton
            aria-label={browserToggleLabel}
            title={browserToggleLabel}
            selected={isNoteBrowserVisible}
            aria-expanded={isNoteBrowserVisible}
            aria-controls="workspace-note-browser"
            onClick={onToggleNoteBrowser}
          >
            <PanelLeft aria-hidden="true" />
          </IconButton>
        ) : null}
        {backAction ? (
          <IconButton
            className="editor-back-button"
            aria-label={backAction.label}
            title={backAction.label}
            onClick={backAction.onClick}
          >
            <ArrowLeft />
          </IconButton>
        ) : null}
        <div
          className="editor-title"
          style={
            selectedNoteType
              ? (noteTypeStyleVars(selectedNoteType) as CSSProperties)
              : undefined
          }
        >
          <TitleIcon
            className="editor-title-kind-icon"
            size={15}
            aria-hidden="true"
          />
          <h2>{selectedNote?.title ?? t("editor.noSelection")}</h2>
          <IconButton
            onClick={() =>
              selectedNote &&
              onToggleNoteFavorite(selectedNote.id, !selectedNote.favorite)
            }
            disabled={!selectedNote}
            aria-label={favoriteLabel}
            aria-pressed={selectedNote?.favorite ?? false}
            selected={selectedNote?.favorite ?? false}
            title={favoriteLabel}
          >
            <Star fill={selectedNote?.favorite ? "currentColor" : "none"} />
          </IconButton>
        </div>
        <div className="toolbar-actions">
          <IconButton
            onClick={handleTogglePinnedNote}
            disabled={!selectedNote}
            aria-label={pinAriaLabel}
            aria-pressed={selectedNote?.pinned ?? false}
            selected={selectedNote?.pinned ?? false}
            title={pinLabel}
          >
            <PinIcon />
          </IconButton>
          <span className="toolbar-separator" aria-hidden="true" />
          <NoteTypePicker
            disabled={!selectedNote}
            kind={selectedNote?.kind ?? null}
            noteTypes={noteTypes}
            onChange={onChangeNoteType}
          />
          <span className="toolbar-separator" aria-hidden="true" />
          <IconButton
            onClick={() => setIsRawMode((currentValue) => !currentValue)}
            disabled={!selectedNote}
            aria-label={rawModeAriaLabel}
            aria-pressed={isRawMode}
            selected={isRawMode}
            title={rawModeLabel}
          >
            <Code2 />
          </IconButton>
          {encryption ? (
            <>
              <span className="toolbar-separator" aria-hidden="true" />
              {selectedNote?.encryption ? (
                <>
                  <IconButton
                    onClick={() => void encryption.lock()}
                    disabled={isEncryptionDisabled || isLocked}
                    aria-label={t("editor.title.lockAria")}
                    title={t("editor.title.lock")}
                  >
                    <Lock />
                  </IconButton>
                  <IconButton
                    onClick={() => setNoteToDecryptId(selectedNote.id)}
                    disabled={isEncryptionDisabled || isLocked}
                    aria-label={t("editor.title.decryptAria")}
                    title={t("editor.title.decrypt")}
                  >
                    <LockOpen />
                  </IconButton>
                </>
              ) : (
                <IconButton
                  onClick={() => void handleEncryptNote()}
                  disabled={isEncryptionDisabled}
                  aria-label={t("editor.title.encryptAria")}
                  title={t("editor.title.encrypt")}
                >
                  <Lock />
                </IconButton>
              )}
            </>
          ) : null}
          <span className="toolbar-separator" aria-hidden="true" />
          <IconButton
            onClick={handleToggleArchivedNote}
            disabled={!selectedNote}
            aria-label={archiveAriaLabel}
            title={archiveLabel}
          >
            <ArchiveIcon />
          </IconButton>
          <IconButton
            onClick={handleRequestDeleteNote}
            disabled={!selectedNote}
            aria-label={t("editor.title.deleteAria")}
            title={t("editor.title.delete")}
            tone="danger"
          >
            <Trash2 />
          </IconButton>
        </div>
      </header>

      {notePendingDeletion ? (
        <DeleteNoteDialog
          noteTitle={notePendingDeletion.title}
          onCancel={handleCancelDeleteNote}
          onConfirm={handleConfirmDeleteNote}
        />
      ) : null}

      {noteToDecrypt ? (
        <ConfirmationDialog
          cancelLabel={t("notes.decryptDialog.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmLabel={t("notes.decryptDialog.confirm")}
          description={t("notes.decryptDialog.description", {
            title: noteToDecrypt.title,
          })}
          onCancel={() => setNoteToDecryptId(null)}
          onConfirm={() => {
            setNoteToDecryptId(null);
            void encryption?.decryptNote(noteToDecrypt.id);
          }}
          title={t("notes.decryptDialog.title")}
        />
      ) : null}

      {passphraseRequest ? (
        <NotePassphraseDialog
          mode={passphraseRequest.mode}
          onCancel={() => setPassphraseRequest(null)}
          onSubmit={handleSubmitPassphrase}
        />
      ) : null}

      {selectedNote?.encryption === "locked" ? (
        <EmptyState
          actions={
            <Button
              disabled={!encryption}
              onClick={() =>
                setPassphraseRequest({ mode: "unlock", encryptNoteId: null })
              }
            >
              {t("notes.locked.unlock")}
            </Button>
          }
          description={t("notes.locked.description")}
          fill
          icon={<Lock />}
        />
      ) : selectedNote ? (
        <MarkdownEditor
          content={content}
          readOnly={readOnly || isEncryptionBusy}
          mode={isRawMode ? "source" : "preview"}
          focusRequest={editorFocusRequest}
          // A conversion starts a fresh history: undo must not bring back deleted image URLs.
          key={`${selectedNote.id}:${selectedNote.encryption ?? "clear"}`}
          documentId={selectedNote.id}
          resolveImageUrl={encryption?.resolveImageUrl}
          uploadImage={(file) => {
            const key = encryption?.getKey();
            const upload = !selectedNote.encryption
              ? uploadAttachmentImage(file, selectedNote.id)
              : key
                ? uploadEncryptedAttachmentImage(file, key)
                : Promise.reject(new Error("Encrypted notes are locked"));
            setUploadCount((count) => count + 1);
            return upload.finally(() => setUploadCount((count) => count - 1));
          }}
          onContentChange={onContentChange}
          onFocusRequestHandled={onEditorFocusRequestHandled}
        />
      ) : (
        <EmptyState
          actions={
            <Button disabled={isCreateNoteDisabled} onClick={onCreateNote}>
              {t("editor.empty.create")}
            </Button>
          }
          description={t("editor.empty.prompt")}
          fill
          icon={<FileText />}
        />
      )}
    </section>
  );
}
