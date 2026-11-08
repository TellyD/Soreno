// @vitest-environment jsdom
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { BlockType, EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitComparison } from "../../domain/projectGit";
import { stubEditorGeometry } from "../markdown-editor/testGeometry";
import GitDiffView from "./GitDiffView";
import { stubModalSelector } from "../ui/testTopLayer";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

const comparison: GitComparison = {
  path: "src/value.ts",
  oldPath: null,
  version: "v1",
  before: {
    text: "const value = 1;\n",
    oid: "a",
    size: 17,
    mode: "100644",
    reason: null,
  },
  after: {
    text: "const value = 2;",
    oid: "b",
    size: 16,
    mode: "100644",
    reason: null,
  },
};
const largeBefore = Array.from(
  { length: 600 },
  (_, index) => `const item${index} = "stable content for row ${index}";`,
).join("\n");
const largeAfter = largeBefore
  .split("\n")
  .map((line, index) =>
    index % 100 === 0 ? line.replace("stable", "updated") : line,
  )
  .join("\n");
let container: HTMLDivElement;
let root: Root;
let restoreGeometry: () => void;

beforeEach(() => {
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  restoreGeometry = stubEditorGeometry();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
  container.remove();
  restoreGeometry();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(
  value = comparison,
  toolbarAction?: string,
  showMinimap = false,
) {
  await act(async () =>
    root.render(
      <GitDiffView
        comparison={value}
        showMinimap={showMinimap}
        toolbarActions={
          toolbarAction ? <button>{toolbarAction}</button> : undefined
        }
      />,
    ),
  );
}
async function click(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.click();
  });
}
function pointerEvent(
  type: string,
  pointerId: number,
  init: MouseEventInit = {},
) {
  const event = new PointerEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}
async function openOptions() {
  await click(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Options du diff"]',
    )!,
  );
  return document.querySelector<HTMLElement>(".git-diff-menu")!;
}

it("applies layout and wrapping options", async () => {
  await render(comparison, "Précédent");
  expect(
    container.querySelector(".git-diff-toolbar-actions")?.textContent,
  ).toBe("Précédent");
  expect(container.querySelector(".cm-mergeView")).toBeNull();
  expect(container.querySelectorAll(".cm-lineWrapping")).toHaveLength(1);
  expect(
    container.querySelector(".cm-changedText, .cm-deletedText"),
  ).not.toBeNull();
  expect(container.querySelector(".cm-changedLine")).not.toBeNull();
  expect(container.querySelector(".cm-deletedChunk")).not.toBeNull();
  expect(
    container
      .querySelector('.cm-content[contenteditable="false"]')
      ?.getAttribute("tabindex"),
  ).toBe("0");
  expect(
    container.querySelector(".cm-merge-revert, .cm-mergeControls"),
  ).toBeNull();

  const menu = await openOptions();
  const radios = menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
  expect(radios).toHaveLength(2);
  expect(radios[0].getAttribute("aria-checked")).toBe("true");
  const split = [...radios].find((item) =>
    item.textContent?.includes("Séparé"),
  )!;
  await click(split);
  expect(split.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector(".cm-mergeView")).not.toBeNull();
  expect(
    container.querySelector(".cm-changedText, .cm-deletedText"),
  ).not.toBeNull();
  expect(container.querySelector(".cm-merge-a .cm-changedLine")).not.toBeNull();
  expect(container.querySelector(".cm-merge-b .cm-changedLine")).not.toBeNull();
  const splitContents = container.querySelectorAll<HTMLElement>(
    '.cm-content[contenteditable="false"]',
  );
  expect(splitContents).toHaveLength(2);
  expect([...splitContents].every((content) => content.tabIndex === 0)).toBe(
    true,
  );

  const wrap = menu.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;
  expect(wrap.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelectorAll(".cm-lineWrapping")).toHaveLength(2);
  await click(wrap);
  expect(wrap.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  await click(wrap);
  expect(wrap.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelectorAll(".cm-lineWrapping")).toHaveLength(2);

  // Moving to a file whose diff is still loading remounts the view.
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.querySelector(".cm-mergeView")).not.toBeNull();
});

