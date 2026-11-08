import { type EditorState, type Text } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { decodeString } from "micromark-util-decode-string";
import { Plus } from "lucide-react";
import { createElement, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IconButton } from "../ui/IconButton";
import { isImeComposing } from "../../domain/keyboard";
import { children, type Node } from "./syntaxNodes";
import { markdownDestination, safeLinkUrl } from "./urls";

type Cell = {
  value: string;
  from: number;
  to: number;
  contentFrom: number;
  node?: Node;
  prefix?: string;
  suffix?: string;
};
type Insert = { from: number; insert: string };
export type PreviewTable = {
  rows: Cell[][];
  align: ("left" | "right" | "center" | null)[];
  newRow: Insert;
  newColumn: Insert[];
};

export function previewTable(state: EditorState, node: Node): PreviewTable {
  const parts = children(node);
  const separator = parts.find((part) => part.name === "TableDelimiter")!;
  const align: PreviewTable["align"] = state.doc
    .sliceString(separator.from, separator.to)
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((part) => {
      const value = part.trim();
      return value.startsWith(":")
        ? value.endsWith(":")
          ? "center"
          : "left"
        : value.endsWith(":")
          ? "right"
          : null;
    });
  const newColumn: Insert[] = [];
  const separatorSource = state.doc
    .sliceString(separator.from, separator.to)
    .trimEnd();
  const separatorEnd = separator.from + separatorSource.length;
  const rows = parts
    .filter((part) => part.name === "TableHeader" || part.name === "TableRow")
    .map((row, index) => {
      const parts = children(row);
      const delimiters = parts.filter((part) => part.name === "TableDelimiter");
      const cells: Cell[] = [];
      const append = (from: number, to: number) => {
        const source = state.doc.sliceString(from, to);
        const value = source.trim();
        cells.push({
          value,
          from,
          to,
          contentFrom:
            from +
            (value
              ? source.length - source.trimStart().length
              : Math.min(1, source.length)),
          node: parts.find(
            (part) =>
              part.name === "TableCell" && part.from >= from && part.to <= to,
          ),
          prefix: from === row.from ? "| " : undefined,
          suffix: to === row.to ? " |" : undefined,
        });
      };
      // GFM only treats spaces and tabs as cell padding, unlike String#trim.
      const blank = (from: number, to: number) =>
        /^[ \t]*$/u.test(state.doc.sliceString(from, to));
      let start = row.from;
      delimiters.forEach((delimiter, index) => {
        if (index !== 0 || !blank(start, delimiter.from))
          append(start, delimiter.from);
        start = delimiter.to;
      });
      if (!blank(start, row.to) || !delimiters.length) append(start, row.to);
      const count = cells.length;
      if (count >= align.length) {
        // An empty last cell needs a closing pipe, or GFM drops it.
        const last = cells[align.length - 1];
        newColumn.push(
          last.to < row.to
            ? { from: last.to + 1, insert: "  |" }
            : { from: row.to, insert: " |  |" },
        );
      }
      if (index === 0)
        newColumn.push({
          from: separatorEnd,
          insert: separatorSource.endsWith("|") ? " --- |" : " | ---",
        });
      const trailing = delimiters.length > 0 && blank(start, row.to);
      while (cells.length < align.length) {
        const prefix =
          (trailing ? " " : " | ") + " | ".repeat(cells.length - count);
        cells.push({
          value: "",
          from: row.to,
          to: row.to,
          contentFrom: row.to,
          prefix,
          suffix: trailing ? " |" : "",
        });
      }
      return cells;
    });
  return {
    rows,
    align,
    newRow: {
      from: node.to,
      insert: `${state.lineBreak}|${"  |".repeat(align.length)}`,
    },
    newColumn,
  };
}

const inlineTags: Record<string, [string, string]> = {
  StrongEmphasis: ["strong", "cm-md-strong"],
  Emphasis: ["em", "cm-md-emphasis"],
  Strikethrough: ["s", "cm-md-strike"],
  InlineCode: ["code", "cm-md-inline-code"],
};

