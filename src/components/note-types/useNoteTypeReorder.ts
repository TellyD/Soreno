import { useEffect, useRef, useState } from "react";
import {
  moveNoteType,
  type NoteType,
  type NoteTypeId,
} from "../../domain/noteTypes";
import { sameItems } from "../../domain/sameItems";

const dragStartThreshold = 4;

type DragState = {
  dropIndex: number;
  isDragging: boolean;
  noteTypeId: NoteTypeId;
  pointerId: number;
  startY: number;
};

type UseNoteTypeReorderOptions = {
  isDisabled: boolean;
  noteTypes: NoteType[];
  onDragStart: () => void;
  onReorder: (ids: NoteTypeId[]) => void | Promise<void>;
};

export function useNoteTypeReorder({
  isDisabled,
  noteTypes,
  onDragStart,
  onReorder,
}: UseNoteTypeReorderOptions) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const itemRefs = useRef(new Map<NoteTypeId, HTMLDivElement>());
  const noteTypesRef = useRef(noteTypes);
  const onDragStartRef = useRef(onDragStart);
  const onReorderRef = useRef(onReorder);
  const suppressNextSelectRef = useRef(false);
  const suppressNextSelectTimeoutRef = useRef<number | null>(null);
  const activeDragState = dragState?.isDragging ? dragState : null;
  const remainingDragTypes = activeDragState
    ? noteTypes.filter((noteType) => noteType.id !== activeDragState.noteTypeId)
    : [];
  const clampedDropIndex = activeDragState
    ? Math.max(
        0,
        Math.min(activeDragState.dropIndex, remainingDragTypes.length),
      )
    : 0;
  const dropBeforeId = activeDragState
    ? (remainingDragTypes[clampedDropIndex]?.id ?? null)
    : null;
  const isReorderDisabled = isDisabled || noteTypes.length < 2;

  useEffect(() => {
    noteTypesRef.current = noteTypes;
    onDragStartRef.current = onDragStart;
    onReorderRef.current = onReorder;
  });

  useEffect(() => {
    function handlePointerMove(event: globalThis.PointerEvent) {
      const currentDrag = dragStateRef.current;

      if (!currentDrag || event.pointerId !== currentDrag.pointerId) {
        return;
      }

      const hasStartedDragging =
        currentDrag.isDragging ||
        Math.abs(event.clientY - currentDrag.startY) >= dragStartThreshold;

      if (!hasStartedDragging) {
        return;
      }

      event.preventDefault();

      if (!currentDrag.isDragging) {
        onDragStartRef.current();
      }

      const nextDragState = {
        ...currentDrag,
        dropIndex: getDropIndex(event.clientY, currentDrag.noteTypeId),
        isDragging: true,
      };

      dragStateRef.current = nextDragState;
      setDragState(nextDragState);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      const currentDrag = dragStateRef.current;

      if (!currentDrag || event.pointerId !== currentDrag.pointerId) {
        return;
      }

      const wasDragging =
        currentDrag.isDragging ||
        Math.abs(event.clientY - currentDrag.startY) >= dragStartThreshold;

      dragStateRef.current = null;
      setDragState(null);

      if (!wasDragging) {
        return;
      }

      event.preventDefault();
      suppressImmediateSelect();

      const currentNoteTypes = noteTypesRef.current;
      const nextIds = moveNoteType(
        currentNoteTypes,
        currentDrag.noteTypeId,
        getDropIndex(event.clientY, currentDrag.noteTypeId),
      ).map((noteType) => noteType.id);
      const currentIds = currentNoteTypes.map((noteType) => noteType.id);

      if (!sameItems(nextIds, currentIds)) {
        void onReorderRef.current(nextIds);
      }
    }

    function handlePointerCancel(event: globalThis.PointerEvent) {
      const currentDrag = dragStateRef.current;

      if (!currentDrag || event.pointerId !== currentDrag.pointerId) {
        return;
      }

      dragStateRef.current = null;
      setDragState(null);
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (suppressNextSelectTimeoutRef.current !== null) {
        window.clearTimeout(suppressNextSelectTimeoutRef.current);
      }
    };
  }, []);

  function startDrag(
    noteTypeId: NoteTypeId,
    pointerId: number,
    startY: number,
  ) {
    if (isReorderDisabled) {
      return;
    }

    const sourceIndex = noteTypesRef.current.findIndex(
      (noteType) => noteType.id === noteTypeId,
    );

    if (sourceIndex < 0) {
      return;
    }

    const nextDragState = {
      dropIndex: sourceIndex,
      isDragging: false,
      noteTypeId,
      pointerId,
      startY,
    };

    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
  }

  function registerItemRef(noteTypeId: NoteTypeId) {
    return (element: HTMLDivElement | null) => {
      if (element) {
        itemRefs.current.set(noteTypeId, element);
      } else {
        itemRefs.current.delete(noteTypeId);
      }
    };
  }

  function shouldSkipSelect() {
    if (!suppressNextSelectRef.current) {
      return false;
    }

    suppressNextSelectRef.current = false;

    if (suppressNextSelectTimeoutRef.current !== null) {
      window.clearTimeout(suppressNextSelectTimeoutRef.current);
      suppressNextSelectTimeoutRef.current = null;
    }

    return true;
  }

  function suppressImmediateSelect() {
    suppressNextSelectRef.current = true;

    if (suppressNextSelectTimeoutRef.current !== null) {
      window.clearTimeout(suppressNextSelectTimeoutRef.current);
    }

    suppressNextSelectTimeoutRef.current = window.setTimeout(() => {
      suppressNextSelectRef.current = false;
      suppressNextSelectTimeoutRef.current = null;
    }, 0);
  }

  function getDropIndex(clientY: number, draggedId: NoteTypeId) {
    const remainingTypes = noteTypesRef.current.filter(
      (noteType) => noteType.id !== draggedId,
    );

    for (let index = 0; index < remainingTypes.length; index += 1) {
      const element = itemRefs.current.get(remainingTypes[index].id);

      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();

      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }

    return remainingTypes.length;
  }

  return {
    dropBeforeId,
    isDragging: (noteTypeId: NoteTypeId) =>
      activeDragState?.noteTypeId === noteTypeId,
    isReordering: activeDragState !== null,
    isReorderDisabled,
    registerItemRef,
    shouldShowDropAtEnd:
      activeDragState !== null && clampedDropIndex >= remainingDragTypes.length,
    shouldSkipSelect,
    startDrag,
  };
}