it("maps changes and the viewport in the interactive minimap", async () => {
  const before = Array.from(
    { length: 120 },
    (_, index) => `stable line ${index + 1}`,
  ).join("\n");
  const after = before.replace("stable line 100", "updated line 100");
  await render(
    {
      ...comparison,
      before: { ...comparison.before, text: before },
      after: { ...comparison.after, text: after },
    },
    undefined,
    true,
  );

  const minimap = container.querySelector<HTMLElement>(
    '[role="scrollbar"][aria-label="Minimap du diff"]',
  )!;
  expect(
    minimap.querySelectorAll(".git-diff-minimap-marker.is-deleted"),
  ).toHaveLength(1);
  expect(
    minimap.querySelectorAll(".git-diff-minimap-marker.is-added"),
  ).toHaveLength(1);

  const scroller = container.querySelector<HTMLElement>(".cm-scroller")!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 400 },
  });
  scroller.scrollTop = 100;
  scroller.dispatchEvent(new Event("scroll"));
  expect(minimap.getAttribute("aria-valuenow")).toBe("33");
  const viewport = minimap.querySelector<HTMLElement>(
    ".git-diff-minimap-viewport",
  )!;
  expect(viewport.style.top).toBe("25%");
  expect(viewport.style.height).toBe("25%");

  vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 20,
    width: 20,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await act(async () =>
    minimap.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientY: 50 }),
    ),
  );
  expect(scroller.scrollTop).toBe(150);
});

it("only navigates the minimap with its active primary pointer", async () => {
  await render(comparison, undefined, true);
  const minimap = container.querySelector<HTMLElement>(
    '[role="scrollbar"][aria-label="Minimap du diff"]',
  )!;
  const scroller = container.querySelector<HTMLElement>(".cm-scroller")!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 400 },
  });
  vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 20,
    width: 20,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const setPointerCapture = vi.fn();
  Object.defineProperty(minimap, "setPointerCapture", {
    configurable: true,
    value: setPointerCapture,
  });
  scroller.scrollTop = 100;

  await act(async () => {
    minimap.dispatchEvent(
      pointerEvent("pointermove", 2, { buttons: 1, clientY: 100 }),
    );
    minimap.dispatchEvent(
      pointerEvent("pointerdown", 2, {
        button: 2,
        buttons: 2,
        clientY: 100,
      }),
    );
  });
  expect(scroller.scrollTop).toBe(100);
  expect(setPointerCapture).not.toHaveBeenCalled();

  await act(async () =>
    minimap.dispatchEvent(
      pointerEvent("pointerdown", 1, {
        button: 0,
        buttons: 1,
        clientY: 50,
      }),
    ),
  );
  expect(scroller.scrollTop).toBe(150);
  expect(setPointerCapture).toHaveBeenCalledWith(1);

  await act(async () =>
    minimap.dispatchEvent(
      pointerEvent("pointermove", 2, { buttons: 1, clientY: 100 }),
    ),
  );
  expect(scroller.scrollTop).toBe(150);

  await act(async () =>
    minimap.dispatchEvent(
      pointerEvent("pointermove", 1, { buttons: 1, clientY: 100 }),
    ),
  );
  expect(scroller.scrollTop).toBe(300);

  await act(async () => {
    minimap.dispatchEvent(pointerEvent("pointerup", 1));
    minimap.dispatchEvent(
      pointerEvent("pointermove", 1, { buttons: 1, clientY: 50 }),
    );
  });
  expect(scroller.scrollTop).toBe(300);

  for (const type of ["pointercancel", "lostpointercapture"]) {
    await act(async () => {
      minimap.dispatchEvent(
        pointerEvent("pointerdown", 1, {
          button: 0,
          buttons: 1,
          clientY: 50,
        }),
      );
      minimap.dispatchEvent(pointerEvent(type, 1));
      minimap.dispatchEvent(
        pointerEvent("pointermove", 1, { buttons: 1, clientY: 100 }),
      );
    });
    expect(scroller.scrollTop).toBe(150);
  }
});

