import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Line,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { openUrl } from "@tauri-apps/plugin-opener";
import { decodeString } from "micromark-util-decode-string";
import {
  BulletWidget,
  ImageWidget,
  TaskWidget,
  type ImageResolver,
} from "./previewWidgets";
import { previewTable, TableWidget } from "./tablePreview";
import { children, type Node } from "./syntaxNodes";
import { markdownDestination, safeLinkUrl } from "./urls";
import { parseImageWidth } from "../../domain/imageSize";
import { CodeCopyWidget, type CodeCopyLabels } from "./CodeCopyWidget";
import {
  CodeLanguageWidget,
  type CodeLanguageLabels,
} from "./CodeLanguageWidget";

type PreviewLabels = CodeCopyLabels &
  CodeLanguageLabels & {
    selectImage: string;
    resizeImage: string;
    tableCell: string;
    tableAddRow: string;
    tableAddColumn: string;
    toggleTask: string;
    imageError: string;
    linkError: string;
    resolveImage?: ImageResolver;
    openImage: (src: string, alt: string) => void;
  };
const inlineStyles: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-emphasis",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-inline-code",
};
const hiddenPrefix = Decoration.replace({});
const isPrefix = (decoration: Decoration) =>
  decoration === hiddenPrefix ||
  decoration.spec.widget instanceof BulletWidget ||
  decoration.spec.widget instanceof TaskWidget;
// Chains prefix ranges from the line start, across spaces between them (`> # `, `> > `, `> - `).
function prefixEnd(value: DecorationSet, line: Line) {
  let end: number,
    next = line.from;
  do {
    end = next;
    let gap = end;
    while (gap < line.to && " \t".includes(line.text[gap - line.from])) gap++;
    value.between(end, gap, (rangeFrom, rangeTo, decoration) => {
      if (rangeFrom < end || rangeTo === rangeFrom || !isPrefix(decoration))
        return;
      next = rangeTo;
      return false;
    });
  } while (next !== end);
  return end;
}
// Every number of a list gets the widest one's room, so their texts align.
// shortcut: walks the whole list for each of its items, quadratic past a few thousand items; cache widths per list in previewRanges if such lists appear.
function widestMarker(list: Node) {
  let width = 0;
  for (let item = list.firstChild; item; item = item.nextSibling) {
    const mark = item.firstChild;
    if (mark?.name === "ListMark") width = Math.max(width, mark.to - mark.from);
  }
  return width;
}
const composingEffect = StateEffect.define<boolean>();
const composing = StateField.define({
  create: () => false,
  update: (value, tr) => {
    for (const effect of tr.effects)
      if (effect.is(composingEffect)) value = effect.value;
    return value;
  },
});

export function buildPreview(state: EditorState, labels: PreviewLabels) {
  return Decoration.set(previewRanges(state, labels), true);
}

