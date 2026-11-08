import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { DialogOverlay, DialogSurface } from "./Dialog";
import { useDismissibleLayer } from "./useDismissibleLayer";
import "./ImagePreviewDialog.css";

export function ImagePreviewDialog({
  src,
  name,
  onClose,
  returnFocusRef,
}: {
  src: string;
  name: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, onClose);
  return createPortal(
    <DialogOverlay>
      <DialogSurface
        ref={surfaceRef}
        className="image-preview-dialog"
        aria-label={name}
        returnFocusRef={returnFocusRef}
        onClick={onClose}
      >
        <img src={src} alt={name} />
      </DialogSurface>
    </DialogOverlay>,
    document.body,
  );
}
