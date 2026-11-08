// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentTabReorder } from "./useAgentTabReorder";

type HookResult = ReturnType<typeof useAgentTabReorder>;
type HarnessProps = {
  axis?: "horizontal" | "vertical";
  disabled?: boolean;
  ids?: string[];
  onClose?: () => void;
  onCreate?: () => void;
  onReorder: (id: string, index: number) => void;
  canSplit?: (id: string, side: "left" | "right") => boolean;
  dropIndexBounds?: (id: string) => readonly [number, number];
  onSplit?: (id: string, side: "left" | "right") => void;
  projectId?: string;
  status?: string;
  withSplitTarget?: boolean;
};

let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let result: HookResult;
let props: HarnessProps;

function Harness({
  axis = "horizontal",
  disabled = false,
  ids = ["a", "b", "c"],
  onClose = () => {},
  onCreate = () => {},
  onReorder,
  canSplit,
  onSplit,
  dropIndexBounds,
  projectId = "project-a",
  status = "idle",
  withSplitTarget = false,
}: HarnessProps) {
  const splitTargetRef = useRef<HTMLDivElement>(null);
  result = useAgentTabReorder({
    axis,
    ids,
    projectId,
    disabled,
    onReorder,
    canSplit,
    onSplit,
    dropIndexBounds,
    splitTargetRef: withSplitTarget ? splitTargetRef : undefined,
  });
  return (
    <>
      <nav ref={result.containerRef} data-status={status}>
        {ids.map((id) => (
          <div
            key={id}
            data-item={id}
            ref={(element) => {
              if (element) result.itemRefs.current.set(id, element);
              else result.itemRefs.current.delete(id);
            }}
          >
            <button
              data-tab={id}
              onPointerDown={(event) => result.startDrag(id, event)}
            >
              {id}
            </button>
            <button data-close={id} onClick={onClose}>
              close
            </button>
          </div>
        ))}
        <button data-create onClick={onCreate}>
          create
        </button>
      </nav>
      {withSplitTarget ? <div ref={splitTargetRef} data-split-target /> : null}
    </>
  );
}

function rect(left: number, right: number, top = 0, bottom = 40): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function geometry(
  scrollSize = 300,
  axis: "horizontal" | "vertical" = "horizontal",
) {
  const nav = host.querySelector("nav")!;
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: 300 });
  Object.defineProperty(nav, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(nav, "scrollWidth", {
    configurable: true,
    value: axis === "horizontal" ? scrollSize : 300,
  });
  Object.defineProperty(nav, "scrollHeight", {
    configurable: true,
    value: axis === "vertical" ? scrollSize : 300,
  });
  nav.getBoundingClientRect = () => rect(0, 300, 0, 300);
  [...host.querySelectorAll<HTMLDivElement>("[data-item]")].forEach(
    (item, index) => {
      item.getBoundingClientRect = () =>
        axis === "horizontal"
          ? rect(
              index * 100 - nav.scrollLeft,
              (index + 1) * 100 - nav.scrollLeft,
            )
          : rect(
              0,
              300,
              index * 100 - nav.scrollTop,
              (index + 1) * 100 - nav.scrollTop,
            );
    },
  );
  const splitTarget = host.querySelector<HTMLElement>("[data-split-target]");
  if (splitTarget)
    splitTarget.getBoundingClientRect = () => rect(0, 300, 320, 620);
  return nav;
}

function tab(id: string) {
  return host.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
}

function pointer(
  target: EventTarget,
  type: string,
  { button = 0, id = 1, pointerType = "mouse", x = 0, y = 20 } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
  });
  target.dispatchEvent(event);
  return event;
}

async function send(target: EventTarget, type: string, init = {}) {
  let event!: MouseEvent;
  await act(async () => {
    event = pointer(target, type, init);
  });
  return event;
}

async function render(next: Partial<HarnessProps> = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(<Harness {...props} />));
  geometry(
    props.ids && props.ids.length > 3 ? props.ids.length * 100 : 300,
    props.axis,
  );
}

