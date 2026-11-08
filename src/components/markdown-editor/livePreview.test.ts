// @vitest-environment jsdom
import {
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorView,
  type Decoration,
  type DecorationSet,
} from "@codemirror/view";
import { cursorCharLeft, undo, history } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubEditorGeometry } from "./testGeometry";
import { markdownSupport } from "./document";
import { buildPreview, livePreview } from "./livePreview";
import { BulletWidget, ImageWidget, TaskWidget } from "./previewWidgets";
import { TableWidget } from "./tablePreview";
import { CodeCopyWidget } from "./CodeCopyWidget";
import { CodeLanguageWidget } from "./CodeLanguageWidget";
import { markdownDestination, safeImageUrl, safeLinkUrl } from "./urls";
let restoreGeometry: () => void;
beforeEach(() => {
  restoreGeometry = stubEditorGeometry();
});
afterEach(() => restoreGeometry());
const labels = {
  codeLanguage: "Code language",
  plainText: "Plain text",
  copyCode: "Copy code",
  codeCopied: "Code copied",
  copyCodeError: "Copy failed",
  selectImage: "Select image",
  resizeImage: "Resize image",
  tableCell: "Table cell",
  tableAddRow: "Add row",
  tableAddColumn: "Add column",
  toggleTask: "Toggle task",
  imageError: "Image failed",
  linkError: "Link failed",
  onError: vi.fn(),
  openImage: vi.fn(),
};
function state(doc: string, anchor = 0, extensions: Extension = []) {
  const initial = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdownSupport, history(), livePreview(labels), extensions],
  });
  // State creation parses for only 20 ms; under full-suite load the tree stays partial.
  if (!ensureSyntaxTree(initial, doc.length, 10_000))
    throw new Error("Markdown parse did not finish");
  return initial.update({}).state;
}
function decorations(editor: EditorState) {
  const ranges: { from: number; to: number; value: Decoration }[] = [];
  buildPreview(editor, labels).between(
    0,
    editor.doc.length,
    (from, to, value) => {
      ranges.push({ from, to, value });
    },
  );
  return ranges;
}
it("decorates without changing the source, keeps block markers rendered and reveals only the edited inline syntax", () => {
  const doc = "\n# Heading\n\n**bold** *em* ~~strike~~ `code`\n\n";
  const editor = state(doc);
  const hidden = (editor: EditorState) =>
    decorations(editor)
      .filter(
        (range) =>
          range.value.spec.widget === undefined &&
          range.value.spec.class === undefined,
      )
      .map((range) => doc.slice(range.from, range.to));
  expect(hidden(editor)).toEqual([
    "# ",
    "**",
    "**",
    "*",
    "*",
    "~~",
    "~~",
    "`",
    "`",
  ]);
  expect(editor.sliceDoc()).toBe(doc);
  expect(hidden(state(doc, doc.indexOf("Heading")))).toContain("# ");
  expect(hidden(state(doc, doc.indexOf("bold")))).toEqual([
    "# ",
    "*",
    "*",
    "~~",
    "~~",
    "`",
    "`",
  ]);
});
it("spaces only blocks directly under another block", () => {
  const doc = "# A\n- item\n## B\n\nText\n\n1. one\n\n### C\nEnd";
  const editor = state(doc);
  expect(
    decorations(editor)
      .filter((range) => range.value.spec.class === "cm-md-block-gap")
      .map(({ from }) => editor.doc.lineAt(from).text),
  ).toEqual(["- item", "## B", "End"]);
});
it("hides only code fences, not code, HTML, references, inline images or unsupported syntax", () => {
  const doc =
    "\n```md\n# h\n- [ ] task\n<!-- telaoi:blank-line -->\n\n\n```\n\n    # code\n\n[x][ref]\n\n[ref]: https://example.com\n\n<div>html</div>\n\ninline ![a](https://example.com/a.png)";
  const ranges = decorations(state(doc));
  const hidden = ranges.filter(
    (range) =>
      !range.value.spec.class &&
      !(range.value.spec.widget instanceof CodeCopyWidget) &&
      !(range.value.spec.widget instanceof CodeLanguageWidget),
  );
  expect(hidden.map((range) => doc.slice(range.from, range.to))).toEqual([
    "```md\n",
    "\n```",
  ]);
});
it("uses centered-divider styling only outside editing and composition", () => {
  const doc = "Before\n\n***\n\nAfter";
  const view = new EditorView({ state: state(doc) });
  try {
    expect(view.dom.querySelector(".cm-md-rule-preview")).not.toBeNull();
    view.dispatch({ selection: { anchor: doc.indexOf("***") } });
    expect(view.dom.querySelector(".cm-md-rule-preview")).toBeNull();
    expect(view.dom.querySelector(".cm-md-rule")?.textContent).toBe("***");
    view.dispatch({ selection: { anchor: 0 } });
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(view.dom.querySelector(".cm-md-rule-preview")).toBeNull();
    expect(view.dom.querySelector(".cm-md-rule")?.textContent).toBe("***");
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(view.dom.querySelector(".cm-md-rule-preview")).not.toBeNull();
    expect(view.state.sliceDoc()).toBe(doc);
  } finally {
    view.destroy();
  }
});
it("keeps table cells editable when the document selection enters the table", () => {
  const doc = "\n| a | | b |\n| :- | - | -: |\n| x\\|y |  | z |";
  const editor = state(doc);
  const table = decorations(editor).find(
    (range) => range.value.spec.widget instanceof TableWidget,
  )!.value.spec.widget as TableWidget;
  const view = new EditorView({ state: editor });
  try {
    const dom = table.toDOM(view);
    expect(
      [...dom.querySelectorAll<HTMLInputElement>("th input")].map(
        (cell) => cell.value,
      ),
    ).toEqual(["a", "", "b"]);
    expect(
      [...dom.querySelectorAll<HTMLInputElement>("td input")].map(
        (cell) => cell.value,
      ),
    ).toEqual(["x\\|y", "", "z"]);
    expect((dom.querySelectorAll("td")[2] as HTMLElement).style.textAlign).toBe(
      "right",
    );
    view.dispatch({ selection: { anchor: doc.indexOf("x") } });
    expect(
      decorations(view.state).some(
        (range) => range.value.spec.widget instanceof TableWidget,
      ),
    ).toBe(true);
    expect(view.state.sliceDoc()).toBe(doc);
  } finally {
    view.destroy();
  }
});
it("replaces list markers and task markers with their indentation, keeping each number", () => {
  const doc =
    "\n- item\n  * nested\n\n+ item\n\n- [ ] task\n  - [x] done\n\n1. first\n10. tenth\n    - sub\n\n2) second\n\n-";
  const editor = state(doc);
  const ranges = decorations(editor);
  const bullets = ranges.filter(
    (range) => range.value.spec.widget instanceof BulletWidget,
  );
  expect(
    bullets.map(({ from, to, value }) => [
      doc.slice(from, to),
      value.spec.widget.marker,
    ]),
  ).toEqual([
    ["- ", "•"],
    ["  * ", "•"],
    ["+ ", "•"],
    ["1. ", "1."],
    ["10. ", "10."],
    ["    - ", "•"],
    ["2) ", "2)"],
  ]);
  expect(
    ranges.map((range) => range.value.spec.attributes?.style).filter(Boolean),
  ).toEqual([
    "--md-list-indent: calc(0em + 0ch)",
    "--md-list-indent: calc(1.5em + 0ch)",
    "--md-list-indent: calc(0em + 0ch)",
    "--md-list-indent: calc(0em + 0ch)",
    "--md-list-indent: calc(2em + 0ch)",
    "--md-list-indent: calc(0em + 0ch); --md-list-marker: 3",
    "--md-list-indent: calc(0em + 0ch); --md-list-marker: 3",
    "--md-list-indent: calc(0.6em + 3ch)",
    "--md-list-indent: calc(0em + 0ch); --md-list-marker: 2",
  ]);
  expect(
    ranges
      .filter((range) => range.value.spec.widget instanceof TaskWidget)
      .map(({ from, to, value }) => [
        doc.slice(from, to),
        value.spec.widget.checked,
      ]),
  ).toEqual([
    ["- [ ] ", false],
    ["  - [x] ", true],
  ]);
  for (const text of ["item", "nested"]) {
    const active = state(doc, doc.indexOf(text));
    const line = active.doc.lineAt(active.selection.main.anchor);
    expect(
      decorations(active).some(
        (range) =>
          range.from >= line.from &&
          range.from <= line.to &&
          range.value.spec.widget instanceof BulletWidget,
      ),
    ).toBe(true);
  }
  expect(editor.sliceDoc()).toBe(doc);
});
it("edits before hidden block markers without breaking the block and shows syntax-only lines while edited", () => {
  const doc = "Intro\n## Title\n- item\n#";
  const view = new EditorView({ state: state(doc, doc.length) });
  const quote = new EditorView({ state: state("# Titre\n> # Titre") });
  const type = (view: EditorView, text: string) =>
    view.state
      .facet(EditorView.inputHandler)
      .some((handler) =>
        handler(
          view,
          view.state.selection.main.head,
          view.state.selection.main.head,
          text,
          () => view.state.update(view.state.replaceSelection(text)),
        ),
      );
  const left = (view: EditorView) => {
    cursorCharLeft(view);
    return view.state.selection.main.head;
  };
  const backspace = () =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    );
  try {
    expect(
      decorations(view.state).some(
        (range) => range.from === doc.length - 1 && !range.value.spec.class,
      ),
    ).toBe(false);
    view.dispatch({ selection: { anchor: doc.indexOf("item") } });
    expect(left(view)).toBe(doc.indexOf("- item"));
    expect(type(view, "x")).toBe(true);
    expect(view.state.sliceDoc()).toBe("Intro\n## Title\n- xitem\n#");
    view.dispatch({ selection: { anchor: doc.indexOf("## ") } });
    expect(view.state.selection.main.head).toBe(doc.indexOf("Title"));
    expect(left(view)).toBe(doc.indexOf("## "));
    backspace();
    expect(view.state.sliceDoc()).toBe("IntroTitle\n- xitem\n#");
    quote.dispatch({ selection: { anchor: 0 } });
    expect(quote.state.selection.main.head).toBe(2);
    quote.dispatch({ selection: { anchor: 8 } });
    expect(quote.state.selection.main.head).toBe(12);
    expect([left(quote), left(quote), left(quote)]).toEqual([10, 9, 8]);
    expect(type(quote, "X")).toBe(true);
    expect(quote.state.sliceDoc()).toBe("# Titre\n> # XTitre");
    expect(Array.from({ length: 5 }, () => left(quote))).toEqual([
      12, 10, 9, 8, 7,
    ]);
  } finally {
    view.destroy();
    quote.destroy();
  }
});
it("keeps checkboxes while editing task text and skips their Markdown with arrow keys", () => {
  const doc = "- [ ] task\n- [x] done";
  for (const text of ["task", "done"]) {
    const view = new EditorView({ state: state(doc, doc.indexOf(text)) });
    try {
      expect(view.dom.querySelectorAll(".cm-md-task")).toHaveLength(2);
      const checkbox = view.dom.querySelector<HTMLInputElement>(".cm-md-task")!;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change"));
      expect(view.state.sliceDoc()).toBe("- [x] task\n- [x] done");
      expect(view.dom.querySelectorAll(".cm-md-task")).toHaveLength(2);
      const right = view.moveByChar(EditorSelection.cursor(0), true);
      expect(right.head).toBe(6);
    } finally {
      view.destroy();
    }
  }
});

