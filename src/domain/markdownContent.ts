export type MarkdownContentInline =
  | {
      text: string;
      type: "code" | "text";
    }
  | {
      children: MarkdownContentInline[];
      type: "emphasis" | "strong";
    }
  | {
      href: string;
      text: string;
      type: "link";
    };

export type MarkdownContentListItem = {
  content: MarkdownContentInline[];
  /** Lists nested under this item. */
  children?: MarkdownContentBlock[];
};

export type MarkdownContentBlock =
  | {
      lines: MarkdownContentInline[][];
      type: "paragraph";
    }
  | {
      content: MarkdownContentInline[];
      level: 1 | 2 | 3;
      type: "heading";
    }
  | {
      items: MarkdownContentListItem[];
      type: "unorderedList";
    }
  | {
      items: MarkdownContentListItem[];
      start: number;
      type: "orderedList";
    }
  | {
      lines: MarkdownContentInline[][];
      type: "blockquote";
    }
  | {
      type: "rule";
    }
  | {
      language: string | null;
      text: string;
      type: "codeBlock";
    }
  | {
      align: MarkdownTableAlign[];
      header: MarkdownContentInline[][];
      rows: MarkdownContentInline[][][];
      type: "table";
    };

export type MarkdownTableAlign = "center" | "left" | "right" | null;

export function tableCellAlign(cell: string): MarkdownTableAlign {
  return cell.startsWith(":")
    ? cell.endsWith(":")
      ? "center"
      : "left"
    : cell.endsWith(":")
      ? "right"
      : null;
}

/** Cells of a GFM table row: split on unescaped pipes, outer pipes optional. */
function tableCells(line: string): string[] {
  // A scan, not a lookbehind regex: older macOS WebKit rejects lookbehinds.
  const cells = [""];
  const row = line.trim();
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cells[cells.length - 1] += "|";
      index += 1;
    } else if (row[index] === "|") cells.push("");
    else cells[cells.length - 1] += row[index];
  }
  if (row.startsWith("|")) cells.shift();
  if (row.endsWith("|") && !row.endsWith("\\|") && cells.length > 1)
    cells.pop();
  return cells.map((cell) => cell.trim());
}

/** The column alignments of a GFM delimiter row, or null if `line` is not one. */
function tableAlignments(line: string): MarkdownTableAlign[] | null {
  if (!line.includes("-")) return null;
  const cells = tableCells(line);
  if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map(tableCellAlign);
}

type ListBlock = Extract<
  MarkdownContentBlock,
  { type: "orderedList" | "unorderedList" }
>;

/** Tabs advance to the next multiple of 4 columns when comparing list indentation. */
const indentWidth = (indent: string) =>
  [...indent].reduce(
    (col, ch) => (ch === "\t" ? col + 4 - (col % 4) : col + 1),
    0,
  );

// shortcut: an info string beyond the language (```html title="x") is not a fence, so its `<!--` lines hide like comments; accept the full info string if such blocks show up.
const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_-]+)?\s*$/u;
const QUOTE_LINE = /^\s*>\s?(.*)$/u;
const HEADING = /^\s*(#{1,3})\s+(.+)$/u;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const UNORDERED_ITEM = /^(\s*)([-*+]\s+)(.+)$/u;
const ORDERED_ITEM = /^(\s*)(\d{1,9}[.)]\s+)(.+)$/u;
const COMMENT_START = /^ {0,3}<!--/u;

/** Like cmark-gfm, caps one table's cells so padded short rows stay bounded. */
const MAX_TABLE_CELLS = 20_000;

/** Lines that start another block and so end a table body. */
const BLOCK_STARTS = [
  FENCE,
  QUOTE_LINE,
  HEADING,
  RULE,
  UNORDERED_ITEM,
  ORDERED_ITEM,
  COMMENT_START,
];

