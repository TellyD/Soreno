// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { EditorState, StateEffect } from "@codemirror/state";
import { forceParsing, highlightingFor } from "@codemirror/language";
import { codeLanguage } from "./codeLanguages";
import { tags } from "@lezer/highlight";
import { markdownHighlightStyle } from "./highlighting";
import { blockActions, commandLabel } from "./commands";
import { redo, undo, undoDepth } from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorProps } from "./MarkdownEditor";
import { stubEditorGeometry } from "./testGeometry";
import * as fileUpload from "./fileUpload";
import { imageAnchors } from "./imageUpload";
import { clearNotifications, getNotifications } from "../../notifications";
import { stubModalSelector } from "../ui/testTopLayer";
import { deferred } from "../../testing/deferred";

const settings = vi.hoisted(() => ({
  language: "fr",
  theme: "light",
  t: (key: string) => key,
}));
vi.mock("../../i18n", () => ({ useI18n: () => settings }));
vi.mock("../../theme", () => ({ useTheme: () => settings }));
let container: HTMLDivElement;
let root: Root;
let restoreGeometry: () => void;
const toolbarStorageKey = "soreno:markdown-toolbar:v1";
const defaultTools = [
  "bold",
  "italic",
  "link",
  "heading1",
  "heading2",
  "bullet",
  "numbered",
  "task",
  "image",
] as const;
let savedToolbarPreference: string | null;
beforeEach(() => {
  savedToolbarPreference = window.localStorage.getItem(toolbarStorageKey);
  window.localStorage.removeItem(toolbarStorageKey);
  // Base UI focus checks can run after the popup closes; keep this for the whole view lifetime.
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  restoreGeometry = stubEditorGeometry();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreGeometry();
  clearNotifications();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  settings.theme = "light";
  settings.language = "fr";
  if (savedToolbarPreference === null)
    window.localStorage.removeItem(toolbarStorageKey);
  else window.localStorage.setItem(toolbarStorageKey, savedToolbarPreference);
});
function view() {
  return EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
}
function lineText(line: Element) {
  const clone = line.cloneNode(true) as Element;
  clone
    .querySelectorAll(".cm-md-code-copy, .cm-md-code-language")
    .forEach((widget) => widget.remove());
  return clone.textContent;
}
const uploadImage = (file: File) => fileUpload.uploadAttachmentImage(file, "A");
async function render(props: Partial<MarkdownEditorProps> = {}) {
  await act(async () =>
    root.render(
      <MarkdownEditor
        documentId="A"
        uploadImage={uploadImage}
        content={"A\n\n\nB\n\n"}
        mode="preview"
        onContentChange={() => {}}
        {...props}
      />,
    ),
  );
}

function toolbarLabels() {
  return [...container.querySelectorAll('[role="toolbar"] button')].map(
    (button) => button.getAttribute("aria-label"),
  );
}
function expectedToolbarLabels(tools: readonly string[]) {
  return [
    ...(tools.some((tool) => tool === "paragraph" || tool.startsWith("heading"))
      ? ["editor.toolbar.headings"]
      : []),
    ...[
      "bold",
      "italic",
      "strike",
      "code",
      "link",
      "bullet",
      "numbered",
      "task",
      "indent",
      "outdent",
      "toggleTask",
      "quote",
      "codeBlock",
      "rule",
      "table",
      "image",
    ]
      .filter((tool) => tools.includes(tool))
      .map((tool) => `editor.command.${tool}`),
  ];
}
async function chooseBlockStyle(action: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.toolbar.headings"]',
  )!;
  await pointerClick(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = [
    ...list.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent === `editor.command.${action}`)!;
  expect(option).toBeDefined();
  await pointerClick(option);
  return trigger;
}
function textButton(scope: ParentNode, text: string) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  return button!;
}
async function pointerClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.focus();
    target.click();
  });
}
async function customizeToolbar() {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.toolbar.title"]',
  )!;
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  return dialog;
}
function toolCheckbox(
  dialog: HTMLElement,
  action: Parameters<typeof commandLabel>[0],
) {
  const checkbox = [
    ...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) => input.labels?.[0].textContent === commandLabel(action));
  expect(checkbox).toBeDefined();
  return checkbox!;
}

async function chooseCodeLanguage(label: string, index = 0) {
  const trigger = container.querySelectorAll<HTMLButtonElement>(
    '[aria-label="editor.codeLanguage"]',
  )[index];
  await act(async () => trigger.click());
  const list = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = [
    ...list.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent === label)!;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}

it.each([false, true])(
  "cancels a pending image import when locked, including after unlocking (%s)",
  async (unlockBeforeResolve) => {
    const content = "Keep this";
    const onContentChange = vi.fn();
    const resolveUpload = deferred<string>();
    const upload = vi
      .spyOn(fileUpload, "uploadAttachmentImage")
      .mockReturnValue(resolveUpload.promise);
    await render({ content, onContentChange });
    const editor = view();
    const paste = () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [new File(["image"], "photo.png", { type: "image/png" })],
        },
      });
      editor.contentDOM.dispatchEvent(event);
    };
    await act(async () => paste());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(editor.state.field(imageAnchors).size).toBe(1);
    editor.scrollDOM.scrollTop = 80;
    await render({ content, onContentChange, readOnly: true });
    expect(view()).toBe(editor);
    expect(editor.scrollDOM.scrollTop).toBe(80);
    expect(editor.state.readOnly).toBe(true);
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(editor.state.field(imageAnchors).size).toBe(0);
    const picker = vi
      .spyOn(
        container.querySelector<HTMLInputElement>('input[type="file"]')!,
        "click",
      )
      .mockImplementation(() => {});
    await act(async () => {
      paste();
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="editor.command.image"]',
        )!
        .click();
      editor.dispatch({ changes: { from: 0, insert: "Blocked" } });
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(picker).not.toHaveBeenCalled();
    expect(editor.state.sliceDoc()).toBe(content);
    if (unlockBeforeResolve)
      await render({ content, onContentChange, readOnly: false });
    await act(async () =>
      resolveUpload.resolve("https://example.com/photo.png"),
    );
    expect(editor.state.sliceDoc()).toBe(content);
    expect(onContentChange).not.toHaveBeenCalled();
    await render({ content, onContentChange, readOnly: true });
    await render({
      content: "External update",
      onContentChange,
      readOnly: true,
    });
    expect(editor.state.sliceDoc()).toBe("External update");
    expect(onContentChange).not.toHaveBeenCalled();
    await render({
      content: "External update",
      onContentChange,
      readOnly: false,
    });
    expect(view()).toBe(editor);
    expect(editor.state.readOnly).toBe(false);
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("true");
    await act(async () =>
      editor.dispatch({ changes: { from: 0, insert: "Allowed " } }),
    );
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith(
      "Allowed External update",
    );
  },
);