async function begin(id: string, from: number, to: number, pointerId = 1) {
  await send(tab(id), "pointerdown", { id: pointerId, x: from });
  await send(document, "pointermove", { id: pointerId, x: to });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  props = { onReorder: vi.fn() };
  await render();
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("reorders in both directions from stable DOM geometry", async () => {
  const onReorder = vi.fn();
  await render({ onReorder });

  await begin("a", 50, 280);
  expect(result).toMatchObject({
    draggingId: "a",
    dropBeforeId: null,
    dropAtEnd: true,
    isReordering: true,
  });
  await send(document, "pointerup", { x: 280 });
  expect(onReorder).toHaveBeenLastCalledWith("a", 2);
  expect(result.isReordering).toBe(false);

  await begin("c", 250, 10, 2);
  expect(result.dropBeforeId).toBe("a");
  await send(document, "pointerup", { id: 2, x: 10 });
  expect(onReorder).toHaveBeenLastCalledWith("c", 0);
});

it("drops eligible tabs into either terminal half instead of reordering", async () => {
  const onReorder = vi.fn();
  const onSplit = vi.fn();
  await render({
    canSplit: () => true,
    onReorder,
    onSplit,
    withSplitTarget: true,
  });

  await send(tab("b"), "pointerdown", { x: 150, y: 20 });
  await send(document, "pointermove", { x: 60, y: 400 });
  expect(result).toMatchObject({
    draggingId: "b",
    dropBeforeId: null,
    dropAtEnd: false,
    splitDropSide: "left",
    isReordering: true,
  });
  await send(document, "pointerup", { x: 60, y: 400 });
  expect(onSplit).toHaveBeenLastCalledWith("b", "left");
  expect(onReorder).not.toHaveBeenCalled();

  await send(tab("c"), "pointerdown", { id: 2, x: 250, y: 20 });
  await send(document, "pointermove", { id: 2, x: 240, y: 400 });
  expect(result.splitDropSide).toBe("right");
  await send(document, "pointerup", { id: 2, x: 240, y: 400 });
  expect(onSplit).toHaveBeenLastCalledWith("c", "right");
  expect(onSplit).toHaveBeenCalledTimes(2);
  expect(onReorder).not.toHaveBeenCalled();
});

it("keeps the drop indicator and reorder within caller bounds", async () => {
  const onReorder = vi.fn();
  await render({
    ids: ["p", "a", "b"],
    dropIndexBounds: (id) => (id === "p" ? [0, 0] : [1, 2]),
    onReorder,
  });

  await begin("b", 250, 10);
  expect(result.dropBeforeId).toBe("a");
  await send(document, "pointerup", { x: 10 });
  expect(onReorder).toHaveBeenLastCalledWith("b", 1);

  await begin("p", 50, 280, 2);
  expect(result).toMatchObject({ dropBeforeId: "a", dropAtEnd: false });
  await send(document, "pointerup", { id: 2, x: 280 });
  expect(onReorder).toHaveBeenCalledTimes(1);
});

it("rejects invalid split targets and clears their indicator on cancellation", async () => {
  const onReorder = vi.fn();
  const onSplit = vi.fn();
  const canSplit = vi.fn(
    (_id: string, side: "left" | "right") => side === "right",
  );
  await render({ canSplit, onReorder, onSplit, withSplitTarget: true });

  await send(tab("b"), "pointerdown", { x: 150, y: 20 });
  await send(document, "pointermove", { x: 60, y: 400 });
  expect(canSplit).toHaveBeenCalledWith("b", "left");
  expect(result.splitDropSide).toBeNull();
  await send(document, "pointermove", { x: 240, y: 400 });
  expect(result.splitDropSide).toBe("right");
  await send(document, "pointermove", { x: 60, y: 400 });
  expect(result.splitDropSide).toBeNull();
  await send(document, "pointerup", { x: 60, y: 400 });
  expect(onSplit).not.toHaveBeenCalled();
  expect(onReorder).not.toHaveBeenCalled();

  await render({ canSplit: () => true });
  await send(tab("b"), "pointerdown", { id: 2, x: 150, y: 20 });
  await send(document, "pointermove", { id: 2, x: 240, y: 400 });
  expect(result.splitDropSide).toBe("right");
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    ),
  );
  expect(result).toMatchObject({
    draggingId: null,
    splitDropSide: null,
    isReordering: false,
  });
  await send(document, "pointerup", { id: 2, x: 240, y: 400 });
  expect(onSplit).not.toHaveBeenCalled();
});

