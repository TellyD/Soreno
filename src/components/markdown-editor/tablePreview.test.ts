// @vitest-environment jsdom
import {
  Compartment,
  EditorState,
  StateField,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { act } from "react";
import { history, redo, undo } from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markdownSupport } from "./document";
import { stubEditorGeometry } from "./testGeometry";
import { previewTable, TableWidget } from "./tablePreview";

const openLink = vi.fn();
function decorations(state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter({ node }) {
      if (node.name !== "Table") return;
      ranges.push(
        Decoration.replace({
          block: true,
          widget: new TableWidget(
            node.from,
            state.sliceDoc(node.from, node.to),
            previewTable(state, node),
            { cell: "Edit cell", addRow: "Add row", addColumn: "Add column" },
            openLink,
          ),
        }).range(node.from, node.to),
      );
      return false;
    },
  });
  return Decoration.set(ranges);
}
const tables = StateField.define({
  create: decorations,
  update: (_value, tr) => decorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});
const views: EditorView[] = [];
let restore: () => void;
beforeEach(() => {
  restore = stubEditorGeometry();
  openLink.mockClear();
});
afterEach(() => {
  views.forEach((view) => {
    view.destroy();
    view.dom.remove();
  });
  views.length = 0;
  restore();
});
const doc =
  "Before\n\n| a | b | c |\n| :- | :-: | -: |\n| x | y | z |\n\nAfter";
function editor(source = doc, readOnly = false) {
  const mode = new Compartment();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      extensions: [
        markdownSupport,
        history(),
        tables,
        mode.of(EditorState.readOnly.of(readOnly)),
      ],
    }),
  });
  views.push(view);
  return { view, mode };
}
function cells(view: EditorView) {
  return Array.from(
    view.dom.querySelectorAll<HTMLInputElement>(".cm-md-table-cell"),
  );
}
function type(input: HTMLInputElement, value: string, caret = value.length) {
  input.value = value;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText" }),
  );
}
function key(
  input: HTMLInputElement,
  key: string,
  options: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  input.dispatchEvent(event);
  return event;
}

it.each([
  ["**Total**", "strong", "Total"],
  ["__Total__", "strong", "Total"],
  ["*italic*", "em", "italic"],
  ["_italic_", "em", "italic"],
  ["~~removed~~", "s", "removed"],
  ["***both***", "em strong", "both"],
  ["` **raw** &amp; `", "code", "**raw** &amp;"],
  ["``a ` b``", "code", "a ` b"],
  ["` a\\|b \\* &amp; `", "code", "a|b \\* &amp;"],
  ["[**link**](https://example.com)", "a strong", "link"],
])(
  "renders %s in headers and body without changing editable Markdown",
  (markdown, selector, text) => {
    const source = `| ${markdown} | b |\n| - | - |\n| ${markdown} | y |`;
    const { view } = editor(source);
    for (const index of [0, 2]) {
      const input = cells(view)[index];
      expect(
        input.nextElementSibling!.querySelector(selector)?.textContent,
      ).toBe(text);
      input.focus();
      expect(input.value).toBe(markdown);
      input.blur();
      expect(input.nextElementSibling!.textContent).toBe(text);
    }
    expect(view.state.sliceDoc()).toBe(source);
  },
);

it("refreshes formatted previews after edits, undo and external changes", () => {
  const { view } = editor();
  const input = cells(view)[3];
  input.focus();
  type(input, "**Total**");
  input.blur();
  expect(input.nextElementSibling!.querySelector("strong")?.textContent).toBe(
    "Total",
  );
  undo(view);
  expect(input.nextElementSibling!.textContent).toBe("x");
  redo(view);
  expect(input.nextElementSibling!.querySelector("strong")?.textContent).toBe(
    "Total",
  );
  view.dispatch({ changes: { from: 0, insert: "Prefix\n" } });
  expect(cells(view)[3]).toBe(input);
  expect(input.nextElementSibling!.querySelector("strong")?.textContent).toBe(
    "Total",
  );
});

