import { describe, expect, it } from "vitest";
import { parseMarkdownContent, parseInlineMarkdown } from "./markdownContent";

describe("parseInlineMarkdown", () => {
  it("parses formatting and safe links without html rendering", () => {
    expect(
      parseInlineMarkdown(
        "Use **bold**, *italic*, `code` and [source](https://example.com/read).",
      ),
    ).toEqual([
      { text: "Use ", type: "text" },
      { children: [{ text: "bold", type: "text" }], type: "strong" },
      { text: ", ", type: "text" },
      { children: [{ text: "italic", type: "text" }], type: "emphasis" },
      { text: ", ", type: "text" },
      { text: "code", type: "code" },
      { text: " and ", type: "text" },
      {
        href: "https://example.com/read",
        text: "source",
        type: "link",
      },
      { text: ".", type: "text" },
    ]);
  });

  it("keeps code and emphasis inside bold text", () => {
    expect(
      parseInlineMarkdown("- **`messages.rs`** : **Nouveau *module* ici**"),
    ).toEqual([
      { text: "- ", type: "text" },
      { children: [{ text: "messages.rs", type: "code" }], type: "strong" },
      { text: " : ", type: "text" },
      {
        children: [
          { text: "Nouveau ", type: "text" },
          { children: [{ text: "module", type: "text" }], type: "emphasis" },
          { text: " ici", type: "text" },
        ],
        type: "strong",
      },
    ]);
  });

  it("scans long unmatched bracket runs without rescanning suffixes", () => {
    const text = "[".repeat(100_000) + "end";
    const start = performance.now();
    expect(parseInlineMarkdown(text)).toEqual([{ type: "text", text }]);
    expect(parseInlineMarkdown(text + "](invalid) **bold**")).toEqual([
      { type: "text", text: text + "](invalid) " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
    ]);
    const unfinishedTargets = "[a](https://".repeat(20_000);
    expect(parseInlineMarkdown(unfinishedTargets)).toEqual([
      { type: "text", text: unfinishedTargets },
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("preserves nested brackets, escapes and inline formatting around links", () => {
    expect(
      parseInlineMarkdown("[a[b](HTTPS://example.com) \\[x] *ok*"),
    ).toEqual([
      { type: "link", text: "a[b", href: "HTTPS://example.com" },
      { type: "text", text: " [x] " },
      { type: "emphasis", children: [{ type: "text", text: "ok" }] },
    ]);
  });

  it("keeps empty labels, empty URLs and whitespace URLs out of markdown links", () => {
    expect(
      parseInlineMarkdown("[](https://a) [a](https://) [a](https://a b)"),
    ).toEqual([
      { text: "[](", type: "text" },
      { href: "https://a", text: "https://a", type: "link" },
      { text: ") [a](https://) [a](", type: "text" },
      { href: "https://a", text: "https://a", type: "link" },
      { text: " b)", type: "text" },
    ]);
  });

  it("links bare URLs without trailing punctuation or unbalanced parentheses", () => {
    expect(
      parseInlineMarkdown(
        "Hono : https://hono.dev/docs/. (voir https://w.org/A_(b)), **https://x.io**, a https://y.io?",
      ),
    ).toEqual([
      { text: "Hono : ", type: "text" },
      {
        href: "https://hono.dev/docs/",
        text: "https://hono.dev/docs/",
        type: "link",
      },
      { text: ". (voir ", type: "text" },
      {
        href: "https://w.org/A_(b)",
        text: "https://w.org/A_(b)",
        type: "link",
      },
      { text: "), ", type: "text" },
      {
        children: [
          { href: "https://x.io", text: "https://x.io", type: "link" },
        ],
        type: "strong",
      },
      { text: ", a ", type: "text" },
      { href: "https://y.io", text: "https://y.io", type: "link" },
      { text: "?", type: "text" },
    ]);
    const text = "xhttps://a.io https:// `https://b.io` <https://c.io";
    expect(parseInlineMarkdown(text)).toEqual([
      { text: "xhttps://a.io https:// ", type: "text" },
      { text: "https://b.io", type: "code" },
      { text: " <https://c.io", type: "text" },
    ]);
  });

  it("parses angle-bracket link targets", () => {
    expect(
      parseInlineMarkdown(
        "un [lien](<https://example.com>). [wiki](<https://w.org/A_(b)>)",
      ),
    ).toEqual([
      { text: "un ", type: "text" },
      { href: "https://example.com", text: "lien", type: "link" },
      { text: ". ", type: "text" },
      { href: "https://w.org/A_(b)", text: "wiki", type: "link" },
    ]);
    const invalid = "[a](<https://>) [a](<https://a b>) [a](<https://a>x)";
    expect(parseInlineMarkdown(invalid)).toEqual([
      { text: invalid, type: "text" },
    ]);
    const start = performance.now();
    const unfinished = "[a](<https://".repeat(20_000);
    expect(parseInlineMarkdown(unfinished)).toEqual([
      { text: unfinished, type: "text" },
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("renders a Markdown image as a link to it, keeping escaped and lone exclamation marks", () => {
    expect(
      parseInlineMarkdown(
        "![image.png](https://example.com/a/b) Wow! \\![x](https://a)",
      ),
    ).toEqual([
      {
        href: "https://example.com/a/b",
        text: "image.png",
        type: "link",
      },
      { text: " Wow! !", type: "text" },
      { href: "https://a", text: "x", type: "link" },
    ]);
  });

  it("accepts asset link targets only where the consumer opts in", () => {
    const markdown =
      "![shot](asset://localhost/a.png) [b](asset://localhost/b)";
    expect(parseInlineMarkdown(markdown)).toEqual([
      { text: markdown, type: "text" },
    ]);
    expect(
      parseInlineMarkdown(markdown, (href) => href.endsWith(".png")),
    ).toEqual([
      { href: "asset://localhost/a.png", text: "shot", type: "link" },
      { text: " [b](asset://localhost/b)", type: "text" },
    ]);
  });

  it("keeps unsafe links as text", () => {
    expect(parseInlineMarkdown("[Open](javascript:alert(1))")).toEqual([
      { text: "[Open](javascript:alert(1))", type: "text" },
    ]);
  });

  it("keeps unmatched markers as text while streaming", () => {
    expect(parseInlineMarkdown("Start **unfinished")).toEqual([
      { text: "Start **unfinished", type: "text" },
    ]);
  });
});

describe("parseMarkdownContent", () => {
  it("parses headings, paragraphs and list items", () => {
    expect(
      parseMarkdownContent(
        [
          "## Analyse",
          "",
          "**Points forts :**",
          "* **Arguments solides :** le fond est clair.",
          "* **Ton approprie :** formel.",
          "",
          "Conclusion.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        content: [{ text: "Analyse", type: "text" }],
        level: 2,
        type: "heading",
      },
      {
        lines: [
          [
            {
              children: [{ text: "Points forts :", type: "text" }],
              type: "strong",
            },
          ],
        ],
        type: "paragraph",
      },
      {
        items: [
          {
            content: [
              {
                children: [{ text: "Arguments solides :", type: "text" }],
                type: "strong",
              },
              { text: " le fond est clair.", type: "text" },
            ],
          },
          {
            content: [
              {
                children: [{ text: "Ton approprie :", type: "text" }],
                type: "strong",
              },
              { text: " formel.", type: "text" },
            ],
          },
        ],
        type: "unorderedList",
      },
      {
        lines: [[{ text: "Conclusion.", type: "text" }]],
        type: "paragraph",
      },
    ]);
  });

  it("keeps blank-line separated items in one numbered list", () => {
    const item = (value: string) => ({
      content: [{ text: value, type: "text" }],
    });
    expect(parseMarkdownContent("1. A\n\n2. B\n\n- C\n3. D")).toEqual([
      { items: [item("A"), item("B")], start: 1, type: "orderedList" },
      { items: [item("C")], type: "unorderedList" },
      { items: [item("D")], start: 3, type: "orderedList" },
    ]);
  });

  it("nests items indented up to their parent's text, back out on dedent", () => {
    const item = (value: string, children?: unknown[]) => ({
      content: [{ text: value, type: "text" }],
      ...(children ? { children } : {}),
    });
    expect(
      parseMarkdownContent(
        [
          "- Features",
          "  - A",
          "  - B",
          "    1. Step",
          "- Fixes",
          "  - C",
          "2. Parent",
          "   <!-- internal -->",
          "   1. Enfant",
          "      <!-- deeper than 3 spaces, still hidden -->",
          "  4. Too shallow: a sibling",
          "3. Suite",
          "-\tTabbed",
          "  - Too shallow after a tab: a sibling",
          "-\tParent",
          "    - Enfant",
        ].join("\n"),
      ),
    ).toEqual([
      {
        items: [
          item("Features", [
            {
              items: [
                item("A"),
                item("B", [
                  { items: [item("Step")], start: 1, type: "orderedList" },
                ]),
              ],
              type: "unorderedList",
            },
          ]),
          item("Fixes", [{ items: [item("C")], type: "unorderedList" }]),
        ],
        type: "unorderedList",
      },
      {
        items: [
          item("Parent", [
            { items: [item("Enfant")], start: 1, type: "orderedList" },
          ]),
          item("Too shallow: a sibling"),
          item("Suite"),
        ],
        start: 2,
        type: "orderedList",
      },
      {
        items: [
          item("Tabbed"),
          item("Too shallow after a tab: a sibling"),
          item("Parent", [{ items: [item("Enfant")], type: "unorderedList" }]),
        ],
        type: "unorderedList",
      },
    ]);
    expect(
      parseMarkdownContent("1. A\n    <!-- a --> <!-- b -->\n1. B"),
    ).toEqual([
      { items: [item("A"), item("B")], start: 1, type: "orderedList" },
    ]);
  });

  it("parses blockquotes without displaying their markers", () => {
    expect(
      parseMarkdownContent(
        "> First **point**.\n>\n> Second point.\n\nConclusion.",
      ),
    ).toEqual([
      {
        lines: [
          [
            { text: "First ", type: "text" },
            { children: [{ text: "point", type: "text" }], type: "strong" },
            { text: ".", type: "text" },
          ],
          [],
          [{ text: "Second point.", type: "text" }],
        ],
        type: "blockquote",
      },
      {
        lines: [[{ text: "Conclusion.", type: "text" }]],
        type: "paragraph",
      },
    ]);
  });

  it("parses a thematic break instead of a list item", () => {
    expect(parseMarkdownContent("Fixed.\n\n---\n\nReviewed.\n- - -")).toEqual([
      { lines: [[{ text: "Fixed.", type: "text" }]], type: "paragraph" },
      { type: "rule" },
      { lines: [[{ text: "Reviewed.", type: "text" }]], type: "paragraph" },
      { type: "rule" },
    ]);
  });

  it("hides HTML comment blocks but keeps them in code", () => {
    const text = (value: string) => [[{ text: value, type: "text" }]];
    expect(
      parseMarkdownContent(
        [
          "Before.",
          "<!-- generated: release notes -->",
          "Middle.",
          "<!--",
          "hidden",
          "-->",
          "<!-- internal --> Important fix",
          "<!--",
          "hidden",
          "--> After.",
          "```",
          "<!-- kept -->",
          "```",
          "| H |",
          "| --- |",
          "<!-- a | b",
          "hidden",
          "-->",
          "<!-- never closed",
          "Lost.",
        ].join("\n"),
      ),
    ).toEqual([
      { lines: text("Before."), type: "paragraph" },
      { lines: text("Middle."), type: "paragraph" },
      { lines: text("Important fix"), type: "paragraph" },
      { lines: text("After."), type: "paragraph" },
      { language: null, text: "<!-- kept -->", type: "codeBlock" },
      { align: [null], header: [text("H")[0]], rows: [], type: "table" },
    ]);
  });

  it("parses GFM tables with their alignment, ending at the first line without a pipe", () => {
    const text = (value: string) => [{ text: value, type: "text" }];
    expect(
      parseMarkdownContent(
        [
          "Voici les fichiers :",
          "| Taille | Fichier | Note |",
          "|---:|:---|:-:|",
          "| 1,1 Mio | `a.exe` |",
          "| 298 Kio | b\\|c.ico | x | ignored |",
          "Fin.",
        ].join("\n"),
      ),
    ).toEqual([
      { lines: [text("Voici les fichiers :")], type: "paragraph" },
      {
        align: ["right", "left", "center"],
        header: [text("Taille"), text("Fichier"), text("Note")],
        rows: [
          [text("1,1 Mio"), [{ text: "a.exe", type: "code" }], []],
          [text("298 Kio"), text("b|c.ico"), text("x")],
        ],
        type: "table",
      },
      { lines: [text("Fin.")], type: "paragraph" },
    ]);
  });

  it("keeps pipes as text without a matching delimiter row", () => {
    expect(parseMarkdownContent("a | b\n--- | --- | ---\nc | d")).toEqual([
      {
        lines: [
          [{ text: "a | b", type: "text" }],
          [{ text: "--- | --- | ---", type: "text" }],
          [{ text: "c | d", type: "text" }],
        ],
        type: "paragraph",
      },
    ]);
  });

  it("keeps quotes, headings and list items with pipes before a delimiter row", () => {
    const types = (markdown: string) =>
      parseMarkdownContent(markdown).map((block) => block.type);
    expect(types("# A | B\n--- | ---")).toEqual(["heading", "paragraph"]);
    expect(types("- A | B\n--- | ---")).toEqual(["unorderedList", "paragraph"]);
    expect(types("1. A | B\n--- | ---")).toEqual(["orderedList", "paragraph"]);
    expect(types("> A | B\n--- | ---")).toEqual(["blockquote", "paragraph"]);
  });

  it("ends a table before a quote, heading or list item with a pipe", () => {
    const text = (value: string) => [{ text: value, type: "text" }];
    expect(
      parseMarkdownContent(
        ["| H |", "| --- |", "| a |", "> b | c", "# d | e", "- f | g"].join(
          "\n",
        ),
      ),
    ).toEqual([
      {
        align: [null],
        header: [text("H")],
        rows: [[text("a")]],
        type: "table",
      },
      { lines: [text("b | c")], type: "blockquote" },
      { content: text("d | e"), level: 1, type: "heading" },
      { items: [{ content: text("f | g") }], type: "unorderedList" },
    ]);
  });

  it("cuts an oversized table at its cell budget and parses the rest as text", () => {
    const columns = 1_000;
    const markdown = [
      `|${" h |".repeat(columns)}`,
      `|${" --- |".repeat(columns)}`,
      ...Array.from({ length: 30 }, () => "| x |"),
    ].join("\n");
    const [table, rest, ...others] = parseMarkdownContent(markdown);

    expect(table.type === "table" && table.rows.length).toBe(19);
    expect(table.type === "table" && table.rows[0][1]).toEqual([]);
    expect(rest.type === "paragraph" && rest.lines.length).toBe(11);
    expect(others).toEqual([]);
  });

  it("keeps a header and delimiter wider than the cell budget as paragraph text", () => {
    const columns = 20_001;
    const markdown = [
      `|${" h |".repeat(columns)}`,
      `|${" --- |".repeat(columns)}`,
    ].join("\n");
    const blocks = parseMarkdownContent(markdown);

    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(blocks[0].type === "paragraph" && blocks[0].lines.length).toBe(2);
  });
});
