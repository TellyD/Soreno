import { Annotation, Text, type EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { codeLanguage } from "./codeLanguages";

export const externalUpdate = Annotation.define<boolean>();
export const markdownSupport = markdown({
  extensions: GFM,
  codeLanguages: codeLanguage,
  addKeymap: false,
  completeHTMLTags: false,
  pasteURLAsLink: false,
});

export function markdownText(source: string): Text {
  return Text.of(source.split(/\r\n?|\n/u));
}

export function lineEnding(source: string): string {
  return source.match(/\r\n?|\n/u)?.[0] ?? "\n";
}

// Only explicit block insertion uses paragraph separators; never normalize a note.
export function blockPadding(
  state: EditorState,
  from: number,
  to: number,
  padEdges = false,
) {
  const leading = state.doc
    .sliceString(Math.max(0, from - 2), from)
    .match(/\n*$/u)![0].length;
  const trailing = state.doc.sliceString(to, to + 2).match(/^\n*/u)![0].length;
  return {
    before: from > 0 || padEdges ? "\n".repeat(2 - leading) : "",
    after: to < state.doc.length || padEdges ? "\n".repeat(2 - trailing) : "",
  };
}
