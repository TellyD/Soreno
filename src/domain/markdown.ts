import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Nodes } from "mdast";
import { imageWidthPrefixes, parseImageWidth } from "./imageSize";

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const internalMarker =
  /^[ \t]*<!--[ \t]*telaoi:(blank-line|empty-check-list-item|checked-empty-check-list-item)[ \t]*-->[ \t]*$/u;

// Compatibility only: replace the old comment, never reinterpret surrounding whitespace.
export function normalizeLegacyMarkdown(markdown: string): string {
  if (!markdown.includes("telaoi:")) return markdown;
  const chunks: string[] = [];
  let cursor = 0;
  for (const node of markdownParser.parse(markdown).children) {
    if (node.type !== "html") continue;
    const start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    const raw = markdown.slice(start, end);
    const marker = raw.match(internalMarker)?.[1];
    if (!marker) continue;
    const replacement =
      marker === "blank-line"
        ? ""
        : marker === "empty-check-list-item"
          ? "- [ ] "
          : "- [x] ";
    chunks.push(
      markdown.slice(cursor, start + raw.indexOf("<!--")),
      replacement,
    );
    cursor = start + raw.indexOf("-->") + 3;
  }
  if (!chunks.length) return markdown;
  chunks.push(markdown.slice(cursor));
  return chunks.join("");
}

// Includes opening/closing lines; a shorter fence or another character is code.
function createFencedCodeTracker(): (line: string) => boolean {
  let fence: string | undefined;
  return (line) => {
    const match = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        !match[2].trim()
      )
        fence = undefined;
      return true;
    }
    if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = match[1];
      return true;
    }
    return false;
  };
}

export function stripInternalBlockMarkers(markdown: string): string {
  const isCodeLine = createFencedCodeTracker();
  const text = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => isCodeLine(line) || !internalMarker.test(line))
    .join("\n");
  if (!imageWidthPrefixes.some((prefix) => text.includes(prefix))) return text;
  const chunks: string[] = [];
  let cursor = 0;
  function visit(node: Nodes) {
    if (node.type === "html" && parseImageWidth(node.value) !== undefined) {
      const from = node.position!.start.offset!,
        to = node.position!.end.offset!;
      chunks.push(text.slice(cursor, from));
      cursor = to;
    } else if ("children" in node) node.children.forEach(visit);
  }
  visit(markdownParser.parse(text));
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

function markdownImageLabel(alt: string): string {
  return alt.replace(/[\r\n]/gu, " ").replace(/[\\[\]]/gu, "\\$&");
}

function markdownImageTarget(url: string): string {
  return url.replace(/[<>\s]/gu, (character) => encodeURIComponent(character));
}

export function markdownImage(alt: string, url: string): string {
  return `![${markdownImageLabel(alt)}](<${markdownImageTarget(url)}>)`;
}