it("keeps a unified addition marker out of its large deletion widget", async () => {
  await render(
    {
      ...comparison,
      path: "large-change.txt",
      before: {
        ...comparison.before,
        text: Array.from(
          { length: 120 },
          (_, index) => `deleted line ${index + 1}`,
        ).join("\n"),
      },
      after: { ...comparison.after, text: "replacement line" },
    },
    undefined,
    true,
  );

  const afterEditor = EditorView.findFromDOM(
    container.querySelector<HTMLElement>(".cm-content")!,
  )!;
  const chunks = getChunks(afterEditor.state)!.chunks;
  expect(chunks).toHaveLength(1);
  await act(async () => {
    afterEditor.dispatch({ selection: { anchor: chunks[0].fromB } });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const block = afterEditor.lineBlockAt(chunks[0].fromB);
  const parts = block.type;
  if (typeof parts === "number") throw new Error("Expected a composite block");
  const text = parts.find((part) => part.type === BlockType.Text)!;
  const deletion = parts.find((part) => part.type === BlockType.WidgetBefore)!;
  expect(text).toBeDefined();
  expect(deletion).toBeDefined();
  const contentHeight = afterEditor.contentHeight;

  await vi.waitFor(() => {
    const added = container.querySelector<HTMLElement>(
      ".git-diff-minimap-marker.is-added",
    )!;
    const deleted = container.querySelector<HTMLElement>(
      ".git-diff-minimap-marker.is-deleted",
    )!;
    expect(Number.parseFloat(added.style.top)).toBeCloseTo(
      ((afterEditor.documentPadding.top + text.top) / contentHeight) * 100,
      5,
    );
    expect(Number.parseFloat(added.style.height)).toBeCloseTo(
      (text.height / contentHeight) * 100,
      5,
    );
    expect(Number.parseFloat(deleted.style.top)).toBeCloseTo(
      ((afterEditor.documentPadding.top + deletion.top) / contentHeight) * 100,
      5,
    );
    expect(Number.parseFloat(deleted.style.height)).toBeCloseTo(
      (deletion.height / contentHeight) * 100,
      5,
    );
  });
});

it("keeps a split deletion marker out of the terminal spacer", async () => {
  await render(
    {
      ...comparison,
      path: "large-change.txt",
      before: { ...comparison.before, text: "obsolete value" },
      after: {
        ...comparison.after,
        text: Array.from(
          { length: 120 },
          (_, index) => `fresh row ${index + 1}`,
        ).join("\n"),
      },
    },
    undefined,
    true,
  );
  const menu = await openOptions();
  await click(
    [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes("Séparé"),
    )!,
  );

  const contents = [...container.querySelectorAll<HTMLElement>(".cm-content")];
  const beforeEditor = EditorView.findFromDOM(contents[0])!;
  const afterEditor = EditorView.findFromDOM(contents[1])!;
  const chunks = getChunks(afterEditor.state)!.chunks;
  expect(chunks).toHaveLength(1);
  await vi.waitFor(() => {
    const type = beforeEditor.lineBlockAt(chunks[0].fromA).type;
    expect(typeof type).not.toBe("number");
    expect(
      typeof type === "number"
        ? undefined
        : type.find((part) => part.type === BlockType.WidgetAfter),
    ).toBeDefined();
  });
  const parts = beforeEditor.lineBlockAt(chunks[0].fromA).type;
  if (typeof parts === "number") throw new Error("Expected a composite block");
  const text = parts.find((part) => part.type === BlockType.Text)!;
  const spacer = parts.find((part) => part.type === BlockType.WidgetAfter)!;
  const contentHeight = Math.max(
    beforeEditor.contentHeight,
    afterEditor.contentHeight,
  );

  await vi.waitFor(() => {
    const deleted = container.querySelector<HTMLElement>(
      ".git-diff-minimap-marker.is-deleted",
    )!;
    expect(Number.parseFloat(deleted.style.top)).toBeCloseTo(
      ((beforeEditor.documentPadding.top + text.top) / contentHeight) * 100,
      5,
    );
    expect(Number.parseFloat(deleted.style.height)).toBeCloseTo(
      (text.height / contentHeight) * 100,
      5,
    );
    expect(text.bottom).toBeLessThanOrEqual(spacer.top);
  });
});

it.each(["unified", "split"])(
  "uses rendered geometry for a large deletion followed by a hunk in %s mode",
  async (layout) => {
    const beforeLines = Array.from(
      { length: 180 },
      (_, index) => `stable line ${index + 1}`,
    );
    const afterLines = beforeLines.filter(
      (_, index) => index === 0 || index > 80,
    );
    afterLines[afterLines.indexOf("stable line 151")] = "updated line 151";
    await render(
      {
        ...comparison,
        before: { ...comparison.before, text: beforeLines.join("\n") },
        after: { ...comparison.after, text: afterLines.join("\n") },
      },
      undefined,
      true,
    );
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }

    expect(container.querySelector(".cm-collapsedLines")).not.toBeNull();
    const contents = [
      ...container.querySelectorAll<HTMLElement>(".cm-content"),
    ];
    const afterEditor = EditorView.findFromDOM(contents[contents.length - 1])!;
    const beforeEditor =
      layout === "split" ? EditorView.findFromDOM(contents[0])! : undefined;
    const chunks = getChunks(afterEditor.state)!.chunks;
    expect(chunks).toHaveLength(2);
    const blockOfType = (
      view: EditorView,
      position: number,
      type: BlockType,
    ) => {
      const block = view.lineBlockAt(position);
      return typeof block.type === "number"
        ? block
        : (block.type.find((part) => part.type === type) ?? block);
    };
    // Geometry is read live: the first CodeMirror measure changes padding and heights.
    const addedTop = () =>
      ((afterEditor.documentPadding.top +
        blockOfType(afterEditor, chunks[1].fromB, BlockType.Text).top) /
        Math.max(beforeEditor?.contentHeight ?? 0, afterEditor.contentHeight)) *
      100;
    const deletionView = beforeEditor ?? afterEditor;
    const deletionPosition = beforeEditor ? chunks[0].fromA : chunks[0].fromB;

    let collapsedAddedTop = 0;
    await vi.waitFor(() => {
      const added = container.querySelectorAll<HTMLElement>(
        ".git-diff-minimap-marker.is-added",
      );
      const deleted = container.querySelectorAll<HTMLElement>(
        ".git-diff-minimap-marker.is-deleted",
      );
      expect(added).toHaveLength(1);
      expect(deleted).toHaveLength(2);
      collapsedAddedTop = addedTop();
      expect(Number.parseFloat(added[0].style.top)).toBeCloseTo(
        collapsedAddedTop,
        5,
      );
      expect(Number.parseFloat(deleted[0].style.top)).toBeCloseTo(
        ((deletionView.documentPadding.top +
          blockOfType(
            deletionView,
            deletionPosition,
            beforeEditor ? BlockType.Text : BlockType.WidgetBefore,
          ).top) /
          Math.max(
            beforeEditor?.contentHeight ?? 0,
            afterEditor.contentHeight,
          )) *
          100,
        5,
      );
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".cm-collapsedLines")!.click();
      for (let frame = 0; frame < 4; frame += 1)
        await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await vi.waitFor(() => {
      const expandedAddedTop = addedTop();
      expect(expandedAddedTop).not.toBeCloseTo(collapsedAddedTop, 5);
      expect(
        Number.parseFloat(
          container.querySelector<HTMLElement>(
            ".git-diff-minimap-marker.is-added",
          )!.style.top,
        ),
      ).toBeCloseTo(expandedAddedTop, 5);
    });
  },
);

it.each(["unified", "split"])(
  "scrolls through an entirely deleted file from the minimap in %s mode",
  async (layout) => {
    await render(
      {
        ...comparison,
        before: {
          ...comparison.before,
          text: Array.from(
            { length: 120 },
            (_, index) => `deleted line ${index + 1}`,
          ).join("\n"),
        },
        after: { ...comparison.after, text: "" },
      },
      undefined,
      true,
    );
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }
    const minimap = container.querySelector<HTMLElement>(
      '[role="scrollbar"][aria-label="Minimap du diff"]',
    )!;
    const scroller = container.querySelector<HTMLElement>(
      layout === "split" ? ".cm-mergeView" : ".cm-scroller",
    )!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 20,
      width: 20,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await act(async () =>
      minimap.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientY: 100 }),
      ),
    );
    expect(scroller.scrollTop).toBe(900);
  },
);

