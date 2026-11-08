import {
  countColumn,
  EditorSelection,
  type EditorState,
  type StateCommand,
} from "@codemirror/state";
import { type Command, type KeyBinding } from "@codemirror/view";
import { indentLess, indentMore, isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSection,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { actionIconElement } from "./actionIcons";
import type { TranslationKey } from "../../i18n";
import { blockPadding, markdownText } from "./document";

export const blockActions = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "bullet",
  "numbered",
  "task",
  "quote",
  "codeBlock",
  "rule",
  "table",
] as const;
export type BlockAction = (typeof blockActions)[number];
export type InlineAction = "bold" | "italic" | "strike" | "code" | "link";
export type EditorAction =
  BlockAction | InlineAction | "indent" | "outdent" | "toggleTask";
export const commandLabel = (action: EditorAction | "image"): TranslationKey =>
  `editor.command.${action}`;

function codeDelimiter(text: string, minimum: number): string {
  let length = minimum;
  for (const match of text.matchAll(/`+/gu))
    length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
}

function inCode(
  state: EditorState,
  from: number,
  to = from,
  inline = false,
): boolean {
  if (syntaxTree(state).length < to) return true;
  let found = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (
        [
          "FencedCode",
          "CodeBlock",
          "HTMLBlock",
          ...(inline ? ["InlineCode"] : []),
        ].includes(node.name)
      ) {
        found = true;
        return false;
      }
    },
  });
  return found;
}

function replace(
  target: Parameters<StateCommand>[0],
  from: number,
  to: number,
  text: string,
  anchor = from,
  head = anchor,
): boolean {
  target.dispatch(
    target.state.update({
      changes: { from, to, insert: markdownText(text) },
      selection: EditorSelection.range(anchor, head),
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
    }),
  );
  return true;
}

function inlineCommand(action: InlineAction): StateCommand {
  return (target) => {
    const { state } = target;
    const { from, to } = state.selection.main;
    if (inCode(state, from, to, action !== "code")) return false;
    const names = {
      bold: "StrongEmphasis",
      italic: "Emphasis",
      strike: "Strikethrough",
      code: "InlineCode",
      link: "Link",
    };
    let node = syntaxTree(state).resolveInner(from, 1);
    for (;;) {
      if (
        node.name === names[action] &&
        node.from <= from &&
        node.to >= to &&
        action !== "link"
      ) {
        const start = node.firstChild!.to,
          end = node.lastChild!.from;
        let inner = state.doc.sliceString(start, end);
        if (
          action === "code" &&
          inner.startsWith(" ") &&
          inner.endsWith(" ") &&
          inner.trim()
        )
          inner = inner.slice(1, -1);
        return replace(
          target,
          node.from,
          node.to,
          inner,
          node.from,
          node.from + inner.length,
        );
      }
      if (!node.parent) break;
      node = node.parent;
    }
    const text = state.doc.sliceString(from, to);
    if (action === "link") {
      const label = text.replace(/\\/gu, "\\\\").replace(/[\[\]]/gu, "\\$&");
      const value = `[${label}](url)`;
      return replace(
        target,
        from,
        to,
        value,
        from + value.length - 4,
        from + value.length - 1,
      );
    }
    const marker =
      action === "code"
        ? codeDelimiter(text, 1)
        : { bold: "**", italic: "*", strike: "~~" }[action];
    const padding =
      action === "code" &&
      (text.startsWith("`") ||
        text.endsWith("`") ||
        (text.startsWith(" ") && text.endsWith(" ") && text.trim()))
        ? " "
        : "";
    const value = marker + padding + text + padding + marker;
    return replace(
      target,
      from,
      to,
      value,
      from + marker.length + padding.length,
      from + marker.length + padding.length + text.length,
    );
  };
}

function blockCommand(action: BlockAction): StateCommand {
  return (target) => {
    const { state } = target;
    const range = state.selection.main;
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(
      range.to > range.from && state.doc.lineAt(range.to).from === range.to
        ? range.to - 1
        : range.to,
    );
    if (inCode(state, first.from, last.to)) return false;
    if (["codeBlock", "rule", "table"].includes(action)) {
      const text = state.doc.sliceString(first.from, last.to);
      const fence = codeDelimiter(text, 3);
      const from = action === "codeBlock" ? first.from : range.from;
      const to = action === "codeBlock" ? last.to : range.to;
      const { before, after } = blockPadding(state, from, to);
      const body =
        action === "rule"
          ? "---"
          : action === "table"
            ? "| A | B |\n| --- | --- |\n|   |   |"
            : `${fence}\n${text}\n${fence}`;
      const offset =
        before.length +
        (action === "table"
          ? 2
          : action === "codeBlock"
            ? fence.length + 1
            : 0);
      return replace(
        target,
        from,
        to,
        before + body + after,
        from + offset,
        from +
          offset +
          (action === "table" ? 1 : action === "codeBlock" ? text.length : 0),
      );
    }
    const changes = [];
    for (let number = first.number; number <= last.number; number++) {
      const line = state.doc.line(number);
      const indent = line.text.match(/^[ \t]*/u)![0];
      const oldPrefix =
        line.text
          .slice(indent.length)
          .match(
            /^(?:#{1,6}[ \t]+|[-+*][ \t]+(?:\[[ xX]\][ \t]*)?|\d+[.)][ \t]+|>[ \t]?)/u,
          )?.[0] ?? "";
      const prefix = action.startsWith("heading")
        ? "#".repeat(Number(action.slice(-1))) + " "
        : action === "bullet"
          ? "- "
          : action === "numbered"
            ? `${number - first.number + 1}. `
            : action === "task"
              ? "- [ ] "
              : action === "quote"
                ? "> "
                : "";
      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + oldPrefix.length,
        insert: prefix,
      });
    }
    const tr = state.update({ changes });
    target.dispatch(
      state.update({
        changes,
        selection: range.empty
          ? EditorSelection.cursor(tr.changes.mapPos(range.head, 1))
          : EditorSelection.range(first.from, tr.changes.mapPos(last.to, 1)),
        annotations: isolateHistory.of("full"),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

const toggleTask: StateCommand = (target) => {
  const { state } = target;
  const line = state.doc.lineAt(state.selection.main.head);
  let marker: { from: number; to: number } | undefined;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name === "TaskMarker") marker = { from: node.from, to: node.to };
    },
  });
  if (!marker) return false;
  const value =
    state.doc.sliceString(marker.from + 1, marker.from + 2).toLowerCase() ===
    "x"
      ? " "
      : "x";
  target.dispatch(
    state.update({
      changes: { from: marker.from + 1, to: marker.from + 2, insert: value },
      annotations: isolateHistory.of("full"),
    }),
  );
  return true;
};

