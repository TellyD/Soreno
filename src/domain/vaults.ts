export const MAX_VAULT_NAME_LENGTH = 60;

export type Vault = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type VaultState = {
  activeVaultId: string;
  vaults: Vault[];
};

export type VaultNameValidationError = "duplicate" | "empty" | "too-long";

export function normalizeVaultName(name: string): string {
  return name.trim();
}

export function validateVaultName(
  name: string,
  vaults: readonly Vault[],
  currentVaultId?: string,
): VaultNameValidationError | null {
  const normalizedName = normalizeVaultName(name);

  if (!normalizedName) {
    return "empty";
  }

  if ([...normalizedName].length > MAX_VAULT_NAME_LENGTH) {
    return "too-long";
  }

  const hasDuplicate = vaults.some((vault) => {
    return vault.id !== currentVaultId && vault.name === normalizedName;
  });

  return hasDuplicate ? "duplicate" : null;
}