it.each(["unified", "split"])(
  "keeps ArrowDown scrolling monotonic in %s mode",
  async (layout) => {
    await render(
      {
        ...comparison,
        before: { ...comparison.before, text: largeBefore },
        after: { ...comparison.after, text: largeAfter },
      },
      undefined,
      true,
    );
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }
    const minimap = container.querySelector<HTMLElement>(
      '[role="scrollbar"][aria-label="Minimap du diff"]',
    )!;
    const scroller = container.querySelector<HTMLElement>(
      layout === "split" ? ".cm-mergeView" : ".cm-scroller",
    )!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event("scroll"));

    await act(async () =>
      minimap.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(scroller.scrollTop).toBeGreaterThan(600);
  },
);

it.each(["unified", "split"])(
  "keeps the focused editor, recomputes collapsed context after a %s content refresh and persists showing all lines",
  async (layout) => {
    const before = Array.from(
      { length: 120 },
      (_, index) => `stable line ${index + 1}`,
    ).join("\n");
    const after = before
      .split("\n")
      .map((line, index) => (index < 20 ? `${line} changed` : line))
      .join("\n");
    const initial: GitComparison = {
      ...comparison,
      before: { ...comparison.before, text: before },
      after: { ...comparison.after, text: after },
    };
    await render(initial);
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }
    const contents = [
      ...container.querySelectorAll<HTMLElement>(".cm-content"),
    ];
    const afterEditor = EditorView.findFromDOM(contents[contents.length - 1])!;
    await act(async () => afterEditor.focus());

    const refreshed = {
      ...initial,
      version: "v2",
      after: {
        ...initial.after,
        text: before.replace("stable line 1", "stable line 1 changed"),
      },
    };
    await render(refreshed);
    expect(
      EditorView.findFromDOM(
        container.querySelectorAll<HTMLElement>(".cm-content")[
          contents.length - 1
        ],
      ),
    ).toBe(afterEditor);
    expect(document.activeElement).toBe(contents[contents.length - 1]);
    expect(container.querySelectorAll(".cm-collapsedLines")).toHaveLength(
      layout === "split" ? 2 : 1,
    );

    const menu =
      document.querySelector<HTMLElement>(".git-diff-menu") ??
      (await openOptions());
    const showAll = [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ].find((item) => item.textContent?.includes("Afficher toutes les lignes"))!;
    await click(showAll);
    expect(showAll.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".cm-collapsedLines")).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await render(refreshed);
    expect(container.querySelector(".cm-mergeView") !== null).toBe(
      layout === "split",
    );
    expect(container.querySelector(".cm-collapsedLines")).toBeNull();
  },
);