it("reorders vertically from the same stable geometry", async () => {
  const onReorder = vi.fn();
  await render({ axis: "vertical", onReorder });

  await send(tab("a"), "pointerdown", { x: 20, y: 50 });
  await send(document, "pointermove", { x: 20, y: 280 });
  expect(result).toMatchObject({
    draggingId: "a",
    dropBeforeId: null,
    dropAtEnd: true,
    isReordering: true,
  });
  await send(document, "pointerup", { x: 20, y: 280 });
  expect(onReorder).toHaveBeenLastCalledWith("a", 2);

  await send(tab("c"), "pointerdown", { id: 2, x: 20, y: 250 });
  await send(document, "pointermove", { id: 2, x: 20, y: 10 });
  expect(result.dropBeforeId).toBe("a");
  await send(document, "pointerup", { id: 2, x: 20, y: 10 });
  expect(onReorder).toHaveBeenLastCalledWith("c", 0);
});

it("keeps ordinary clicks below the horizontal threshold and suppresses a completed drag click", async () => {
  const selected = vi.fn();
  tab("a").onclick = selected;

  await send(tab("a"), "pointerdown", { x: 50 });
  await send(document, "pointermove", { x: 53, y: 200 });
  expect(result.isReordering).toBe(false);
  await send(document, "pointerup", { x: 53, y: 20 });
  tab("a").click();
  expect(selected).toHaveBeenCalledOnce();

  await send(tab("a"), "pointerdown", { id: 2, x: 50 });
  const move = await send(document, "pointermove", { id: 2, x: 54 });
  expect(move.defaultPrevented).toBe(true);
  expect(result.isReordering).toBe(true);
  await send(document, "pointerup", { id: 2, x: 54 });
  tab("a").click();
  expect(selected).toHaveBeenCalledOnce();
});

it("keeps a jittery click on a splittable tab a click", async () => {
  const onSplit = vi.fn();
  await render({ canSplit: () => true, onSplit, withSplitTarget: true });
  const selected = vi.fn();
  tab("b").onclick = selected;

  await send(tab("b"), "pointerdown", { x: 150, y: 20 });
  await send(document, "pointerup", { x: 150, y: 30 });
  tab("b").click();
  await send(tab("b"), "pointerdown", { id: 2, x: 150, y: 20 });
  await send(document, "pointermove", { id: 2, x: 152, y: 28 });
  expect(result.isReordering).toBe(false);
  await send(document, "pointerup", { id: 2, x: 152, y: 28 });
  tab("b").click();
  expect(selected).toHaveBeenCalledTimes(2);

  await send(tab("b"), "pointerdown", { id: 3, x: 150, y: 20 });
  await send(document, "pointermove", { id: 3, x: 150, y: 32 });
  expect(result.isReordering).toBe(true);
  await send(document, "pointerup", { id: 3, x: 150, y: 32 });
  tab("b").click();
  expect(selected).toHaveBeenCalledTimes(2);
  expect(onSplit).not.toHaveBeenCalled();
});

