import type { AgentProject } from "../domain/agentSessions";
import type { GitFile, GitRepository, GitSide } from "../domain/projectGit";

const defaultMaxScopes = 4;
const defaultMaxEntries = 64;
const defaultMaxCharacters = 8 * 1024 * 1024;

const gitMutableReadTtl = 5_000;

const persistedRepositorySchema = 1;
const persistedRepositoryCharacters = 512 * 1024;
const persistedRepositoryMaxSnapshots = 8;
const persistedRepositoryPrefix = "soreno:git-repository:";
const persistedRepositoryKey = (projectId: string) =>
  `${persistedRepositoryPrefix}${encodeURIComponent(projectId)}`;
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const count = (value: unknown): value is number | null =>
  value === null || nonnegativeInteger(value);
const gitFile = (value: unknown): value is GitFile => {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<GitFile>;
  return (
    typeof file.path === "string" &&
    nullableString(file.oldPath) &&
    typeof file.indexStatus === "string" &&
    typeof file.worktreeStatus === "string" &&
    typeof file.conflict === "boolean" &&
    typeof file.submodule === "boolean" &&
    typeof file.actionable === "boolean" &&
    typeof file.mode === "string" &&
    count(file.added) &&
    count(file.deleted)
  );
};
const gitRepository = (value: unknown): value is GitRepository => {
  if (!value || typeof value !== "object") return false;
  const repository = value as Partial<GitRepository>;
  const identity = repository.identity;
  return (
    ["ready", "notRepository", "bare"].includes(
      repository.availability ?? "",
    ) &&
    (identity === null ||
      (!!identity &&
        typeof identity.root === "string" &&
        typeof identity.gitDir === "string" &&
        typeof identity.commonDir === "string")) &&
    typeof repository.version === "string" &&
    nullableString(repository.head) &&
    nullableString(repository.branch) &&
    nullableString(repository.upstream) &&
    nonnegativeInteger(repository.ahead) &&
    nonnegativeInteger(repository.behind) &&
    nullableString(repository.operation) &&
    nullableString(repository.mergeMessage) &&
    Array.isArray(repository.files) &&
    repository.files.length <= 1_000 &&
    repository.files.every(gitFile) &&
    typeof repository.limited === "boolean" &&
    typeof repository.truncated === "boolean"
  );
};

export function readPersistedGitRepository(
  projectId: string,
  scope: string,
): GitRepository | undefined {
  try {
    const serialized = localStorage.getItem(persistedRepositoryKey(projectId));
    if (!serialized || serialized.length > persistedRepositoryCharacters)
      return undefined;
    const stored = JSON.parse(serialized) as {
      repository?: unknown;
      savedAt?: unknown;
      schema?: unknown;
      scope?: unknown;
    };
    return stored.schema === persistedRepositorySchema &&
      stored.scope === scope &&
      gitRepository(stored.repository)
      ? stored.repository
      : undefined;
  } catch {
    return undefined;
  }
}

function persistedSnapshots(
  exclude?: string,
): { key: string; savedAt: number }[] {
  const snapshots: { key: string; savedAt: number }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(persistedRepositoryPrefix) || key === exclude)
      continue;
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "") as {
        savedAt?: unknown;
      };
      snapshots.push({
        key,
        savedAt: typeof stored.savedAt === "number" ? stored.savedAt : 0,
      });
    } catch {
      snapshots.push({ key, savedAt: 0 });
    }
  }
  return snapshots.sort((left, right) => left.savedAt - right.savedAt);
}

export function writePersistedGitRepository(
  projectId: string,
  scope: string,
  repository: GitRepository,
): void {
  const key = persistedRepositoryKey(projectId);
  const serialized = JSON.stringify({
    schema: persistedRepositorySchema,
    savedAt: Date.now(),
    scope,
    repository,
  });
  if (serialized.length > persistedRepositoryCharacters) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional persistence. */
    }
    return;
  }
  for (;;) {
    try {
      localStorage.setItem(key, serialized);
      break;
    } catch (reason) {
      if (
        !(reason instanceof DOMException) ||
        reason.name !== "QuotaExceededError"
      )
        return;
      const oldest = persistedSnapshots(key)[0];
      if (!oldest) return;
      try {
        localStorage.removeItem(oldest.key);
      } catch {
        return;
      }
    }
  }
  const snapshots = persistedSnapshots(key);
  for (const snapshot of snapshots.slice(
    0,
    Math.max(0, snapshots.length + 1 - persistedRepositoryMaxSnapshots),
  )) {
    try {
      localStorage.removeItem(snapshot.key);
    } catch {
      break;
    }
  }
}

export const gitReadScope = (project: AgentProject): string =>
  JSON.stringify([
    project.id,
    project.path,
    project.environment.kind,
    project.environment.distribution,
    project.environment.ssh
      ? [
          project.environment.ssh.host,
          project.environment.ssh.user,
          project.environment.ssh.port,
          project.environment.ssh.identityFile,
          project.environment.ssh.hostKey,
        ]
      : null,
  ]);

export const gitReadKeys = {
  repository: "mutable:repository",
  branches: "mutable:branches",
  worktrees: "mutable:worktrees",
  remotes: "mutable:remotes",
  history: (
    snapshot: string | string[] | null,
    offset: number,
    path: string | null = null,
  ) => `mutable:history:${JSON.stringify([snapshot, offset, path])}`,
  commitDetail: (oid: string) => `mutable:commit-detail:${oid}`,
  commitComparison: (oid: string, path: string) =>
    `mutable:commit-comparison:${JSON.stringify([oid, path])}`,
  comparisonPrefix: (path: string, side: GitSide) =>
    `mutable:comparison:${JSON.stringify([path, side])}:`,
  comparison: (path: string, side: GitSide, version: string | null) =>
    `${gitReadKeys.comparisonPrefix(path, side)}${JSON.stringify(version)}`,
};