it.each(["", "\n", "A\r\n\r\nB", "A\r\nB\nC", "A  \n\n\t\nB\n"])(
  "opens %j without saving",
  async (content) => {
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    await render({ content, mode: "source", onContentChange });
    expect(onContentChange).not.toHaveBeenCalled();
  },
);

it("keeps document, selection and history through three mode cycles and theme/locale changes", async () => {
  const changed = vi.fn();
  await render({ onContentChange: changed });
  const editor = view();
  await act(async () =>
    editor.dispatch({
      changes: { from: 0, insert: "X" },
      selection: { anchor: 1 },
    }),
  );
  const content = editor.state.sliceDoc();
  for (let i = 0; i < 3; i++) {
    await render({ content, mode: "source", onContentChange: changed });
    await render({ content, mode: "preview", onContentChange: changed });
  }
  settings.theme = "dark";
  settings.language = "en";
  await render({ content, onContentChange: changed });
  expect(view()).toBe(editor);
  expect(editor.state.sliceDoc()).toBe(content);
  expect(editor.state.selection.main.anchor).toBe(1);
  expect(undoDepth(editor.state)).toBe(1);
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => {
    undo(editor);
  });
  expect(editor.state.sliceDoc()).toBe("A\n\n\nB\n\n");
});

it.each(["light", "dark"])(
  "uses theme syntax colors without underlining headings in %s",
  async (theme) => {
    settings.theme = theme;
    await render({ content: "\n## À préparer\n\n```ts\ncode\n```" });
    for (const tag of [
      tags.heading1,
      tags.heading2,
      tags.processingInstruction,
      tags.labelName,
      tags.monospace,
      tags.link,
    ]) {
      expect(highlightingFor(view().state, [tag])).toBe(
        markdownHighlightStyle.style([tag]),
      );
    }
    const specs = markdownHighlightStyle.specs;
    expect(
      specs.find((spec) => spec.tag === tags.heading)?.textDecoration,
    ).toBeUndefined();
  },
);

it.each([
  ["```ts\n  const x = 1;\n\n  x++;  \n```", "  const x = 1;\n\n  x++;  "],
  ["~~~~md\n```\n~~~~", "```"],
  ["```\n```", ""],
  ["```\nstill typing\n", "still typing\n"],
  ["> ```js\n> a\n>\n> b\n> ```", "a\n\nb"],
  ["- ```\n  a\n    b\n  ```", "a\n  b"],
  ["    a\n      b", "a\n  b"],
  ["```\r\na\r\nb\r\n```", "a\r\nb"],
])(
  "copies code only from %j without changing the note or selection",
  async (content, expected) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    const editor = view();
    const selection = editor.state.selection;
    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.copyCode"]',
    )!;
    await act(async () => {
      copy.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      copy.click();
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "editor.codeCopied",
    );
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(editor.state.sliceDoc()).toBe(content);
    expect(undoDepth(editor.state)).toBe(0);
    expect(onContentChange).not.toHaveBeenCalled();
  },
);

it.each(["```", "~~~~"])(
  "hides %s fences in preview while keeping code editable and source intact",
  async (fence) => {
    const content = `${fence}js\nconst x = 1;\n${fence}`;
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    const editor = view();
    expect(editor.contentDOM.textContent).not.toContain(fence);
    expect([...container.querySelectorAll(".cm-line")].map(lineText)).toEqual([
      "const x = 1;",
    ]);
    await act(async () =>
      editor.dispatch({ selection: { anchor: content.indexOf("const") } }),
    );
    expect(
      editor.moveToLineBoundary(editor.state.selection.main, false, false).head,
    ).toBe(content.indexOf("const"));
    expect(
      editor.moveToLineBoundary(editor.state.selection.main, true, false).head,
    ).toBe(content.lastIndexOf("\n"));
    expect(editor.contentDOM.textContent).not.toContain(fence);
    expect(editor.state.sliceDoc()).toBe(content);
    expect(onContentChange).not.toHaveBeenCalled();
    await act(async () =>
      editor.dispatch({
        changes: {
          from: content.indexOf("1"),
          to: content.indexOf("1") + 1,
          insert: "2",
        },
      }),
    );
    const updated = content.replace("1", "2");
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith(updated);
    await render({ content: updated, mode: "source", onContentChange });
    expect(
      [...container.querySelectorAll(".cm-line")]
        .map((line) => line.textContent)
        .join("\n"),
    ).toBe(updated);
    await render({ content: updated, onContentChange });
    expect(editor.contentDOM.textContent).not.toContain(fence);
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(editor.state.sliceDoc()).toBe(content);
  },
);

it.each([
  ["```\nfirst\nlast\n```", ["first", "last"]],
  ["```\n\nfirst\n\n```", ["", "first", ""]],
  ["```\n\n```", [""]],
  ["```\n```", [""]],
  ["```\nfirst\n", ["first", ""]],
  ["```", [""]],
  ["```\r\nfirst\r\nlast\r\n```", ["first", "last"]],
] as const)("folds only delimiter lines in %j", async (content, expected) => {
  const onContentChange = vi.fn();
  await render({ content: `Before\n\n${content}`, onContentChange });
  const codeLines = [...container.querySelectorAll(".cm-md-code-block")];
  expect(codeLines.map(lineText)).toEqual(expected);
  expect(container.querySelectorAll(".cm-md-code-copy")).toHaveLength(1);
  expect(onContentChange).not.toHaveBeenCalled();
});

it("keeps text after a folded code block separate and its empty body editable", async () => {
  const content = "Before\n\n```\n\n```\n\nAfter";
  const onContentChange = vi.fn();
  await render({ content, onContentChange });
  const lines = () => [...container.querySelectorAll(".cm-line")].map(lineText);
  expect(lines()).toEqual(["Before", "", "", "", "After"]);
  const position = content.indexOf("```\n") + 4;
  await act(async () =>
    view().dispatch({
      changes: { from: position, insert: "code" },
      selection: { anchor: position + 4 },
    }),
  );
  expect(lines()).toEqual(["Before", "", "code", "", "After"]);
  expect(onContentChange).toHaveBeenCalledExactlyOnceWith(
    content.replace("```\n\n", "```\ncode\n"),
  );
  await act(async () => {
    expect(undo(view())).toBe(true);
  });
  expect(view().state.sliceDoc()).toBe(content);
});

it.each([
  ["~~~\nprint(1)\n~~~", "~~~py\nprint(1)\n~~~"],
  [
    '```  TS title="example"\r\nprint(1)\r\n```',
    '```  py title="example"\r\nprint(1)\r\n```',
  ],
  ["> ```js\n> print(1)\n> ```", "> ```py\n> print(1)\n> ```"],
])(
  "changes only the language in %j, with undo and redo",
  async (content, expected) => {
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    expect(onContentChange).not.toHaveBeenCalled();
    await chooseCodeLanguage("Python");
    expect(view().state.sliceDoc()).toBe(expected);
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith(expected);
    expect(undoDepth(view().state)).toBe(1);
    await act(async () => {
      expect(undo(view())).toBe(true);
    });
    expect(view().state.sliceDoc()).toBe(content);
    await act(async () => {
      expect(redo(view())).toBe(true);
    });
    expect(view().state.sliceDoc()).toBe(expected);
  },
);

