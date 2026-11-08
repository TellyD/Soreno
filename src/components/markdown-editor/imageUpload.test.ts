// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubEditorGeometry } from "./testGeometry";
import { externalUpdate, markdownSupport } from "./document";
import {
  cancelImagePosition,
  imageAnchors,
  insertUploadedImages,
  reserveImagePosition,
} from "./imageUpload";
import { deferred } from "../../testing/deferred";
let views: EditorView[] = [];
let restoreGeometry: () => void;
beforeEach(() => {
  restoreGeometry = stubEditorGeometry();
});
afterEach(() => {
  views.forEach((view) => view.destroy());
  views = [];
  restoreGeometry();
});
function editor(doc: string, from = doc.length, to = from) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: from, head: to },
      extensions: [markdownSupport, history(), imageAnchors],
    }),
  });
  views.push(view);
  return view;
}
const image = (name = "picture.png") =>
  new File(["image"], name, { type: "image/png" });
it("maps the insertion anchor through typing without putting a placeholder in the text", async () => {
  const view = editor("AB", 1);
  const pending = deferred<string>();
  const upload = vi.fn().mockReturnValue(pending.promise);
  const done = insertUploadedImages(view, {
    files: [image()],
    signal: new AbortController().signal,
    onError: vi.fn(),
    upload,
  });
  expect(view.state.sliceDoc()).toBe("AB");
  view.dispatch({ changes: { from: 0, insert: "new " } });
  pending.resolve("https://example.com/picture.png");
  await done;
  expect(upload).toHaveBeenCalledWith(expect.any(File));
  expect(view.state.sliceDoc()).toBe(
    "new A\n\n![picture.png](<https://example.com/picture.png>)\n\nB",
  );
  undo(view);
  expect(view.state.sliceDoc()).toBe("new AB");
  expect(view.state.field(imageAnchors).size).toBe(0);
});
it.each(["selection", "cursor", "external", "abort", "cancel"] as const)(
  "ignores results after %s invalidation",
  async (reason) => {
    const view = editor("ABCDE", 2, reason === "selection" ? 4 : 2);
    const anchor = reserveImagePosition(view);
    const pending = deferred<string>();
    const controller = new AbortController();
    const onError = vi.fn();
    const done = insertUploadedImages(view, {
      files: [image()],
      signal: controller.signal,
      anchor,
      onError,
      upload: () => pending.promise,
    });
    if (reason === "selection" || reason === "cursor")
      view.dispatch({ changes: { from: 1, to: 3, insert: "" } });
    if (reason === "external")
      view.dispatch({
        changes: { from: 0, to: 5, insert: "replacement" },
        annotations: externalUpdate.of(true),
      });
    if (reason === "abort") {
      controller.abort();
      view.destroy();
      views = views.filter((other) => other !== view);
    }
    if (reason === "cancel") cancelImagePosition(view, anchor);
    const expected = view.state.sliceDoc();
    pending.resolve("https://example.com/image.png");
    await done;
    expect(view.state.sliceDoc()).toBe(expected);
    expect(onError).not.toHaveBeenCalled();
  },
);
it("preserves typed text at a zero-width anchor and does not reverse its range", async () => {
  const view = editor("A", 1);
  const pending = deferred<string>();
  const done = insertUploadedImages(view, {
    files: [image()],
    signal: new AbortController().signal,
    onError: vi.fn(),
    upload: () => pending.promise,
  });
  view.dispatch({ changes: { from: 1, insert: " typed" } });
  pending.resolve("https://example.com/a.png");
  await done;
  expect(view.state.sliceDoc()).toMatch(/^A typed\n\n!\[/);
});
it("inserts successes in file order despite out-of-order completion and reports failures", async () => {
  const view = editor("");
  const first = deferred<string>(),
    last = deferred<string>();
  const error = new Error("failed");
  const onError = vi.fn();
  const upload = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(error)
    .mockReturnValueOnce(last.promise);
  const done = insertUploadedImages(view, {
    files: [image("one.png"), image("bad.png"), image("three.png")],
    signal: new AbortController().signal,
    onError,
    upload,
  });
  last.resolve("https://example.com/3.png");
  first.resolve("https://example.com/1.png");
  await done;
  expect(view.state.sliceDoc()).toBe(
    "\n\n![one.png](<https://example.com/1.png>)\n\n![three.png](<https://example.com/3.png>)\n\n",
  );
  expect(view.state.selection.main.head).toBe(view.state.doc.length);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});
it("keeps original text on upload failure", async () => {
  const view = editor("selected", 0, 8);
  const onError = vi.fn();
  await insertUploadedImages(view, {
    files: [image()],
    signal: new AbortController().signal,
    onError,
    upload: async () => {
      throw new Error("disk full");
    },
  });
  expect(view.state.sliceDoc()).toBe("selected");
  expect(onError).toHaveBeenCalledOnce();
});
it("escapes alt text and protects URLs with whitespace or parentheses", async () => {
  const view = editor("");
  await insertUploadedImages(view, {
    files: [image("a[b]\\c.png")],
    signal: new AbortController().signal,
    onError: vi.fn(),
    upload: async () => "https://example.com/a b(c).png",
  });
  expect(view.state.sliceDoc().trim()).toBe(
    "![a\\[b\\]\\\\c.png](<https://example.com/a%20b(c).png>)",
  );
});
