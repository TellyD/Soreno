import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { lineEnding, markdownSupport, markdownText } from "./document";

describe("native Markdown document", () => {
  it.each([
    "",
    "\n",
    "A\nB",
    "A\n\nB",
    "A\n\n\nB",
    "\n A  \n\t\nB\n\n",
    "A\r\n\r\nB\r\n",
    "```\n<!-- telaoi:blank-line -->\n\n",
  ])("preserves %j", (content) => {
    const state = EditorState.create({
      doc: markdownText(content),
      extensions: [
        markdownSupport,
        EditorState.lineSeparator.of(lineEnding(content)),
      ],
    });
    expect(state.sliceDoc()).toBe(content);
  });

  it("normalizes mixed endings only when exporting an edited document", () => {
    const content = "A\r\nB\nC";
    const state = EditorState.create({
      doc: markdownText(content),
      extensions: [EditorState.lineSeparator.of(lineEnding(content))],
    });
    expect(state.doc.lines).toBe(3);
    expect(
      state.update({ changes: { from: 0, insert: "X" } }).state.sliceDoc(),
    ).toBe("XA\r\nB\r\nC");
  });

  it("uses CommonMark plus GFM, not Obsidian or extra Markdown extensions", () => {
    const state = EditorState.create({
      doc: "- [x] task\n\n~~strike~~\n\n| a | b |\n| - | - |\n| c | d |\n\n~sub~ ^super^",
      extensions: [markdownSupport],
    });
    const tree = syntaxTree(state).toString();
    expect(tree).toContain("TaskMarker");
    expect(tree).toContain("Table");
    expect(tree).toContain("Strikethrough");
    expect(tree).not.toMatch(/Subscript|Superscript/);
  });
});