// Render the editor's existing syntax tree, never interpreting note text as HTML.
function renderInline(
  state: EditorState,
  node: Node,
  openLink: (url: string) => void,
): globalThis.Node {
  const source = state.sliceDoc(node.from, node.to);
  const parts = children(node);
  if (node.name === "InlineCode") {
    const code = document.createElement("code");
    code.className = "cm-md-inline-code";
    const text = state
      .sliceDoc(parts[0].to, parts[parts.length - 1].from)
      .replace(/\\\|/gu, "|");
    code.textContent =
      /^ .* $/u.test(text) && /[^ ]/u.test(text) ? text.slice(1, -1) : text;
    return code;
  }
  const link = node.name === "Link" || node.name === "Autolink";
  const url = link
    ? parts.find((part) => part.name === "URL")
    : node.name === "URL"
      ? node
      : undefined;
  const closing = link
    ? parts.find(
        (part) =>
          part.name === "LinkMark" &&
          state.sliceDoc(part.from, part.to) === "]",
      )
    : undefined;
  if (link && !url) return document.createTextNode(source);
  if (node.name === "Image" || node.name === "HTMLTag")
    return document.createTextNode(source);
  const tag = inlineTags[node.name];
  const element = document.createElement(url ? "a" : (tag?.[0] ?? "span"));
  if (tag) element.className = tag[1];
  if (url) {
    element.className = "cm-md-link";
    const href = safeLinkUrl(
      markdownDestination(state.sliceDoc(url.from, url.to)),
    );
    if (href) element.setAttribute("href", href);
    element.onclick = (event) => {
      event.preventDefault();
      if (href) openLink(href);
    };
    if (!closing) {
      element.textContent = decodeString(state.sliceDoc(url.from, url.to));
      return element;
    }
  }
  let cursor = closing ? node.from + 1 : node.from;
  const end = closing?.from ?? node.to;
  for (const part of parts) {
    if (part.from < cursor || part.from >= end) continue;
    element.append(
      document.createTextNode(decodeString(state.sliceDoc(cursor, part.from))),
    );
    if (!["EmphasisMark", "StrikethroughMark"].includes(part.name))
      element.append(renderInline(state, part, openLink));
    cursor = part.to;
  }
  element.append(
    document.createTextNode(decodeString(state.sliceDoc(cursor, end))),
  );
  return element;
}

// Preserve existing escapes; only protect new structural pipes and odd trailing backslashes.
function protect(value: string) {
  let source = "",
    slashes = 0;
  const offsets = [0];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "|" && slashes % 2 === 0) source += "\\";
    source += char;
    slashes = char === "\\" ? slashes + 1 : 0;
    offsets.push(source.length);
  }
  if (slashes % 2) {
    source += "\\";
    offsets[value.length] = source.length;
  }
  return { source, offsets };
}

type DOMState = {
  widget: TableWidget;
  view: EditorView;
  doc: Text;
  editing?: HTMLInputElement;
};
const domStates = new WeakMap<HTMLElement, DOMState>();
const focusedCells = new WeakMap<
  EditorView,
  { dom: HTMLElement; input: HTMLInputElement; doc: Text; cell: Cell }
>();

export function forgetTableCell(view: EditorView) {
  focusedCells.delete(view);
}

// Return a staged edit so synchronous formatting can share its single undo step.
export function prepareTableCell(view: EditorView) {
  const target = focusedCells.get(view);
  focusedCells.delete(view);
  if (
    !target ||
    target.doc !== view.state.doc ||
    !target.dom.isConnected ||
    view.state.readOnly
  )
    return;
  const { cell } = target;
  if (
    cell.from !== cell.to ||
    !cell.prefix ||
    view.state.selection.main.from !== cell.contentFrom ||
    !view.state.selection.main.empty
  )
    return;
  return view.state.update({
    changes: { from: cell.from, insert: cell.prefix + (cell.suffix ?? " ") },
    selection: { anchor: cell.from + cell.prefix.length },
  });
}

export type TableLabels = { cell: string; addRow: string; addColumn: string };
const actionRoots = new WeakMap<HTMLElement, { root: Root; key?: string }>();

