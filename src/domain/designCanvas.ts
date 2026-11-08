import type { DesignFrame, DesignTarget } from "./design";

/** Screen = board × scale + (x, y), in the canvas's pixels. */
export type DesignView = { x: number; y: number; scale: number };
export type DesignRect = Pick<DesignFrame, "x" | "y" | "width" | "height">;
/** Edges a resize handle moves: n, s, e, w or a corner such as "se". */
export type DesignHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const DESIGN_FRAME_MIN = 120;
// design_update_frame refuses larger frames.
export const DESIGN_FRAME_MAX = 4096;
export const DESIGN_ZOOM_MIN = 0.05;
export const DESIGN_ZOOM_MAX = 4;
export const DESIGN_ZOOM_STEP = 1.25;

const clampScale = (scale: number) =>
  Math.min(DESIGN_ZOOM_MAX, Math.max(DESIGN_ZOOM_MIN, scale));

/** `view` zoomed to `scale`, the canvas point (`px`, `py`) staying over the same board point. */
export function designZoomAt(
  view: DesignView,
  scale: number,
  px: number,
  py: number,
): DesignView {
  const next = clampScale(scale);
  const ratio = next / view.scale;
  return {
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
    scale: next,
  };
}

/** The scale after a Ctrl+wheel or a trackpad pinch of `deltaY`. */
export const designWheelScale = (scale: number, deltaY: number) =>
  scale * Math.exp(-deltaY / 300);

/** The view showing every frame in a `width` × `height` canvas, never above 100%. */
export function designFitView(
  frames: readonly DesignRect[],
  width: number,
  height: number,
  padding = 48,
): DesignView {
  if (!frames.length) return { x: width / 2, y: height / 2, scale: 1 };
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  const scale = clampScale(
    Math.min(
      1,
      Math.max(1, width - 2 * padding) / (right - left),
      Math.max(1, height - 2 * padding) / (bottom - top),
    ),
  );
  return {
    x: (width - (right - left) * scale) / 2 - left * scale,
    y: (height - (bottom - top) * scale) / 2 - top * scale,
    scale,
  };
}

/** `rect` with the edges of `handle` dragged by (`dx`, `dy`) board units, within the frame size bounds. */
export function designResize(
  rect: DesignRect,
  handle: DesignHandle,
  dx: number,
  dy: number,
): DesignRect {
  const size = (value: number) =>
    Math.round(Math.min(DESIGN_FRAME_MAX, Math.max(DESIGN_FRAME_MIN, value)));
  let { x, y, width, height } = rect;
  if (handle.includes("e")) width = size(width + dx);
  if (handle.includes("s")) height = size(height + dy);
  // The opposite edge stays put.
  if (handle.includes("w")) {
    width = size(rect.width - dx);
    x = rect.x + rect.width - width;
  }
  if (handle.includes("n")) {
    height = size(rect.height - dy);
    y = rect.y + rect.height - height;
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** An alignment line: axis "x" is vertical at x = `position`, from `start` to `end` along y; "y" the reverse. */
export type DesignGuide = {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
};

const thirds = (start: number, size: number) => [
  start,
  start + size / 2,
  start + size,
];

/** The anchors that snap on one axis: all three for a move, only the dragged edges for a resize. */
function snapAnchors(
  start: number,
  size: number,
  handle: DesignHandle | null,
  low: string,
  high: string,
) {
  if (!handle) return thirds(start, size);
  return [
    ...(handle.includes(low) ? [start] : []),
    ...(handle.includes(high) ? [start + size] : []),
  ];
}

function closestSnap(
  anchors: readonly number[],
  targets: readonly number[],
  threshold: number,
) {
  let best: number | null = null;
  for (const anchor of anchors)
    for (const target of targets) {
      const delta = target - anchor;
      if (
        Math.abs(delta) <= threshold &&
        (best === null || Math.abs(delta) < Math.abs(best))
      )
        best = delta;
    }
  return best;
}

/**
 * `rect`, moved (`handle` null) or resized by `handle`, snapped within `threshold` board units to the
 * left/centre/right and top/middle/bottom of `others`, with the guides of the alignments it reaches.
 */
export function designSnap(
  rect: DesignRect,
  others: readonly DesignRect[],
  threshold: number,
  handle: DesignHandle | null,
): { rect: DesignRect; guides: DesignGuide[] } {
  const dx = closestSnap(
    snapAnchors(rect.x, rect.width, handle, "w", "e"),
    others.flatMap((other) => thirds(other.x, other.width)),
    threshold,
  );
  const dy = closestSnap(
    snapAnchors(rect.y, rect.height, handle, "n", "s"),
    others.flatMap((other) => thirds(other.y, other.height)),
    threshold,
  );
  // Through designResize: the size bounds win over a snap, the opposite edge stays put.
  const snapped = handle
    ? designResize(rect, handle, dx ?? 0, dy ?? 0)
    : { ...rect, x: rect.x + (dx ?? 0), y: rect.y + (dy ?? 0) };
  const guides: DesignGuide[] = [];
  for (const axis of ["x", "y"] as const) {
    if ((axis === "x" ? dx : dy) === null) continue;
    const [at, size, across, length, low, high] =
      axis === "x"
        ? (["x", "width", "y", "height", "w", "e"] as const)
        : (["y", "height", "x", "width", "n", "s"] as const);
    for (const position of snapAnchors(
      snapped[at],
      snapped[size],
      handle,
      low,
      high,
    )) {
      // Half a unit: resizing rounds an edge snapped to a centre.
      const matched = others.filter((other) =>
        thirds(other[at], other[size]).some(
          (anchor) => Math.abs(anchor - position) <= 0.5,
        ),
      );
      if (!matched.length) continue;
      const spans = [snapped, ...matched];
      guides.push({
        axis,
        position,
        start: Math.min(...spans.map((span) => span[across])),
        end: Math.max(...spans.map((span) => span[across] + span[length])),
      });
    }
  }
  return { rect: snapped, guides };
}

/** The target Escape leaves for: element → its frame → the board. */
export function designEscapeTarget(target: DesignTarget): DesignTarget {
  return target.kind === "element"
    ? { kind: "frame", frameId: target.frameId }
    : { kind: "board" };
}

/** `frame` raised above every other frame, unchanged when already on top. */
export function designBringToFront(
  frames: readonly DesignFrame[],
  frame: DesignFrame,
): DesignFrame {
  const top = Math.max(
    ...frames.filter((other) => other.id !== frame.id).map(({ z }) => z),
  );
  return frame.z > top ? frame : { ...frame, z: top + 1 };
}