it("decodes text escapes, keeps HTML inert and opens only safe links", () => {
  const markdown =
    "\\*literal\\* &amp; x\\|y <img src=x onerror=alert(1)> [bad](javascript&colon;alert(1)) [good](https://example.com/?a=1&amp;b=2) <https://example.org>";
  const { view } = editor(`| a | b |\n| - | - |\n| ${markdown} | y |`, true);
  const preview = cells(view)[2].nextElementSibling!;
  expect(preview.textContent).toBe(
    "*literal* & x|y <img src=x onerror=alert(1)> bad good https://example.org",
  );
  expect(preview.querySelector("img, script, em")).toBeNull();
  const links = [...preview.querySelectorAll("a")];
  expect(links[0].hasAttribute("href")).toBe(false);
  links.forEach((link) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
  expect(openLink.mock.calls).toEqual([
    ["https://example.com/?a=1&b=2"],
    ["https://example.org/"],
  ]);
});

it("keeps native inputs, focus and selection stable through repeated targeted writes", () => {
  const { view } = editor();
  const input = cells(view)[4];
  input.focus();
  type(input, "one");
  type(input, "one two", 3);
  expect(cells(view)[4]).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(3);
  expect(input.value).toBe("one two");
  expect(view.state.sliceDoc()).toBe(
    doc.replace("| x | y | z |", "| x | one two | z |"),
  );
  expect(view.state.selection.main.anchor).toBe(
    view.state.sliceDoc().indexOf("one two") + 3,
  );
  expect(input.parentElement!.style.textAlign).toBe("center");
  input.setSelectionRange(1, 4, "backward");
  input.dispatchEvent(new Event("select"));
  expect(view.state.selection.main.anchor).toBe(
    view.state.sliceDoc().indexOf("one two") + 4,
  );
  expect(view.state.selection.main.head).toBe(
    view.state.sliceDoc().indexOf("one two") + 1,
  );
});

it("protects typed code pipes while rendering them literally and preserving undo", () => {
  const { view } = editor();
  const input = cells(view)[3];
  input.focus();
  type(input, "`a|b`");
  expect(input.value).toBe("`a|b`");
  expect(view.state.sliceDoc()).toBe(
    doc.replace("| x | y | z |", "| `a\\|b` | y | z |"),
  );
  input.blur();
  expect(input.nextElementSibling!.querySelector("code")?.textContent).toBe(
    "a|b",
  );
  expect(undo(view)).toBe(true);
  expect(view.state.sliceDoc()).toBe(doc);
  expect(input.value).toBe("x");
  expect(input.nextElementSibling!.textContent).toBe("x");
});

it("protects pipes and trailing backslashes without re-escaping existing escapes", () => {
  const { view } = editor();
  const input = cells(view)[3];
  input.focus();
  type(input, "a|b");
  expect(input.value).toBe("a|b");
  expect(view.state.sliceDoc()).toContain("| a\\|b | y | z |");
  expect(view.state.selection.main.anchor).toBe(
    view.state.sliceDoc().indexOf("a\\|b") + 4,
  );
  type(input, "a|bc");
  expect(view.state.sliceDoc()).toContain("| a\\|bc | y | z |");
  type(input, "a\\|b\\");
  expect(view.state.sliceDoc()).toContain("| a\\|b\\\\ | y | z |");
  expect(input.value).toBe("a\\|b\\");
  expect(cells(view)).toHaveLength(6);
  type(input, "a\\\\|b");
  expect(view.state.sliceDoc()).toContain("| a\\\\\\|b | y | z |");
  expect(cells(view)).toHaveLength(6);
});

it.each(["| x |", "x", "x |", "| x", "| x |   "])(
  "fills implicit cells in %s without replacing its existing cell",
  (row) => {
    const source = `| a | b | c |\n| - | - | - |\n${row}`;
    const { view } = editor(source);
    const input = cells(view)[5];
    input.focus();
    type(input, "third");
    expect(view.state.sliceDoc().startsWith(source)).toBe(true);
    expect(cells(view).map((cell) => cell.value)).toEqual([
      "a",
      "b",
      "c",
      "x",
      "",
      "third",
    ]);
    type(input, "third!");
    expect(cells(view)[5]).toBe(input);
    const second = cells(view)[4];
    second.focus();
    type(second, "second");
    expect(cells(view).map((cell) => cell.value)).toEqual([
      "a",
      "b",
      "c",
      "x",
      "second",
      "third!",
    ]);
  },
);

it.each([0, 1, 2, 3])(
  "keeps borderless columns when clearing edge cell %s",
  (index) => {
    const source = "a | b\n--- | ---\nx | y";
    const { view } = editor(source);
    const input = cells(view)[index];
    input.focus();
    expect(view.state.sliceDoc()).toBe(source);
    type(input, "");
    const expected = ["a", "b", "x", "y"];
    expected[index] = "";
    expect(cells(view).map((cell) => cell.value)).toEqual(expected);
    expect(cells(view)[index]).toBe(input);
    expect(view.state.sliceDoc().split("\n")[index < 2 ? 2 : 0]).toBe(
      index < 2 ? "x | y" : "a | b",
    );
    undo(view);
    expect(view.state.sliceDoc()).toBe(source);
  },
);

it("preserves neighboring Markdown verbatim and maps whitespace/escaped caret positions", () => {
  const source = "| **a** | b | c |\n| - | - | - |\n| x\\|y  |   old   | `z` |";
  const { view } = editor(source);
  const input = cells(view)[4];
  input.focus();
  type(input, "  a|b  ", 4);
  expect(view.state.sliceDoc()).toBe(
    source.replace("   old   ", "   a\\|b   "),
  );
  input.dispatchEvent(new Event("select"));
  expect(view.state.selection.main.anchor).toBe(
    view.state.sliceDoc().indexOf("a\\|b") + 3,
  );
  type(input, "");
  input.dispatchEvent(new Event("select"));
  const row = view.state.sliceDoc().indexOf("| x\\|y");
  expect(view.state.selection.main.anchor).toBe(row + "| x\\|y  | ".length);
});

it("routes keyboard undo/redo to parent history and isolates cells", () => {
  const { view } = editor();
  const first = cells(view)[3],
    second = cells(view)[4];
  first.focus();
  type(first, "first");
  second.focus();
  type(second, "second");
  key(second, "z", { ctrlKey: true });
  expect(first.value).toBe("first");
  expect(second.value).toBe("y");
  expect(cells(view)[4]).toBe(second);
  expect(document.activeElement).toBe(second);
  key(second, "Z", { metaKey: true, shiftKey: true });
  expect(second.value).toBe("second");
  key(second, "z", { metaKey: true });
  key(second, "y", { ctrlKey: true });
  expect(second.value).toBe("second");
  undo(view);
  undo(view);
  expect(view.state.sliceDoc()).toBe(doc);
  redo(view);
  expect(first.value).toBe("first");
});

it("refreshes positions and callbacks when text before the table changes", () => {
  const { view } = editor();
  const input = cells(view)[4];
  input.focus();
  type(input, "one");
  const stale = input.oninput!;
  view.dispatch({ changes: { from: 0, insert: "Prefix\n" } });
  expect(cells(view)[4]).toBe(input);
  expect(document.activeElement).toBe(input);
  stale.call(input, new Event("input"));
  expect(view.state.sliceDoc()).toBe(
    "Prefix\n" + doc.replace("| x | y | z |", "| x | one | z |"),
  );
  type(input, "two");
  expect(view.state.sliceDoc()).toBe(
    "Prefix\n" + doc.replace("| x | y | z |", "| x | two | z |"),
  );
  expect(view.state.selection.main.anchor).toBe(
    view.state.sliceDoc().indexOf("two") + 3,
  );
});

it("leaves Tab and IME Enter native, advances Enter and exits Escape without writes", () => {
  const { view } = editor();
  const input = cells(view)[3];
  input.focus();
  expect(key(input, "Tab").defaultPrevented).toBe(false);
  expect(key(input, "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  input.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  type(input, "日本");
  expect(key(input, "Enter", { isComposing: true }).defaultPrevented).toBe(
    false,
  );
  expect(document.activeElement).toBe(input);
  input.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  expect(key(input, "Enter").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(cells(view)[4]);
  const source = view.state.sliceDoc();
  key(cells(view)[4], "Escape");
  expect(view.state.sliceDoc()).toBe(source);
  expect(document.activeElement).toBe(view.contentDOM);
  expect(view.state.selection.main.anchor).toBeGreaterThan(
    source.indexOf("z |") + 3,
  );
});

it("respects readonly, including reconfiguration without document changes", () => {
  const { view, mode } = editor();
  const input = cells(view)[3];
  input.focus();
  view.dispatch({ effects: mode.reconfigure(EditorState.readOnly.of(true)) });
  expect(cells(view)[3]).toBe(input);
  expect(input.readOnly).toBe(true);
  type(input, "blocked");
  expect(input.value).toBe("x");
  expect(view.state.sliceDoc()).toBe(doc);
  view.dispatch({ effects: mode.reconfigure(EditorState.readOnly.of(false)) });
  expect(input.readOnly).toBe(false);
  type(input, "allowed");
  expect(view.state.sliceDoc()).toContain("allowed");
});

it.each([
  [
    "newColumn",
    "| a | b |\n| :- | -: |\n| x | y |",
    "| a | b |  |\n| :- | -: | --- |\n| x | y |  |",
    [
      ["a", "b", ""],
      ["x", "y", ""],
    ],
  ],
  [
    "newColumn",
    "a | b\n--- | ---\nx | y",
    "a | b |  |\n--- | --- | ---\nx | y |  |",
    [
      ["a", "b", ""],
      ["x", "y", ""],
    ],
  ],
  [
    "newColumn",
    "| a | b |\n| - | - |\n| x |\n| x | y | extra |",
    "| a | b |  |\n| - | - | --- |\n| x |\n| x | y |  | extra |",
    [
      ["a", "b", ""],
      ["x", "", ""],
      ["x", "y", ""],
    ],
  ],
  [
    "newRow",
    "| a | b |\n| - | - |\n| x | y |\n\nAfter",
    "| a | b |\n| - | - |\n| x | y |\n|  |  |\n\nAfter",
    [
      ["a", "b"],
      ["x", "y"],
      ["", ""],
    ],
  ],
  ["newRow", "| a |\n| - |", "| a |\n| - |\n|  |", [["a"], [""]]],
  ["newRow", "| a |\r\n| - |", "| a |\r\n| - |\r\n|  |", [["a"], [""]]],
  [
    "newColumn",
    "a | \u00a0\n--- | ---",
    "a | \u00a0 |  |\n--- | --- | ---",
    [["a", "", ""]],
  ],
] as const)("adds a %s to %j", (target, source, expected, values) => {
  const table = (state: EditorState) =>
    previewTable(state, syntaxTree(state).topNode.getChild("Table")!);
  const state = EditorState.create({
    doc: source,
    extensions: [
      markdownSupport,
      EditorState.lineSeparator.of(source.includes("\r\n") ? "\r\n" : "\n"),
    ],
  });
  const next = state.update({ changes: table(state)[target] }).state;
  const { rows, align } = table(next);
  expect(next.sliceDoc()).toBe(expected);
  expect(
    rows.map((row) => row.slice(0, align.length).map((cell) => cell.value)),
  ).toEqual(values);
});

it("adds rows and columns from the table and focuses the new cell", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const { view, mode } = await act(async () => editor());
    const click = (name: string) =>
      act(async () =>
        view.dom
          .querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
          .click(),
      );
    await click("Add column");
    type(document.activeElement as HTMLInputElement, "d");
    await click("Add row");
    type(document.activeElement as HTMLInputElement, "w");
    expect(view.state.sliceDoc()).toBe(
      "Before\n\n| a | b | c | d |\n| :- | :-: | -: | --- |\n| x | y | z |  |\n| w |  |  |  |\n\nAfter",
    );
    await act(async () =>
      view.dispatch({
        effects: mode.reconfigure(EditorState.readOnly.of(true)),
      }),
    );
    expect(view.dom.querySelector("button")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
