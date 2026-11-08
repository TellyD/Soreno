import type { syntaxTree } from "@codemirror/language";

export type Node = ReturnType<typeof syntaxTree>["topNode"];

export function children(node: Node): Node[] {
  const result: Node[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    result.push(child);
  return result;
}
