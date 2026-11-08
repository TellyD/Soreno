// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesignFrame } from "../../domain/design";
import { DesignCanvas } from "./DesignCanvas";

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const pointer = (
  type: string,
  target: Element,
  clientX: number,
  clientY: number,
) =>
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }),
    );
  });

it("commits a frame drag once, at its end, in board units", () => {
  const frame: DesignFrame = {
    boardId: "b",
    id: "home",
    title: "Home",
    html: "<p>Hi</p>",
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    z: 1,
    updatedAt: "",
  };
  const onFrameChange = vi.fn();
  act(() =>
    root.render(
      <DesignCanvas
        frames={[frame]}
        viewKey="drag"
        target={{ kind: "frame", frameId: "home" }}
        onTargetChange={vi.fn()}
        targeting={false}
        onTargetingChange={vi.fn()}
        onFrameChange={onFrameChange}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    ),
  );
  const label = container.querySelector(".design-canvas-frame-label")!;
  const viewport = container.querySelector('[role="region"]')!;
  pointer("pointerdown", label, 100, 100);
  pointer("pointermove", viewport, 130, 90);
  pointer("pointermove", viewport, 150, 140);
  expect(onFrameChange).not.toHaveBeenCalled();
  pointer("pointerup", viewport, 150, 140);
  expect(onFrameChange).toHaveBeenCalledOnce();
  expect(onFrameChange).toHaveBeenCalledWith({ ...frame, x: 60, y: 60 });
});

it("commits a nudge when focus leaves, then nudges the newly selected frame", () => {
  const frame = (id: string, x: number): DesignFrame => ({
    boardId: "b",
    id,
    title: id,
    html: "",
    x,
    y: 0,
    width: 200,
    height: 200,
    z: 1,
    updatedAt: "",
  });
  const frames = [frame("a", 0), frame("b", 400)];
  const onFrameChange = vi.fn();
  const render = (frameId: string) =>
    act(() =>
      root.render(
        <DesignCanvas
          frames={frames}
          viewKey="nudge"
          target={{ kind: "frame", frameId }}
          onTargetChange={vi.fn()}
          targeting={false}
          onTargetingChange={vi.fn()}
          onFrameChange={onFrameChange}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
  const key = (type: string, target: Element, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key }));
    });
  render("a");
  const [a, b] = container.querySelectorAll<HTMLElement>(
    ".design-canvas-frame",
  );
  act(() => a.focus());
  key("keydown", a, "ArrowDown");
  const prompt = document.createElement("textarea");
  document.body.append(prompt);
  act(() => prompt.focus());
  expect(onFrameChange).toHaveBeenCalledWith({ ...frames[0], y: 1 });
  render("b");
  key("keydown", b, "ArrowRight");
  // Selecting A while B's arrow is still held saves B before A moves.
  render("a");
  key("keydown", a, "ArrowUp");
  expect(onFrameChange).toHaveBeenLastCalledWith({ ...frames[1], x: 401 });
  key("keyup", a, "ArrowUp");
  expect(onFrameChange).toHaveBeenLastCalledWith({ ...frames[0], y: -1 });
  expect(onFrameChange).toHaveBeenCalledTimes(3);
  prompt.remove();
});

it("only pans and zooms a read-only preview: a frame drag moves the view, Delete keeps the frame", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  const frame: DesignFrame = {
    boardId: "b",
    id: "home",
    title: "Home",
    html: "<p>Hi</p>",
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    z: 1,
    updatedAt: "",
  };
  act(() =>
    root.render(<DesignCanvas readOnly viewKey="read-only" frames={[frame]} />),
  );
  const element = container.querySelector<HTMLElement>(".design-canvas-frame")!;
  const world = container.querySelector<HTMLElement>(".design-canvas-world")!;
  const viewport = container.querySelector('[role="region"]')!;
  const before = world.style.transform;

  pointer(
    "pointerdown",
    element.querySelector(".design-canvas-frame-label")!,
    100,
    100,
  );
  pointer("pointermove", viewport, 150, 140);
  pointer("pointerup", viewport, 150, 140);
  act(() => element.focus());
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }),
    );
  });

  expect(element.style.left).toBe("10px");
  expect(world.style.transform).not.toBe(before);
  expect(container.querySelectorAll(".design-canvas-frame")).toHaveLength(1);
  expect(container.querySelector(".design-canvas-handle")).toBeNull();

  // Zoom keys act only with focus in the preview: a terminal beside it keeps "!".
  const press = (target: Element, init: KeyboardEventInit) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
    });
  const panned = world.style.transform;
  press(document.body, { key: "!", code: "Digit1", shiftKey: true });
  expect(world.style.transform).toBe(panned);
  press(viewport, { key: "!", code: "Digit1", shiftKey: true });
  expect(world.style.transform).toBe(before);
  press(viewport, { key: "=", code: "Equal", ctrlKey: true });
  expect(world.style.transform).toContain("scale(1.25)");
});

