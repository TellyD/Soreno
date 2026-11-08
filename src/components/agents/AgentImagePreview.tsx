import { useRef, useState } from "react";
import { ImagePreviewDialog } from "../ui/ImagePreviewDialog";
import "./AgentImagePreview.css";

export function AgentImagePreview({
  src,
  name,
  label,
}: {
  src: string;
  name: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="agent-image-preview-trigger"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt="" />
      </button>
      {open ? (
        <ImagePreviewDialog
          src={src}
          name={name}
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  );
}
