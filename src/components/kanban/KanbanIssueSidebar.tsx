import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useI18n } from "../../i18n";

const sidebarWidthKey = "soreno.kanban.issueSidebarWidth.v1";
// `maxShare` mirrors the CSS cap `min(var(--kanban-issue-sidebar-width), 45%)`.
const sidebarWidth = {
  initial: 240,
  min: 220,
  max: 520,
  maxShare: 0.45,
  step: 16,
};

function clampSidebarWidth(width: number, max: number = sidebarWidth.max) {
  return Math.round(Math.min(max, Math.max(sidebarWidth.min, width)));
}

function readSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem(sidebarWidthKey));
    return stored ? clampSidebarWidth(stored) : sidebarWidth.initial;
  } catch {
    return sidebarWidth.initial;
  }
}

export function KanbanIssueSidebar({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [width, setWidth] = useState(readSidebarWidth);
  const asideRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    width: number;
    max: number;
  }>(null);

  // Adjustments start from what is rendered, not a stored preference the layout caps.
  function availableMax() {
    const body = asideRef.current?.parentElement?.clientWidth ?? 0;
    return body > 0
      ? Math.max(
          sidebarWidth.min,
          Math.min(sidebarWidth.max, body * sidebarWidth.maxShare),
        )
      : sidebarWidth.max;
  }

  useEffect(() => {
    try {
      localStorage.setItem(sidebarWidthKey, String(width));
    } catch {
      /* Optional preference. */
    }
  }, [width]);

  function stopDrag(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  return (
    <aside
      className="kanban-issue-sidebar"
      ref={asideRef}
      style={{ "--kanban-issue-sidebar-width": `${width}px` } as CSSProperties}
    >
      <div
        aria-label={t("kanban.issue.resizeSidebar")}
        aria-orientation="vertical"
        aria-valuemax={sidebarWidth.max}
        aria-valuemin={sidebarWidth.min}
        aria-valuenow={width}
        className="kanban-issue-sidebar-resizer"
        onDoubleClick={() => setWidth(sidebarWidth.initial)}
        onKeyDown={(event) => {
          // The handle sits on the sidebar's left edge: moving left widens it.
          const delta =
            event.key === "ArrowLeft"
              ? sidebarWidth.step
              : event.key === "ArrowRight"
                ? -sidebarWidth.step
                : null;
          if (event.key === "Home") setWidth(sidebarWidth.min);
          else if (event.key === "End")
            setWidth(clampSidebarWidth(availableMax()));
          else if (delta !== null) {
            const max = availableMax();
            setWidth((current) =>
              clampSidebarWidth(Math.min(current, max) + delta, max),
            );
          } else return;
          event.preventDefault();
        }}
        onLostPointerCapture={stopDrag}
        onPointerCancel={stopDrag}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const max = availableMax();
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width: Math.min(width, max),
            max,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId !== event.pointerId) return;
          setWidth(
            clampSidebarWidth(drag.width - (event.clientX - drag.x), drag.max),
          );
        }}
        onPointerUp={stopDrag}
        role="separator"
        tabIndex={0}
      />
      {children}
    </aside>
  );
}