// `include` limits the walk to some top-level blocks; nested nodes never decorate outside them.
function previewRanges(
  state: EditorState,
  labels: PreviewLabels,
  include?: (block: Node) => boolean,
) {
  const ranges: Range<Decoration>[] = [];
  const active = (from: number, to: number) =>
    state.selection.ranges.some(
      (range) => range.from <= to && range.to >= from,
    );
  // Syntax-only lines (`#`, `>`, `---`) stay visible while edited, or typed markers would vanish.
  const editingMarkup = (from: number) => {
    const line = state.doc.lineAt(from);
    return (
      /^[\s#>=*+_-]*$/u.test(line.text) &&
      state.selection.ranges.some(
        (range) => range.from <= line.to && range.to >= line.from,
      )
    );
  };
  const hide = (from: number, to: number) => {
    if (to > from) ranges.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (to > from)
      ranges.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lines = (from: number, to: number, className: string) => {
    for (
      let number = state.doc.lineAt(from).number;
      number <= state.doc.lineAt(to).number;
      number++
    ) {
      ranges.push(
        Decoration.line({ class: className }).range(
          state.doc.line(number).from,
        ),
      );
    }
  };
  const isComposing = state.field(composing, false) ?? false;
  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      if (include && node.parent && !node.parent.parent && !include(node))
        return false;
      const { name, from, to } = node;
      // Preview spacing comes from blank lines: a block right under another one gets its own.
      if (
        node.parent?.name === "Document" &&
        /^(Paragraph|BulletList|OrderedList|(ATX|Setext)Heading[1-6])$/u.test(
          name,
        ) &&
        node.prevSibling &&
        state.doc.lineAt(node.prevSibling.to).number + 1 ===
          state.doc.lineAt(from).number
      )
        lines(from, from, "cm-md-block-gap");
      if (name === "FencedCode" || name === "CodeBlock") {
        const parts = children(node);
        let firstVisible = from,
          lastVisible = to;
        if (name === "FencedCode" && !isComposing) {
          const opening = state.doc.lineAt(from);
          const closing = parts.filter((part) => part.name === "CodeMark")[1];
          const contentStart = opening.to + 1;
          const contentEnd = closing
            ? state.doc.lineAt(closing.from).from - 1
            : to;
          if (contentStart <= contentEnd) {
            // shortcut: a fence opening on a list marker line (`3. ```js`) hides the marker too; upgrade if notes use it.
            // Block replacements keep Home/End on code, not on the hidden delimiters.
            ranges.push(
              Decoration.replace({
                block: true,
                inclusiveStart: true,
                inclusiveEnd: false,
              }).range(opening.from, contentStart),
            );
            if (closing)
              ranges.push(
                Decoration.replace({
                  block: true,
                  inclusiveStart: false,
                  inclusiveEnd: true,
                }).range(contentEnd, to),
              );
            firstVisible = contentStart;
            lastVisible = contentEnd;
          } else {
            hide(from, to);
            lastVisible = from;
          }
        }
        lines(firstVisible, lastVisible, "cm-md-code-block");
        lines(firstVisible, firstVisible, "cm-md-code-start");
        lines(lastVisible, lastVisible, "cm-md-code-end");
        // CodeText omits Markdown fences and list/quote prefixes, but keeps code whitespace.
        const text = parts
          .filter((part) => part.name === "CodeText")
          .map((part) => state.sliceDoc(part.from, part.to))
          .join("");
        ranges.push(
          Decoration.widget({
            widget: new CodeCopyWidget(text, labels),
            side: -1,
          }).range(firstVisible),
        );
        if (name === "FencedCode") {
          const info = parts.find((part) => part.name === "CodeInfo");
          const languageFrom = info?.from ?? parts[0].to;
          const language = info
            ? state.doc.sliceString(info.from, info.to).match(/^\S*/u)![0]
            : "";
          ranges.push(
            Decoration.widget({
              widget: new CodeLanguageWidget(
                languageFrom,
                languageFrom + language.length,
                language,
                labels,
                state.readOnly,
                state.doc,
              ),
              side: -2,
            }).range(firstVisible),
          );
        }
        return false;
      }
      if (
        name === "HTMLBlock" ||
        name === "HTMLTag" ||
        name === "LinkReference"
      )
        return false;
      if (name === "Table" && node.parent?.name === "Document") {
        ranges.push(
          Decoration.replace({
            block: true,
            widget: new TableWidget(
              from,
              state.doc.sliceString(from, to),
              previewTable(state, node),
              {
                cell: labels.tableCell,
                addRow: labels.tableAddRow,
                addColumn: labels.tableAddColumn,
              },
              (url) => {
                void openUrl(url).catch(() => labels.onError(labels.linkError));
              },
            ),
          }).range(state.doc.lineAt(from).from, to),
        );
        return false;
      }
      if (name === "Image") {
        const parts = children(node),
          url = parts.find((part) => part.name === "URL");
        const closing = parts.find(
          (part) =>
            part.name === "LinkMark" &&
            state.doc.sliceString(part.from, part.to) === "]",
        );
        const paragraph = node.parent;
        let width = paragraph
          ? parseImageWidth(state.doc.sliceString(to, paragraph.to))
          : undefined;
        if (
          url &&
          closing &&
          paragraph?.name === "Paragraph" &&
          paragraph.parent?.name === "Document" &&
          paragraph.from === from &&
          (paragraph.to === to || width !== undefined)
        ) {
          const start = state.doc.lineAt(from).from;
          let end = paragraph.to;
          // Linear moves the width comment into its own block: the image owns it, and a resize rewrites them all.
          for (
            let next = paragraph.nextSibling;
            paragraph.to === to && next?.name === "CommentBlock";
            next = next.nextSibling
          ) {
            const separated = parseImageWidth(
              state.doc.sliceString(next.from, next.to).trim(),
            );
            if (separated === undefined) break;
            width ??= separated;
            end = next.to;
          }
          const selected = state.selection.ranges.some(
            (range) => range.from <= from && range.to >= end,
          );
          const { main } = state.selection;
          const gap =
            state.selection.ranges.length > 1 || !main.empty
              ? null
              : main.head === start
                ? "before"
                : main.head === end
                  ? "after"
                  : null;
          ranges.push(
            Decoration.replace({
              block: true,
              widget: new ImageWidget(
                from,
                end,
                selected,
                gap,
                markdownDestination(state.doc.sliceString(url.from, url.to)),
                decodeString(state.doc.sliceString(from + 2, closing.from)),
                labels.selectImage,
                labels.imageError,
                labels.onError,
                labels.openImage,
                {
                  imageTo: to,
                  width,
                  label: labels.resizeImage,
                  readOnly: state.readOnly,
                },
                labels.resolveImage,
              ),
            }).range(start, end),
          );
        }
        return false;
      }
      if (/^(ATX|Setext)Heading[1-6]$/u.test(name))
        lines(from, to, `cm-md-heading cm-md-h${name.slice(-1)}`);
      if (name === "Blockquote") lines(from, to, "cm-md-quote");
      if (name === "ListItem") lines(from, from, "cm-md-list");
      if (name === "HorizontalRule") {
        const preview = !editingMarkup(from) && !isComposing;
        lines(
          from,
          to,
          preview ? "cm-md-rule cm-md-rule-preview" : "cm-md-rule",
        );
        if (preview) hide(from, to);
        return false;
      }
      if (inlineStyles[name]) mark(from, to, inlineStyles[name]);
      if (name === "Link") {
        const parts = children(node),
          url = parts.find((part) => part.name === "URL");
        const close = parts.find(
          (part) =>
            part.name === "LinkMark" &&
            state.doc.sliceString(part.from, part.to) === "]",
        );
        if (url && close) {
          mark(from, to, "cm-md-link");
          if (!active(from, to) && !isComposing) {
            hide(from, from + 1);
            hide(close.from, to);
          }
        }
        // The URL is still discoverable in the syntax tree for Mod-click.
        return false;
      }
      if (name === "URL") mark(from, to, "cm-md-link");
      if (isComposing) return;
      if (name === "TaskMarker") {
        // Bullet tasks get their checkbox with the list marker below.
        if (
          node.parent?.prevSibling?.name === "ListMark" &&
          node.parent.parent?.parent?.name === "BulletList"
        )
          return;
        ranges.push(
          Decoration.replace({
            widget: new TaskWidget(
              from,
              /[xX]/u.test(state.doc.sliceString(from, to)),
              labels.toggleTask,
              state.readOnly,
            ),
          }).range(from, to),
        );
        return;
      }
      // A bare `-` is already an empty item, but text typed right after it would not be one.
      if (
        name === "ListMark" &&
        /^(Bullet|Ordered)List$/u.test(node.parent?.parent?.name ?? "") &&
        /[ \t]/u.test(state.doc.sliceString(to, to + 1))
      ) {
        const list = node.parent!.parent!;
        const ordered = list.name === "OrderedList";
        const line = state.doc.lineAt(from);
        const indent = /[ \t]*$/u.exec(
          state.doc.sliceString(line.from, from),
        )![0].length;
        // Parent items' text offsets, so nested items start under their parent's text.
        let tenthsOfEm = 0,
          chars = 0;
        for (let item = list.parent; item; item = item.parent) {
          if (item.name !== "ListItem") continue;
          if (item.parent!.name === "OrderedList") {
            chars += widestMarker(item.parent!);
            tenthsOfEm += 6;
          } else
            tenthsOfEm +=
              item.firstChild?.nextSibling?.name === "Task" ? 20 : 15;
        }
        // shortcut: ordered tasks keep their checkbox after the number, so wrapped lines hang under the checkbox; merge them like bullet tasks if seen.
        const first =
          !ordered && node.nextSibling?.name === "Task"
            ? node.nextSibling.firstChild
            : null;
        const task = first?.name === "TaskMarker" ? first : null;
        const end = task ? task.to : to;
        // The widget replaces the indentation so wrapped lines can hang under the text.
        // shortcut: markers sharing a line (`1. 1. x`, `- - x`) merge their line styles, so each widget takes the innermost hang; give each its own width if seen.
        ranges.push(
          Decoration.line({
            class: task
              ? "cm-md-bullet-line cm-md-task-line"
              : ordered
                ? "cm-md-bullet-line cm-md-ordered-line"
                : "cm-md-bullet-line",
            attributes: {
              style: `--md-list-indent: calc(${tenthsOfEm / 10}em + ${chars}ch)${ordered ? `; --md-list-marker: ${widestMarker(list)}` : ""}`,
            },
          }).range(line.from),
          // shortcut: a tab after the mark (`-\titem`) stays outside the widget, so inserts at the prefix end precede it; include tabs if seen.
          Decoration.replace({
            widget: task
              ? new TaskWidget(
                  task.from,
                  /[xX]/u.test(state.doc.sliceString(task.from, task.to)),
                  labels.toggleTask,
                  state.readOnly,
                )
              : new BulletWidget(
                  ordered ? state.doc.sliceString(from, to) : "•",
                ),
          }).range(
            from - indent,
            state.doc.sliceString(end, end + 1) === " " ? end + 1 : end,
          ),
        );
      } else if (
        ["EmphasisMark", "StrikethroughMark", "CodeMark"].includes(name)
      ) {
        if (!active(node.parent!.from, node.parent!.to)) hide(from, to);
      } else if (
        (name === "QuoteMark" || name === "HeaderMark") &&
        !editingMarkup(from)
      ) {
        // shortcut: closing ATX hashes (`## Title ##`) stay hidden, so text typed after them lands outside the heading; handle if notes use them.
        const end =
          name === "HeaderMark" &&
          node.parent?.name.startsWith("ATX") &&
          state.doc.sliceString(to, to + 1) === " "
            ? to + 1
            : to;
        ranges.push(hiddenPrefix.range(from, end));
      }
    },
  });
  return ranges;
}