it("keeps the language selector current after code edits and preceding insertions", async () => {
  await render({ content: "```unknown\ncode\n```\n\n```js\nsecond\n```" });
  expect(
    container.querySelector('[aria-label="editor.codeLanguage"]')?.textContent,
  ).toBe("unknown");
  await act(async () =>
    view().dispatch({
      changes: {
        from: view().state.sliceDoc().indexOf("code"),
        insert: "new ",
      },
    }),
  );
  await chooseCodeLanguage("TypeScript");
  expect(view().state.sliceDoc()).toContain("```ts\nnew code");
  await act(async () =>
    view().dispatch({ changes: { from: 0, insert: "Before\n\n" } }),
  );
  await chooseCodeLanguage("editor.plainText", 1);
  expect(view().state.sliceDoc()).toBe(
    "Before\n\n```ts\nnew code\n```\n\n```text\nsecond\n```",
  );
});

it("supports keyboard language selection and disables it in read-only mode", async () => {
  const content = "```\nconst n = 1;\n```";
  await render({ content });
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.codeLanguage"]',
  )!;
  expect(trigger.textContent).toBe("editor.plainText");
  expect(
    [...container.querySelectorAll(".cm-md-code-block span")].some(
      (span) => span.textContent === "const",
    ),
  ).toBe(false);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const selected = document.querySelector<HTMLElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  await act(async () => {
    selected.focus();
    selected.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(document.activeElement?.textContent).toBe("JavaScript");
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(view().state.sliceDoc()).toBe(content.replace("```\n", "```js\n"));
  await act(async () =>
    view().dispatch({
      effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
    }),
  );
  expect(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.codeLanguage"]',
    )!.disabled,
  ).toBe(true);
  await render({ content: view().state.sliceDoc(), mode: "source" });
  expect(container.querySelector(".cm-md-code-language")).toBeNull();
});

it.each(["light", "dark"])(
  "colors an explicitly typed block after loading its parser in %s without affecting copy",
  async (theme) => {
    settings.theme = theme;
    const content = '```ts\nconst message: string = "hello"; // note\n```';
    const onContentChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render({ content, onContentChange });
    await act(async () => {
      await codeLanguage("ts")!.load();
      forceParsing(view(), view().state.doc.length, 1000);
    });
    const code = container.querySelector(".cm-md-code-block")!;
    const keyword = [...code.querySelectorAll("span")].find(
      (span) => span.textContent === "const",
    );
    expect(
      keyword?.classList.contains(
        highlightingFor(view().state, [tags.keyword])!,
      ),
    ).toBe(true);
    expect(container.querySelectorAll(".cm-md-code-block")).toHaveLength(1);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="editor.copyCode"]')!
        .click(),
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      'const message: string = "hello"; // note',
    );
    expect(view().state.sliceDoc()).toBe(content);
    expect(onContentChange).not.toHaveBeenCalled();
    await chooseCodeLanguage("editor.plainText");
    await act(async () => {
      forceParsing(view(), view().state.doc.length, 1000);
    });
    expect(
      [...container.querySelectorAll(".cm-md-code-block span")].some(
        (span) => span.textContent === "const",
      ),
    ).toBe(false);
  },
);

it("resets the copy confirmation and ignores a late failure after changing notes", async () => {
  let rejectCopy!: (error: Error) => void;
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCopy = reject;
        }),
    );
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await render({ content: "```\ncode\n```" });
  vi.useFakeTimers();
  try {
    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.copyCode"]',
    )!;
    await act(async () => copy.click());
    expect(copy.getAttribute("aria-label")).toBe("editor.codeCopied");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(copy.getAttribute("aria-label")).toBe("editor.copyCode");
    await act(async () => copy.click());
    await render({ documentId: "B", content: "Another note" });
    await act(async () => rejectCopy(new Error("Denied")));
    expect(getNotifications()).toEqual([]);
    expect(view().state.sliceDoc()).toBe("Another note");
  } finally {
    vi.useRealTimers();
  }
});

it("copies the latest code after an edit and removes copy controls in source mode", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await render({ content: "```\nold\n```\n\n~~~\nsecond\n~~~" });
  await act(async () =>
    view().dispatch({ changes: { from: 4, to: 7, insert: "new" } }),
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    '[aria-label="editor.copyCode"]',
  );
  expect(buttons).toHaveLength(2);
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  expect(writeText.mock.calls).toEqual([["new"], ["second"]]);
  await render({ content: view().state.sliceDoc(), mode: "source" });
  expect(container.querySelector(".cm-md-code-copy")).toBeNull();
});

it.each([true, false])(
  "reports clipboard failures without modifying code (API available: %s)",
  async (available) => {
    vi.stubGlobal(
      "navigator",
      available
        ? {
            clipboard: {
              writeText: vi.fn().mockRejectedValue(new Error("Denied")),
            },
          }
        : {},
    );
    const content = "```\nkeep\n```";
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="editor.copyCode"]')!
        .click(),
    );
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        message: "editor.copyCodeError",
        tone: "error",
      }),
    ]);
    expect(
      container.querySelector('[aria-label="editor.codeCopied"]'),
    ).toBeNull();
    expect(view().state.sliceDoc()).toBe(content);
    expect(onContentChange).not.toHaveBeenCalled();
  },
);

it("restores actual list markers in source mode without saving", async () => {
  const content = "\n- item\n  - nested\n- [ ] task\n\n1. numbered";
  const onContentChange = vi.fn();
  await render({ content, onContentChange });
  expect(container.querySelectorAll(".cm-md-bullet")).toHaveLength(3);
  expect(container.querySelectorAll(".cm-md-task")).toHaveLength(1);
  await render({ content, mode: "source", onContentChange });
  expect(container.querySelector(".cm-md-bullet, .cm-md-task")).toBeNull();
  expect(
    [...container.querySelectorAll(".cm-line")]
      .map((line) => line.textContent)
      .join("\n"),
  ).toBe(content);
  expect(view().state.sliceDoc()).toBe(content);
  expect(onContentChange).not.toHaveBeenCalled();
});

