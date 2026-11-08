import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  BlockType,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DiffLineSelection } from "../../domain/diffLineComment";
import { IconButton } from "../ui/IconButton";

export type CommentHandler = (
  version: DiffLineSelection["version"],
  view: EditorView,
) => void;

export function selectedLines(state: EditorState) {
  const range = state.selection.main;
  const doc = state.doc;
  const first = doc.lineAt(range.from);
  let last = doc.lineAt(range.to);
  // A drag ending at the start of the next line does not include that line.
  if (last.number > first.number && range.to === last.from)
    last = doc.line(last.number - 1);
  return {
    fromLine: first.number,
    toLine: last.number,
    text: doc.sliceString(first.from, last.to),
  };
}

const setHoveredLine = StateEffect.define<number | null>();

const hoveredLine = StateField.define<number | null>({
  create: () => null,
  update(line, transaction) {
    if (transaction.docChanged) line = null;
    for (const effect of transaction.effects)
      if (effect.is(setHoveredLine)) line = effect.value;
    return line;
  },
});

/** Hover moves only redraw the gutter; they say nothing about the diff itself. */
export function isCommentHover(transaction: Transaction) {
  return (
    !transaction.docChanged &&
    !transaction.selection &&
    transaction.effects.length > 0 &&
    transaction.effects.every((effect) => effect.is(setHoveredLine))
  );
}

function textLineAt(view: EditorView, clientY: number) {
  const block = view.elementAtHeight(clientY - view.documentTop);
  return block.type === BlockType.Text
    ? view.state.doc.lineAt(block.from).number
    : null;
}

const hoverTracker = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.move);
      view.dom.addEventListener("mouseleave", this.leave);
    }
    move = (event: MouseEvent) =>
      this.hover(textLineAt(this.view, event.clientY));
    leave = () => this.hover(null);
    hover(line: number | null) {
      if (this.view.state.field(hoveredLine) !== line)
        this.view.dispatch({ effects: setHoveredLine.of(line) });
    }
    destroy() {
      this.view.dom.removeEventListener("mousemove", this.move);
      this.view.dom.removeEventListener("mouseleave", this.leave);
    }
  },
);

function renderReact(dom: HTMLElement, node: ReactNode) {
  const root = createRoot(dom);
  root.render(node);
  return root;
}

const markerRoots = new WeakMap<Node, Root>();

class AddMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }
  eq(other: GutterMarker) {
    return other instanceof AddMarker && other.label === this.label;
  }
  toDOM() {
    const dom = document.createElement("div");
    dom.className = "git-diff-comment-marker";
    const root = renderReact(
      dom,
      <span className="git-diff-comment-add" title={this.label}>
        <Plus size={14} aria-hidden="true" />
      </span>,
    );
    markerRoots.set(dom, root);
    return dom;
  }
  destroy(dom: Node) {
    const root = markerRoots.get(dom);
    markerRoots.delete(dom);
    // React refuses to unmount synchronously while it may be rendering.
    if (root) queueMicrotask(() => root.unmount());
  }
}

/**
 * The comment action, laid over the comment gutter cell of the last selected line;
 * it lives in a tooltip because CodeMirror hides its gutters from assistive technologies.
 */
