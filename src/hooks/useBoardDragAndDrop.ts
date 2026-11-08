import { useEffect, useRef, useState, type PointerEvent } from "react";

const dragStartThreshold = 6;

export type BoardDragPreview<TItem> = {
  height: number;
  item: TItem;
  width: number;
  x: number;
  y: number;
};

type UseBoardDragAndDropOptions<TItem, TColumn extends string> = {
  canStartDrag?: (item: TItem, target: Element) => boolean;
  columnAtPoint: (x: number, y: number) => TColumn | null;
  getColumn: (item: TItem) => TColumn;
  getId: (item: TItem) => string;
  onDrop: (item: TItem, column: TColumn) => void;
  onTap?: (item: TItem, target: Element | null) => void;
};

type PointerDragState<TItem, TColumn extends string> = {
  currentColumn: TColumn | null;
  height: number;
  isDragging: boolean;
  item: TItem;
  itemId: string;
  offsetX: number;
  offsetY: number;
  originColumn: TColumn;
  pointerId: number;
  startTarget: Element | null;
  startX: number;
  startY: number;
  width: number;
};

export function useBoardDragAndDrop<TItem, TColumn extends string>(
  options: UseBoardDragAndDropOptions<TItem, TColumn>,
) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] =
    useState<BoardDragPreview<TItem> | null>(null);
  const [dropColumn, setDropColumn] = useState<TColumn | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<PointerDragState<TItem, TColumn> | null>(null);
  const suppressedClickIdRef = useRef<string | null>(null);
  const suppressedClickTimeoutRef = useRef<number | null>(null);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    return () => {
      if (suppressedClickTimeoutRef.current !== null) {
        window.clearTimeout(suppressedClickTimeoutRef.current);
      }
    };
  }, []);

  function shouldSkipClick(itemId: string) {
    if (suppressedClickIdRef.current !== itemId) {
      return false;
    }

    suppressedClickIdRef.current = null;

    if (suppressedClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressedClickTimeoutRef.current);
      suppressedClickTimeoutRef.current = null;
    }

    return true;
  }

  function getPointerHandlers(item: TItem) {
    return {
      onPointerCancel: (event: PointerEvent<HTMLElement>) =>
        handlePointerCancel(event),
      onPointerDown: (event: PointerEvent<HTMLElement>) =>
        handlePointerDown(item, event),
      onPointerMove: (event: PointerEvent<HTMLElement>) =>
        handlePointerMove(event),
      onPointerUp: (event: PointerEvent<HTMLElement>) =>
        handlePointerEnd(event),
    };
  }

  function handlePointerDown(item: TItem, event: PointerEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null;

    if (
      event.button !== 0 ||
      (target && optionsRef.current.canStartDrag?.(item, target) === false)
    ) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();

    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      currentColumn: null,
      height: bounds.height,
      isDragging: false,
      item,
      itemId: optionsRef.current.getId(item),
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      originColumn: optionsRef.current.getColumn(item),
      pointerId: event.pointerId,
      startTarget: target,
      startX: event.clientX,
      startY: event.clientY,
      width: bounds.width,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const dragState = pointerDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = Math.abs(event.clientX - dragState.startX);
    const deltaY = Math.abs(event.clientY - dragState.startY);

    if (!dragState.isDragging && deltaX + deltaY < dragStartThreshold) {
      return;
    }

    event.preventDefault();
    dragState.isDragging = true;

    setDraggedId((currentId) =>
      currentId === dragState.itemId ? currentId : dragState.itemId,
    );
    const x = event.clientX - dragState.offsetX;
    const y = event.clientY - dragState.offsetY;
    if (previewRef.current) {
      previewRef.current.style.left = `${x}px`;
      previewRef.current.style.top = `${y}px`;
    } else {
      setDragPreview({
        height: dragState.height,
        item: dragState.item,
        width: dragState.width,
        x,
        y,
      });
    }

    const column = optionsRef.current.columnAtPoint(
      event.clientX,
      event.clientY,
    );

    if (column !== dragState.currentColumn) {
      dragState.currentColumn = column;
      setDropColumn(column);
    }
  }

  function handlePointerEnd(event: PointerEvent<HTMLElement>) {
    const dragState = pointerDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    releasePointerCapture(event);
    resetDragState();

    if (!dragState.isDragging) {
      optionsRef.current.onTap?.(dragState.item, dragState.startTarget);
      return;
    }

    suppressNextClick(dragState.itemId);
    const column = optionsRef.current.columnAtPoint(
      event.clientX,
      event.clientY,
    );

    if (!column || column === dragState.originColumn) {
      return;
    }

    optionsRef.current.onDrop(dragState.item, column);
  }

  function handlePointerCancel(event: PointerEvent<HTMLElement>) {
    const dragState = pointerDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    releasePointerCapture(event);
    resetDragState();

    if (dragState.isDragging) {
      suppressNextClick(dragState.itemId);
    }
  }

  function resetDragState() {
    pointerDragRef.current = null;
    setDragPreview(null);
    setDraggedId(null);
    setDropColumn(null);
  }

  function suppressNextClick(itemId: string) {
    suppressedClickIdRef.current = itemId;

    if (suppressedClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressedClickTimeoutRef.current);
    }

    suppressedClickTimeoutRef.current = window.setTimeout(() => {
      if (suppressedClickIdRef.current === itemId) {
        suppressedClickIdRef.current = null;
      }

      suppressedClickTimeoutRef.current = null;
    }, 0);
  }

  return {
    draggedId,
    dragPreview,
    dropColumn,
    getPointerHandlers,
    previewRef,
    shouldSkipClick,
  };
}

export function boardColumnAtPoint(
  x: number,
  y: number,
  attribute: string,
): string | null {
  return (
    document
      .elementFromPoint(x, y)
      ?.closest(`[${attribute}]`)
      ?.getAttribute(attribute) ?? null
  );
}

function releasePointerCapture(event: PointerEvent<HTMLElement>) {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}