it.each(["Backspace", "Delete"])(
  "selects an image without revealing Markdown, deletes it with %s and supports undo",
  async (key) => {
    const image = "![photo](https://example.com/photo.png)";
    const content = `Before\n\n${image}\n\nAfter`;
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    const editor = view();
    const photo =
      container.querySelector<HTMLImageElement>(".cm-md-image img")!;
    await act(async () => photo.click());
    expect(container.querySelector(".cm-md-image-selected img")).toBe(photo);
    expect(
      editor.state.sliceDoc(
        editor.state.selection.main.from,
        editor.state.selection.main.to,
      ),
    ).toBe(image);
    expect(editor.hasFocus).toBe(true);
    expect(editor.contentDOM.textContent).not.toContain(image);
    expect(onContentChange).not.toHaveBeenCalled();
    await act(async () => {
      editor.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
    expect(editor.state.sliceDoc()).toBe("Before\n\n\n\nAfter");
    expect(container.querySelector(".cm-md-image")).toBeNull();
    expect(onContentChange).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(editor.state.sliceDoc()).toBe(content);
    expect(container.querySelector(".cm-md-image img")).not.toBeNull();
  },
);

it.each(["Enter", " "])(
  "selects images with %j and exposes their Markdown only in source mode",
  async (key) => {
    const content = "![photo](https://example.com/photo.png)";
    const onContentChange = vi.fn();
    await render({ content, onContentChange });
    const widget = container.querySelector<HTMLElement>(".cm-md-image-select")!;
    await act(async () => {
      widget.focus();
      widget.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
    expect(widget.getAttribute("aria-pressed")).toBe("true");
    expect(view().hasFocus).toBe(true);
    expect(view().state.selection.main.to).toBe(content.length);
    await render({ content, mode: "source", onContentChange });
    expect(container.querySelector(".cm-md-image")).toBeNull();
    expect(view().contentDOM.textContent).toContain(content);
    await render({ content, mode: "preview", onContentChange });
    expect(container.querySelector(".cm-md-image-selected img")).not.toBeNull();
    expect(onContentChange).not.toHaveBeenCalled();
  },
);

it("shows resolved image URLs while keeping the written ones, and reports a failed resolution", async () => {
  const shown = deferred<string>();
  const failed = deferred<string>();
  const resolveImageUrl = vi.fn((url: string) =>
    url.endsWith("/a.png")
      ? shown.promise
      : url.endsWith("/b.png")
        ? failed.promise
        : null,
  );
  const content =
    "![a](https://private.test/a.png)\n\n![b](https://private.test/b.png)\n\n![c](https://example.com/c.png)";
  await render({ content, resolveImageUrl });
  const images = () =>
    [...container.querySelectorAll<HTMLImageElement>(".cm-md-image img")].map(
      (image) => [
        image.getAttribute("src"),
        getComputedStyle(image).display !== "none",
      ],
    );
  expect(images()).toEqual([
    [null, false],
    [null, false],
    ["https://example.com/c.png", true],
  ]);

  await act(async () => {
    shown.resolve("blob:shown");
    failed.reject(new Error("denied"));
  });

  expect(images()).toEqual([
    ["blob:shown", true],
    ["https://example.com/c.png", true],
  ]);
  expect(getNotifications()).toEqual([
    expect.objectContaining({ message: "editor.imagePreviewError" }),
  ]);
  expect(view().state.sliceDoc()).toBe(content);
});

it("opens a double-clicked or keyboard-selected image in a dismissible preview", async () => {
  const content = "![photo](https://example.com/photo.png)";
  await render({ content });
  const image = container.querySelector(".cm-md-image img")!;
  await act(async () => {
    image.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("photo");
  expect(dialog.querySelector("img")?.src).toBe(
    "https://example.com/photo.png",
  );
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  const enter = (target: HTMLElement) =>
    act(async () => {
      target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await enter(container.querySelector<HTMLElement>(".cm-md-image-select")!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await enter(view().contentDOM);
  expect(
    document.querySelector('[role="dialog"]')?.querySelector("img")?.src,
  ).toBe("https://example.com/photo.png");
  expect(view().state.sliceDoc()).toBe(content);

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await render({ content, readOnly: true });
  act(() => view().dispatch({ selection: { anchor: content.length } }));
  // jsdom focuses contenteditable="false", browsers don't: keep focus on the image like a browser.
  vi.spyOn(view().contentDOM, "focus").mockImplementation(() => {});
  container.querySelector<HTMLElement>(".cm-md-image-select")!.focus();
  await enter(document.activeElement as HTMLElement);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(
    container.querySelector(".cm-md-image-select"),
  );
  await enter(document.activeElement as HTMLElement);
  expect(
    document.querySelector('[role="dialog"]')?.querySelector("img")?.src,
  ).toBe("https://example.com/photo.png");
});

it("saves a resized image through onContentChange and restores its size when reopening the note", async () => {
  const content =
    "![photo](https://example.com/photo.png)<!-- soreno:image-width=400 -->";
  const onContentChange = vi.fn();
  await render({ content, onContentChange });
  const image = container.querySelector<HTMLElement>(".cm-md-image")!;
  await act(async () => image.click());
  const geometry = vi
    .spyOn(image, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 400, 200));
  const handle = image.querySelector<HTMLElement>(".cm-md-image-resize")!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => false;
  await act(async () => {
    for (const [type, clientX] of [
      ["pointerdown", 400],
      ["pointermove", 390],
      ["pointerup", 390],
    ] as const) {
      const event = new MouseEvent(type, {
        clientX,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      handle[`on${type}`]?.call(handle, event as PointerEvent);
    }
  });
  geometry.mockRestore();
  const saved = content.replace("width=400", "width=390");
  expect(onContentChange).toHaveBeenCalledExactlyOnceWith(saved);
  await render({ documentId: "B", content: "Another note" });
  await render({ content: saved, onContentChange });
  expect(
    container.querySelector<HTMLElement>(".cm-md-image")!.style.width,
  ).toBe("390px");
  expect(onContentChange).toHaveBeenCalledTimes(1);
});

it("does not replace or re-emit a parent echo", async () => {
  const changed = vi.fn();
  function Parent() {
    const [content, setContent] = useState("A");
    return (
      <MarkdownEditor
        documentId="A"
        uploadImage={uploadImage}
        content={content}
        mode="source"
        onContentChange={(next) => {
          changed(next);
          setContent(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Parent />));
  const editor = view();
  await act(async () =>
    editor.dispatch({ changes: { from: 1, insert: "\n\nB" } }),
  );
  expect(changed).toHaveBeenCalledExactlyOnceWith("A\n\nB");
  expect(undoDepth(editor.state)).toBe(1);
});

it.each(["External\r\n\r\nB", "A\r\nB"])(
  "makes external content/separator replacement %j undoable without an echo",
  async (next) => {
    const changed = vi.fn();
    await render({ content: "A\nB", onContentChange: changed });
    const editor = view();
    await render({ content: next, onContentChange: changed });
    expect(changed).not.toHaveBeenCalled();
    expect(editor.state.sliceDoc()).toBe(next);
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(changed).toHaveBeenLastCalledWith("A\nB");
    await act(async () => {
      expect(redo(editor)).toBe(true);
    });
    expect(changed).toHaveBeenLastCalledWith(next);
  },
);

it("reserves the current toolbar overlay height only in preview without changing the document", async () => {
  const content = "Hello\n\nWorld";
  const onContentChange = vi.fn();
  await render({ content, onContentChange });
  const editor = view();
  const margins = editor.state.facet(EditorView.scrollMargins);
  expect(margins).toHaveLength(1);
  const overlay = container.querySelector<HTMLElement>(
    ".markdown-toolbar-overlay",
  )!;
  expect(container.querySelectorAll(".markdown-toolbar-host")).toHaveLength(1);
  Object.defineProperty(overlay, "offsetHeight", {
    value: 88,
    configurable: true,
  });
  expect(margins[0](editor)).toEqual({ top: 88 });
  Object.defineProperty(overlay, "offsetHeight", { value: 96 });
  expect(margins[0](editor)).toEqual({ top: 96 });

  await render({ content, mode: "source", onContentChange });
  expect(container.querySelector(".markdown-toolbar-overlay")).toBeNull();
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
  expect(margins[0](editor)).toEqual({ top: 0 });
  expect(container.querySelectorAll(".markdown-toolbar-host")).toHaveLength(1);
  expect(editor.state.sliceDoc()).toBe(content);

  await render({ content, mode: "preview", onContentChange });
  const restored = container.querySelector<HTMLElement>(
    ".markdown-toolbar-overlay",
  )!;
  expect(restored).not.toBe(overlay);
  expect(container.querySelectorAll(".markdown-toolbar-host")).toHaveLength(1);
  Object.defineProperty(restored, "offsetHeight", { value: 88 });
  expect(margins[0](editor)).toEqual({ top: 88 });
  expect(view()).toBe(editor);
  expect(editor.state.sliceDoc()).toBe(content);
  expect(onContentChange).not.toHaveBeenCalled();
});

it("applies toolbar formatting to the selection saved before clicking", async () => {
  await render({ content: "Hello", mode: "preview" });
  const editor = view();
  await act(async () => editor.dispatch({ selection: { anchor: 0, head: 5 } }));
  const bold = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.bold"]',
  )!;
  await act(async () => {
    bold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    bold.click();
  });
  expect(editor.state.sliceDoc()).toBe("**Hello**");
  await act(async () => {
    undo(editor);
  });
  expect(editor.state.sliceDoc()).toBe("Hello");
});

it("formats the focused implicit third cell without saving on focus, in one undo step", async () => {
  const content = "| a | b | c |\n| - | - | - |\n| x |\n\nAfter";
  const changed = vi.fn();
  await render({ content, onContentChange: changed });
  const editor = view();
  const cells = () => [
    ...container.querySelectorAll<HTMLInputElement>(".cm-md-table-cell"),
  ];
  await act(async () => cells()[5].focus());
  expect(changed).not.toHaveBeenCalled();
  expect(editor.state.sliceDoc()).toBe(content);
  const bold = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.bold"]',
  )!;
  await act(async () => {
    bold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    bold.focus();
    bold.click();
  });
  expect(editor.state.sliceDoc()).toBe(
    content.replace("| x |", "| x |  | **** |"),
  );
  expect(cells().map((cell) => cell.value)).toEqual([
    "a",
    "b",
    "c",
    "x",
    "",
    "****",
  ]);
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => {
    undo(editor);
  });
  expect(editor.state.sliceDoc()).toBe(content);
  expect(undoDepth(editor.state)).toBe(0);
});

it.each([false, true])(
  "preserves the implicit third cell through customization unless abandoned for text (abandon=%s)",
  async (abandon) => {
    const content = "| a | b | c |\n| - | - | - |\n| x |";
    const changed = vi.fn();
    await render({ content, onContentChange: changed });
    const editor = view();
    const cells = () => [
      ...container.querySelectorAll<HTMLInputElement>(".cm-md-table-cell"),
    ];
    await act(async () => cells()[5].focus());
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.toolbar.title"]',
    )!;
    await pointerClick(trigger);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const strikeOption = toolCheckbox(dialog, "strike");
    await pointerClick(strikeOption);
    await act(async () => textButton(dialog, "editor.toolbar.done").click());
    expect(document.activeElement).toBe(trigger);
    expect(editor.state.sliceDoc()).toBe(content);
    expect(undoDepth(editor.state)).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    if (abandon) await act(async () => editor.focus());
    const strike = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.command.strike"]',
    )!;
    await pointerClick(strike);
    expect(editor.state.sliceDoc()).toBe(
      abandon ? content + "~~~~" : content.replace("| x |", "| x |  | ~~~~ |"),
    );
    if (!abandon)
      expect(cells().map((cell) => cell.value)).toEqual([
        "a",
        "b",
        "c",
        "x",
        "",
        "~~~~",
      ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(undoDepth(editor.state)).toBe(1);
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(editor.state.sliceDoc()).toBe(content);
    expect(undoDepth(editor.state)).toBe(0);
  },
);

it("keeps inline Markdown formatting inside a displayed table", async () => {
  const content = "| a | b |\n| - | - |\n| x | y |";
  await render({ content });
  const input =
    container.querySelectorAll<HTMLInputElement>(".cm-md-table-cell")[2];
  const bold = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.bold"]',
  )!;
  await act(async () => {
    input.focus();
    input.setSelectionRange(0, 1);
    input.dispatchEvent(new Event("select"));
    bold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    bold.focus();
    bold.click();
  });
  expect(view().state.sliceDoc()).toBe(content.replace("| x |", "| **x** |"));
  expect(container.querySelectorAll(".cm-md-table-cell")).toHaveLength(4);
  expect(input.value).toBe("**x**");
  expect(input.nextElementSibling!.querySelector("strong")?.textContent).toBe(
    "x",
  );
});

it("drops the implicit target when leaving the toolbar for normal editing at the same position", async () => {
  const content = "| a | b | c |\n| - | - | - |\n| x |";
  await render({ content });
  const bold = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.bold"]',
  )!;
  await act(async () => {
    container
      .querySelectorAll<HTMLInputElement>(".cm-md-table-cell")[5]
      .focus();
    bold.focus();
    view().focus();
    bold.focus();
    bold.click();
  });
  expect(view().state.sliceDoc()).toBe(content + "****");
});

it("drops the toolbar's implicit target when external content changes at the same positions", async () => {
  const content = "| a | b | c |\n| - | - | - |\n| x |";
  await render({ content });
  const bold = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.bold"]',
  )!;
  await act(async () => {
    container
      .querySelectorAll<HTMLInputElement>(".cm-md-table-cell")[5]
      .focus();
    bold.focus();
  });
  const next = content.replace("x", "y");
  await render({ content: next });
  await act(async () => bold.click());
  expect(view().state.sliceDoc()).toBe(next + "****");
});

it.each(["text", "document", "source", "note"])(
  "forgets an implicit cell target after leaving for %s",
  async (destination) => {
    const content = "| a | b | c |\n| - | - | - |\n| x |\n\nAfter";
    await render({ content });
    await act(async () =>
      container
        .querySelectorAll<HTMLInputElement>(".cm-md-table-cell")[5]
        .focus(),
    );
    const bold = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="editor.command.bold"]',
      )!;
    if (destination === "document") {
      await act(async () => bold().focus());
      await render({ content: content.replace("x", "y") });
    } else if (destination === "source") {
      await render({ content, mode: "source" });
      await render({ content });
    } else if (destination === "note")
      await render({ content, documentId: "B" });
    else await act(async () => view().focus());
    const editor = view();
    const before = editor.state.sliceDoc();
    await act(async () => {
      editor.dispatch({
        selection: { anchor: before.indexOf("After"), head: before.length },
      });
      bold().dispatchEvent(new Event("pointerdown", { bubbles: true }));
      bold().focus();
      bold().click();
    });
    expect(editor.state.sliceDoc()).toBe(before.replace("After", "**After**"));
  },
);

it("exposes essential tools by default, enables every command and applies a block command from the keyboard", async () => {
  await render({ content: "Hello", mode: "preview" });
  const toolbar = container.querySelector('[role="toolbar"]')!;
  expect(toolbarLabels()).toEqual(expectedToolbarLabels(defaultTools));
  const dialog = await customizeToolbar();
  const actions = [
    "bold",
    "italic",
    "strike",
    "code",
    "link",
    ...blockActions,
    "image",
    "indent",
    "outdent",
    "toggleTask",
  ] as const;
  expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(
    actions.length,
  );
  for (const action of actions) {
    const checkbox = toolCheckbox(dialog, action);
    expect(checkbox.checked).toBe(defaultTools.some((tool) => tool === action));
    if (!checkbox.checked) await act(async () => checkbox.click());
  }
  await act(async () => textButton(dialog, "editor.toolbar.done").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(
    [...toolbar.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual(expectedToolbarLabels(actions));
  const editor = view();
  await act(async () => editor.dispatch({ selection: { anchor: 0, head: 5 } }));
  const heading = await chooseBlockStyle("heading2");
  expect(editor.state.sliceDoc()).toBe("## Hello");
  expect(document.activeElement).toBe(heading);
  await act(async () => {
    undo(editor);
  });
  expect(editor.state.sliceDoc()).toBe("Hello");
  const picker = vi
    .spyOn(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      "click",
    )
    .mockImplementation(() => {});
  await act(async () =>
    toolbar
      .querySelector<HTMLButtonElement>('[aria-label="editor.command.image"]')!
      .click(),
  );
  expect(picker).toHaveBeenCalledOnce();
  picker.mockRestore();
});

it("changes block style with the keyboard, preserves selection and follows cursor and undo", async () => {
  await render({ content: "Hello\n\nOther\n\n###### Hidden" });
  const editor = view();
  await act(async () => editor.dispatch({ selection: { anchor: 0, head: 5 } }));
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.toolbar.headings"]',
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const selected = document.querySelector<HTMLElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  await act(async () => {
    selected.focus();
    selected.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(document.activeElement?.textContent).toBe("editor.command.heading1");
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(editor.state.sliceDoc()).toBe("# Hello\n\nOther\n\n###### Hidden");
  expect(editor.state.selection.main.from).toBe(0);
  expect(editor.state.selection.main.to).toBe(7);
  expect(trigger.textContent).toBe("editor.command.heading1");
  expect(document.activeElement).toBe(trigger);
  expect(undoDepth(editor.state)).toBe(1);
  await chooseBlockStyle("paragraph");
  expect(editor.state.sliceDoc()).toBe("Hello\n\nOther\n\n###### Hidden");
  expect(trigger.textContent).toBe("editor.command.paragraph");
  await act(async () => {
    expect(undo(editor)).toBe(true);
  });
  expect(trigger.textContent).toBe("editor.command.heading1");
  await act(async () =>
    editor.dispatch({ selection: { anchor: editor.state.doc.length } }),
  );
  expect(trigger.textContent).toBe("editor.command.heading6");
  await pointerClick(trigger);
  const unavailable = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent === "editor.command.heading6")!;
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await act(async () =>
    editor.dispatch({
      selection: { anchor: editor.state.sliceDoc().indexOf("Other") },
    }),
  );
  expect(trigger.textContent).toBe("editor.command.paragraph");
});

it("keeps an implicit table cell while navigating and dismissing the block-style portal", async () => {
  const content = "| a | b | c |\n| - | - | - |\n| x |";
  await render({ content });
  const editor = view();
  await act(async () =>
    container
      .querySelectorAll<HTMLInputElement>(".cm-md-table-cell")[5]
      .focus(),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="editor.toolbar.headings"]',
  )!;
  await pointerClick(trigger);
  const option = document.querySelector<HTMLElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  await act(async () => {
    option.focus();
    option.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(trigger);
  await pointerClick(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.command.bold"]',
    )!,
  );
  expect(editor.state.sliceDoc()).toBe(
    content.replace("| x |", "| x |  | **** |"),
  );
  expect(undoDepth(editor.state)).toBe(1);
  await act(async () => {
    expect(undo(editor)).toBe(true);
  });
  expect(editor.state.sliceDoc()).toBe(content);
});

it.each([
  ["**bold** outside", "bold", 2, 6, true],
  ["**bold** outside", "bold", 2, 10, false],
  ["*italic*", "italic", 2, 4, true],
  ["~~strike~~", "strike", 2, 8, true],
  ["`code`", "code", 1, 5, true],
  ["[link](url)", "link", 1, 5, true],
  ["```md\n# **not a heading**\n```", "bold", 10, 15, false],
] as const)(
  "derives %s / %s activity from a node containing the whole selection",
  async (content, action, anchor, head, pressed) => {
    window.localStorage.setItem(
      toolbarStorageKey,
      JSON.stringify([...defaultTools, "strike", "code"]),
    );
    await render({ content });
    await act(async () => view().dispatch({ selection: { anchor, head } }));
    expect(
      container
        .querySelector(`[aria-label="editor.command.${action}"]`)
        ?.getAttribute("aria-pressed"),
    ).toBe(String(pressed));
    expect(
      container.querySelector('[aria-label="editor.toolbar.headings"]')
        ?.textContent,
    ).toBe("editor.command.paragraph");
  },
);

it("activates only the task list button on checkboxes and restores ordinary list activity", async () => {
  const content =
    "- [ ] **pending**\n- [x] done\n- bullet\n\n1. numbered\n2. [ ] ordered task";
  await render({ content });
  for (const [text, expected] of [
    ["pending", "task"],
    ["done", "task"],
    ["bullet", "bullet"],
    ["numbered", "numbered"],
    ["ordered task", "task"],
    ["pending", "task"],
  ]) {
    await act(async () =>
      view().dispatch({ selection: { anchor: content.indexOf(text) + 1 } }),
    );
    for (const action of ["bullet", "numbered", "task"]) {
      const button = container.querySelector(
        `[aria-label="editor.command.${action}"]`,
      )!;
      expect(button.getAttribute("aria-pressed")).toBe(
        String(action === expected),
      );
    }
    expect(
      container
        .querySelector('[aria-label="editor.command.bold"]')
        ?.getAttribute("aria-pressed"),
    ).toBe(String(text === "pending"));
  }
});

it("adds and removes tools immediately without changing the document, selection or history", async () => {
  const changed = vi.fn();
  await render({ content: "Hello", onContentChange: changed });
  const editor = view();
  await act(async () =>
    editor.dispatch({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 1, head: 4 },
    }),
  );
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  changed.mockClear();
  const dialog = await customizeToolbar();
  await act(async () => toolCheckbox(dialog, "bold").click());
  expect(toolCheckbox(dialog, "bold").checked).toBe(false);
  expect(toolbarLabels()).toEqual(
    expectedToolbarLabels(defaultTools.filter((tool) => tool !== "bold")),
  );
  await act(async () => toolCheckbox(dialog, "code").click());
  expect(toolCheckbox(dialog, "code").checked).toBe(true);
  expect(toolbarLabels()).toEqual(
    expectedToolbarLabels([
      "italic",
      "code",
      "link",
      "heading1",
      "heading2",
      "bullet",
      "numbered",
      "task",
      "image",
    ]),
  );
  expect(JSON.parse(window.localStorage.getItem(toolbarStorageKey)!)).toEqual([
    ...defaultTools.filter((tool) => tool !== "bold"),
    "code",
  ]);
  await act(async () => textButton(dialog, "editor.toolbar.done").click());
  expect(view()).toBe(editor);
  expect(editor.state.doc).toBe(doc);
  expect(editor.state.selection.eq(selection)).toBe(true);
  expect(undoDepth(editor.state)).toBe(1);
  expect(changed).not.toHaveBeenCalled();
  await act(async () => {
    expect(undo(editor)).toBe(true);
  });
  expect(editor.state.sliceDoc()).toBe("Hello");
  await act(async () => {
    expect(redo(editor)).toBe(true);
  });
  expect(editor.state.sliceDoc()).toBe("Hello!");
});

it("persists customized tools across notes, source/preview and a full remount", async () => {
  await render();
  const dialog = await customizeToolbar();
  await act(async () => toolCheckbox(dialog, "italic").click());
  await act(async () => toolCheckbox(dialog, "table").click());
  await act(async () => textButton(dialog, "editor.toolbar.done").click());
  const labels = expectedToolbarLabels([
    "bold",
    "link",
    "heading1",
    "heading2",
    "bullet",
    "numbered",
    "task",
    "table",
    "image",
  ]);
  expect(toolbarLabels()).toEqual(labels);
  await render({ documentId: "B", content: "Other note" });
  expect(toolbarLabels()).toEqual(labels);
  await render({ documentId: "B", content: "Other note", mode: "source" });
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
  await render({ documentId: "B", content: "Other note" });
  expect(toolbarLabels()).toEqual(labels);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(toolbarLabels()).toEqual(labels);
  const restored = await customizeToolbar();
  expect(toolCheckbox(restored, "italic").checked).toBe(false);
  expect(toolCheckbox(restored, "table").checked).toBe(true);
});

it("allows removing every tool, reopening an empty toolbar and resetting the saved defaults", async () => {
  const changed = vi.fn();
  await render({ onContentChange: changed });
  let dialog = await customizeToolbar();
  for (const tool of defaultTools)
    await act(async () => toolCheckbox(dialog, tool).click());
  expect(toolbarLabels()).toEqual([]);
  expect(window.localStorage.getItem(toolbarStorageKey)).toBe("[]");
  await act(async () => textButton(dialog, "editor.toolbar.done").click());
  await render({ mode: "source", onContentChange: changed });
  await render({ onContentChange: changed });
  expect(toolbarLabels()).toEqual([]);
  dialog = await customizeToolbar();
  expect(
    [
      ...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].every((input) => !input.checked),
  ).toBe(true);
  const reset = textButton(dialog, "editor.toolbar.reset");
  await act(async () => reset.click());
  expect(toolbarLabels()).toEqual(expectedToolbarLabels(defaultTools));
  expect(JSON.parse(window.localStorage.getItem(toolbarStorageKey)!)).toEqual(
    defaultTools,
  );
  for (const tool of defaultTools)
    expect(toolCheckbox(dialog, tool).checked).toBe(true);
  expect(view().state.sliceDoc()).toBe("A\n\n\nB\n\n");
  expect(changed).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(toolbarLabels()).toEqual(expectedToolbarLabels(defaultTools));
});

it.each(["Escape", "outside", "close", "done"])(
  "dismisses toolbar customization with %s and restores trigger focus",
  async (method) => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.toolbar.title"]',
    )!;
    const dialog = await customizeToolbar();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () =>
      dialog.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await act(async () => {
      if (method === "Escape")
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      else if (method === "outside")
        dialog.parentElement!.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true }),
        );
      else if (method === "close")
        dialog
          .querySelector<HTMLButtonElement>(
            '[aria-label="editor.toolbar.close"]',
          )!
          .click();
      else textButton(dialog, "editor.toolbar.done").click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  },
);

it.each(["unavailable", "setItem"])(
  "keeps customization usable and reports storage failure (%s) until a save succeeds",
  async (failure) => {
    const storageFailure =
      failure === "unavailable"
        ? vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
            throw new DOMException("Denied", "SecurityError");
          })
        : vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("Full", "QuotaExceededError");
          });
    const changed = vi.fn();
    await render({ content: "Keep this", onContentChange: changed });
    expect(toolbarLabels()).toEqual(expectedToolbarLabels(defaultTools));
    const dialog = await customizeToolbar();
    await act(async () => toolCheckbox(dialog, "bold").click());
    expect(toolbarLabels()).toEqual(
      expectedToolbarLabels(defaultTools.filter((tool) => tool !== "bold")),
    );
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        message: "editor.toolbar.saveError",
        tone: "error",
      }),
    ]);
    expect(view().state.sliceDoc()).toBe("Keep this");
    expect(undoDepth(view().state)).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    storageFailure.mockRestore();
    await act(async () => toolCheckbox(dialog, "bold").click());
    expect(getNotifications()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(toolbarStorageKey)!)).toEqual(
      expect.arrayContaining([...defaultTools]),
    );
  },
);