it("preserves the editor and selection when only comparison metadata changes", async () => {
  await render();
  const content = container.querySelector<HTMLElement>(".cm-content")!;
  const editor = EditorView.findFromDOM(content)!;
  editor.dispatch({ selection: { anchor: 4 } });
  await render(
    {
      ...comparison,
      version: "v2",
      before: { ...comparison.before, oid: "new-before" },
      after: { ...comparison.after, oid: "new-after" },
    },
    "Actualisation",
  );
  expect(container.querySelector(".cm-content")).toBe(content);
  expect(EditorView.findFromDOM(content)).toBe(editor);
  expect(editor.state.selection.main.anchor).toBe(4);

  await render({
    ...comparison,
    after: { ...comparison.after, text: "const value = 3;" },
  });
  expect(
    EditorView.findFromDOM(
      container.querySelector<HTMLElement>(".cm-content")!,
    )?.state.doc.toString(),
  ).toBe("const value = 3;");
  expect(container.querySelector(".cm-content")).toBe(content);
});

it.each(["unified", "split"])(
  "updates %s content in place without losing selection, focus or scrolling",
  async (layout) => {
    await render();
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }
    const contents = [
      ...container.querySelectorAll<HTMLElement>(".cm-content"),
    ];
    const editors = contents.map((content) => EditorView.findFromDOM(content)!);
    const afterEditor = editors[editors.length - 1];
    const scroller = container.querySelector<HTMLElement>(
      layout === "split" ? ".cm-mergeView" : ".cm-scroller",
    )!;
    for (const editor of editors)
      editor.dispatch({ selection: { anchor: 6, head: 11 } });
    await act(async () => afterEditor.focus());
    scroller.scrollTop = 120;
    scroller.scrollLeft = 25;
    const prefix = "// updated\n";
    await render({
      ...comparison,
      version: "v2",
      before: { ...comparison.before, text: prefix + comparison.before.text },
      after: { ...comparison.after, text: prefix + comparison.after.text },
    });
    expect([...container.querySelectorAll(".cm-content")]).toEqual(contents);
    expect(document.activeElement).toBe(contents[contents.length - 1]);
    expect(scroller.scrollTop).toBe(120);
    expect(scroller.scrollLeft).toBe(25);
    for (const editor of editors) {
      expect(editor.state.selection.main.anchor).toBe(prefix.length + 6);
      expect(editor.state.selection.main.head).toBe(prefix.length + 11);
    }
    expect(afterEditor.state.doc.toString()).toBe(
      prefix + comparison.after.text,
    );
    expect(
      (layout === "split"
        ? editors[0].state.doc
        : getOriginalDoc(editors[0].state)
      ).toString(),
    ).toBe(prefix + comparison.before.text);

    await render({ ...comparison, after: { ...comparison.after, text: "" } });
    expect(afterEditor.state.doc.length).toBe(0);
    expect(afterEditor.state.selection.main.head).toBe(0);

    await render({
      ...comparison,
      before: { ...comparison.before, text: "const value = 1;\r\nnext\r\n" },
      after: { ...comparison.after, text: "const value = 2;\r\nnext\r\n" },
    });
    expect(afterEditor.state.doc.toString()).toBe("const value = 2;\nnext\n");
    expect(
      (layout === "split"
        ? editors[0].state.doc
        : getOriginalDoc(editors[0].state)
      ).toString(),
    ).toBe("const value = 1;\nnext\n");
  },
);

