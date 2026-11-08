import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700" },
  { tag: tags.strong, color: "var(--cm-strong)", fontWeight: "750" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    color: "var(--cm-code-text)",
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--cm-link)",
    textDecoration: "underline",
  },
  {
    tag: [tags.processingInstruction, tags.labelName, tags.contentSeparator],
    color: "var(--editor-text)",
  },
  { tag: tags.keyword, color: "var(--cm-syntax-keyword)" },
  { tag: tags.string, color: "var(--cm-syntax-string)" },
  { tag: [tags.number, tags.bool], color: "var(--cm-syntax-number)" },
  { tag: tags.comment, color: "var(--cm-syntax-comment)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--cm-syntax-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName],
    color: "var(--cm-syntax-type)",
  },
]);