it("scrolls overflowing tools with the wheel while preserving native trackpad and zoom gestures", async () => {
  await render();
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')!;
  Object.defineProperties(toolbar, {
    clientWidth: { value: 300 },
    scrollWidth: { value: 800, configurable: true },
  });
  function wheel(options: WheelEventInit) {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...options,
    });
    toolbar.firstElementChild!.dispatchEvent(event);
    return event.defaultPrevented;
  }
  expect(wheel({ deltaY: 60 })).toBe(true);
  expect(toolbar.scrollLeft).toBe(60);
  expect(wheel({ deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(
    true,
  );
  expect(toolbar.scrollLeft).toBe(28);
  expect(wheel({ deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_PAGE })).toBe(true);
  expect(toolbar.scrollLeft).toBe(500);
  expect(wheel({ deltaX: -80, deltaY: 10 })).toBe(false);
  expect(wheel({ deltaY: 40, ctrlKey: true })).toBe(false);
  expect(toolbar.scrollLeft).toBe(500);
  expect(wheel({ deltaY: -1000 })).toBe(true);
  expect(toolbar.scrollLeft).toBe(0);
  Object.defineProperty(toolbar, "scrollWidth", { value: 300 });
  expect(wheel({ deltaY: 60 })).toBe(false);
  expect(toolbar.scrollLeft).toBe(0);
});

it("drags the toolbar without activating tools and preserves simple and keyboard clicks", async () => {
  await render();
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')!;
  Object.defineProperties(toolbar, {
    clientWidth: { value: 300 },
    scrollWidth: { value: 800 },
  });
  const image = toolbar.querySelector<HTMLButtonElement>(
    '[aria-label="editor.command.image"]',
  )!;
  const picker = vi
    .spyOn(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      "click",
    )
    .mockImplementation(() => {});
  function mouse(
    target: EventTarget,
    type: string,
    clientX: number,
    buttons = 0,
  ) {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        buttons,
        button: 0,
        detail: 1,
      }),
    );
  }
  await act(async () => {
    mouse(image, "mousedown", 200, 1);
    mouse(window, "mousemove", 120, 1);
    expect(toolbar.scrollLeft).toBe(80);
    expect(toolbar.dataset.dragging).toBe("true");
    mouse(window, "mouseup", 120);
    expect(toolbar.dataset.dragging).toBeUndefined();
    mouse(image, "click", 120);
  });
  expect(picker).not.toHaveBeenCalled();
  await act(async () => {
    mouse(image, "mousedown", 120, 1);
    mouse(window, "mousemove", 122, 1);
    mouse(window, "mouseup", 122);
    mouse(image, "click", 122);
  });
  expect(toolbar.scrollLeft).toBe(80);
  expect(picker).toHaveBeenCalledOnce();
  await act(async () => {
    mouse(image, "mousedown", 200, 1);
    mouse(window, "mousemove", 100, 1);
    window.dispatchEvent(new Event("blur"));
    mouse(window, "mousemove", 50, 1);
    expect(toolbar.scrollLeft).toBe(180);
    expect(toolbar.dataset.dragging).toBeUndefined();
    image.click();
  });
  expect(picker).toHaveBeenCalledTimes(2);
});

