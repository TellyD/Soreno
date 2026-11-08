const legacyKeyPattern = /^telaoi(?=[.:])/u;

// Moves interface state saved before the Telaoi → Soreno rename; an existing Soreno value wins.
export function migrateLegacyStorageKeys(): void {
  try {
    const storage = window.localStorage;
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && legacyKeyPattern.test(key)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const value = storage.getItem(key);
      const renamed = key.replace(legacyKeyPattern, "soreno");
      if (value === null || storage.getItem(renamed) !== null) {
        storage.removeItem(key);
        continue;
      }
      // Both keys have the same length, so freeing the old one first keeps the swap within quota.
      storage.removeItem(key);
      try {
        storage.setItem(renamed, value);
      } catch {
        try {
          storage.setItem(key, value);
        } catch {
          // Restoring failed too: the value is lost and the interface uses its default.
        }
      }
    }
  } catch {
    // Storage denied: the interface falls back to its defaults.
  }
}
