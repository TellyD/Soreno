import { invoke } from "@tauri-apps/api/core";
import type { Vault, VaultState } from "../domain/vaults";

export async function listVaults(): Promise<Vault[]> {
  return invoke<Vault[]>("list_vaults");
}

export async function getActiveVault(): Promise<Vault> {
  return invoke<Vault>("get_active_vault");
}

export async function createVault(name: string): Promise<VaultState> {
  return invoke<VaultState>("create_vault", { name });
}

export async function renameVault(
  id: string,
  name: string,
): Promise<VaultState> {
  return invoke<VaultState>("rename_vault", { id, name });
}

export async function selectVault(id: string): Promise<VaultState> {
  return invoke<VaultState>("select_vault", { id });
}

export async function deleteVault(id: string): Promise<VaultState> {
  return invoke<VaultState>("delete_vault", { id });
}