it("accepts only the matching primary mouse gesture", async () => {
  const onReorder = vi.fn();
  await render({ onReorder });
  for (const [pointerType, button] of [
    ["touch", 0],
    ["pen", 0],
    ["mouse", 1],
    ["mouse", 2],
  ] as const) {
    await send(tab("a"), "pointerdown", { button, id: 4, pointerType, x: 50 });
    await send(document, "pointermove", { button, id: 4, pointerType, x: 280 });
    await send(document, "pointerup", { button, id: 4, pointerType, x: 280 });
    expect(result.isReordering).toBe(false);
  }

  await send(tab("a"), "pointerdown", { id: 7, x: 50 });
  await send(document, "pointermove", { id: 8, x: 280 });
  await send(document, "pointerup", { id: 8, x: 280 });
  expect(result.isReordering).toBe(false);
  await send(document, "pointermove", { id: 7, x: 280 });
  expect(result.isReordering).toBe(true);
  await send(document, "pointerup", { id: 7, x: 280 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", 2);
});

it("suppresses only the click generated after a drag, including close and create actions", async () => {
  const onClose = vi.fn();
  const onCreate = vi.fn();
  await render({ onClose, onCreate });
  const close = host.querySelector<HTMLButtonElement>("[data-close=a]")!;
  const create = host.querySelector<HTMLButtonElement>("[data-create]")!;

  await begin("a", 50, 200);
  await send(close, "pointerup", { x: 200 });
  close.click();
  expect(onClose).not.toHaveBeenCalled();
  await send(close, "pointerdown", { id: 2, x: 20 });
  close.click();
  expect(onClose).toHaveBeenCalledOnce();

  await begin("a", 50, 280, 3);
  await send(create, "pointerup", { id: 3, x: 280 });
  create.click();
  expect(onCreate).not.toHaveBeenCalled();
  await send(create, "pointerdown", { id: 4, x: 280 });
  create.click();
  expect(onCreate).toHaveBeenCalledOnce();
});

it("cancels on Escape, pointer cancellation, blur, and release outside the navigation band", async () => {
  const onReorder = vi.fn();
  await render({ onReorder });

  await begin("a", 50, 280);
  const escaped = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => document.body.dispatchEvent(escaped));
  expect(escaped.defaultPrevented).toBe(true);
  expect(result.isReordering).toBe(false);

  await begin("a", 50, 280, 2);
  await send(document, "pointercancel", { id: 9, x: 280 });
  expect(result.isReordering).toBe(true);
  await send(document, "pointercancel", { id: 2, x: 280 });
  expect(result.isReordering).toBe(false);

  await begin("a", 50, 280, 3);
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(result.isReordering).toBe(false);

  await begin("a", 50, 280, 4);
  await send(document, "pointerup", { id: 4, x: 301 });
  expect(result.isReordering).toBe(false);
  expect(onReorder).not.toHaveBeenCalled();
});

it("keeps an Escape cancellation tied to its pointer until a delayed release", async () => {
  vi.useFakeTimers();
  const onReorder = vi.fn();
  const selected = vi.fn();
  await render({ onReorder });
  tab("a").onclick = selected;

  await begin("a", 50, 280, 7);
  const escape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => document.dispatchEvent(escape));
  await act(async () => vi.advanceTimersByTime(1000));
  await send(document, "pointerup", { id: 7, x: 280 });
  tab("a").click();
  expect(onReorder).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();

  await send(tab("a"), "pointerdown", { id: 8, x: 50 });
  await send(document, "pointerup", { id: 8, x: 50 });
  tab("a").click();
  expect(selected).toHaveBeenCalledOnce();
});

it("cancels only for meaningful option changes and calls the latest reorder callback", async () => {
  const oldReorder = vi.fn();
  const latestReorder = vi.fn();
  await render({ onReorder: oldReorder });

  await begin("a", 50, 280);
  await render({ ids: ["a", "c", "b"] });
  expect(result.isReordering).toBe(false);

  await begin("a", 50, 280, 2);
  await render({ ids: ["a", "c", "b"], projectId: "project-b" });
  expect(result.isReordering).toBe(false);

  await begin("a", 50, 280, 3);
  await render({ disabled: true });
  expect(result.isReordering).toBe(false);

  await render({ disabled: false });
  await begin("a", 50, 280, 4);
  await render({
    ids: ["a", "c", "b"],
    onReorder: latestReorder,
    status: "running",
  });
  expect(result.isReordering).toBe(true);
  await send(document, "pointerup", { id: 4, x: 280 });
  expect(oldReorder).not.toHaveBeenCalled();
  expect(latestReorder).toHaveBeenCalledExactlyOnceWith("a", 2);
});