function commentSendTooltip(
  version: DiffLineSelection["version"],
  label: string,
  onComment: { current: CommentHandler },
): Extension {
  const tooltip = (state: EditorState): Tooltip | null => {
    if (state.selection.main.empty) return null;
    const line = selectedLines(state).toLine;
    return {
      pos: state.doc.line(line).from,
      above: false,
      strictSide: true,
      create: (view) => {
        const dom = document.createElement("div");
        dom.className = "git-diff-comment-tooltip";
        const root = renderReact(
          dom,
          <IconButton
            size="small"
            className="git-diff-comment-send"
            aria-label={label}
            title={label}
            // A mousedown would move the editor selection before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onComment.current(version, view)}
          >
            <Plus aria-hidden="true" />
          </IconButton>,
        );
        return {
          dom,
          getCoords: (pos) => {
            // A unified deletion widget may share the line block: use its text row.
            const block = view.lineBlockAt(pos);
            const text = Array.isArray(block.type)
              ? (block.type.find((part) => part.type === BlockType.Text) ??
                block)
              : block;
            const top = view.documentTop + text.top;
            const cell = view.dom
              .querySelector(".git-diff-comment-gutter")!
              .getBoundingClientRect();
            const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters")!;
            // CodeMirror hides tooltips ending before the gutters' scroll margin.
            const right = Math.max(
              cell.right,
              view.scrollDOM.getBoundingClientRect().left +
                gutters.offsetWidth * view.scaleX,
            );
            // Below a zero-height rect, the tooltip top meets the line top.
            return { left: cell.left, right, top, bottom: top };
          },
          destroy: () => queueMicrotask(() => root.unmount()),
        };
      },
    };
  };
  return StateField.define<Tooltip | null>({
    create: tooltip,
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.selection) return value;
      const next = tooltip(transaction.state);
      // Same line, same button: avoids remounting it on every drag step.
      return value && next && value.pos === next.pos && !transaction.docChanged
        ? value
        : next;
    },
    provide: (field) => showTooltip.from(field),
  });
}

/** Selects whole lines from `anchorLine` to the line under the pointer until the button is released. */
function dragLines(
  view: EditorView,
  anchorLine: number,
  headLine: number,
  onEnd: () => void,
) {
  const select = (line: number) => {
    const doc = view.state.doc;
    const from = doc.line(Math.min(anchorLine, line, doc.lines));
    const to = Math.min(Math.max(anchorLine, line), doc.lines);
    // Ending at the next line start mirrors a mouse drag over whole lines.
    const head = to < doc.lines ? doc.line(to + 1).from : doc.length;
    view.dispatch({ selection: { anchor: from.from, head } });
  };
  const move = (event: MouseEvent) => {
    // The release happened outside the window: drop the drag without commenting.
    if ((event.buttons & 1) === 0) return stop();
    const line = textLineAt(view, event.clientY);
    if (line !== null) select(line);
  };
  const stop = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", end);
    window.removeEventListener("blur", stop);
  };
  const end = () => {
    stop();
    onEnd();
  };
  view.focus();
  select(headLine);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  window.addEventListener("blur", stop);
}

/** A gutter offering "+" on the hovered line and the comment action beside the selected lines. */
export function diffLineCommentGutter(
  version: DiffLineSelection["version"],
  label: string,
  onComment: { current: CommentHandler },
): Extension {
  const add = new AddMarker(label);
  const buildMarkers = (state: EditorState) => {
    const { doc, selection } = state;
    const selected = selection.main.empty ? null : selectedLines(state).toLine;
    const hovered = state.field(hoveredLine);
    // The selected line's cell carries the send tooltip instead.
    return hovered !== null && hovered !== selected && hovered <= doc.lines
      ? RangeSet.of(add.range(doc.line(hovered).from))
      : RangeSet.empty;
  };
  const markers = StateField.define<RangeSet<GutterMarker>>({
    create: buildMarkers,
    update: (value, transaction) =>
      transaction.docChanged ||
      transaction.selection ||
      transaction.startState.field(hoveredLine) !==
        transaction.state.field(hoveredLine)
        ? buildMarkers(transaction.state)
        : value,
  });
  return [
    hoveredLine,
    markers,
    hoverTracker,
    commentSendTooltip(version, label, onComment),
    gutter({
      class: "git-diff-comment-gutter",
      markers: (view) => view.state.field(markers),
      domEventHandlers: {
        mousedown(view, _line, domEvent) {
          const event = domEvent as MouseEvent;
          if (event.button !== 0) return false;
          // The hover may be stale after a wheel scroll without pointer motion.
          const pressed = textLineAt(view, event.clientY);
          if (pressed === null) return false;
          if (view.state.field(hoveredLine) !== pressed)
            view.dispatch({ effects: setHoveredLine.of(pressed) });
          const { state } = view;
          let anchor = pressed;
          if (event.shiftKey && !state.selection.main.empty) {
            const { fromLine, toLine } = selectedLines(state);
            anchor = pressed >= fromLine ? fromLine : toLine;
          }
          dragLines(view, anchor, pressed, () =>
            onComment.current(version, view),
          );
          return true;
        },
      },
    }),
  ];
}
