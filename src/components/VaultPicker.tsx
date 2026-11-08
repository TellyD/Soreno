import { Check, ChevronDown, Folder, X } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import {
  MAX_VAULT_NAME_LENGTH,
  normalizeVaultName,
  validateVaultName,
  type Vault,
  type VaultNameValidationError,
} from "../domain/vaults";
import { useI18n, type TranslationKey } from "../i18n";
import { useNotification } from "../notifications";
import { Button } from "./ui/Button";
import { DeleteVaultDialog } from "./DeleteVaultDialog";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Input";
import { MenuItem, MenuSurface } from "./ui/Menu";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";
import "./VaultPicker.css";

type VaultFormMode = "create" | "rename";

type VaultPickerProps = {
  activeVault: Vault | null;
  isChangingVault: boolean;
  onCreateVault: (name: string) => Promise<void>;
  onDeleteVault: (id: string) => Promise<void>;
  onRenameVault: (id: string, name: string) => Promise<void>;
  onSelectVault: (id: string) => Promise<void>;
  vaults: Vault[];
};

const validationMessages: Record<VaultNameValidationError, TranslationKey> = {
  duplicate: "vaults.error.duplicate",
  empty: "vaults.error.emptyName",
  "too-long": "vaults.error.nameTooLong",
};

export function VaultPicker({
  activeVault,
  isChangingVault,
  onCreateVault,
  onDeleteVault,
  onRenameVault,
  onSelectVault,
  vaults,
}: VaultPickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [formMode, setFormMode] = useState<VaultFormMode | null>(null);
  const [draftName, setDraftName] = useState("");
  const [submittedValidationError, setSubmittedValidationError] =
    useState<VaultNameValidationError | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [vaultToDelete, setVaultToDelete] = useState<Vault | null>(null);
  const isDisabled = isSaving || isChangingVault;
  const closePicker = useCallback(() => {
    setIsOpen(false);
    setFormMode(null);
    setSubmittedValidationError(null);
  }, []);
  const pickerRef = useDismissibleLayer<HTMLDivElement>(isOpen, closePicker);
  const displayVaultName = (vault: Vault) =>
    vault.id === "local" && vault.name === "Coffre local"
      ? t("status.localVault")
      : vault.name;
  const activeVaultName = activeVault
    ? displayVaultName(activeVault)
    : t("status.localVault");
  const currentVaultId = formMode === "rename" ? activeVault?.id : undefined;
  const validationError = validateVaultName(
    draftName,
    vaults.map((vault) => ({ ...vault, name: displayVaultName(vault) })),
    currentVaultId,
  );
  const normalizedDraftName = normalizeVaultName(draftName);
  const hasFormChanges =
    formMode === "create" ||
    normalizedDraftName !== normalizeVaultName(activeVaultName);
  const canSubmitForm = Boolean(formMode) && !validationError && hasFormChanges;
  useNotification(
    formMode && submittedValidationError
      ? {
          key: "vault-form",
          message: t(validationMessages[submittedValidationError]),
        }
      : null,
  );

  function openForm(mode: VaultFormMode) {
    setSubmittedValidationError(null);
    setFormMode(mode);
    setDraftName(mode === "rename" ? activeVaultName : "");
  }

  async function handleSelectVault(vault: Vault) {
    if (vault.id === activeVault?.id) {
      setIsOpen(false);
      return;
    }

    try {
      setIsSaving(true);
      await onSelectVault(vault.id);
      setIsOpen(false);
    } catch {
      // The vault controller reports the failure.
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!formMode) {
      return;
    }

    if (validationError) {
      setSubmittedValidationError(validationError);
      return;
    }

    if (!hasFormChanges) {
      return;
    }

    try {
      setIsSaving(true);
      setSubmittedValidationError(null);

      if (formMode === "create") {
        await onCreateVault(normalizedDraftName);
      } else if (activeVault) {
        await onRenameVault(activeVault.id, normalizedDraftName);
      }

      setFormMode(null);
      setIsOpen(false);
    } catch {
      // The vault controller reports the failure.
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div className="status-segment vault-picker" ref={pickerRef}>
        <button
          type="button"
          className="status-vault-button"
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-label={t("vaults.selectAria")}
          disabled={isDisabled}
          title={activeVaultName}
          onClick={() => {
            setIsOpen((currentValue) => !currentValue);
            setFormMode(null);
            setSubmittedValidationError(null);
          }}
        >
          <Folder size={13} />
          <span>{activeVaultName}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>

        {isOpen ? (
          <MenuSurface className="vault-picker-menu">
            {formMode ? (
              <form className="vault-picker-form" onSubmit={handleSubmit}>
                <div className="vault-picker-form-header">
                  <span>
                    {formMode === "create"
                      ? t("vaults.createTitle")
                      : t("vaults.renameTitle")}
                  </span>
                  <IconButton
                    aria-label={t("vaults.cancel")}
                    disabled={isDisabled}
                    onClick={() => {
                      setFormMode(null);
                      setSubmittedValidationError(null);
                    }}
                    size="small"
                  >
                    <X />
                  </IconButton>
                </div>
                <Input
                  aria-label={t("vaults.namePlaceholder")}
                  autoFocus
                  disabled={isDisabled}
                  maxLength={MAX_VAULT_NAME_LENGTH + 1}
                  placeholder={t("vaults.namePlaceholder")}
                  size="small"
                  value={draftName}
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    setSubmittedValidationError(null);
                  }}
                />
                <div className="vault-picker-form-actions">
                  <Button
                    size="small"
                    disabled={isDisabled}
                    onClick={() => {
                      setFormMode(null);
                      setSubmittedValidationError(null);
                    }}
                  >
                    {t("vaults.cancel")}
                  </Button>
                  <Button
                    size="small"
                    type="submit"
                    disabled={isDisabled || !canSubmitForm}
                    variant="primary"
                  >
                    {formMode === "create"
                      ? t("vaults.create")
                      : t("vaults.save")}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="vault-picker-list">
                  {vaults.map((vault) => {
                    const isSelected = vault.id === activeVault?.id;

                    return (
                      <MenuItem
                        role="menuitemradio"
                        aria-checked={isSelected}
                        disabled={isDisabled}
                        key={vault.id}
                        leading={<Folder size={13} />}
                        selected={isSelected}
                        trailing={
                          isSelected ? (
                            <Check size={13} aria-hidden="true" />
                          ) : null
                        }
                        onClick={() => void handleSelectVault(vault)}
                      >
                        {displayVaultName(vault)}
                      </MenuItem>
                    );
                  })}
                </div>
                <div className="vault-picker-actions">
                  <MenuItem
                    role="menuitem"
                    disabled={isDisabled}
                    onClick={() => openForm("create")}
                  >
                    {t("vaults.new")}
                  </MenuItem>
                  <MenuItem
                    role="menuitem"
                    disabled={isDisabled || !activeVault}
                    onClick={() => openForm("rename")}
                  >
                    {t("vaults.rename")}
                  </MenuItem>
                  <MenuItem
                    role="menuitem"
                    danger
                    disabled={isDisabled || !activeVault || vaults.length <= 1}
                    onClick={() => {
                      if (!activeVault) {
                        return;
                      }

                      setIsOpen(false);
                      setVaultToDelete(activeVault);
                    }}
                  >
                    {t("vaults.delete")}
                  </MenuItem>
                </div>
              </>
            )}
          </MenuSurface>
        ) : null}
      </div>
      {vaultToDelete ? (
        <DeleteVaultDialog
          vault={vaultToDelete}
          onCancel={() => setVaultToDelete(null)}
          onConfirm={async () => {
            await onDeleteVault(vaultToDelete.id);
            setVaultToDelete(null);
          }}
        />
      ) : null}
    </>
  );
}
