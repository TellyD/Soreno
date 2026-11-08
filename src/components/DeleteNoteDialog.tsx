import { useI18n } from "../i18n";
import { ConfirmationDialog } from "./ui/ConfirmationDialog";

type DeleteNoteDialogProps = {
  noteTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteNoteDialog({
  noteTitle,
  onCancel,
  onConfirm,
}: DeleteNoteDialogProps) {
  const { t } = useI18n();

  return (
    <ConfirmationDialog
      cancelLabel={t("notes.deleteDialog.cancel")}
      closeLabel={t("confirmationDialog.close")}
      confirmLabel={t("notes.deleteDialog.confirm")}
      description={t("notes.deleteDialog.description", { title: noteTitle })}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t("notes.deleteDialog.title")}
    />
  );
}
