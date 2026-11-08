// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { GitRepository } from "../domain/projectGit";
import {
  createGitReadCache,
  gitReadKeys,
  gitReadScope,
  readPersistedGitRepository,
  writePersistedGitRepository,
} from "./gitReadCache";

const repository = (version: string): GitRepository => ({
  availability: "ready",
  identity: { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" },
  version,
  head: "abc",
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  mergeMessage: null,
  limited: false,
  truncated: false,
  files: [
    {
      path: "file.txt",
      oldPath: null,
      indexStatus: ".",
      worktreeStatus: "M",
      conflict: false,
      submodule: false,
      actionable: true,
      mode: "100644",
      added: 1,
      deleted: 0,
    },
  ],
});

beforeEach(() => localStorage.clear());

it("deduplicates identical reads and expires mutable values", async () => {
  let now = 0;
  const cache = createGitReadCache({ now: () => now });
  let resolve!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const first = cache.read("scope", "mutable:value", load, { ttl: 5_000 });
  const second = cache.read("scope", "mutable:value", load, { ttl: 5_000 });
  expect(load).toHaveBeenCalledTimes(1);
  resolve("known");
  await expect(Promise.all([first, second])).resolves.toEqual([
    "known",
    "known",
  ]);
  expect(cache.peek("scope", "mutable:value")).toBe("known");
  await cache.read("scope", "mutable:value", load, { ttl: 5_000 });
  expect(load).toHaveBeenCalledTimes(1);
  now = 5_000;
  await cache.read("scope", "mutable:value", async () => "fresh", {
    ttl: 5_000,
  });
  expect(cache.peek("scope", "mutable:value")).toBe("fresh");
});

it("fences invalidated and forced in-flight responses without caching errors", async () => {
  const cache = createGitReadCache();
  let resolveOld!: (value: string) => void;
  const old = cache.read(
    "scope",
    "mutable:path",
    () =>
      new Promise<string>((done) => {
        resolveOld = done;
      }),
  );
  const fresh = cache.read("scope", "mutable:path", async () => "fresh", {
    force: true,
  });
  await expect(fresh).resolves.toBe("fresh");
  resolveOld("old");
  await expect(old).resolves.toBe("old");
  expect(cache.peek("scope", "mutable:path")).toBe("fresh");

  await cache.read("scope", "mutable:missing", async () => "old");
  await expect(
    cache.read(
      "scope",
      "mutable:missing",
      async () => {
        throw new Error("gone");
      },
      { force: true },
    ),
  ).rejects.toThrow("gone");
  expect(cache.peek("scope", "mutable:missing")).toBeUndefined();
  cache.invalidateMutable("scope");
  expect(cache.peek("scope", "mutable:path")).toBeUndefined();
});

it("bounds entries, JSON characters and retained scopes", async () => {
  const cache = createGitReadCache({
    maxCharacters: 12,
    maxEntries: 2,
    maxScopes: 2,
  });
  await cache.read("a", "one", async () => "1");
  await cache.read("a", "two", async () => "2");
  await cache.read("a", "three", async () => "3");
  expect(cache.peek("a", "one")).toBeUndefined();
  await cache.read("a", "three", async () => "12345678", { force: true });
  await cache.read("a", "three", async () => "x".repeat(20), { force: true });
  expect(cache.peek("a", "three")).toBeUndefined();
  await cache.read("a", "four", async () => "12345678");
  await cache.read("a", "five", async () => "12345678");
  expect(cache.peek("a", "four")).toBeUndefined();
  expect(cache.peek("a", "five")).toBe("12345678");

  await cache.read("b", "one", async () => 1);
  await cache.read("c", "one", async () => 1);
  expect(cache.peek("a", "three")).toBeUndefined();
  expect(cache.peek("b", "one")).toBe(1);
  expect(cache.peek("c", "one")).toBe(1);
});

it("evicts by total serialized size and never retains oversized comparisons", async () => {
  const cache = createGitReadCache({ maxCharacters: 100 });
  const large = { before: "x".repeat(50), after: "" };
  await cache.read("a", "large-a", async () => large);
  await cache.read("a", "large-b", async () => large);
  expect(cache.peek("a", "large-a")).toBeUndefined();
  expect(cache.peek("a", "large-b")).toEqual(large);

  const conflict = "y".repeat(30);
  await cache.read("a", "oversized", async () => ({
    before: conflict,
    after: conflict,
    conflictStages: [{ stage: 1, content: conflict }],
  }));
  expect(cache.peek("a", "oversized")).toBeUndefined();
  expect(cache.peek("a", "large-b")).toEqual(large);
});

it("separates comparison reads by scope, side and repository version", async () => {
  const cache = createGitReadCache();
  const unstagedV1 = gitReadKeys.comparison("same.ts", "unstaged", "v1");
  const stagedV1 = gitReadKeys.comparison("same.ts", "staged", "v1");
  const unstagedV2 = gitReadKeys.comparison("same.ts", "unstaged", "v2");

  expect(new Set([unstagedV1, stagedV1, unstagedV2]).size).toBe(3);
  await cache.read("scope-a", unstagedV1, async () => "a");
  await cache.read("scope-b", unstagedV1, async () => "b");
  expect(cache.peek("scope-a", unstagedV1)).toBe("a");
  expect(cache.peek("scope-b", unstagedV1)).toBe("b");
});

it("restores only a valid repository from the exact SSH scope", () => {
  writePersistedGitRepository("project", "scope", repository("v1"));
  expect(readPersistedGitRepository("project", "scope")).toEqual(
    repository("v1"),
  );
  expect(readPersistedGitRepository("project", "other")).toBeUndefined();

  const key = localStorage.key(0)!;
  const stored = JSON.parse(localStorage.getItem(key)!);
  delete stored.savedAt;
  localStorage.setItem(key, JSON.stringify(stored));
  expect(readPersistedGitRepository("project", "scope")).toEqual(
    repository("v1"),
  );
  localStorage.setItem(
    key,
    JSON.stringify({
      ...stored,
      repository: { ...stored.repository, files: [{ path: 42 }] },
    }),
  );
  expect(readPersistedGitRepository("project", "scope")).toBeUndefined();
});

it("bounds persisted repository snapshots globally by saved time", () => {
  const now = vi.spyOn(Date, "now");
  let savedAt = 0;
  now.mockImplementation(() => ++savedAt);
  for (let index = 0; index < 9; index++)
    writePersistedGitRepository(
      `project-${index}`,
      `scope-${index}`,
      repository(`v${index}`),
    );
  expect(readPersistedGitRepository("project-0", "scope-0")).toBeUndefined();
  for (let index = 1; index < 9; index++)
    expect(
      readPersistedGitRepository(`project-${index}`, `scope-${index}`)?.version,
    ).toBe(`v${index}`);
  expect(localStorage.length).toBe(8);
  now.mockRestore();
});

it("evicts an older snapshot on quota and preserves the current snapshot if retry is impossible", () => {
  writePersistedGitRepository("old", "old-scope", repository("old"));
  writePersistedGitRepository("current", "scope", repository("current-v1"));
  const original = Storage.prototype.setItem;
  let failures = 1;
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (failures-- > 0) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    });
  writePersistedGitRepository("new", "new-scope", repository("new"));
  expect(readPersistedGitRepository("old", "old-scope")).toBeUndefined();
  expect(readPersistedGitRepository("new", "new-scope")).toEqual(
    repository("new"),
  );

  setItem.mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  writePersistedGitRepository("current", "scope", repository("current-v2"));
  expect(readPersistedGitRepository("current", "scope")).toEqual(
    repository("current-v1"),
  );
  setItem.mockRestore();
});

it("includes project path and complete environment in the explicit scope", () => {
  const base = {
    id: "p1",
    name: "Repo",
    path: "/repo",
    environment: { kind: "local" as const, distribution: null },
  };
  expect(gitReadScope(base)).not.toBe(
    gitReadScope({ ...base, path: "/other" }),
  );
  expect(gitReadScope(base)).not.toBe(
    gitReadScope({
      ...base,
      environment: { kind: "wsl", distribution: "Ubuntu" },
    }),
  );
  const ssh = {
    host: "one.example",
    user: "git",
    port: 22,
    identityFile: null,
    hostKey: null,
  };
  expect(
    gitReadScope({
      ...base,
      environment: { kind: "ssh", distribution: null, ssh },
    }),
  ).not.toBe(
    gitReadScope({
      ...base,
      environment: {
        kind: "ssh",
        distribution: null,
        ssh: { ...ssh, host: "two.example" },
      },
    }),
  );
});