function renderActions(dom: HTMLElement, labels: TableLabels, hidden: boolean) {
  const actions = actionRoots.get(dom);
  const key = hidden ? "" : `${labels.addRow}\n${labels.addColumn}`;
  if (!actions || actions.key === key) return;
  actions.key = key;
  actions.root.render(
    hidden
      ? null
      : (["newRow", "newColumn"] as const).map((target) => {
          const label = target === "newRow" ? labels.addRow : labels.addColumn;
          return createElement(IconButton, {
            key: target,
            size: "small",
            className: `cm-md-table-add cm-md-table-${target === "newRow" ? "add-row" : "add-column"}`,
            "aria-label": label,
            title: label,
            onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
            onClick: () => {
              const context = domStates.get(dom);
              context?.widget.insert(context.view, target);
            },
            children: createElement(Plus, { "aria-hidden": true }),
          });
        }),
  );
}

export class TableWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly source: string,
    readonly table: PreviewTable,
    readonly labels: TableLabels,
    readonly openLink: (url: string) => void = () => {},
  ) {
    super();
  }
  // Always refresh callbacks, including when only readOnly or the selection changes.
  eq() {
    return false;
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-widget cm-md-table";
    const table = document.createElement("table");
    const head = document.createElement("thead"),
      body = document.createElement("tbody");
    this.table.rows.forEach((_cells, index) => {
      const row = document.createElement("tr");
      this.table.align.forEach(() => {
        const cell = document.createElement(index === 0 ? "th" : "td");
        if (index === 0) cell.setAttribute("scope", "col");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "cm-md-table-cell";
        const preview = document.createElement("span");
        preview.className = "cm-md-table-cell-preview";
        cell.append(input, preview);
        row.append(cell);
      });
      (index === 0 ? head : body).append(row);
    });
    table.append(head, body);
    const actions = document.createElement("div");
    actions.className = "cm-md-table-actions";
    wrapper.append(table, actions);
    actionRoots.set(wrapper, { root: createRoot(actions) });
    this.updateDOM(wrapper, view);
    return wrapper;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const inputs = Array.from(
      dom.querySelectorAll<HTMLInputElement>("input.cm-md-table-cell"),
    );
    const columns = this.table.align.length;
    if (
      inputs.length !== this.table.rows.length * columns ||
      dom.querySelectorAll("tr").length !== this.table.rows.length
    )
      return false;
    const previous = domStates.get(dom);
    const externalChange = !previous || previous.doc !== view.state.doc;
    const context: DOMState = {
      widget: this,
      view,
      doc: view.state.doc,
      editing: previous?.editing,
    };
    domStates.set(dom, context);
    renderActions(dom, this.labels, view.state.readOnly);
    const focused = focusedCells.get(view);
    if (focused?.dom === dom && focused.doc !== view.state.doc)
      focusedCells.delete(view);
    const current = () =>
      domStates.get(dom)?.widget === this &&
      view.state.doc.sliceString(this.from, this.from + this.source.length) ===
        this.source;
    inputs.forEach((input, index) => {
      const row = Math.floor(index / columns),
        column = index % columns;
      const cell = this.table.rows[row][column];
      if (focusedCells.get(view)?.input === input)
        focusedCells.set(view, { dom, input, doc: view.state.doc, cell });
      input.readOnly = view.state.readOnly;
      input.setAttribute(
        "aria-label",
        `${this.labels.cell} ${row + 1}, ${column + 1}`,
      );
      input.parentElement!.style.textAlign = this.table.align[column] ?? "";
      if (externalChange) {
        input.nextElementSibling!.replaceChildren(
          cell.node
            ? renderInline(view.state, cell.node, this.openLink)
            : document.createTextNode(cell.value),
        );
      }
      if (
        externalChange &&
        context.editing !== input &&
        input.value !== cell.value
      ) {
        const start = input.selectionStart,
          end = input.selectionEnd,
          direction = input.selectionDirection;
        input.value = cell.value;
        if (document.activeElement === input)
          input.setSelectionRange(start, end, direction ?? undefined);
      }
      const selection = (
        contentFrom = cell.contentFrom,
        offsets?: number[],
      ) => {
        const start = input.selectionStart ?? 0,
          end = input.selectionEnd ?? start;
        const map = (offset: number) =>
          Math.min(
            view.state.doc.length,
            contentFrom + (offsets?.[offset] ?? offset),
          );
        return input.selectionDirection === "backward"
          ? { anchor: map(end), head: map(start) }
          : { anchor: map(start), head: map(end) };
      };
      const syncSelection = (isolate = false) => {
        if (!current()) return;
        const verbatim = input.value === cell.value;
        const offsets = verbatim ? undefined : protect(input.value).offsets;
        const range = selection(
          verbatim ? cell.contentFrom : cell.from + 1,
          offsets,
        );
        if (
          isolate ||
          range.anchor !== view.state.selection.main.anchor ||
          range.head !== view.state.selection.main.head
        ) {
          view.dispatch({
            selection: range,
            ...(isolate ? { annotations: isolateHistory.of("full") } : {}),
          });
        }
      };
      input.onfocus = () => {
        syncSelection(true);
        focusedCells.set(view, { dom, input, doc: view.state.doc, cell });
      };
      input.onblur = (event) => {
        const next = event.relatedTarget;
        const toolbar = view.dom
          .closest(".markdown-editor")
          ?.querySelector(".markdown-toolbar-row");
        if (!(next instanceof Node) || !toolbar?.contains(next))
          focusedCells.delete(view);
      };
      input.onselect = () => {
        if (document.activeElement === input) syncSelection();
      };
      input.onclick = () => syncSelection();
      input.onkeyup = () => syncSelection();
      input.oninput = () => {
        if (!current()) return;
        if (view.state.readOnly) {
          input.value = cell.value;
          return;
        }
        const { source, offsets } = protect(input.value);
        const prefix = cell.prefix ?? " ",
          suffix = cell.suffix ?? " ";
        const contentFrom = cell.from + prefix.length;
        const start = input.selectionStart ?? 0,
          end = input.selectionEnd ?? start;
        const anchor =
          contentFrom +
          offsets[input.selectionDirection === "backward" ? end : start];
        const head =
          contentFrom +
          offsets[input.selectionDirection === "backward" ? start : end];
        context.editing = input;
        try {
          view.dispatch({
            changes: {
              from: cell.from,
              to: cell.to,
              insert: prefix + source + suffix,
            },
            selection: { anchor, head },
            userEvent: "input.type",
          });
        } finally {
          const latest = domStates.get(dom);
          if (latest) latest.editing = undefined;
        }
      };
      input.onkeydown = (event) => {
        if (isImeComposing(event)) return;
        if (!current()) return;
        const key = event.key.toLowerCase();
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (key === "z" || key === "y")
        ) {
          event.preventDefault();
          if (!view.state.readOnly)
            (key === "y" || event.shiftKey ? redo : undo)(view);
        } else if (event.key === "Enter") {
          event.preventDefault();
          inputs[index + 1]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          const end = this.from + this.source.length;
          const anchor =
            end < view.state.doc.length
              ? end + 1
              : this.from > 0
                ? this.from - 1
                : end;
          view.dispatch({ selection: { anchor }, scrollIntoView: true });
          view.focus();
        }
      };
    });
    return true;
  }
  insert(view: EditorView, target: "newRow" | "newColumn") {
    if (
      view.state.readOnly ||
      view.state.doc.sliceString(this.from, this.from + this.source.length) !==
        this.source
    )
      return;
    const { rows, align } = this.table;
    view.dispatch({ changes: this.table[target], userEvent: "input" });
    const index =
      target === "newRow" ? rows.length * align.length : align.length;
    for (const dom of view.contentDOM.querySelectorAll<HTMLElement>(
      ".cm-md-table",
    ))
      if (domStates.get(dom)?.widget.from === this.from)
        dom
          .querySelectorAll<HTMLInputElement>("input.cm-md-table-cell")
          [index]?.focus();
  }
  destroy(dom: HTMLElement) {
    const context = domStates.get(dom);
    if (context && focusedCells.get(context.view)?.dom === dom)
      focusedCells.delete(context.view);
    domStates.delete(dom);
    const actions = actionRoots.get(dom);
    actionRoots.delete(dom);
    // React refuses a synchronous unmount while it is rendering.
    if (actions) queueMicrotask(() => actions.root.unmount());
  }
}