type BlockSpan = { start: number; from: number; to: number };

// Selection-only updates change `active()` solely in blocks touching the old or new selection lines;
// Markdown blocks are line-based, so sibling blocks never share a line.
function refreshSelectionPreview(
  value: DecorationSet,
  previous: EditorSelection,
  state: EditorState,
  labels: PreviewLabels,
) {
  const { doc } = state;
  const spans = [...previous.ranges, ...state.selection.ranges].map(
    (range) => ({
      from: doc.lineAt(range.from).from,
      to: doc.lineAt(range.to).to,
    }),
  );
  const blocks: BlockSpan[] = [];
  for (
    let block = syntaxTree(state).topNode.firstChild;
    block;
    block = block.nextSibling
  ) {
    const to = doc.lineAt(block.to).to;
    // A width comment belongs to the image before it, so both refresh together.
    if (block.name === "CommentBlock" && blocks.length)
      blocks[blocks.length - 1].to = to;
    else
      blocks.push({ start: block.from, from: doc.lineAt(block.from).from, to });
  }
  const rebuilt = blocks.filter((block) =>
    spans.some((span) => span.from <= block.to && span.to >= block.from),
  );
  if (!rebuilt.length) return value;
  const starts = new Set(rebuilt.map((block) => block.start));
  const inRebuilt = (position: number) => {
    let low = 0,
      high = rebuilt.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (position < rebuilt[middle].from) high = middle - 1;
      else if (position > rebuilt[middle].to) low = middle + 1;
      else return true;
    }
    return false;
  };
  return value.update({
    filter: (from) => !inRebuilt(from),
    filterFrom: rebuilt[0].from,
    filterTo: rebuilt[rebuilt.length - 1].to,
    add: previewRanges(state, labels, (block) => starts.has(block.from)),
    sort: true,
  });
}