it("updates the drop indicator on native navigation scroll and ignores scroll after cancellation", async () => {
  const onReorder = vi.fn();
  await render({ ids: ["a", "b", "c", "d", "e"], onReorder });
  const nav = geometry(500);

  await begin("a", 50, 180);
  expect(result.dropBeforeId).toBe("c");
  nav.scrollLeft = 100;
  await act(async () => nav.dispatchEvent(new Event("scroll")));
  expect(result.dropBeforeId).toBe("d");
  await send(document, "pointerup", { x: 180 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", 2);

  nav.scrollLeft = 0;
  await begin("a", 50, 180, 2);
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    ),
  );
  nav.scrollLeft = 100;
  await act(async () => nav.dispatchEvent(new Event("scroll")));
  expect(result).toMatchObject({
    draggingId: null,
    dropBeforeId: null,
    isReordering: false,
  });
  expect(onReorder).toHaveBeenCalledTimes(1);
});

it("auto-scrolls a vertical list and cleans up its frame", async () => {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames.delete(id);
    });
  await render({ axis: "vertical", ids: ["a", "b", "c", "d", "e"] });
  const nav = geometry(500, "vertical");
  const runFrame = async (timestamp: number) => {
    const entry = frames.entries().next().value as [
      number,
      FrameRequestCallback,
    ];
    frames.delete(entry[0]);
    await act(async () => entry[1](timestamp));
  };

  await send(tab("a"), "pointerdown", { x: 20, y: 50 });
  await send(document, "pointermove", { x: 20, y: 280 });
  await runFrame(0);
  await runFrame(100);
  expect(nav.scrollTop).toBe(36);
  await runFrame(200);
  expect(nav.scrollTop).toBe(72);
  expect(result.dropBeforeId).toBe("e");

  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    ),
  );
  expect(cancel).toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

it("auto-scrolls at both edges from animation timestamps and cleans up its frame", async () => {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames.delete(id);
    });
  await render({ ids: ["a", "b", "c", "d", "e"] });
  const nav = geometry(500);
  const runFrame = async (timestamp: number) => {
    const entry = frames.entries().next().value as [
      number,
      FrameRequestCallback,
    ];
    frames.delete(entry[0]);
    await act(async () => entry[1](timestamp));
  };

  await begin("a", 50, 280);
  expect(result.dropBeforeId).toBe("d");
  expect(request).toHaveBeenCalledOnce();
  await runFrame(0);
  await runFrame(100);
  expect(nav.scrollLeft).toBe(36);
  await runFrame(200);
  expect(nav.scrollLeft).toBe(72);
  expect(result.dropBeforeId).toBe("e");

  await send(document, "pointermove", { x: 150 });
  expect(frames.size).toBe(0);
  await send(document, "pointermove", { x: 5 });
  await runFrame(300);
  await runFrame(400);
  expect(nav.scrollLeft).toBe(36);

  await send(document, "pointermove", { x: 5 });
  expect(frames.size).toBe(1);
  const escape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => document.dispatchEvent(escape));
  expect(cancel).toHaveBeenCalled();
  expect(frames.size).toBe(0);

  nav.scrollLeft = 200;
  await send(tab("a"), "pointerdown", { id: 2, x: 50 });
  await send(document, "pointermove", { id: 2, x: 295 });
  expect(frames.size).toBe(0);

  await act(async () => root.unmount());
  mounted = false;
  expect(frames.size).toBe(0);
});
