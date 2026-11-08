import { expect, it } from "vitest";
import { buildGitFileTree, type GitFileTreeNode } from "./gitFileTree";

it("compacts folder chains, counts descendants and sorts folders before root files", () => {
  expect(
    buildGitFileTree([
      "README.md",
      "apps/mobile/src/ui/Z.tsx",
      "apps/mobile/src/ui/A.tsx",
      "apps/mobile/src/hooks/useApp.ts",
    ]),
  ).toEqual([
    {
      name: "apps/mobile/src",
      path: "apps/mobile/src",
      count: 3,
      children: [
        {
          name: "hooks",
          path: "apps/mobile/src/hooks",
          count: 1,
          children: [
            {
              name: "useApp.ts",
              path: "apps/mobile/src/hooks/useApp.ts",
              count: 1,
              children: null,
            },
          ],
        },
        {
          name: "ui",
          path: "apps/mobile/src/ui",
          count: 2,
          children: [
            {
              name: "A.tsx",
              path: "apps/mobile/src/ui/A.tsx",
              count: 1,
              children: null,
            },
            {
              name: "Z.tsx",
              path: "apps/mobile/src/ui/Z.tsx",
              count: 1,
              children: null,
            },
          ],
        },
      ],
    },
    { name: "README.md", path: "README.md", count: 1, children: null },
  ]);
});

it("keeps exact paths, including file/directory replacements and special names", () => {
  const tree = buildGitFileTree([
    "old",
    "old/new.ts",
    "__proto__/notes with spaces.md",
  ]);
  expect(tree).toHaveLength(3);
  expect(
    tree.find((node) => node.path === "old" && !node.children),
  ).toBeDefined();
  expect(
    tree.find((node) => node.path === "old" && node.children)?.children?.[0]
      .path,
  ).toBe("old/new.ts");
  expect(
    tree.find((node) => node.path === "__proto__")?.children?.[0].path,
  ).toBe("__proto__/notes with spaces.md");
  expect(buildGitFileTree([])).toEqual([]);
});

it("keeps the change order outside path order, placing folders at their first file", () => {
  const names = (nodes: GitFileTreeNode[]): unknown[] =>
    nodes.map(({ name, children }) =>
      children ? [name, names(children)] : name,
    );
  expect(
    names(
      buildGitFileTree(
        ["src/z.ts", "README.md", "src/a.ts", "docs/guide.md"],
        "mostChanged",
      ),
    ),
  ).toEqual([["src", ["z.ts", "a.ts"]], "README.md", ["docs", ["guide.md"]]]);
});
