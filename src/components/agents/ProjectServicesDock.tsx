import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { usePersistedValue } from "../../hooks/usePersistedValue";
import {
  readServicesPanelHeight,
  servicesPanelHeightKey,
} from "./agentWorkspaceStorage";
import { useAgentStrings } from "./agentStrings";

const defaultHeight = 280;
const minHeight = 140;
const minTerminalHeight = 120;

export function ProjectServicesDock({
  id,
  hidden,
  onClose,
  children,
}: {
  id: string;
  hidden: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const s = useAgentStrings();
  const [height, setHeight] = useState(() =>
    Math.max(minHeight, readServicesPanelHeight() ?? defaultHeight),
  );
  const dockRef = useRef<HTMLDivElement>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  usePersistedValue(servicesPanelHeightKey, height);
  useEffect(() => () => stopResizeRef.current?.(), []);
  const [maxHeight, setMaxHeight] = useState<number>();
  // shortcut: a window resize while the Agents view is hidden drops aria-valuemax until the next resize or reopen; observe the parent with ResizeObserver if screen-reader users hit it.
  useLayoutEffect(() => {
    function measure() {
      const available = dockRef.current?.parentElement?.clientHeight;
      setMaxHeight(
        available
          ? Math.max(minHeight, available - minTerminalHeight)
          : undefined,
      );
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  function clampHeight(value: number) {
    // An unmeasured parent (0) leaves only the minimum to enforce.
    const available =
      dockRef.current?.parentElement?.clientHeight || Number.POSITIVE_INFINITY;
    return Math.round(
      Math.max(minHeight, Math.min(available - minTerminalHeight, value)),
    );
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResizeRef.current?.();
    const startY = event.clientY;
    const startHeight =
      dockRef.current?.getBoundingClientRect().height || height;
    document.body.classList.add("is-resizing-services");
    function move(moveEvent: globalThis.PointerEvent) {
      setHeight(clampHeight(startHeight + startY - moveEvent.clientY));
    }
    function stop() {
      document.body.classList.remove("is-resizing-services");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      stopResizeRef.current = null;
    }
    stopResizeRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
    document.addEventListener("pointercancel", stop, { once: true });
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setHeight(clampHeight(height + (event.key === "ArrowUp" ? 12 : -12)));
  }

  return (
    <div
      id={id}
      ref={dockRef}
      className="agent-services-dock"
      hidden={hidden}
      style={{ "--services-dock-height": `${height}px` } as CSSProperties}
      onKeyDown={(event) => {
        // A running service's log terminal keeps Escape for its process.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="agent-services-resizer"
        role="separator"
        aria-label={s.resizeServices}
        aria-orientation="horizontal"
        aria-valuemin={minHeight}
        aria-valuemax={maxHeight && Math.max(maxHeight, height)}
        aria-valuenow={height}
        tabIndex={0}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
      {children}
    </div>
  );
}
