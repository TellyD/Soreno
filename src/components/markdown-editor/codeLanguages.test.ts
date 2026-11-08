import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import {
  codeLanguage,
  codeLanguageOptions,
  codeLanguages,
} from "./codeLanguages";
import { markdownSupport } from "./document";
import { markdownHighlightStyle } from "./highlighting";

describe("fenced code languages", () => {
  it("resolves every exact alias and canonical option, ignoring case and trailing metadata", () => {
    for (const language of codeLanguages) {
      for (const alias of language.alias) {
        expect(codeLanguage(`  ${alias.toUpperCase()}\t title=example`)).toBe(
          language,
        );
      }
    }
    for (const option of codeLanguageOptions) {
      expect(codeLanguage(option.value)?.name).toBe(option.label);
    }
  });

  it.each([
    "",
    "  ",
    "text",
    "plain",
    "plaintext",
    "unknown",
    "javascript-extra",
    "file.js",
    "{.js}",
  ])("does not guess a parser for %j", (info) => {
    expect(codeLanguage(info)).toBeNull();
    const doc = `\`\`\`${info}\nconst value = 42;\n\`\`\``;
    const state = EditorState.create({ doc, extensions: [markdownSupport] });
    expect(ensureSyntaxTree(state, doc.length)?.toString()).toContain(
      "CodeText",
    );
  });

  it.each([
    ["js", "const answer = 42;", "const", tags.keyword],
    ["jsx", "const node = <div />;", "div", tags.tagName],
    ["ts", "const answer: number = 42;", "const", tags.keyword],
    ["tsx", "const node: JSX.Element = <div />;", "div", tags.tagName],
    ["py", "def greet():\n    return 'hello'", "def", tags.keyword],
    ["rs", "fn main() { let n = 42; }", "fn", tags.keyword],
    ["json", '{"answer": 42}', "42", tags.number],
    ["html", '<div class="greeting">Hello</div>', "div", tags.tagName],
    ["css", 'a { content: "hello"; }', '"hello"', tags.string],
    ["sql", "SELECT name FROM people;", "SELECT", tags.keyword],
    ["bash", '# hello\necho "world"', "# hello", tags.comment],
  ])(
    "loads %s and mounts real code highlighting inside Markdown",
    async (info, source, token, tag) => {
      const language = codeLanguage(info)!;
      const support = await language.load();
      expect(support).toBe(language.support);
      const doc = `\`\`\`${info}\n${source}\n\`\`\``;
      const state = EditorState.create({ doc, extensions: [markdownSupport] });
      const tree = ensureSyntaxTree(state, doc.length, 1000)!;
      const highlighted: { text: string; classes: string }[] = [];
      highlightTree(tree, markdownHighlightStyle, (from, to, classes) => {
        highlighted.push({ text: doc.slice(from, to), classes });
      });
      expect(highlighted).toContainEqual({
        text: token,
        classes: markdownHighlightStyle.style([tag]),
      });
      expect(highlighted).toContainEqual({
        text: "```",
        classes: markdownHighlightStyle.style([tags.processingInstruction]),
      });
    },
  );
});