it("keeps ordered task numbers while replacing task markers with checkboxes", () => {
  const doc = "Intro\n\n1. [ ] Première\n2. [x] Deuxième";
  const editor = state(doc);
  const ranges = decorations(editor);
  const widgets = (type: typeof BulletWidget | typeof TaskWidget) =>
    ranges
      .filter((range) => range.value.spec.widget instanceof type)
      .map(({ from, to }) => doc.slice(from, to));
  expect(widgets(BulletWidget)).toEqual(["1. ", "2. "]);
  expect(widgets(TaskWidget)).toEqual(["[ ]", "[x]"]);
  expect(editor.sliceDoc()).toBe(doc);
});
it("changes only the task marker, with undo", () => {
  const doc = "\n- [ ] task  \n\n";
  const view = new EditorView({ state: state(doc) });
  try {
    const widget = decorations(view.state).find(
      (range) => range.value.spec.widget instanceof TaskWidget,
    )!.value.spec.widget as TaskWidget;
    const checkbox = widget.toDOM(view);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(view.state.sliceDoc()).toBe("\n- [x] task  \n\n");
    undo(view);
    expect(view.state.sliceDoc()).toBe(doc);
  } finally {
    view.destroy();
  }
});
it("keeps standalone images rendered at the cursor, skips their source with arrow keys and opens a paragraph beside them", () => {
  const doc = "![an image](<https://example.com/image.png>)";
  const view = new EditorView({ state: state(doc) });
  try {
    const dom = view.dom.querySelector<HTMLElement>(".cm-md-image")!;
    expect(dom.querySelector("img")?.alt).toBe("an image");
    expect(view.moveByChar(EditorSelection.cursor(0), true).head).toBe(
      doc.length,
    );
    expect(
      view.moveByChar(EditorSelection.cursor(doc.length), false).head,
    ).toBe(0);
    dom.click();
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(doc.length);
    expect(view.dom.querySelector(".cm-md-image-selected")).toBe(dom);
    expect(
      dom.querySelector(".cm-md-image-select")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(view.state.sliceDoc()).toBe(doc);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector(".cm-md-image-selected")).toBeNull();
    expect(view.dom.querySelector(".cm-md-image")).toBe(dom);
    view.dispatch(view.state.replaceSelection("x"), {
      userEvent: "input.paste",
    });
    expect(view.state.sliceDoc()).toBe(`${doc}\n\nx`);
    expect(view.state.selection.main.head).toBe(doc.length + 3);
    undo(view);
    expect(view.state.sliceDoc()).toBe(doc);
    view.dispatch({ selection: { anchor: doc.length } });
    const input = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "x",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
    view.dispatch({ selection: { anchor: 0 } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(view.state.sliceDoc()).toBe(`\n\n${doc}\n\nx`);
    expect(view.state.selection.main.head).toBe(0);
    expect(
      decorations(view.state).some(
        (range) => range.value.spec.widget instanceof ImageWidget,
      ),
    ).toBe(true);
  } finally {
    view.destroy();
  }
  const crlf = new EditorView({
    state: state(doc, doc.length, EditorState.lineSeparator.of("\r\n")),
  });
  try {
    crlf.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(crlf.state.doc.lines).toBe(3);
    expect(crlf.state.sliceDoc()).toBe(`${doc}\r\n\r\n`);
    expect(crlf.state.selection.main.head).toBe(doc.length + 2);
    undo(crlf);
    crlf.dispatch({ selection: { anchor: 0 } });
    crlf.dispatch(crlf.state.replaceSelection("y"), {
      userEvent: "input.paste",
    });
    expect(crlf.state.sliceDoc()).toBe(`y\r\n\r\n${doc}`);
    expect(crlf.state.selection.main.head).toBe(1);
  } finally {
    crlf.destroy();
  }
});
it("refreshes image selection coordinates after preceding edits without recreating the image", () => {
  const doc = "\n![alt](https://example.com/image.png)";
  const view = new EditorView({ state: state(doc) });
  try {
    const image = view.dom.querySelector("img");
    view.dispatch({ changes: { from: 0, insert: "Before\n" } });
    view.dom.querySelector<HTMLElement>(".cm-md-image")!.click();
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe(doc.trim());
    expect(view.state.selection.main.from).toBe(8);
    expect(view.dom.querySelector("img")).toBe(image);
  } finally {
    view.destroy();
  }
});
it.each(["javascript:alert(1)", "https://example.com/missing.png"])(
  "keeps failed images selectable without revealing their source and reports once: %s",
  (url) => {
    labels.onError.mockClear();
    const doc = `![alt](<${url}>)`;
    const view = new EditorView({ state: state(doc) });
    try {
      view.dom.querySelector("img")?.dispatchEvent(new Event("error"));
      expect(view.dom.querySelector(".cm-md-image")!.textContent).toBe("alt");
      view.dispatch({ changes: { from: 0, insert: "Before\n\n" } });
      expect(labels.onError.mock.calls).toEqual([[labels.imageError]]);
      const dom = view.dom.querySelector<HTMLElement>(".cm-md-image")!;
      expect(dom.textContent).toBe("alt");
      dom.click();
      expect(view.state.selection.main.to).toBe(doc.length + 8);
      expect(view.dom.querySelector(".cm-md-image-selected")).not.toBeNull();
      expect(view.state.sliceDoc()).toBe(`Before\n\n${doc}`);
    } finally {
      view.destroy();
    }
  },
);
it("reveals text syntax during IME composition but keeps images rendered without changing the document", () => {
  const doc =
    "\n**bold**\n\n- bullet\n- [ ] task\n\n1. numbered\n\n![alt](https://example.com/a.png)";
  const view = new EditorView({ state: state(doc) });
  try {
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(
      decorations(view.state).every(
        (range) =>
          Boolean(range.value.spec.class) ||
          range.value.spec.widget instanceof ImageWidget,
      ),
    ).toBe(true);
    expect(view.dom.querySelector(".cm-md-image")).not.toBeNull();
    expect(view.state.sliceDoc()).toBe(doc);
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(
      decorations(view.state).some(
        (range) => range.value.spec.widget instanceof BulletWidget,
      ),
    ).toBe(true);
    expect(view.state.sliceDoc()).toBe(doc);
  } finally {
    view.destroy();
  }
});

it("updates selection-only previews exactly like a full rebuild", () => {
  const doc = [
    "# Heading **bold**",
    "Setext",
    "======",
    "",
    "Text *em* ~~s~~ `c` [link](https://example.com) and **b**.",
    "",
    "- [ ] task",
    "- [x] done",
    "- item",
    "  - nested *em*",
    "1. one",
    "",
    "> quote **q**",
    "> more",
    "",
    "***",
    "",
    "| a | b |",
    "|---|---|",
    "| [x](https://example.com) | 2 |",
    "",
    "![alt](https://example.com/a.png)",
    "",
    "<!-- soreno:image-width=300 -->",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "Last `line`",
  ].join("\n");
  let editor = EditorState.create({
    doc,
    extensions: [
      markdownSupport,
      history(),
      livePreview(labels),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  if (!ensureSyntaxTree(editor, doc.length, 10_000))
    throw new Error("Markdown parse did not finish");
  editor = editor.update({}).state;
  const snapshot = (set: DecorationSet) => {
    const ranges: unknown[] = [];
    set.between(0, editor.doc.length, (from, to, value) => {
      ranges.push({
        from,
        to,
        side: value.startSide,
        widget: value.spec.widget?.constructor.name,
        spec: JSON.stringify(value.spec, (key, field: unknown) =>
          typeof field === "function" || key === "doc" || key === "node"
            ? undefined
            : field,
        ),
      });
    });
    return ranges;
  };
  const current = () => {
    const sets = editor
      .facet(EditorView.decorations)
      .filter((source) => typeof source !== "function");
    expect(sets).toHaveLength(1);
    return sets[0];
  };
  const selections = [
    ...Array.from({ length: doc.length + 1 }, (_, index) =>
      EditorSelection.single(index),
    ),
    EditorSelection.single(doc.indexOf("Text"), doc.indexOf("> more")),
    EditorSelection.single(doc.indexOf("| a"), doc.indexOf("```ts")),
    EditorSelection.single(0, doc.length),
    EditorSelection.create([
      EditorSelection.cursor(doc.indexOf("link")),
      EditorSelection.cursor(doc.indexOf("***")),
      EditorSelection.range(doc.indexOf("![alt]"), doc.indexOf(".png)") + 5),
    ]),
    EditorSelection.single(doc.length),
  ];
  for (const selection of selections) {
    editor = editor.update({ selection }).state;
    expect(snapshot(current())).toEqual(snapshot(buildPreview(editor, labels)));
  }
});
describe("URL boundaries", () => {
  it("decodes Markdown escapes and entities before validating destinations", () => {
    expect(
      markdownDestination("<https://example.com/a\\(b\\)?x=1&amp;y=2>"),
    ).toBe("https://example.com/a(b)?x=1&y=2");
    expect(
      safeLinkUrl(markdownDestination("javascript&colon;alert(1)")),
    ).toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "./relative.png",
  ])("rejects %s", (url) => {
    expect(safeLinkUrl(url)).toBeNull();
    expect(safeImageUrl(url)).toBeNull();
  });
  it("allows existing attachments and raster fallback, but not SVG data", () => {
    expect(safeImageUrl("asset://localhost/image.webp")).toBeTruthy();
    expect(safeImageUrl("http://asset.localhost/image.webp")).toBeTruthy();
    expect(safeImageUrl("data:image/png;base64,aGVsbG8=")).toBeTruthy();
    expect(safeImageUrl("data:image/svg+xml;base64,aGVsbG8=")).toBeNull();
    expect(safeLinkUrl("mailto:hello@example.com")).toBeTruthy();
  });
});
