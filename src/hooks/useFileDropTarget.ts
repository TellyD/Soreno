import { useRef, useState, type DragEvent } from "react";

function hasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Tracks files dragged over an element. `canDrop` is read at every event; `onDrop` receives
 * every file drop, refused ones included, so it can invalidate earlier work.
 */
export function useFileDropTarget(
  canDrop: () => boolean,
  onDrop: (files: File[]) => void,
) {
  const depth = useRef(0);
  const [active, setActive] = useState(false);

  function reset() {
    depth.current = 0;
    setActive(false);
  }

  return {
    active,
    reset,
    handlers: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!canDrop()) return reset();
        depth.current++;
        setActive(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!canDrop()) return reset();
        event.dataTransfer.dropEffect = "copy";
        setActive(true);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (depth.current === 0 && !hasFiles(event)) return;
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        reset();
        onDrop(Array.from(event.dataTransfer.files));
      },
    },
  };
}
