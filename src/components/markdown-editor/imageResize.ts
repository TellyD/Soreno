import { EditorView } from "@codemirror/view";
import {
  deleteCharBackward,
  deleteCharForward,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import {
  imageWidthComment,
  maxImageWidth,
  minImageWidth,
} from "../../domain/imageSize";
import { isImeComposing } from "../../domain/keyboard";

const cancelResize = new WeakMap<HTMLElement, () => void>();
export function stopImageResize(dom: HTMLElement) {
  cancelResize.get(dom)?.();
  cancelResize.delete(dom);
}

function setImageWidth(dom: HTMLElement, width: number | undefined) {
  dom.classList.toggle("cm-md-image-resized", width !== undefined);
  dom.style.width = width === undefined ? "" : `${width}px`;
}

export function bindImageResize(
  dom: HTMLElement,
  view: EditorView,
  options: {
    from: number;
    to: number;
    imageTo: number;
    width: number | undefined;
    label: string;
    selected: boolean;
  },
) {
  stopImageResize(dom);
  setImageWidth(dom, options.width);
  let handle = dom.querySelector<HTMLElement>(".cm-md-image-resize");
  if (!handle) {
    handle = document.createElement("div");
    handle.className = "cm-md-image-resize";
    handle.tabIndex = -1;
    dom.append(handle);
  }
  const control = handle;
  control.hidden = !options.selected || view.state.readOnly;
  control.setAttribute("aria-label", options.label);
  const doc = view.state.doc;
  let drag:
    { pointer: number; x: number; initial: number; width: number } | undefined;
  const current = () =>
    dom.isConnected && view.state.doc === doc && !view.state.readOnly;
  const clamp = (width: number) => {
    const style = getComputedStyle(view.contentDOM);
    const available =
      view.contentDOM.clientWidth -
      parseFloat(style.paddingLeft || "0") -
      parseFloat(style.paddingRight || "0");
    return Math.round(
      Math.max(
        minImageWidth,
        Math.min(width, maxImageWidth, available || maxImageWidth),
      ),
    );
  };
  const cancel = () => {
    const pointer = drag?.pointer;
    drag = undefined;
    setImageWidth(dom, options.width);
    if (pointer !== undefined && control.hasPointerCapture(pointer))
      control.releasePointerCapture(pointer);
  };
  cancelResize.set(dom, cancel);
  const commit = (width: number) => {
    if (!current()) return;
    const insert =
      doc.sliceString(options.from, options.imageTo) + imageWidthComment(width);
    if (doc.sliceString(options.from, options.to) === insert) return;
    // Replace the atomic image as a whole so redo also restores its full selection.
    view.dispatch({
      changes: { from: options.from, to: options.to, insert },
      selection: { anchor: options.from, head: options.from + insert.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.resize",
    });
  };
  control.onclick = (event) => event.stopPropagation();
  control.onpointerdown = (event) => {
    if (event.button !== 0 || !current() || drag) return;
    event.preventDefault();
    event.stopPropagation();
    control.focus();
    const width = dom.getBoundingClientRect().width;
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      initial: width,
      width,
    };
    control.setPointerCapture(event.pointerId);
  };
  control.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!current()) {
      cancel();
      return;
    }
    drag.width = clamp(drag.initial + event.clientX - drag.x);
    setImageWidth(dom, drag.width);
    view.requestMeasure();
  };
  control.onpointerup = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { width, initial } = drag;
    cancel();
    if (width !== initial) commit(width);
    view.focus();
  };
  control.onpointercancel = cancel;
  control.onlostpointercapture = cancel;
  control.onkeydown = (event) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      view.focus();
      return;
    }
    if (!current()) return;
    const key = event.key.toLowerCase();
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (key === "z" || key === "y")
    ) {
      event.preventDefault();
      event.stopPropagation();
      (key === "y" || event.shiftKey ? redo : undo)(view);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      (event.key === "Backspace" ? deleteCharBackward : deleteCharForward)(
        view,
      );
      view.focus();
      return;
    }
  };
}
