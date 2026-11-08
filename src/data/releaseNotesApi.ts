import { invoke } from "@tauri-apps/api/core";
import type { AppLanguage } from "../i18n/language";

// The release script commits these files before tagging, so each build
// carries the changelog of its own version and of every earlier one.
const changelogFiles = import.meta.glob<string>("../../docs/changelog/*.md", {
  import: "default",
  query: "?raw",
});

const changelogLoaders = new Map<
  string,
  Partial<Record<AppLanguage, () => Promise<string>>>
>();
for (const [path, load] of Object.entries(changelogFiles)) {
  const match = /\/([^/]+)\.(fr|en)\.md$/.exec(path);
  if (!match) continue;
  const [, version, language] = match;
  changelogLoaders.set(version, {
    ...changelogLoaders.get(version),
    [language]: load,
  });
}

export const changelogVersions = [...changelogLoaders.keys()];

export async function loadChangelog(
  version: string,
  language: AppLanguage,
): Promise<string> {
  const loaders = changelogLoaders.get(version);
  const load = loaders?.[language] ?? loaders?.fr ?? loaders?.en;
  if (!load) throw new Error(`No changelog for Soreno ${version}`);
  return load();
}

export async function getLastSeenVersion(): Promise<string | null> {
  return invoke<string | null>("last_seen_version");
}

export async function markVersionSeen(): Promise<void> {
  await invoke("mark_version_seen");
}