it("fits a board's first frames once, then keeps its view across remounts", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  const frames: DesignFrame[] = [
    {
      boardId: "b",
      id: "wide",
      title: "Wide",
      html: "",
      x: 0,
      y: 0,
      width: 2000,
      height: 1000,
      z: 1,
      updatedAt: "",
    },
  ];
  const mount = (viewKey: string, shown: readonly DesignFrame[]) =>
    act(() =>
      root.render(<DesignCanvas readOnly viewKey={viewKey} frames={shown} />),
    );
  const transform = () =>
    container.querySelector<HTMLElement>(".design-canvas-world")!.style
      .transform;
  const remount = () => {
    act(() => root.unmount());
    root = createRoot(container);
  };

  // An empty board keeps no view: its first frames are fitted on the next visit.
  mount("empty-first", []);
  remount();
  mount("empty-first", frames);
  expect(transform()).toContain("scale(0.452)");

  // A user's view survives a reload that shows no frame at first.
  remount();
  mount("kept", frames);
  expect(transform()).toContain("scale(0.452)");
  act(() =>
    container
      .querySelector<HTMLElement>('[aria-label="design.canvas.zoomIn"]')!
      .click(),
  );
  const zoomed = transform();
  expect(zoomed).not.toContain("scale(0.452)");
  remount();
  mount("kept", []);
  mount("kept", frames);
  expect(transform()).toBe(zoomed);
});

it("zooms, fits and toggles targeting from board-wide keys, not while typing", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  const frame: DesignFrame = {
    boardId: "b",
    id: "wide",
    title: "Wide",
    html: "",
    x: 0,
    y: 0,
    width: 2000,
    height: 1000,
    z: 1,
    updatedAt: "",
  };
  const onTargetingChange = vi.fn();
  act(() =>
    root.render(
      <DesignCanvas
        frames={[frame]}
        viewKey="shortcuts"
        target={{ kind: "board" }}
        onTargetChange={vi.fn()}
        targeting={false}
        onTargetingChange={onTargetingChange}
        onFrameChange={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        shortcuts
      />,
    ),
  );
  const transform = () =>
    container.querySelector<HTMLElement>(".design-canvas-world")!.style
      .transform;
  const press = (init: KeyboardEventInit, target: Element = document.body) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
    });
  press({ key: "!", code: "Digit0", shiftKey: true });
  expect(transform()).toContain("scale(1)");
  press({ key: "!", code: "Digit1", shiftKey: true });
  expect(transform()).toContain("scale(0.452)");
  press({ key: "=", code: "Equal", ctrlKey: true });
  expect(transform()).toContain("scale(0.565");
  const prompt = document.createElement("textarea");
  document.body.append(prompt);
  press({ key: "t", code: "KeyT" }, prompt);
  expect(onTargetingChange).not.toHaveBeenCalled();
  press({ key: "t", code: "KeyT" });
  expect(onTargetingChange).toHaveBeenCalledWith(true);
  press({ key: "t", code: "KeyT", repeat: true });
  expect(onTargetingChange).toHaveBeenCalledOnce();
  prompt.remove();
});

it("marks only the frames the agent is reworking as busy", () => {
  const frame = (id: string): DesignFrame => ({
    boardId: "b",
    id,
    title: id,
    html: "",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    z: 1,
    updatedAt: "",
  });
  act(() =>
    root.render(
      <DesignCanvas
        frames={[frame("a"), frame("b")]}
        viewKey="busy"
        target={{ kind: "board" }}
        onTargetChange={vi.fn()}
        targeting={false}
        onTargetingChange={vi.fn()}
        onFrameChange={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        busyFrameIds={new Set(["b"])}
      />,
    ),
  );
  const busy = [
    ...container.querySelectorAll<HTMLElement>('[role="group"]'),
  ].map((element) => [element.getAttribute("aria-label"), element.ariaBusy]);
  expect(busy).toEqual([
    ["a", null],
    ["b", "true"],
  ]);
});
