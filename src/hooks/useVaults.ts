import { useMemo, useRef, useState } from "react";
import {
  createVault,
  deleteVault,
  getActiveVault,
  listVaults,
  renameVault,
  selectVault,
} from "../data/vaultsApi";
import type { Vault, VaultState } from "../domain/vaults";
import { notifyError } from "../notifications";

type VaultErrorMessages = {
  create: string;
  delete: string;
  rename: string;
  select: string;
};

type UseVaultsOptions = {
  messages: VaultErrorMessages;
  onBeforeVaultChange: () => Promise<void>;
  onVaultChanged: (options: { resetView?: boolean }) => Promise<void>;
};

export function useVaults({
  messages,
  onBeforeVaultChange,
  onVaultChanged,
}: UseVaultsOptions) {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [isChangingVault, setIsChangingVault] = useState(false);
  const isVaultMutationLocked = useRef(false);

  const activeVault = useMemo(() => {
    return vaults.find((vault) => vault.id === activeVaultId) ?? null;
  }, [activeVaultId, vaults]);

  function setVaultState(nextVaultState: VaultState) {
    setVaults(nextVaultState.vaults);
    setActiveVaultId(nextVaultState.activeVaultId);
  }

  async function loadVaultState() {
    const [loadedVaults, loadedActiveVault] = await Promise.all([
      listVaults(),
      getActiveVault(),
    ]);

    setVaultState({
      activeVaultId: loadedActiveVault.id,
      vaults: loadedVaults,
    });
  }

  async function runVaultMutation(
    fallbackMessage: string,
    mutation: () => Promise<void>,
    changesActiveVault = true,
  ) {
    if (isVaultMutationLocked.current) {
      return;
    }

    isVaultMutationLocked.current = true;

    if (changesActiveVault) {
      setIsChangingVault(true);
    }

    try {
      await mutation();
    } catch (error) {
      notifyError(fallbackMessage);
      throw error;
    } finally {
      isVaultMutationLocked.current = false;

      if (changesActiveVault) {
        setIsChangingVault(false);
      }
    }
  }

  async function handleCreateVault(name: string) {
    await runVaultMutation(messages.create, async () => {
      await onBeforeVaultChange();
      setVaultState(await createVault(name));
      await onVaultChanged({ resetView: true });
    });
  }

  async function handleRenameVault(id: string, name: string) {
    await runVaultMutation(
      messages.rename,
      async () => setVaultState(await renameVault(id, name)),
      false,
    );
  }

  async function handleSelectVault(id: string) {
    if (id === activeVaultId) {
      return;
    }

    await runVaultMutation(messages.select, async () => {
      await onBeforeVaultChange();
      setVaultState(await selectVault(id));
      await onVaultChanged({ resetView: true });
    });
  }

  async function handleDeleteVault(id: string) {
    const wasActiveVault = id === activeVaultId;

    await runVaultMutation(
      messages.delete,
      async () => {
        if (wasActiveVault) await onBeforeVaultChange();
        setVaultState(await deleteVault(id));
        if (wasActiveVault) await onVaultChanged({ resetView: true });
      },
      wasActiveVault,
    );
  }

  return {
    activeVault,
    handleCreateVault,
    handleDeleteVault,
    handleRenameVault,
    handleSelectVault,
    isChangingVault,
    loadVaultState,
    vaults,
  };
}
