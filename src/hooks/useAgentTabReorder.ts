import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const dragThreshold = 4;
// Splitting drags far below the tab bar; a few pixels of click jitter must not.
const splitDragThreshold = 12;
const edgeSize = 24;
const scrollSpeed = 360;
const clickSuppressionMs = 250;

type ReorderAxis = "horizontal" | "vertical";
export type SplitDropSide = "left" | "right";

export type AgentTabReorder = {
  containerRef: RefObject<HTMLElement | null>;
  itemRefs: RefObject<Map<string, HTMLElement>>;
  startDrag: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  draggingId: string | null;
  dropBeforeId: string | null;
  dropAtEnd: boolean;
  splitDropSide: SplitDropSide | null;
  isReordering: boolean;
};

type DragState = {
  axis: ReorderAxis;
  dropIndex: number;
  id: string;
  idsKey: string;
  isDragging: boolean;
  lastX: number;
  lastY: number;
  pointerId: number;
  projectId: string | undefined;
  sourceIds: string[];
  sourceIndex: number;
  splitDropSide: SplitDropSide | null;
  startPosition: number;
};

type Indicator = {
  draggingId: string;
  dropAtEnd: boolean;
  dropBeforeId: string | null;
  splitDropSide: SplitDropSide | null;
};

type UseAgentTabReorderOptions = {
  axis?: ReorderAxis;
  ids: string[];
  projectId: string | undefined;
  disabled: boolean;
  onReorder: (id: string, index: number) => void;
  canSplit?: (id: string, side: SplitDropSide) => boolean;
  // Inclusive insertion bounds, as indices among the ids without the dragged one.
  dropIndexBounds?: (id: string) => readonly [number, number];
  onSplit?: (id: string, side: SplitDropSide) => void;
  splitTargetRef?: RefObject<HTMLElement | null>;
};

function maximumScroll(container: HTMLElement, axis: ReorderAxis) {
  return Math.max(
    0,
    axis === "horizontal"
      ? container.scrollWidth - container.clientWidth
      : container.scrollHeight - container.clientHeight,
  );
}