it("normalizes pasted line endings without changing newline counts", async () => {
  const changed = vi.fn();
  await render({ content: "A\r\nB", mode: "source", onContentChange: changed });
  const editor = view();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      types: ["text/plain"],
      getData: (format: string) => (format === "text/plain" ? "X\nY" : ""),
    },
  });
  await act(async () => {
    editor.contentDOM.dispatchEvent(event);
  });
  expect(editor.state.sliceDoc()).toBe("X\r\nYA\r\nB");
  expect(editor.state.doc.lines).toBe(3);
  expect(changed).toHaveBeenCalledExactlyOnceWith("X\r\nYA\r\nB");
});

it("does not delete selected text on an HTML-only paste", async () => {
  await render({ content: "Keep this", mode: "source" });
  const editor = view();
  await act(async () => editor.dispatch({ selection: { anchor: 0, head: 9 } }));
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      types: ["text/html"],
      getData: (format: string) =>
        format === "text/html" ? "<b>Other</b>" : "",
    },
  });
  await act(async () => {
    editor.contentDOM.dispatchEvent(event);
  });
  expect(editor.state.sliceDoc()).toBe("Keep this");
});

it.each([true, false])(
  "prepares note content and preview before paint (keyed: %s)",
  async (keyed) => {
    const snapshots: Array<{ content: string | null; heading: boolean }> = [];
    function Parent({ noteId }: { noteId: string }) {
      useLayoutEffect(() => {
        const dom = container.querySelector<HTMLElement>(".cm-editor");
        snapshots.push({
          content: dom ? EditorView.findFromDOM(dom)!.state.sliceDoc() : null,
          heading: container.querySelector(".cm-md-h1") !== null,
        });
      }, [noteId]);
      return (
        <MarkdownEditor
          key={keyed ? noteId : undefined}
          documentId={noteId}
          uploadImage={uploadImage}
          content={`# ${noteId}`}
          mode="preview"
          onContentChange={() => {}}
        />
      );
    }
    for (const noteId of ["A", "B"]) {
      await act(async () => root.render(<Parent noteId={noteId} />));
      expect(container.querySelectorAll(".markdown-toolbar")).toHaveLength(1);
      expect(container.querySelectorAll(".markdown-toolbar-host")).toHaveLength(
        1,
      );
    }
    expect(snapshots).toEqual([
      { content: "# A", heading: true },
      { content: "# B", heading: true },
    ]);
  },
);

