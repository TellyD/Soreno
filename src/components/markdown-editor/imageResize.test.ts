// @vitest-environment jsdom
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseImageWidth } from "../../domain/imageSize";
import { markdownSupport } from "./document";
import { livePreview } from "./livePreview";
import { stubEditorGeometry } from "./testGeometry";

const labels = {
  codeLanguage: "Code language",
  plainText: "Plain text",
  copyCode: "Copy code",
  codeCopied: "Code copied",
  copyCodeError: "Copy failed",
  selectImage: "Select image",
  resizeImage: "Resize image",
  tableCell: "Cell",
  tableAddRow: "Add row",
  tableAddColumn: "Add column",
  toggleTask: "Task",
  imageError: "Failed",
  linkError: "Failed",
  onError: vi.fn(),
  openImage: vi.fn(),
};
const image = '![photo](<https://example.com/a.png> "Existing title")';
const original = `Before\n\n${image}\n\nAfter`;
let view: EditorView;
let parent: HTMLElement;
let restoreGeometry: () => void;
let display: Compartment;
let readOnly: Compartment;
beforeEach(() => {
  restoreGeometry = stubEditorGeometry();
  parent = document.createElement("div");
  document.body.append(parent);
  display = new Compartment();
  readOnly = new Compartment();
});
afterEach(() => {
  view?.destroy();
  parent.remove();
  restoreGeometry();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
function open(doc = original) {
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdownSupport,
        history(),
        keymap.of(defaultKeymap),
        display.of(livePreview(labels)),
        readOnly.of(EditorState.readOnly.of(false)),
      ],
    }),
  });
  Object.defineProperty(view.contentDOM, "clientWidth", {
    configurable: true,
    value: 1000,
  });
  const dom = view.dom.querySelector<HTMLElement>(".cm-md-image")!;
  vi.spyOn(dom, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, parseFloat(dom.style.width) || 720, 400),
  );
  dom.click();
  const handle = dom.querySelector<HTMLElement>(".cm-md-image-resize")!;
  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    captured = false;
  };
  return { dom, handle };
}
function pointer(handle: HTMLElement, type: string, x: number) {
  const event = new MouseEvent(type, {
    clientX: x,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  // jsdom does not implement PointerEvent handler properties; exercise the same callbacks directly.
  const handler = handle[`on${type}` as "onpointerdown"];
  handler?.call(handle, event as PointerEvent);
}
function key(handle: HTMLElement, name: string, shiftKey = false) {
  handle.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: name,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}
it("previews dragging without saving, commits once, and preserves URL/title and undo/redo", () => {
  const { dom, handle } = open();
  const img = dom.querySelector("img");
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointermove", 520);
  expect(dom.style.width).toBe("520px");
  expect(view.state.sliceDoc()).toBe(original);
  pointer(handle, "pointermove", 400);
  pointer(handle, "pointerup", 400);
  expect(view.state.sliceDoc()).toBe(
    original.replace(image, `${image}<!-- soreno:image-width=400 -->`),
  );
  expect(dom.style.width).toBe("400px");
  expect(dom.querySelector("img")).toBe(img);
  expect(undoDepth(view.state)).toBe(1);
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe(`${image}<!-- soreno:image-width=400 -->`);
  undo(view);
  expect(view.state.sliceDoc()).toBe(original);
  expect(dom.style.width).toBe("");
  redo(view);
  expect(dom.style.width).toBe("400px");
  expect(handle.hidden).toBe(false);
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe(`${image}<!-- soreno:image-width=400 -->`);
  pointer(handle, "pointerdown", 400);
  pointer(handle, "pointermove", 300);
  pointer(handle, "pointerup", 300);
  expect(view.state.sliceDoc().match(/soreno:image-width=/gu)).toHaveLength(1);
  expect(dom.style.width).toBe("300px");
  undo(view);
  expect(dom.style.width).toBe("400px");
});
it("restores saved widths in a new editor and source-mode round trip, deleting metadata with the image", () => {
  const doc = original.replace(
    image,
    `${image}<!-- soreno:image-width=350 -->`,
  );
  const { dom } = open(doc);
  expect(dom.style.width).toBe("350px");
  expect(undoDepth(view.state)).toBe(0);
  view.dispatch({ effects: display.reconfigure([]) });
  expect(view.contentDOM.textContent).toContain("soreno:image-width=350");
  view.dispatch({ effects: display.reconfigure(livePreview(labels)) });
  expect(view.dom.querySelector<HTMLElement>(".cm-md-image")!.style.width).toBe(
    "350px",
  );
  expect(view.contentDOM.textContent).not.toContain("soreno:image-width");
  key(view.contentDOM, "Delete");
  expect(view.state.sliceDoc()).toBe("Before\n\n\n\nAfter");
  undo(view);
  expect(view.state.sliceDoc()).toBe(doc);
});
it.each([
  `${image}<!-- telaoi:image-width=350 -->`,
  `${image}\n\n<!-- soreno:image-width=350 -->\n\n<!-- soreno:image-width=407 -->`,
])(
  "keeps widths saved before the Soreno rename or moved by Linear into their own blocks, and rewrites them on resize: %j",
  (saved) => {
    const { dom, handle } = open(original.replace(image, saved));
    expect(dom.style.width).toBe("350px");
    expect(view.contentDOM.textContent).not.toContain("image-width");
    pointer(handle, "pointerdown", 350);
    pointer(handle, "pointermove", 300);
    pointer(handle, "pointerup", 300);
    expect(view.state.sliceDoc()).toBe(
      original.replace(image, `${image}<!-- soreno:image-width=300 -->`),
    );
  },
);
it("does not resize with arrow keys or advertise keyboard resizing", () => {
  const { dom, handle } = open();
  expect(handle.tabIndex).toBe(-1);
  handle.focus();
  for (const name of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    key(handle, name);
    key(handle, name, true);
  }
  expect(dom.style.width).toBe("");
  expect(view.state.sliceDoc()).toBe(original);
  expect(undoDepth(view.state)).toBe(0);
});
it("clamps mouse resizing to the minimum and available width", () => {
  const { dom, handle } = open();
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointermove", -9000);
  pointer(handle, "pointerup", -9000);
  expect(dom.style.width).toBe("48px");
  pointer(handle, "pointerdown", 48);
  pointer(handle, "pointermove", 9000);
  pointer(handle, "pointerup", 9000);
  expect(dom.style.width).toBe("1000px");
});
it("keeps undo/redo and deletion available while the resize handle has keyboard focus", () => {
  const { dom, handle } = open();
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointermove", 710);
  pointer(handle, "pointerup", 710);
  handle.focus();
  handle.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(view.state.sliceDoc()).toBe(original);
  handle.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(dom.style.width).toBe("710px");
  key(handle, "Delete");
  expect(view.state.sliceDoc()).toBe("Before\n\n\n\nAfter");
});
it.each(["pointercancel", "lostpointercapture", "Escape"])(
  "cancels a drag on %s without saving",
  (event) => {
    const { dom, handle } = open();
    pointer(handle, "pointerdown", 720);
    pointer(handle, "pointermove", 300);
    if (event === "Escape") key(handle, event);
    else pointer(handle, event, 300);
    pointer(handle, "pointerup", 300);
    expect(dom.style.width).toBe("");
    expect(view.state.sliceDoc()).toBe(original);
    expect(undoDepth(view.state)).toBe(0);
  },
);
it("does not save a simple click or let a stale drag overwrite another document edit", () => {
  const { dom, handle } = open();
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointerup", 720);
  expect(view.state.sliceDoc()).toBe(original);
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointermove", 300);
  view.dispatch({ changes: { from: 0, insert: "New\n\n" } });
  pointer(handle, "pointerup", 300);
  expect(view.state.sliceDoc()).toBe(`New\n\n${original}`);
  expect(dom.style.width).toBe("");
});
it("cancels when switching to source and hides the handle in read-only mode", () => {
  const { handle } = open();
  pointer(handle, "pointerdown", 720);
  pointer(handle, "pointermove", 300);
  view.dispatch({ effects: display.reconfigure([]) });
  pointer(handle, "pointerup", 300);
  expect(view.state.sliceDoc()).toBe(original);
  view.dispatch({
    effects: [
      display.reconfigure(livePreview(labels)),
      readOnly.reconfigure(EditorState.readOnly.of(true)),
    ],
  });
  const control = view.dom.querySelector<HTMLElement>(".cm-md-image-resize")!;
  expect(control.hidden).toBe(true);
  key(control, "ArrowLeft");
  pointer(control, "pointerdown", 720);
  pointer(control, "pointermove", 300);
  pointer(control, "pointerup", 300);
  expect(view.state.sliceDoc()).toBe(original);
});
it.each(["0", "47", "4097", "99999", "NaN", "-10", "300.5"])(
  "rejects invalid stored widths: %s",
  (value) => {
    expect(
      parseImageWidth(`<!-- soreno:image-width=${value} -->`),
    ).toBeUndefined();
  },
);
