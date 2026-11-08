import { describe, expect, it } from "vitest";
import {
  absoluteProjectFilePath,
  isMarkdownProjectFile,
  movedProjectFilePath,
  normalizeProjectFileInput,
  projectFileAncestors,
  projectFileGitStatus,
} from "./projectFiles";
import type { GitFile } from "./projectGit";

function gitFile(path: string, patch: Partial<GitFile> = {}): GitFile {
  return {
    path,
    oldPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    conflict: false,
    submodule: false,
    actionable: true,
    mode: "100644",
    added: 1,
    deleted: 0,
    ...patch,
  };
}

describe("normalizeProjectFileInput", () => {
  it("keeps typed paths relative to the project", () => {
    expect(normalizeProjectFileInput("  src//components\\App.tsx/ ")).toBe(
      "src/components/App.tsx",
    );
    for (const value of [
      "",
      "  ",
      "/etc/passwd",
      "C:/Users/file",
      "../outside",
      "src/./file",
      "src/.GIT/config",
    ])
      expect(normalizeProjectFileInput(value)).toBeNull();
  });
});

describe("movedProjectFilePath", () => {
  it("rewrites the moved path and its descendants only", () => {
    expect(movedProjectFilePath("src", "src", "lib")).toBe("lib");
    expect(movedProjectFilePath("src/a/b.ts", "src", "lib/src")).toBe(
      "lib/src/a/b.ts",
    );
    expect(movedProjectFilePath("srcs/b.ts", "src", "lib")).toBeNull();
  });
});

it("lists the directories to expand outermost first", () => {
  expect(projectFileAncestors("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(projectFileAncestors("c.ts")).toEqual([]);
});

it("detects Markdown extensions case-insensitively", () => {
  expect(isMarkdownProjectFile("docs/README.MD")).toBe(true);
  expect(isMarkdownProjectFile("guide.markdown")).toBe(true);
  expect(isMarkdownProjectFile("notes.md/index.ts")).toBe(false);
  expect(isMarkdownProjectFile("readme.mdx")).toBe(false);
});

it("joins absolute paths with the project's separator", () => {
  expect(absoluteProjectFilePath("/srv/app/", "src/App.tsx")).toBe(
    "/srv/app/src/App.tsx",
  );
  expect(absoluteProjectFilePath("C:\\work\\app", "src/App.tsx")).toBe(
    "C:\\work\\app\\src\\App.tsx",
  );
});

describe("projectFileGitStatus", () => {
  it("maps root-relative status below the project prefix", () => {
    const status = projectFileGitStatus(
      [
        gitFile("app/src/changed.ts"),
        gitFile("app/src/new.ts", { indexStatus: "A", worktreeStatus: "M" }),
        gitFile("app/untracked.md", { worktreeStatus: "?" }),
        gitFile("app/gone.ts", { indexStatus: "D", worktreeStatus: "." }),
        gitFile("app/moved.ts", { indexStatus: "R", worktreeStatus: "." }),
        gitFile("app/both.ts", {
          indexStatus: "U",
          worktreeStatus: "U",
          conflict: true,
        }),
        gitFile("other/outside.ts"),
      ],
      "app/",
    );
    expect(
      Object.fromEntries(
        [...status.files].map(([path, change]) => [path, change.badge]),
      ),
    ).toEqual({
      "src/changed.ts": "M",
      "src/new.ts": "A",
      "untracked.md": "?",
      "gone.ts": "D",
      "moved.ts": "R",
      "both.ts": "U",
    });
    expect([...status.directories]).toEqual(["src"]);
    expect(status.files.get("src/changed.ts")).toEqual({
      badge: "M",
      gitPath: "app/src/changed.ts",
      side: "unstaged",
    });
    expect(status.files.get("moved.ts")?.side).toBe("staged");
    expect(status.files.get("both.ts")?.side).toBe("unstaged");
  });

  it("ignores entries without a visible change", () => {
    const status = projectFileGitStatus(
      [gitFile("same.ts", { indexStatus: ".", worktreeStatus: "." })],
      "",
    );
    expect(status.files.size).toBe(0);
  });

  it("marks modified submodules as changed directory rows", () => {
    const status = projectFileGitStatus(
      [
        gitFile("app/lib", { submodule: true, mode: "160000" }),
        gitFile("app/vendor/dep", { mode: "160000" }),
      ],
      "app/",
    );
    expect([...status.files.keys()]).toEqual(["lib", "vendor/dep"]);
    expect([...status.directories].sort()).toEqual([
      "lib",
      "vendor",
      "vendor/dep",
    ]);
  });
});