type Entry = {
  characters: number;
  generation: number;
  promise?: Promise<unknown>;
  storedAt: number;
  value?: unknown;
};
type Scope = {
  characters: number;
  entries: Map<string, Entry>;
  generation: number;
};
type ReadOptions = { force?: boolean; ttl?: number };
type CacheOptions = {
  maxCharacters?: number;
  maxEntries?: number;
  maxScopes?: number;
  now?: () => number;
};

export type GitReadCache = ReturnType<typeof createGitReadCache>;

export function readMutableGit<T>(
  cache: GitReadCache | undefined,
  scope: string,
  key: string,
  load: () => Promise<T>,
  force: boolean,
): Promise<T> {
  return cache
    ? cache.read(scope, key, load, { force, ttl: gitMutableReadTtl })
    : load();
}

export function createGitReadCache(options: CacheOptions = {}) {
  const maxScopes = options.maxScopes ?? defaultMaxScopes;
  const maxEntries = options.maxEntries ?? defaultMaxEntries;
  const maxCharacters = options.maxCharacters ?? defaultMaxCharacters;
  const now = options.now ?? Date.now;
  const scopes = new Map<string, Scope>();

  function removeEntry(scope: Scope, key: string) {
    const entry = scope.entries.get(key);
    if (!entry) return;
    scope.entries.delete(key);
    scope.characters -= entry.characters;
    entry.generation++;
  }

  function touchScope(key: string, create = false): Scope | undefined {
    let scope = scopes.get(key);
    if (!scope && create) {
      scope = { characters: 0, entries: new Map(), generation: 0 };
      scopes.set(key, scope);
    } else if (scope) {
      scopes.delete(key);
      scopes.set(key, scope);
    }
    while (scopes.size > maxScopes) {
      const oldestKey = scopes.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = scopes.get(oldestKey)!;
      oldest.generation++;
      for (const entry of oldest.entries.values()) entry.generation++;
      scopes.delete(oldestKey);
    }
    return scope;
  }

  function trim(scope: Scope) {
    while (
      scope.entries.size > maxEntries ||
      scope.characters > maxCharacters
    ) {
      const oldest = scope.entries.keys().next().value;
      if (oldest === undefined) break;
      removeEntry(scope, oldest);
    }
  }

  function peek<T>(scopeKey: string, key: string): T | undefined {
    const scope = touchScope(scopeKey);
    const entry = scope?.entries.get(key);
    if (!entry || entry.value === undefined) return undefined;
    scope!.entries.delete(key);
    scope!.entries.set(key, entry);
    return entry.value as T;
  }

  function peekLatest<T>(scopeKey: string, prefix: string): T | undefined {
    const scope = touchScope(scopeKey);
    if (!scope) return undefined;
    for (const [key, entry] of [...scope.entries].reverse()) {
      if (key.startsWith(prefix) && entry.value !== undefined)
        return peek<T>(scopeKey, key);
    }
    return undefined;
  }

  function invalidatePending(scopeKey: string, key: string) {
    const scope = scopes.get(scopeKey);
    if (scope?.entries.get(key)?.promise) removeEntry(scope, key);
  }

  function invalidate(
    scopeKey: string,
    match?: string | ((key: string) => boolean),
  ) {
    const scope = scopes.get(scopeKey);
    if (!scope) return;
    if (match === undefined) {
      scope.generation++;
      for (const entry of scope.entries.values()) entry.generation++;
      scope.entries.clear();
      scope.characters = 0;
      return;
    }
    const matches =
      typeof match === "string" ? (key: string) => key === match : match;
    for (const key of [...scope.entries.keys()])
      if (matches(key)) removeEntry(scope, key);
  }

  function invalidateMutable(scopeKey: string) {
    invalidate(scopeKey, (key) => key.startsWith("mutable:"));
  }

  async function read<T>(
    scopeKey: string,
    key: string,
    load: () => Promise<T>,
    { force = false, ttl = Number.POSITIVE_INFINITY }: ReadOptions = {},
  ): Promise<T> {
    const scope = touchScope(scopeKey, true)!;
    const existing = scope.entries.get(key);
    if (force && existing) {
      existing.generation++;
      existing.promise = undefined;
    }
    if (!force && existing?.promise) return existing.promise as Promise<T>;
    if (
      !force &&
      existing?.value !== undefined &&
      now() - existing.storedAt < ttl
    )
      return existing.value as T;

    const entry = existing ?? { characters: 0, generation: 0, storedAt: 0 };
    if (!existing) scope.entries.set(key, entry);
    else {
      scope.entries.delete(key);
      scope.entries.set(key, entry);
    }
    const scopeGeneration = scope.generation;
    const entryGeneration = entry.generation;
    const promise = load().then(
      (value) => {
        if (
          scope.generation !== scopeGeneration ||
          entry.generation !== entryGeneration ||
          scope.entries.get(key) !== entry
        )
          return value;
        const characters = JSON.stringify(value).length;
        entry.promise = undefined;
        entry.storedAt = now();
        if (characters > maxCharacters) {
          removeEntry(scope, key);
        } else {
          scope.characters -= entry.characters;
          entry.value = value;
          entry.characters = characters;
          scope.characters += characters;
          trim(scope);
        }
        return value;
      },
      (reason) => {
        if (
          scope.generation === scopeGeneration &&
          entry.generation === entryGeneration &&
          scope.entries.get(key) === entry
        )
          removeEntry(scope, key);
        throw reason;
      },
    );
    entry.promise = promise;
    trim(scope);
    return promise;
  }

  return {
    invalidate,
    invalidateMutable,
    invalidatePending,
    peek,
    peekLatest,
    read,
  };
}
