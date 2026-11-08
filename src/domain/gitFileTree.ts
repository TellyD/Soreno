import type { GitChangeOrder } from "./projectGit";

export type GitFileTreeNode = {
  name: string;
  path: string;
  count: number;
  children: GitFileTreeNode[] | null;
};

type Directory = {
  name: string;
  path: string;
  count: number;
  children: Map<string, Directory | GitFileTreeNode>;
};

/**
 * Git paths use '/', independently of the project's host platform. Outside path
 * order, siblings keep the input order: a folder sits where its first file does.
 */
export function buildGitFileTree(
  paths: string[],
  order: GitChangeOrder = "path",
): GitFileTreeNode[] {
  const root: Directory = { name: "", path: "", count: 0, children: new Map() };
  for (const path of paths) {
    const parts = path.split("/");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index];
      const key = `directory:${name}`;
      let directory = parent.children.get(key) as Directory | undefined;
      if (!directory) {
        directory = {
          name,
          path: parts.slice(0, index + 1).join("/"),
          count: 0,
          children: new Map(),
        };
        parent.children.set(key, directory);
      }
      directory.count++;
      parent = directory;
    }
    parent.children.set(`file:${path}`, {
      name: parts[parts.length - 1],
      path,
      count: 1,
      children: null,
    });
  }
  function compact(
    entries: Map<string, Directory | GitFileTreeNode>,
  ): GitFileTreeNode[] {
    const nodes = [...entries.values()].map((entry): GitFileTreeNode => {
      if (!(entry.children instanceof Map)) return entry as GitFileTreeNode;
      const children = compact(entry.children);
      const only = children.length === 1 ? children[0] : null;
      return only?.children
        ? { ...only, name: `${entry.name}/${only.name}` }
        : {
            name: entry.name,
            path: entry.path,
            count: entry.count,
            children,
          };
    });
    return order === "path"
      ? nodes.sort(
          (a, b) =>
            Number(!!b.children) - Number(!!a.children) ||
            a.name.localeCompare(b.name),
        )
      : nodes;
  }
  return compact(root.children);
}
