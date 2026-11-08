import {
  useRef,
  type Dispatch,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  isRailResizeKey,
  railKeyboardRatio,
  railResizeRatio,
  startRailResize,
  stopRailResize,
  type RailAxis,
  type RailResizeSession,
} from "./railResize";

type RailResizerProps = {
  axis: RailAxis;
  className: string;
  container: RefObject<HTMLElement | null>;
  controls?: string;
  defaultRatio: number;
  label: string;
  max: number;
  min: number;
  ratio: number;
  onRatioChange: Dispatch<SetStateAction<number>>;
};

/** Separator resizing the panes of `container` by pointer, keyboard, or double-click to reset. */
export function RailResizer({
  axis,
  className,
  container,
  controls,
  defaultRatio,
  label,
  max,
  min,
  ratio,
  onRatioChange,
}: RailResizerProps) {
  const sessionRef = useRef<RailResizeSession | null>(null);

  function stop(event: PointerEvent<HTMLDivElement>) {
    stopRailResize(sessionRef, event);
  }

  return (
    <div
      className={className}
      role="separator"
      tabIndex={0}
      aria-controls={controls}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(ratio)}
      onPointerDown={(event) =>
        startRailResize(event, sessionRef, container.current, axis, ratio)
      }
      onPointerMove={(event) => {
        const next = railResizeRatio(sessionRef.current, event, min, max);
        if (next !== null) onRatioChange(next);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(event) => {
        if (!isRailResizeKey(event.key, axis)) return;
        event.preventDefault();
        onRatioChange((current) =>
          railKeyboardRatio(event.key, axis, current, min, max),
        );
      }}
      onDoubleClick={() => onRatioChange(defaultRatio)}
    />
  );
}
