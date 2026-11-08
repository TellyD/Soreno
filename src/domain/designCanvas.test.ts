import { describe, expect, it } from "vitest";
import type { DesignFrame } from "./design";
import {
  DESIGN_ZOOM_MAX,
  designBringToFront,
  designEscapeTarget,
  designFitView,
  designResize,
  designSnap,
  designZoomAt,
} from "./designCanvas";

const frame = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  z = 0,
): DesignFrame => ({
  boardId: "b",
  id,
  title: id,
  html: "",
  x,
  y,
  width,
  height,
  z,
  updatedAt: "",
});

describe("design canvas", () => {
  it("keeps the board point under the pointer while zooming, within bounds", () => {
    const view = { x: 100, y: 50, scale: 1 };
    const zoomed = designZoomAt(view, 2, 300, 250);
    // Board point (200, 200) was under (300, 250) and stays there.
    expect(200 * zoomed.scale + zoomed.x).toBe(300);
    expect(200 * zoomed.scale + zoomed.y).toBe(250);
    expect(designZoomAt(view, 100, 0, 0).scale).toBe(DESIGN_ZOOM_MAX);
  });

  it("fits every frame centred, never above 100%", () => {
    const frames = [
      frame("a", -100, 0, 1000, 500),
      frame("b", 1100, 200, 1000, 800),
    ];
    const view = designFitView(frames, 1196, 1096, 48);
    expect(view.scale).toBe(0.5);
    // Bounds -100..2100 × 0..1000 land centred in the 1196 × 1096 canvas.
    expect(-100 * view.scale + view.x).toBe(48);
    expect(view.y).toBe(298);
    expect(designFitView([frame("c", 0, 0, 100, 100)], 1000, 1000).scale).toBe(
      1,
    );
  });

  it("resizes from any edge within the frame size bounds", () => {
    const rect = { x: 0, y: 0, width: 400, height: 300 };
    expect(designResize(rect, "se", 50, -20)).toEqual({
      x: 0,
      y: 0,
      width: 450,
      height: 280,
    });
    // Dragging the west edge past the east one stops at the minimum, the east edge fixed.
    expect(designResize(rect, "nw", 1000, 10)).toEqual({
      x: 280,
      y: 10,
      width: 120,
      height: 290,
    });
    expect(designResize(rect, "n", 0, 500)).toEqual({
      x: 0,
      y: 180,
      width: 400,
      height: 120,
    });
    // Past the maximum the size stops at 4096, the opposite edge still fixed.
    expect(designResize(rect, "se", 9000, 9000)).toEqual({
      x: 0,
      y: 0,
      width: 4096,
      height: 4096,
    });
    expect(designResize(rect, "nw", -9000, -9000)).toEqual({
      x: 400 - 4096,
      y: 300 - 4096,
      width: 4096,
      height: 4096,
    });
  });

  it("snaps a moved frame to the closest anchor within the threshold only", () => {
    const a = { x: 0, y: 0, width: 200, height: 100 };
    const rect = (x: number) => ({ x, y: 300, width: 120, height: 100 });
    expect(designSnap(rect(4), [a], 6, null)).toEqual({
      rect: rect(0),
      guides: [{ axis: "x", position: 0, start: 0, end: 400 }],
    });
    expect(designSnap(rect(7), [a], 6, null)).toEqual({
      rect: rect(7),
      guides: [],
    });
    // Centre 97 meets a's centre 100.
    expect(designSnap({ ...rect(47), width: 100 }, [a], 6, null).rect.x).toBe(
      50,
    );
    // a's left is 3 away, b's left 2 away from the right edge (123).
    const b = { x: 125, y: 600, width: 100, height: 100 };
    expect(designSnap(rect(3), [a, b], 6, null).rect.x).toBe(5);
  });

  it("snaps only the edges a handle drags, within the size bounds", () => {
    const left = { x: 298, y: 0, width: 100, height: 100 };
    const right = { x: 503, y: 0, width: 100, height: 100 };
    const rect = { x: 300, y: 300, width: 200, height: 100 };
    // The left edge, 2 away from `left`, stays: only the right one is dragged.
    expect(designSnap(rect, [left, right], 6, "e").rect).toEqual({
      ...rect,
      width: 203,
    });
    expect(
      designSnap(
        { ...rect, height: 200 },
        [{ x: 296, y: 303, width: 100, height: 100 }],
        6,
        "nw",
      ),
    ).toEqual({
      rect: { x: 296, y: 303, width: 204, height: 197 },
      guides: [
        { axis: "x", position: 296, start: 303, end: 500 },
        { axis: "y", position: 303, start: 296, end: 500 },
      ],
    });
    // Bounds win over a snap, and no guide claims the alignment then.
    expect(
      designSnap(
        { x: 0, y: 0, width: 4094, height: 200 },
        [{ x: 4100, y: 0, width: 100, height: 100 }],
        6,
        "e",
      ),
    ).toEqual({ rect: { x: 0, y: 0, width: 4096, height: 200 }, guides: [] });
    expect(
      designSnap(
        { x: 0, y: 0, width: 121, height: 200 },
        [{ x: 5, y: 500, width: 100, height: 100 }],
        6,
        "w",
      ),
    ).toEqual({ rect: { x: 1, y: 0, width: 120, height: 200 }, guides: [] });
  });

  it("escapes from an element to its frame, then to the board", () => {
    const element = {
      kind: "element",
      frameId: "f",
      selector: "body > p",
      outerHTML: "<p>",
    } as const;
    expect(designEscapeTarget(element)).toEqual({
      kind: "frame",
      frameId: "f",
    });
    expect(designEscapeTarget({ kind: "frame", frameId: "f" })).toEqual({
      kind: "board",
    });
  });

  it("raises a frame above the others only when it is not on top", () => {
    const frames = [
      frame("a", 0, 0, 200, 200, 1),
      frame("b", 0, 0, 200, 200, 4),
    ];
    expect(designBringToFront(frames, frames[0]).z).toBe(5);
    expect(designBringToFront(frames, frames[1])).toBe(frames[1]);
    expect(designBringToFront([frames[0]], frames[0])).toBe(frames[0]);
  });
});
