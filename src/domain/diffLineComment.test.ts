import { describe, expect, it } from "vitest";
import {
  diffLineCommentRequest,
  diffLineRangeLabel,
  type DiffLineSelection,
} from "./diffLineComment";

const selection: DiffLineSelection = {
  path: "src/value.ts",
  side: "unstaged",
  version: "after",
  fromLine: 2,
  toLine: 3,
  text: "const average = total / xs.length;\nreturn average;",
};

describe("diffLineCommentRequest", () => {
  it("leads with the location and remark, then quotes the selected code", () => {
    const text = diffLineCommentRequest(
      selection,
      " Gère le cas vide.\nRetourne 0. ",
    );
    expect(text.split("\n")[0]).toBe(
      "Soreno comment on src/value.ts lines 2-3: Gère le cas vide.",
    );
    expect(text).toContain(
      "Gère le cas vide.\nRetourne 0.\n\nSelected code (current version, unstaged changes):\n```\nconst average = total / xs.length;\nreturn average;\n```",
    );
    expect(text).toContain("`git diff -- src/value.ts`");
  });

  it("describes a single previous-version line of a staged change", () => {
    const text = diffLineCommentRequest(
      { ...selection, side: "staged", version: "before", toLine: 2 },
      "Pourquoi supprimer ceci ?",
    );
    expect(text.split("\n")[0]).toBe(
      "Soreno comment on src/value.ts line 2: Pourquoi supprimer ceci ?",
    );
    expect(text).toContain("(previous version, staged changes)");
    expect(text).toContain("`git diff --staged -- src/value.ts`");
  });

  it("keeps the excerpt fenced when the code contains backticks", () => {
    const text = diffLineCommentRequest(
      { ...selection, text: "const doc = ```md```;" },
      "Échapper",
    );
    expect(text).toContain("````\nconst doc = ```md```;\n````");
  });

  it("truncates very long selections", () => {
    const lines = Array.from(
      { length: 205 },
      (_, index) => `line ${index + 1}`,
    );
    const text = diffLineCommentRequest(
      { ...selection, toLine: 206, text: lines.join("\n") },
      "Trop long",
    );
    expect(text).toContain("line 200\n… (5 more lines)\n```");
    expect(text).not.toContain("line 201");
  });

  it("names the repository and runs git from its root for group agents", () => {
    const text = diffLineCommentRequest(
      {
        ...selection,
        side: "staged",
        gitRoot: "/home/me/src/api",
        repository: { name: "api", path: "/home/me/src/api" },
      },
      "Garde la compatibilité.",
    );
    expect(text.split("\n")[0]).toBe(
      "Soreno comment on src/value.ts lines 2-3 in api: Garde la compatibilité.",
    );
    expect(text).toContain("Repository: api at /home/me/src/api\n");
    expect(text).toContain(
      "`git -C /home/me/src/api diff --staged -- src/value.ts`",
    );
  });

  it("quotes paths the shell would split or expand", () => {
    const text = diffLineCommentRequest(
      {
        ...selection,
        path: "src/it's $HOME.ts",
        gitRoot: "/home/me/my repo",
      },
      "Renommer",
    );
    expect(text).toContain(
      "`git -C '/home/me/my repo' diff -- 'src/it'\\''s $HOME.ts'`",
    );
  });

  it("asks to read untracked files instead of diffing them", () => {
    const text = diffLineCommentRequest(
      { ...selection, untracked: true, gitRoot: "/home/me/api" },
      "Ajoute un test.",
    );
    expect(text).toContain("(current version, untracked file)");
    expect(text).toContain(
      "new and untracked, so `git diff` shows nothing: read src/value.ts (relative to /home/me/api) directly.",
    );
    expect(text).not.toContain("git -C");
  });
});

describe("diffLineRangeLabel", () => {
  it("shows one line or an inclusive range", () => {
    expect(diffLineRangeLabel({ ...selection, toLine: 2 })).toBe("L2");
    expect(diffLineRangeLabel(selection)).toBe("L2–3");
  });
});
