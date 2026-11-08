import {
  EditorSelection,
  EditorState,
  type StateCommand,
} from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { expect, it } from "vitest";
import {
  editorCommand,
  formattingKeymap,
  slashSource,
  type EditorAction,
} from "./commands";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdownSupport, markdownText } from "./document";
function document(doc: string, from = 0, to = from) {
  let state = EditorState.create({
    doc: markdownText(doc),
    selection: EditorSelection.range(from, to),
    extensions: [markdownSupport, history()],
  });
  return {
    get state() {
      return state;
    },
    dispatch: (tr: ReturnType<EditorState["update"]>) => {
      state = tr.state;
    },
  };
}
it("limits ordinary text to one indent and still allows outdent and undo", () => {
  const target = document("text");
  editorCommand("indent")(target);
  expect(target.state.sliceDoc()).toBe("  text");
  expect(editorCommand("indent")(target)).toBe(true);
  expect(target.state.sliceDoc()).toBe("  text");
  undo(target);
  expect(target.state.sliceDoc()).toBe("text");
  editorCommand("indent")(target);
  editorCommand("outdent")(target);
  expect(target.state.sliceDoc()).toBe("text");
});
it("does not partially indent a selection when one ordinary line is already at its limit", () => {
  const source = "first\n  second\nlast";
  const target = document(source, 0, source.indexOf("last"));
  editorCommand("indent")(target);
  expect(target.state.sliceDoc()).toBe(source);
  expect(target.state.selection.main.to).toBe(source.indexOf("last"));
});
it("excludes the next line at the selection end from the indent limit", () => {
  const target = document("first\n  last", 0, 6);
  editorCommand("indent")(target);
  expect(target.state.sliceDoc()).toBe("  first\n  last");
});
it.each([
  ["- parent\n  - child\n  - sibling", "sibling"],
  ["1. parent\n   1. child\n   2. sibling", "sibling"],
  ["- [ ] parent\n  - [ ] child\n  - [ ] sibling", "sibling"],
  ["```\n  code\n```", "code"],
  ["    code", "code"],
])("preserves deeper indentation in lists and code: %j", (source, word) => {
  const target = document(source, source.indexOf(word));
  const from = target.state.doc.lineAt(target.state.selection.main.head).from;
  editorCommand("indent")(target);
  expect(target.state.sliceDoc()).toBe(
    source.slice(0, from) + "  " + source.slice(from),
  );
});
it("routes the indentation shortcut through the same limit", () => {
  const target = document("  text");
  const run = formattingKeymap.find((binding) => binding.key === "Mod-]")!.run!;
  expect(run(target as Parameters<typeof run>[0])).toBe(true);
  expect(target.state.sliceDoc()).toBe("  text");
});
it.each<[EditorAction, string]>([
  ["bold", "**é😀**"],
  ["italic", "*é😀*"],
  ["strike", "~~é😀~~"],
  ["code", "`é😀`"],
])(
  "wraps and unwraps %s without changing surrounding text",
  (action, expected) => {
    const target = document("before é😀 after", 7, 10);
    editorCommand(action)(target);
    expect(target.state.sliceDoc()).toBe(`before ${expected} after`);
    editorCommand(action)(target);
    expect(target.state.sliceDoc()).toBe("before é😀 after");
  },
);
it.each(["`inside", "a`inside`b", "x``y", " spaces "])(
  "chooses safe inline code delimiters for %j",
  (text) => {
    const target = document(text, 0, text.length);
    editorCommand("code")(target);
    expect(target.state.sliceDoc()).toContain(text);
    editorCommand("code")(target);
    expect(target.state.sliceDoc()).toBe(text);
  },
);
it("inserts an escaped link and selects only its destination", () => {
  const target = document("[hello]", 0, 7);
  editorCommand("link")(target);
  expect(target.state.sliceDoc()).toBe("[\\[hello\\]](url)");
  const { from, to } = target.state.selection.main;
  expect(target.state.doc.sliceString(from, to)).toBe("url");
});
it.each<[EditorAction, string]>([
  ["heading2", "## one\n## two"],
  ["bullet", "- one\n- two"],
  ["numbered", "1. one\n2. two"],
  ["task", "- [ ] one\n- [ ] two"],
  ["quote", "> one\n> two"],
])(
  "transforms selected lines for %s, excluding the next line at the selection end",
  (action, expected) => {
    const target = document("one\ntwo\nlast", 0, 8);
    editorCommand(action)(target);
    expect(target.state.sliceDoc()).toBe(`${expected}\nlast`);
    undo(target);
    expect(target.state.sliceDoc()).toBe("one\ntwo\nlast");
  },
);
it("preserves cursor offset in text while changing a block prefix", () => {
  const target = document("hello", 2);
  editorCommand("heading1")(target);
  expect(target.state.sliceDoc()).toBe("# hello");
  expect(target.state.selection.main.head).toBe(4);
  editorCommand("paragraph")(target);
  expect(target.state.sliceDoc()).toBe("hello");
});
it("inserts a table without deleting unselected text", () => {
  const target = document("before after", 7);
  editorCommand("table")(target);
  expect(target.state.sliceDoc()).toBe(
    "before \n\n| A | B |\n| --- | --- |\n|   |   |\n\nafter",
  );
  expect(
    target.state.doc.sliceString(
      target.state.selection.main.from,
      target.state.selection.main.to,
    ),
  ).toBe("A");
  undo(target);
  expect(target.state.sliceDoc()).toBe("before after");
});
it("wraps code with a safe fence and keeps original code text", () => {
  const text = "const x = `a`;\n// ```";
  const target = document(text, 0, text.length);
  editorCommand("codeBlock")(target);
  expect(target.state.sliceDoc()).toBe(`\`\`\`\`\n${text}\n\`\`\`\``);
});
it.each(["heading1", "bold", "task", "table"] as const)(
  "does not interpret code as a target for %s",
  (action) => {
    const source = "```md\n- [ ] **literal**\n```";
    const target = document(source, 12);
    expect(editorCommand(action)(target)).toBe(false);
    expect(target.state.sliceDoc()).toBe(source);
  },
);
it("toggles only the current task, not code or adjacent tasks", () => {
  const target = document("- [ ] A\n- [X] B\n", 6);
  editorCommand("toggleTask")(target);
  expect(target.state.sliceDoc()).toBe("- [x] A\n- [X] B\n");
});
it.each(["https://example.com/", "word /heading", "```md\n/", "    /"])(
  "does not offer slash commands inside %j",
  async (source) => {
    const target = document(source, source.length);
    expect(
      await slashSource(
        (key) => key,
        () => {},
      )(new CompletionContext(target.state, source.length, false)),
    ).toBeNull();
  },
);
it("offers native insertions after a slash on an empty line", async () => {
  const target = document("A\n\n/hea", 7);
  const result = await slashSource(
    (key) => key,
    () => {},
  )(new CompletionContext(target.state, 7, false));
  expect(result?.from).toBe(4);
  expect(
    result?.options.some(
      (option) => option.label === "editor.command.heading1",
    ),
  ).toBe(true);
  expect(
    result?.options.some((option) => option.label === "editor.command.image"),
  ).toBe(true);
});

it("commands retain CRLF output", () => {
  let state = EditorState.create({
    doc: markdownText("A\r\nB"),
    selection: { anchor: 0, head: 3 },
    extensions: [markdownSupport, EditorState.lineSeparator.of("\r\n")],
  });
  const target: Parameters<StateCommand>[0] = {
    get state() {
      return state;
    },
    dispatch: (tr) => {
      state = tr.state;
    },
  };
  editorCommand("bullet")(target);
  expect(state.sliceDoc()).toBe("- A\r\n- B");
});