export function useAgentTabReorder({
  axis = "horizontal",
  ids,
  projectId,
  disabled,
  onReorder,
  canSplit,
  onSplit,
  dropIndexBounds,
  splitTargetRef,
}: UseAgentTabReorderOptions): AgentTabReorder {
  const containerRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<DragState | null>(null);
  const optionsRef = useRef({
    axis,
    disabled,
    ids,
    idsKey: JSON.stringify(ids),
    onReorder,
    projectId,
    canSplit,
    onSplit,
    dropIndexBounds,
    splitTargetRef,
  });
  const rafRef = useRef<number | null>(null);
  const rafTimestampRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const suppressedPointerIdRef = useRef<number | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const idsKey = JSON.stringify(ids);

  optionsRef.current = {
    axis,
    disabled,
    ids,
    idsKey,
    onReorder,
    projectId,
    canSplit,
    onSplit,
    dropIndexBounds,
    splitTargetRef,
  };

  function clearClickSuppression() {
    suppressClickRef.current = false;
    if (suppressClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressClickTimeoutRef.current);
      suppressClickTimeoutRef.current = null;
    }
  }

  function suppressNextClick() {
    clearClickSuppression();
    suppressClickRef.current = true;
    suppressClickTimeoutRef.current = window.setTimeout(
      clearClickSuppression,
      clickSuppressionMs,
    );
  }

  function stopAutoScroll() {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    rafTimestampRef.current = null;
  }

  function finishDrag(suppressClick: boolean, waitForPointerUp = false) {
    const drag = dragRef.current;
    dragRef.current = null;
    stopAutoScroll();
    if (!drag?.isDragging) return;
    setIndicator(null);
    if (!suppressClick) return;
    if (waitForPointerUp) suppressedPointerIdRef.current = drag.pointerId;
    else suppressNextClick();
  }

  function remainingIds(drag: DragState) {
    return drag.sourceIds.filter((id) => id !== drag.id);
  }

  function getDropIndex(position: number, drag: DragState) {
    const remaining = remainingIds(drag);
    let dropIndex = remaining.length;
    for (let index = 0; index < remaining.length; index += 1) {
      const element = itemRefs.current.get(remaining[index]);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const midpoint =
        drag.axis === "horizontal"
          ? rect.left + rect.width / 2
          : rect.top + rect.height / 2;
      if (position < midpoint) {
        dropIndex = index;
        break;
      }
    }
    const bounds = optionsRef.current.dropIndexBounds?.(drag.id);
    if (!bounds) return dropIndex;
    return Math.min(Math.max(dropIndex, bounds[0]), bounds[1]);
  }

  function splitSideAt(clientX: number, clientY: number, id: string) {
    const current = optionsRef.current;
    const rect = current.splitTargetRef?.current?.getBoundingClientRect();
    if (
      !rect ||
      !current.onSplit ||
      !current.canSplit ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    )
      return null;
    const side = clientX < rect.left + rect.width / 2 ? "left" : "right";
    return current.canSplit(id, side) ? side : null;
  }

  function publishIndicator(drag: DragState, insideContainer = true) {
    const remaining = remainingIds(drag);
    const next = {
      draggingId: drag.id,
      dropAtEnd:
        !drag.splitDropSide &&
        insideContainer &&
        drag.dropIndex >= remaining.length,
      dropBeforeId:
        !drag.splitDropSide && insideContainer
          ? (remaining[drag.dropIndex] ?? null)
          : null,
      splitDropSide: drag.splitDropSide,
    };
    setIndicator((current) =>
      current?.draggingId === next.draggingId &&
      current.dropAtEnd === next.dropAtEnd &&
      current.dropBeforeId === next.dropBeforeId &&
      current.splitDropSide === next.splitDropSide
        ? current
        : next,
    );
  }

  function isInsideContainer(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    return (
      !!rect &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function autoScrollDirection(drag: DragState) {
    const container = containerRef.current;
    if (!container || !isInsideContainer(drag.lastX, drag.lastY)) return 0;
    const rect = container.getBoundingClientRect();
    const position = drag.axis === "horizontal" ? drag.lastX : drag.lastY;
    const start = drag.axis === "horizontal" ? rect.left : rect.top;
    const end = drag.axis === "horizontal" ? rect.right : rect.bottom;
    const scrollPosition =
      drag.axis === "horizontal" ? container.scrollLeft : container.scrollTop;
    const maximum = maximumScroll(container, drag.axis);
    if (position < start + edgeSize && scrollPosition > 0) return -1;
    if (position > end - edgeSize && scrollPosition < maximum) return 1;
    return 0;
  }

  function autoScrollFrame(timestamp: number) {
    rafRef.current = null;
    const drag = dragRef.current;
    const container = containerRef.current;
    const direction = drag?.isDragging ? autoScrollDirection(drag) : 0;
    if (!drag || !container || direction === 0) {
      rafTimestampRef.current = null;
      return;
    }

    if (rafTimestampRef.current !== null) {
      const current =
        drag.axis === "horizontal" ? container.scrollLeft : container.scrollTop;
      const maximum = maximumScroll(container, drag.axis);
      const elapsed = Math.max(0, timestamp - rafTimestampRef.current) / 1000;
      const next = Math.max(
        0,
        Math.min(maximum, current + direction * scrollSpeed * elapsed),
      );
      if (next !== current) {
        if (drag.axis === "horizontal") container.scrollLeft = next;
        else container.scrollTop = next;
        drag.dropIndex = getDropIndex(
          drag.axis === "horizontal" ? drag.lastX : drag.lastY,
          drag,
        );
        publishIndicator(drag);
      }
    }
    rafTimestampRef.current = timestamp;

    if (autoScrollDirection(drag) !== 0) {
      rafRef.current = window.requestAnimationFrame(autoScrollFrame);
    } else {
      rafTimestampRef.current = null;
    }
  }

  function syncAutoScroll() {
    const drag = dragRef.current;
    if (!drag?.isDragging || autoScrollDirection(drag) === 0) {
      stopAutoScroll();
      return;
    }
    if (rafRef.current === null) {
      rafTimestampRef.current = null;
      rafRef.current = window.requestAnimationFrame(autoScrollFrame);
    }
  }

  function gestureIsCurrent(drag: DragState) {
    const current = optionsRef.current;
    return (
      !current.disabled &&
      current.axis === drag.axis &&
      current.projectId === drag.projectId &&
      current.idsKey === drag.idsKey
    );
  }

  function updateDrag(event: globalThis.PointerEvent, isPointerUp = false) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return false;
    if (!gestureIsCurrent(drag)) {
      finishDrag(true, !isPointerUp);
      return false;
    }
    const position = drag.axis === "horizontal" ? event.clientX : event.clientY;
    if (!drag.isDragging) {
      const alongAxis = Math.abs(position - drag.startPosition);
      const distance = Math.hypot(
        event.clientX - drag.lastX,
        event.clientY - drag.lastY,
      );
      // A release never starts a drag: it would swallow the click it ends.
      if (
        isPointerUp ||
        (alongAxis < dragThreshold &&
          (!optionsRef.current.splitTargetRef || distance < splitDragThreshold))
      )
        return false;
    }

    if (!drag.isDragging) {
      drag.isDragging = true;
      window.getSelection()?.removeAllRanges();
    }
    if (event.cancelable) event.preventDefault();
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.splitDropSide = splitSideAt(event.clientX, event.clientY, drag.id);
    const insideContainer = isInsideContainer(event.clientX, event.clientY);
    if (insideContainer) drag.dropIndex = getDropIndex(position, drag);
    publishIndicator(drag, insideContainer);
    if (drag.splitDropSide) stopAutoScroll();
    else syncAutoScroll();
    return true;
  }

  useEffect(() => {
    function handlePointerDown() {
      clearClickSuppression();
      suppressedPointerIdRef.current = null;
    }

    function handlePointerMove(event: globalThis.PointerEvent) {
      updateDrag(event);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      if (suppressedPointerIdRef.current === event.pointerId) {
        suppressedPointerIdRef.current = null;
        suppressNextClick();
        return;
      }
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wasDragging = updateDrag(event, true);
      if (!wasDragging) {
        finishDrag(false);
        return;
      }

      const dropIndex = drag.dropIndex;
      const splitDropSide = drag.splitDropSide;
      const shouldReorder =
        !splitDropSide &&
        isInsideContainer(event.clientX, event.clientY) &&
        dropIndex !== drag.sourceIndex;
      finishDrag(true);
      if (splitDropSide) optionsRef.current.onSplit?.(drag.id, splitDropSide);
      else if (shouldReorder) optionsRef.current.onReorder(drag.id, dropIndex);
    }

    function handlePointerCancel(event: globalThis.PointerEvent) {
      if (dragRef.current?.pointerId === event.pointerId)
        finishDrag(true, true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !dragRef.current?.isDragging) return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(true, true);
    }

    function handleBlur() {
      finishDrag(true, true);
    }

    function handleDragStart(event: DragEvent) {
      if (dragRef.current?.isDragging) event.preventDefault();
    }

    function handleScroll(event: Event) {
      const drag = dragRef.current;
      if (!drag?.isDragging || event.target !== containerRef.current) return;
      if (!gestureIsCurrent(drag)) {
        finishDrag(true, true);
        return;
      }
      drag.dropIndex = getDropIndex(
        drag.axis === "horizontal" ? drag.lastX : drag.lastY,
        drag,
      );
      publishIndicator(drag, isInsideContainer(drag.lastX, drag.lastY));
      syncAutoScroll();
    }

    function handleClick(event: MouseEvent) {
      if (!suppressClickRef.current) return;
      clearClickSuppression();
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerCancel);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("dragstart", handleDragStart, true);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("dragstart", handleDragStart, true);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("blur", handleBlur);
      dragRef.current = null;
      suppressedPointerIdRef.current = null;
      stopAutoScroll();
      clearClickSuppression();
    };
  }, []);

  useEffect(() => {
    finishDrag(true, true);
  }, [axis, disabled, idsKey, projectId]);

  function startDrag(id: string, event: ReactPointerEvent<HTMLElement>) {
    clearClickSuppression();
    const current = optionsRef.current;
    if (
      current.disabled ||
      current.ids.length < 2 ||
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !itemRefs.current.has(id)
    )
      return;
    const sourceIndex = current.ids.indexOf(id);
    if (sourceIndex < 0) return;

    finishDrag(false);
    dragRef.current = {
      axis: current.axis,
      dropIndex: sourceIndex,
      id,
      idsKey: current.idsKey,
      isDragging: false,
      lastX: event.clientX,
      lastY: event.clientY,
      pointerId: event.pointerId,
      projectId: current.projectId,
      sourceIds: [...current.ids],
      sourceIndex,
      splitDropSide: null,
      startPosition:
        current.axis === "horizontal" ? event.clientX : event.clientY,
    };
  }

  return {
    containerRef,
    itemRefs,
    startDrag,
    draggingId: indicator?.draggingId ?? null,
    dropBeforeId: indicator?.dropBeforeId ?? null,
    dropAtEnd: indicator?.dropAtEnd ?? false,
    splitDropSide: indicator?.splitDropSide ?? null,
    isReordering: indicator !== null,
  };
}
