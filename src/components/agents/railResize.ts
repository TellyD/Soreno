import type { MutableRefObject, PointerEvent } from "react";

export type RailAxis = "x" | "y";
export type RailResizeSession = {
  axis: RailAxis;
  available: number;
  pointerId: number;
  position: number;
  ratio: number;
};

const railArrowKeys = {
  x: { decrease: "ArrowRight", increase: "ArrowLeft" },
  y: { decrease: "ArrowUp", increase: "ArrowDown" },
} as const;

export function startRailResize(
  event: PointerEvent<HTMLElement>,
  sessionRef: MutableRefObject<RailResizeSession | null>,
  container: HTMLElement | null,
  axis: RailAxis,
  ratio: number,
) {
  if (event.button !== 0 || !container) return;
  const bounds = container.getBoundingClientRect();
  const available = (axis === "x" ? bounds.width : bounds.height) - 1;
  if (available <= 0) return;
  sessionRef.current = {
    axis,
    available,
    pointerId: event.pointerId,
    position: axis === "x" ? event.clientX : event.clientY,
    ratio,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
}

export function railResizeRatio(
  session: RailResizeSession | null,
  event: PointerEvent<HTMLElement>,
  min: number,
  max: number,
) {
  if (!session || session.pointerId !== event.pointerId) return null;
  const position = session.axis === "x" ? event.clientX : event.clientY;
  const direction = session.axis === "x" ? -1 : 1;
  return Math.min(
    max,
    Math.max(
      min,
      session.ratio +
        ((direction * (position - session.position)) / session.available) * 100,
    ),
  );
}

export function stopRailResize(
  sessionRef: MutableRefObject<RailResizeSession | null>,
  event: PointerEvent<HTMLElement>,
) {
  if (sessionRef.current?.pointerId === event.pointerId)
    sessionRef.current = null;
}

export function isRailResizeKey(key: string, axis: RailAxis) {
  const { decrease, increase } = railArrowKeys[axis];
  return [decrease, increase, "Home", "End"].includes(key);
}

export function railKeyboardRatio(
  key: string,
  axis: RailAxis,
  ratio: number,
  min: number,
  max: number,
) {
  if (key === "Home") return min;
  if (key === "End") return max;
  return Math.min(
    max,
    Math.max(min, ratio + (key === railArrowKeys[axis].decrease ? -2 : 2)),
  );
}