it.each(["unified", "split"])(
  "keeps dispersed changes precise in %s mode and on refresh",
  async (layout) => {
    const largeComparison: GitComparison = {
      ...comparison,
      before: { ...comparison.before, text: largeBefore },
      after: { ...comparison.after, text: largeAfter },
    };
    await render(largeComparison);
    if (layout === "split") {
      const menu = await openOptions();
      await click(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes("Séparé"),
        )!,
      );
    }

    const contents = [
      ...container.querySelectorAll<HTMLElement>(".cm-content"),
    ];
    const editors = contents.map((content) => EditorView.findFromDOM(content)!);
    const afterEditor = editors[editors.length - 1];
    const expectedLines = [1, 101, 201, 301, 401, 501].map((line) => ({
      a: [line, line],
      b: [line, line],
    }));
    const chunkLines = () => {
      const original =
        layout === "split"
          ? editors[0].state.doc
          : getOriginalDoc(afterEditor.state);
      const result = getChunks(afterEditor.state);
      expect(result).not.toBeNull();
      return result!.chunks.map((chunk) => ({
        a: [
          original.lineAt(chunk.fromA).number,
          original.lineAt(chunk.toA - 1).number,
        ],
        b: [
          afterEditor.state.doc.lineAt(chunk.fromB).number,
          afterEditor.state.doc.lineAt(chunk.toB - 1).number,
        ],
      }));
    };
    expect(chunkLines()).toEqual(expectedLines);

    const selection = afterEditor.state.doc.line(76).from + 12;
    afterEditor.dispatch({ selection: { anchor: selection } });
    const refreshedBefore = largeBefore
      .split("\n")
      .map((line, index) =>
        index % 100 === 25 ? line.replace("stable", "shared") : line,
      )
      .join("\n");
    const refreshedAfter = largeAfter
      .split("\n")
      .map((line, index) =>
        index % 100 === 25 ? line.replace("stable", "shared") : line,
      )
      .join("\n");
    await render({
      ...largeComparison,
      version: "v2",
      before: { ...largeComparison.before, text: refreshedBefore },
      after: { ...largeComparison.after, text: refreshedAfter },
    });

    expect([...container.querySelectorAll(".cm-content")]).toEqual(contents);
    expect(afterEditor.state.selection.main.anchor).toBe(selection);
    expect(afterEditor.state.doc.lineAt(selection).text).toContain("item75");
    expect(chunkLines()).toEqual(expectedLines);
  },
);

