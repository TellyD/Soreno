import type { Vault } from "../domain/vaults";
import { useI18n } from "../i18n";
import { ConfirmationDialog } from "./ui/ConfirmationDialog";

type DeleteVaultDialogProps = {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  vault: Vault;
};

export function DeleteVaultDialog({
  onCancel,
  onConfirm,
  vault,
}: DeleteVaultDialogProps) {
  const { t } = useI18n();

  async function handleConfirm() {
    onCancel();

    try {
      await onConfirm();
    } catch {
      // The vault controller reports the failure.
    }
  }

  return (
    <ConfirmationDialog
      cancelLabel={t("vaults.cancel")}
      closeLabel={t("confirmationDialog.close")}
      confirmLabel={t("vaults.delete")}
      description={t("vaults.deleteDescription", { name: vault.name })}
      onCancel={onCancel}
      onConfirm={() => void handleConfirm()}
      title={t("vaults.deleteTitle")}
    />
  );
}