export function livePreview(labels: PreviewLabels): Extension {
  const atomicRanges = new WeakMap<DecorationSet, DecorationSet>();
  const decorations = StateField.define({
    create: (state) => buildPreview(state, labels),
    update: (value, tr) => {
      if (
        tr.docChanged ||
        tr.startState.readOnly !== tr.state.readOnly ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
        tr.effects.some((effect) => effect.is(composingEffect))
      )
        return buildPreview(tr.state, labels);
      return tr.selection
        ? refreshSelectionPreview(
            value,
            tr.startState.selection,
            tr.state,
            labels,
          )
        : value;
    },
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => {
        const value = view.state.field(field);
        let atomic = atomicRanges.get(value);
        if (!atomic) {
          atomic = value.update({
            filter: (_from, _to, decoration) =>
              isPrefix(decoration) ||
              decoration.spec.widget instanceof TableWidget ||
              decoration.spec.widget instanceof ImageWidget,
          });
          atomicRanges.set(value, atomic);
        }
        return atomic;
      }),
    ],
  });
  // The webview cannot put its caret beside a block image, so input would land on another line:
  // a new paragraph opens on the cursor's side first.
  // shortcut: an IME composition started at an image gap still lands on the neighbouring line; open the gap on compositionstart if reported.
  const imageGapAt = (state: EditorState) => {
    const { head } = state.selection.main;
    const gaps: { at: number; after: boolean }[] = [];
    state.field(decorations).between(head, head, (from, to, value) => {
      const widget: unknown = value.spec.widget;
      if (!(widget instanceof ImageWidget) || !widget.gap) return;
      gaps.push(
        widget.gap === "after"
          ? { at: to, after: true }
          : { at: from, after: false },
      );
      return false;
    });
    return gaps[0];
  };
  const openImageGap = (view: EditorView) => {
    const gap = imageGapAt(view.state);
    if (!gap) return false;
    view.dispatch({
      changes: { from: gap.at, insert: view.state.lineBreak.repeat(2) },
      // Positions count each line break as one character, whatever the separator.
      selection: { anchor: gap.after ? gap.at + 2 : gap.at },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  };
  // Enter on a selected image opens its preview instead of replacing it with a line break.
  const openSelectedImage = (view: EditorView) => {
    const { ranges, main } = view.state.selection;
    if (ranges.length > 1) return false;
    let at: number | undefined;
    view.state
      .field(decorations)
      .between(main.from, main.to, (from, _to, value) => {
        const widget: unknown = value.spec.widget;
        if (
          widget instanceof ImageWidget &&
          widget.from === main.from &&
          widget.to === main.to
        ) {
          at = from;
          return false;
        }
      });
    if (at === undefined) return false;
    const image = [
      ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-image"),
    ]
      .find((wrapper) => view.posAtDOM(wrapper) === at)
      ?.querySelector("img");
    if (!image?.src) return false;
    labels.openImage(image.src, image.alt);
    return true;
  };
  return [
    composing,
    decorations,
    // Cursors landing before a hidden block prefix move past it, so commands and pastes keep the block;
    // a cursor moving backward out of the prefix stays, otherwise ArrowLeft/Home would get stuck.
    // shortcut: toolbar formatting from a cursor moved back before the prefix still inserts before it; normalize in commands if reported.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection) return tr;
      const value = tr.state.field(decorations);
      const start = tr.startState.selection.ranges;
      let changed = false;
      const ranges = tr.selection.ranges.map((range, index) => {
        if (!range.empty) return range;
        const end = prefixEnd(value, tr.state.doc.lineAt(range.head));
        const before =
          index < start.length
            ? tr.changes.mapPos(start[index].head)
            : range.head;
        if (range.head >= end || (before > range.head && before <= end))
          return range;
        changed = true;
        return EditorSelection.cursor(end);
      });
      return changed
        ? [
            tr,
            {
              selection: EditorSelection.create(ranges, tr.selection.mainIndex),
              sequential: true,
            },
          ]
        : tr;
    }),
    // A paste at an image gap opens the paragraph in the same transaction, so one undo removes both.
    // shortcut: a linewise paste (line copied without selection) still lands at the image line start; relocate it to the gap if reported.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !tr.isUserEvent("input.paste")) return tr;
      const gap = imageGapAt(tr.startState);
      if (!gap) return tr;
      const insert = tr.state.lineBreak.repeat(2);
      const end = tr.changes.mapPos(gap.at, 1);
      return [
        tr,
        gap.after
          ? {
              changes: { from: tr.changes.mapPos(gap.at, -1), insert },
              selection: { anchor: end + 2 },
              sequential: true,
            }
          : {
              changes: { from: end, insert },
              selection: { anchor: end },
              sequential: true,
            },
      ];
    }),
    // The cursor can still sit before a hidden block prefix; edits there must not break the block.
    // shortcut: an IME composition started before a hidden prefix bypasses it (prefixes drop while composing); normalize on compositionstart if reported.
    EditorView.inputHandler.of((view, from, to, text) => {
      const end = prefixEnd(
        view.state.field(decorations),
        view.state.doc.lineAt(from),
      );
      if (from !== to || from >= end) return false;
      view.dispatch({
        changes: { from: end, insert: text },
        selection: { anchor: end + text.length },
        userEvent: "input.type",
      });
      return true;
    }),
    Prec.high(
      keymap.of([
        { key: "Enter", run: openSelectedImage },
        { key: "Enter", run: openImageGap },
        {
          key: "Backspace",
          run: (view) => {
            const { selection, doc } = view.state;
            const { head, empty } = selection.main;
            const line = doc.lineAt(head);
            const end = prefixEnd(view.state.field(decorations), line);
            if (selection.ranges.length > 1 || !empty || head >= end)
              return false;
            view.dispatch({
              changes: { from: Math.max(0, line.from - 1), to: end },
              userEvent: "delete.backward",
            });
            return true;
          },
        },
      ]),
    ),
    EditorView.domEventHandlers({
      // Plugin handlers run before the builtin paste, which reads the selection afterwards;
      // re-dispatching the selection lets the filter above move cursors past hidden prefixes.
      paste: (_event, view) => {
        view.dispatch({ selection: view.state.selection });
        return false;
      },
      beforeinput: (event, view) => {
        if (
          event.inputType !== "insertText" ||
          event.data === null ||
          !openImageGap(view)
        )
          return false;
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(event.data), {
          userEvent: "input.type",
        });
        return true;
      },
      compositionstart: (_event, view) => {
        view.dispatch({ effects: composingEffect.of(true) });
      },
      compositionend: (_event, view) => {
        view.dispatch({ effects: composingEffect.of(false) });
      },
      click: (event, view) => {
        if (!event.metaKey && !event.ctrlKey) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        let node: Node | null = syntaxTree(view.state).resolveInner(pos, 1);
        let target: Node | undefined;
        for (let parent: Node | null = node; parent; parent = parent.parent) {
          if (
            [
              "InlineCode",
              "FencedCode",
              "CodeBlock",
              "HTMLBlock",
              "Image",
              "LinkReference",
            ].includes(parent.name)
          )
            return false;
        }
        while (node) {
          if (node.name === "Link") {
            target = children(node).find((part) => part.name === "URL");
            break;
          }
          if (node.name === "URL") target = node;
          node = node.parent;
        }
        if (!target) return false;
        const url = safeLinkUrl(
          markdownDestination(
            view.state.doc.sliceString(target.from, target.to),
          ),
        );
        event.preventDefault();
        if (!url) labels.onError(labels.linkError);
        else void openUrl(url).catch(() => labels.onError(labels.linkError));
        return true;
      },
    }),
  ];
}