it("reserves text emphasis for partial changes", async () => {
  await render({
    ...comparison,
    before: { ...comparison.before, text: "head\nold\ntail\n" },
    after: {
      ...comparison.after,
      text: "head\nadded one\nadded two\nold\ntail\n",
    },
  });
  const addedLines = [...container.querySelectorAll(".cm-wholeLineChange")];
  expect(addedLines).toHaveLength(2);
  expect(
    addedLines.every((line) => line.querySelector(".cm-changedText")),
  ).toBe(true);
  const showAll = [
    ...(await openOptions()).querySelectorAll<HTMLElement>(
      '[role="menuitemcheckbox"]',
    ),
  ].find((item) => item.textContent?.includes("Afficher toutes les lignes"))!;
  await click(showAll);
  expect(showAll.getAttribute("aria-checked")).toBe("true");
  expect(
    [...container.querySelectorAll<HTMLElement>(".cm-wholeLineChange")].map(
      (line) => line.textContent,
    ),
  ).toEqual(["added one", "added two"]);

  await render({
    ...comparison,
    before: {
      ...comparison.before,
      text: ".rule {\n  border-left: 1px solid;\n  background: blue;\n}\n\n.tail {}\n",
    },
    after: {
      ...comparison.after,
      text: ".rule {\n  background: blue;\n}\n\n.new {\n  display: block;\n}\n\n.tail {}\n",
    },
  });
  expect(
    [...container.querySelectorAll<HTMLElement>(".cm-wholeLineChange")]
      .map((line) => line.textContent)
      .filter(Boolean),
  ).toEqual([".new {", "  display: block;", "}"]);
  expect(
    [...container.querySelectorAll<HTMLElement>(".cm-line")]
      .find((line) => line.textContent === "  background: blue;")
      ?.classList.contains("cm-wholeLineChange"),
  ).toBe(false);

  await render(comparison);
  expect(container.querySelector(".cm-wholeLineChange")).toBeNull();
  expect(
    container.querySelector(".cm-changedText, .cm-deletedText"),
  ).not.toBeNull();
});

it("aligns changed lines before diffing their characters", async () => {
  const restore = [
    "    if (textRef.current.length === 0) {",
    "      setCommentText(draftToRestore);",
    "      moveInputSelection({",
    "        start: draftToRestore.length,",
    "        end: draftToRestore.length,",
    "      });",
    "    }",
    "    focusCommentInput();",
  ];
  const before = [
    "  if (editingCommentId) {",
    "    const success = await editComment(editingCommentId, contentToSubmit);",
    "    if (success) {",
    "      setEditingCommentId(null);",
    "      return;",
    "    }",
    "",
    ...restore.map((line) => `  ${line}`),
    "    return;",
    "  }",
    "",
    "  const success = await addComment(contentToSubmit);",
    "  if (!success) {",
    ...restore,
    "  }",
    "",
  ].join("\n");
  const after = [
    "  const restoreDraft = () => {",
    "    const typedMeanwhile = textRef.current;",
    "    const restored =",
    "      typedMeanwhile.length === 0",
    "        ? draftToRestore",
    "        : `${draftToRestore}\\n${typedMeanwhile}`;",
    "    setCommentText(restored);",
    "    moveInputSelection({ start: restored.length, end: restored.length });",
    "    focusCommentInput();",
    "  };",
    "",
    "  if (editedId) {",
    "    const success = await editComment(editedId, contentToSubmit);",
    "    if (success) {",
    "      setEditingCommentId((current) =>",
    "        current === editedId ? null : current,",
    "      );",
    "      return;",
    "    }",
    "",
    "    restoreDraft();",
    "    return;",
    "  }",
    "",
    "  const success = await addComment(contentToSubmit);",
    "  if (!success) {",
    "    restoreDraft();",
    "  }",
    "",
  ].join("\n");
  await render({
    ...comparison,
    before: { ...comparison.before, text: before },
    after: { ...comparison.after, text: after },
  });
  const editor = EditorView.findFromDOM(
    container.querySelector<HTMLElement>(".cm-content")!,
  )!;
  const changedLines = new Set(
    getChunks(editor.state)!.chunks.flatMap((chunk) => {
      const lines: string[] = [];
      for (let pos = chunk.fromB; pos < chunk.toB; ) {
        const line = editor.state.doc.lineAt(pos);
        lines.push(line.text);
        pos = line.to + 1;
      }
      return lines;
    }),
  );
  for (const unchanged of [
    "    if (success) {",
    "  const success = await addComment(contentToSubmit);",
    "  if (!success) {",
  ])
    expect(changedLines).not.toContain(unchanged);
});