it("resets history and destroys the view on a note change", async () => {
  await render();
  const first = view();
  await act(async () =>
    first.dispatch({ changes: { from: 0, insert: "edit" } }),
  );
  await render({ documentId: "B", content: "Other" });
  expect(view()).not.toBe(first);
  expect(first.dom.isConnected).toBe(false);
  expect(undoDepth(view().state)).toBe(0);
  expect(view().state.sliceDoc()).toBe("Other");
});

it.each(["source", "preview"] as const)(
  "cleans up StrictMode in %s and handles a focus request once",
  async (mode) => {
    const handled = vi.fn();
    await act(async () =>
      root.render(
        <StrictMode>
          <MarkdownEditor
            documentId="A"
            uploadImage={uploadImage}
            content="Test"
            mode={mode}
            focusRequest={1}
            onFocusRequestHandled={handled}
            onContentChange={() => {}}
          />
        </StrictMode>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(container.querySelectorAll(".markdown-toolbar-host")).toHaveLength(
      1,
    );
    const toolbarHost = view().scrollDOM.firstElementChild!;
    expect(toolbarHost.querySelectorAll(".markdown-toolbar")).toHaveLength(
      mode === "preview" ? 1 : 0,
    );
    expect(view().hasFocus).toBe(true);
    expect(handled).toHaveBeenCalledExactlyOnceWith(1);
  },
);