/** `acceptLocalLink` lets a consumer accept `asset:` link targets besides `http(s):` ones. */
export function parseMarkdownContent(
  markdown: string,
  acceptLocalLink?: (href: string) => boolean,
): MarkdownContentBlock[] {
  const parseInline = (line: string) =>
    parseInlineMarkdown(line, acceptLocalLink);
  const blocks: MarkdownContentBlock[] = [];
  const paragraphLines: string[] = [];
  const quoteLines: string[] = [];
  let listStack: { list: ListBlock; indent: number; contentIndent: number }[] =
    [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  function flushParagraph() {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push({
      lines: paragraphLines.map(parseInline),
      type: "paragraph",
    });
    paragraphLines.length = 0;
  }

  function flushList() {
    if (listStack.length === 0) {
      return;
    }

    blocks.push(listStack[0].list);
    listStack = [];
  }

  /** An item indented up to its parent item's text nests under it, as in CommonMark. */
  function addListItem(
    indent: number,
    contentIndent: number,
    fresh: ListBlock,
    content: MarkdownContentInline[],
  ) {
    // shortcut: a nested sibling less indented than the first one (tab then 2 spaces) starts a new list (numbering restarts); pop on the parent's content column if users mix indents.
    while (
      listStack.length > 1 &&
      indent < listStack[listStack.length - 1].indent
    )
      listStack.pop();
    const top = listStack[listStack.length - 1];
    if (top && indent >= top.contentIndent) {
      const parent = top.list.items[top.list.items.length - 1];
      (parent.children ??= []).push(fresh);
      listStack.push({ list: fresh, indent, contentIndent });
    } else if (top?.list.type !== fresh.type) {
      if (listStack.length > 1) {
        listStack.pop();
        const outer = listStack[listStack.length - 1].list;
        outer.items[outer.items.length - 1].children!.push(fresh);
        listStack.push({ list: fresh, indent, contentIndent });
      } else {
        flushList();
        listStack.push({ list: fresh, indent, contentIndent });
      }
    } else {
      top.contentIndent = contentIndent;
    }
    listStack[listStack.length - 1].list.items.push({ content });
  }

  function flushQuote() {
    if (quoteLines.length === 0) {
      return;
    }

    blocks.push({
      lines: quoteLines.map(parseInline),
      type: "blockquote",
    });
    quoteLines.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(FENCE);

    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();

      const marker = fence[1];
      const codeLines: string[] = [];
      let closingIndex = index + 1;

      for (; closingIndex < lines.length; closingIndex += 1) {
        if (lines[closingIndex].trim() === marker) {
          break;
        }

        codeLines.push(lines[closingIndex]);
      }

      blocks.push({
        language: fence[2] ?? null,
        text: codeLines.join("\n"),
        type: "codeBlock",
      });

      index = closingIndex;
      continue;
    }

    // As GitHub/GitLab render it, an HTML comment block (to its `-->` line) is not shown.
    // A comment indented to the open list's item text belongs to that item and keeps the list.
    // shortcut: no indented code, so a `<!--` indented as code in an item hides like a comment; and a comment back at a parent's level keeps its sublist open (numbering continues). Track item columns if such documents are reported.
    const commentIndent = /^(\s*)<!--/u.exec(line)?.[1];
    const inList =
      commentIndent !== undefined &&
      listStack.length > 0 &&
      indentWidth(commentIndent) >= listStack[0].contentIndent;
    if (inList || COMMENT_START.test(line)) {
      flushParagraph();
      if (!inList) flushList();
      flushQuote();
      const startAt = line.indexOf("<!--") + 4;
      let closingIndex = index;
      let endAt = line.indexOf("-->", startAt);
      while (endAt < 0 && ++closingIndex < lines.length)
        endAt = lines[closingIndex].indexOf("-->");
      const suffix =
        endAt < 0 ? "" : lines[closingIndex].slice(endAt + 3).trimStart();
      // Text after `-->` stays visible: reparse it as the closing line, inside the item when listed.
      // shortcut: each chained comment re-measures the item indent, quadratic for a huge indent followed by thousands of `<!--x-->`; walk the chain with a cursor if such input shows up.
      if (suffix) {
        lines[closingIndex] = inList ? commentIndent + suffix : suffix;
        index = closingIndex - 1;
      } else {
        index = closingIndex;
      }
      continue;
    }

    // Blank lines between items keep one (loose) list; any other block flushes it.
    if (!line.trim()) {
      flushParagraph();
      flushQuote();
      continue;
    }

    const quoteLine = line.match(QUOTE_LINE);

    if (quoteLine) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteLine[1]);
      continue;
    }

    const heading = line.match(HEADING);

    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({
        content: parseInline(heading[2]),
        level: heading[1].length as 1 | 2 | 3,
        type: "heading",
      });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: "rule" });
      continue;
    }

    const unorderedItem = line.match(UNORDERED_ITEM);
    const orderedItem = unorderedItem ? null : line.match(ORDERED_ITEM);

    // shortcut: a lazy continuation line or mixed "1."/"1)" delimiters do not split or join lists like CommonMark; upgrade if agents rely on them.
    if (unorderedItem || orderedItem) {
      flushParagraph();
      flushQuote();
      const [, indent, marker, text] = (unorderedItem ?? orderedItem)!;
      addListItem(
        indentWidth(indent),
        indentWidth(indent + marker),
        unorderedItem
          ? { items: [], type: "unorderedList" }
          : { items: [], start: parseInt(marker, 10), type: "orderedList" },
        parseInline(text),
      );
      continue;
    }

    const align =
      line.includes("|") && lines[index + 1]?.includes("|")
        ? tableAlignments(lines[index + 1])
        : null;
    const header = align ? tableCells(line) : null;

    if (
      align &&
      align.length <= MAX_TABLE_CELLS &&
      header?.length === align.length
    ) {
      flushParagraph();
      flushList();
      flushQuote();
      const rows: MarkdownContentInline[][][] = [];
      let cellCount = align.length;
      let rowIndex = index + 2;

      // GFM pads short rows and drops cells past the header's columns.
      for (
        ;
        rowIndex < lines.length &&
        lines[rowIndex].trim() &&
        lines[rowIndex].includes("|") &&
        !BLOCK_STARTS.some((pattern) => pattern.test(lines[rowIndex])) &&
        cellCount + align.length <= MAX_TABLE_CELLS;
        rowIndex += 1
      ) {
        const cells = tableCells(lines[rowIndex]);
        rows.push(
          align.map((_, column) =>
            column < cells.length ? parseInline(cells[column]) : [],
          ),
        );
        cellCount += align.length;
      }

      blocks.push({
        align,
        header: header.map(parseInline),
        rows,
        type: "table",
      });
      index = rowIndex - 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();

  return blocks;
}