const indentText: StateCommand = ({ state, dispatch }) =>
  indentMore({
    state,
    dispatch: (tr) => {
      let blocked = false;
      tr.changes.iterChanges((from, _to, nextFrom) => {
        const line = state.doc.lineAt(from);
        const whitespace = line.text.match(/^[ \t]*/u)![0];
        let node = syntaxTree(state).resolveInner(
          line.from + whitespace.length,
          1,
        );
        for (;;) {
          if (["ListItem", "FencedCode", "CodeBlock"].includes(node.name))
            return;
          if (!node.parent) break;
          node = node.parent;
        }
        // Four leading spaces turn ordinary Markdown text into code, not a deeper visual indent.
        const nextWhitespace = tr.newDoc
          .lineAt(nextFrom)
          .text.match(/^[ \t]*/u)![0];
        if (countColumn(nextWhitespace, state.tabSize) > 2) blocked = true;
      });
      // Keep a multi-line selection together rather than shifting only some of its lines.
      if (!blocked) dispatch(tr);
    },
  });

export function editorCommand(action: EditorAction): StateCommand {
  if (action === "toggleTask") return toggleTask;
  if (action === "indent") return indentText;
  if (action === "outdent") return indentLess;
  if (["bold", "italic", "strike", "code", "link"].includes(action))
    return inlineCommand(action as InlineAction);
  return blockCommand(action as BlockAction);
}

export const formattingKeymap: readonly KeyBinding[] = [
  ["Mod-b", "bold"],
  ["Mod-i", "italic"],
  ["Mod-k", "link"],
  ["Mod-Shift-x", "toggleTask"],
  ["Mod-]", "indent"],
  ["Mod-[", "outdent"],
].map(([key, action]) => ({
  key,
  run: ((view) =>
    !view.composing && editorCommand(action as EditorAction)(view)) as Command,
}));

type SlashAction = BlockAction | "image";
type SlashCompletion = Completion & { action: SlashAction };

const slashSection = (rank: number): CompletionSection => ({
  name: String(rank),
  rank,
  header: () => {
    const separator = document.createElement("completion-section");
    separator.setAttribute("aria-hidden", "true");
    return separator;
  },
});
const slashSections = [slashSection(0), slashSection(1), slashSection(2)];
const slashSyntax: Partial<Record<SlashAction, string>> = {
  heading1: "#",
  heading2: "##",
  heading3: "###",
  heading4: "####",
  heading5: "#####",
  heading6: "######",
  bullet: "-",
  numbered: "1.",
  task: "- [ ]",
  quote: ">",
  codeBlock: "```",
  rule: "---",
};

export function slashSource(
  t: (key: TranslationKey) => string,
  onImage: () => void,
): CompletionSource {
  return (context: CompletionContext) => {
    const line = context.state.doc.lineAt(context.pos);
    const query = context.state.doc
      .sliceString(line.from, context.pos)
      .match(/^[ \t]*\/([\p{L}\p{N}-]*)$/u);
    if (!query || inCode(context.state, line.from, context.pos, true))
      return null;
    const slash = context.pos - query[1].length - 1;
    return {
      from: slash + 1,
      validFor: /^[\p{L}\p{N}-]*$/u,
      options: [...blockActions, "image" as const].map(
        (action, index): SlashCompletion => ({
          action,
          label: t(commandLabel(action)),
          detail: slashSyntax[action],
          section:
            slashSections[
              action === "paragraph" || action.startsWith("heading")
                ? 0
                : ["bullet", "numbered", "task"].includes(action)
                  ? 1
                  : 2
            ],
          // Keeps the toolbar order instead of the alphabetical one.
          boost: 99 - index,
          apply: (
            view: Parameters<Command>[0],
            _completion: unknown,
            _from: number,
            to: number,
          ) => {
            if (view.composing) return;
            const removed = view.state.update({
              changes: { from: slash, to, insert: "" },
            });
            if (action === "image") {
              view.dispatch(removed);
              onImage();
              return;
            }
            editorCommand(action)({
              state: removed.state,
              dispatch: (formatted) => {
                view.dispatch({
                  changes: removed.changes.compose(formatted.changes),
                  selection: formatted.state.selection,
                  annotations: isolateHistory.of("full"),
                });
              },
            });
          },
        }),
      ),
    };
  };
}

export function slashCompletions(
  t: (key: TranslationKey) => string,
  onImage: () => void,
) {
  return autocompletion({
    override: [slashSource(t, onImage)],
    icons: false,
    addToOptions: [
      {
        render: (completion) => {
          const icon = document.createElement("span");
          icon.className = "cm-completion-action-icon";
          const svg = actionIconElement((completion as SlashCompletion).action);
          if (svg) icon.append(svg);
          return icon;
        },
        position: 20,
      },
    ],
  });
}