it("wraps long additions and deletions without altering their text", async () => {
  const before = `const value = "${"previous value ".repeat(30)}";`;
  const after = `const value = "${"updated value ".repeat(30)}";`;
  await render({
    ...comparison,
    before: { ...comparison.before, text: before },
    after: { ...comparison.after, text: after },
  });
  const content = container.querySelector<HTMLElement>(".cm-content")!;
  expect(content.classList.contains("cm-lineWrapping")).toBe(true);
  expect(content.querySelector(".cm-deletedChunk")?.textContent).toBe(before);
  expect(content.querySelector(".cm-changedLine")?.textContent).toBe(after);
  expect(EditorView.findFromDOM(content)?.state.doc.toString()).toBe(after);
  expect(container.querySelector(".cm-deletedLineGutter")).not.toBeNull();
  expect(container.querySelector(".cm-changedLineGutter")).not.toBeNull();
});

it("explains a read-only conflict comparison without merge controls", async () => {
  await render({
    ...comparison,
    conflictStages: [
      { stage: 1, content: { ...comparison.before, oid: "base" } },
      { stage: 2, content: { ...comparison.before, oid: "ours" } },
      { stage: 3, content: { ...comparison.after, oid: "theirs" } },
    ],
  });
  expect(container.textContent).toContain("compare Nôtre au contenu actuel");
  expect(
    container.querySelector(".cm-merge-revert, .cm-mergeControls"),
  ).toBeNull();
});

it("keeps unknown files as raw text and explains unavailable content", async () => {
  await render({
    ...comparison,
    path: "NOTICE.custom",
    before: { ...comparison.before, text: "raw <value>\n" },
    after: { ...comparison.after, text: "raw >value<\n" },
  });
  expect(container.querySelector(".cm-content")?.textContent).toContain(
    "raw >value<",
  );
  await render({
    ...comparison,
    before: { ...comparison.before, text: null, reason: "binary" },
    after: { ...comparison.after, text: null, reason: "tooLarge" },
  });
  expect(container.querySelector(".cm-editor")).toBeNull();
  expect(container.querySelector('[aria-label="Options du diff"]')).toBeNull();
  expect(container.textContent).toContain("contenu binaire");
  expect(container.textContent).toContain("trop volumineux");
  await render({
    ...comparison,
    before: { ...comparison.before, text: null, reason: "symlink" },
    after: { ...comparison.after, text: null, reason: "submodule" },
  });
  expect(container.textContent).toContain("lien symbolique");
  expect(container.textContent).toContain("sous-module");
  await render({
    ...comparison,
    before: { ...comparison.before, text: null, reason: "nonUtf8" },
    after: { ...comparison.after, text: null, reason: "nonUtf8" },
  });
  expect(container.textContent).toContain("n’est pas encodé en UTF-8 valide");
  expect(container.textContent).not.toContain("Contenu indisponible: nonUtf8");
});

it("previews binary images and keeps the reason for sides without a preview", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  await render({
    ...comparison,
    path: "assets/logo.png",
    before: { ...comparison.before, text: "", mode: "000000" },
    after: {
      ...comparison.after,
      text: null,
      reason: "binary",
      imageDataUrl: image,
    },
  });
  expect(container.querySelector(".cm-editor")).toBeNull();
  expect(
    Array.from(container.querySelectorAll("img"), (img) => [
      img.getAttribute("alt"),
      img.getAttribute("src"),
    ]),
  ).toEqual([["Ajouté — logo.png", image]]);
  expect(container.textContent).not.toContain("contenu binaire");
  const preview = container.querySelector("img")!;
  Object.defineProperties(preview, {
    naturalWidth: { value: 640 },
    naturalHeight: { value: 480 },
  });
  await act(async () => preview.dispatchEvent(new Event("load")));
  expect(container.textContent).toContain("640 × 480 px");
  await render({
    ...comparison,
    path: "assets/logo.png",
    before: { ...comparison.before, text: null, reason: "binary", size: 1000 },
    after: {
      ...comparison.after,
      text: null,
      reason: "binary",
      size: 3500,
      imageDataUrl: image,
    },
  });
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.textContent).toContain("Le contenu binaire");
  expect(container.textContent).toMatch(/3,5\sko\s\(\+2,5\sko\)/);
});