export function parseInlineMarkdown(
  markdown: string,
  acceptLocalLink?: (href: string) => boolean,
): MarkdownContentInline[] {
  const tokens: MarkdownContentInline[] = [];
  let index = 0;
  let linkLabelEnd = -1;
  let linkHref: string | null = null;
  let linkClose = -1;
  let linkTargetEnd = -1;
  let angleTargetEnd = -1;
  const linkStart = acceptLocalLink
    ? /\]\(<?(?:https?|asset):\/\//iy
    : /\]\(<?https?:\/\//iy;
  const linkEnd = /[\s)]/gu;
  const angleLinkEnd = /[\s<>]/gu;
  const bareUrl = /https?:\/\/[\w-][\w.-]*[^\s<]*/iy;

  function pushText(text: string) {
    if (!text) {
      return;
    }

    const previous = tokens[tokens.length - 1];

    if (previous?.type === "text") {
      previous.text += text;
      return;
    }

    tokens.push({ text, type: "text" });
  }

  while (index < markdown.length) {
    if (markdown[index] === "\\" && markdown[index + 1]) {
      pushText(markdown[index + 1]);
      index += 2;
      continue;
    }

    if (markdown[index] === "`") {
      const endIndex = markdown.indexOf("`", index + 1);

      if (endIndex > index + 1) {
        tokens.push({
          text: markdown.slice(index + 1, endIndex),
          type: "code",
        });
        index = endIndex + 1;
        continue;
      }
    }

    if (markdown[index] === "[") {
      // All opening brackets before this closing bracket share the same target.
      if (linkLabelEnd < index) {
        linkLabelEnd = markdown.indexOf("]", index + 1);
        if (linkLabelEnd === -1) linkLabelEnd = markdown.length;
        linkHref = null;
        linkStart.lastIndex = linkLabelEnd;
        if (linkStart.test(markdown)) {
          const contentStart = linkStart.lastIndex;
          if (markdown[linkLabelEnd + 2] === "<") {
            if (angleTargetEnd < contentStart) {
              angleLinkEnd.lastIndex = contentStart;
              angleTargetEnd =
                angleLinkEnd.exec(markdown)?.index ?? markdown.length;
            }
            if (
              markdown.startsWith(">)", angleTargetEnd) &&
              angleTargetEnd > contentStart
            ) {
              linkHref = markdown.slice(linkLabelEnd + 3, angleTargetEnd);
              linkClose = angleTargetEnd + 1;
            }
          } else {
            if (linkTargetEnd < contentStart) {
              linkEnd.lastIndex = contentStart;
              linkTargetEnd = linkEnd.exec(markdown)?.index ?? markdown.length;
            }
            if (
              markdown[linkTargetEnd] === ")" &&
              linkTargetEnd > contentStart
            ) {
              linkHref = markdown.slice(linkLabelEnd + 2, linkTargetEnd);
              linkClose = linkTargetEnd;
            }
          }
          if (
            linkHref &&
            !/^https?:/i.test(linkHref) &&
            !acceptLocalLink?.(linkHref)
          ) {
            linkHref = null;
          }
        }
      }
      if (linkHref && linkLabelEnd > index + 1) {
        // Images are shown as links to them, so the `!` of `![alt](url)` is syntax, not text.
        const previous = tokens[tokens.length - 1];
        if (
          markdown[index - 1] === "!" &&
          markdown[index - 2] !== "\\" &&
          previous?.type === "text"
        ) {
          previous.text = previous.text.slice(0, -1);
          if (!previous.text) tokens.pop();
        }
        tokens.push({
          href: linkHref,
          text: markdown.slice(index + 1, linkLabelEnd),
          type: "link",
        });
        index = linkClose + 1;
        continue;
      }
    }

    // shortcut: a trailing entity (`https://a.io&nbsp;`) keeps `&nbsp` in the URL; trim whole entities if agents emit them.
    // GFM autolinks: a bare URL after a boundary, minus trailing punctuation and unbalanced `)`.
    if (
      (markdown[index] === "h" || markdown[index] === "H") &&
      (index === 0 || /[\s*_~(]/u.test(markdown[index - 1]))
    ) {
      bareUrl.lastIndex = index;
      let url = bareUrl.exec(markdown)?.[0];
      if (url) {
        let unbalanced = url.split(")").length - url.split("(").length;
        for (;;) {
          const last = url[url.length - 1];
          if (/[?!.,:;*_~'"]/u.test(last)) url = url.slice(0, -1);
          else if (last === ")" && unbalanced > 0) {
            url = url.slice(0, -1);
            unbalanced -= 1;
          } else break;
        }
        tokens.push({ href: url, text: url, type: "link" });
        index += url.length;
        continue;
      }
    }

    const strongMarker = markdown.startsWith("**", index)
      ? "**"
      : markdown.startsWith("__", index)
        ? "__"
        : null;

    if (strongMarker) {
      const endIndex = markdown.indexOf(strongMarker, index + 2);

      if (endIndex > index + 2) {
        tokens.push({
          children: parseInlineMarkdown(
            markdown.slice(index + 2, endIndex),
            acceptLocalLink,
          ),
          type: "strong",
        });
        index = endIndex + 2;
        continue;
      }
    }

    if (markdown[index] === "*") {
      const endIndex = markdown.indexOf("*", index + 1);

      if (endIndex > index + 1) {
        tokens.push({
          children: parseInlineMarkdown(
            markdown.slice(index + 1, endIndex),
            acceptLocalLink,
          ),
          type: "emphasis",
        });
        index = endIndex + 1;
        continue;
      }
    }

    pushText(markdown[index]);
    index += 1;
  }

  return tokens;
}
