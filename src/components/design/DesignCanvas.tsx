import { ContextMenu } from "@base-ui/react/context-menu";
import {
  Copy,
  LoaderCircle,
  Maximize,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { DesignFrame, DesignTarget } from "../../domain/design";
import {
  designFrameDocument,
  designFramePick,
} from "../../domain/designFrameDocument";
import {
  DESIGN_ZOOM_STEP,
  designBringToFront,
  designEscapeTarget,
  designFitView,
  designResize,
  designSnap,
  designWheelScale,
  designZoomAt,
  type DesignGuide,
  type DesignHandle,
  type DesignView,
} from "../../domain/designCanvas";
import { isImeComposing, isTextFieldTarget } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "../agents/contextMenuKeyboard";
// Frames run it alone, under their policy.
import pickerUrl from "./framePicker.js?url&no-inline";
import "./DesignCanvas.css";

const PICKER = new URL(pickerUrl, location.href).href;
const HANDLES: DesignHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
// Screen pixels within which a moved or resized edge snaps.
const SNAP_DISTANCE = 6;
const NUDGES: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Gesture = { pointerX: number; pointerY: number; moved: boolean } & (
  | { kind: "pan"; view: DesignView; background: boolean }
  | {
      kind: "frame";
      handle: DesignHandle | null;
      start: DesignFrame;
      raised: boolean;
      current: DesignFrame;
    }
);

type DesignCanvasEditing = {
  readOnly?: false;
  target: DesignTarget;
  onTargetChange: (target: DesignTarget) => void;
  /** Geometry/z/title committed once per gesture (drag end, resize end, bring to front). */
  onFrameChange: (frame: DesignFrame) => void;
  onDuplicate: (frameId: string) => void;
  onDelete: (frameId: string) => void;
  /** Clicks inside frames pick an element instead of selecting the frame. */
  targeting: boolean;
  onTargetingChange: (targeting: boolean) => void;
  /** Zoom, fit and targeting keys listen on the whole document while true: the board is on screen. */
  shortcuts?: boolean;
  /** Frames the agent is reworking after a targeted prompt. */
  busyFrameIds?: ReadonlySet<string>;
};

const boardTarget: DesignTarget = { kind: "board" };
const ignore = () => {};
// Views survive remounts (tab or board switches) for the app's lifetime.
const savedViews = new Map<string, DesignView>();

/** A read-only canvas only pans and zooms: no selection, edit or targeting. */
export function DesignCanvas(
  props: {
    frames: readonly DesignFrame[];
    /** Remembers the pan and zoom under this key; without a saved view, frames are fitted. */
    viewKey: string;
    /** Shown centered when there is no frame yet. */
    empty?: ReactNode;
  } & (DesignCanvasEditing | { readOnly: true }),
) {
  const { frames, empty, viewKey } = props;
  const editor = props.readOnly ? null : props;
  const target = editor?.target ?? boardTarget;
  const targeting = editor?.targeting ?? false;
  const onTargetChange = editor?.onTargetChange ?? ignore;
  const onFrameChange = editor?.onFrameChange ?? ignore;
  const onDuplicate = editor?.onDuplicate ?? ignore;
  const onDelete = editor?.onDelete ?? ignore;
  const setTargeting = editor?.onTargetingChange ?? ignore;
  const { t } = useI18n();
  const { theme } = useTheme();
  const hintId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<DesignView>(
    () => savedViews.get(viewKey) ?? { x: 0, y: 0, scale: 1 },
  );
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  // The frame being moved, resized or nudged, until the committed frames come back.
  const [live, setLive] = useState<DesignFrame | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const nudged = useRef<DesignFrame | null>(null);
  const [guides, setGuides] = useState<DesignGuide[]>([]);
  const fitted = useRef(savedViews.has(viewKey));
  const iframes = useRef(new Map<string, HTMLIFrameElement>());
  const frameElements = useRef(new Map<string, HTMLElement>());
  const selectedId = target.kind === "board" ? null : target.frameId;
  const shown = frames.map((frame) =>
    frame.id === live?.id
      ? { ...live, html: frame.html, title: frame.title }
      : frame,
  );
  const selected = shown.find((frame) => frame.id === selectedId);

  useEffect(() => setLive(null), [frames]);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A saved view means the first fit is done: an unfitted view is never kept.
  useEffect(() => {
    if (fitted.current) savedViews.set(viewKey, view);
  }, [view, viewKey]);

  // Fits once per key, when the first frames arrive; afterwards the user's view stays,
  // even through the empty frames of a reload.
  useLayoutEffect(() => {
    if (!frames.length && !savedViews.has(viewKey)) fitted.current = false;
    if (fitted.current || !frames.length || !size.width) return;
    fitted.current = true;
    setView(designFitView(frames, size.width, size.height));
  }, [frames, size, viewKey]);

  // Non-passive: the WebView would scroll or zoom the whole page otherwise.
  useEffect(() => {
    const element = viewport.current!;
    let pinch = 1;
    const point = (clientX: number, clientY: number) => {
      const box = element.getBoundingClientRect();
      return [clientX - box.left, clientY - box.top] as const;
    };
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const [px, py] = point(event.clientX, event.clientY);
      const unit = event.deltaMode === 1 ? 16 : 1;
      if (event.ctrlKey || event.metaKey) {
        setView((current) =>
          designZoomAt(
            current,
            designWheelScale(current.scale, event.deltaY * unit),
            px,
            py,
          ),
        );
        return;
      }
      // Shift+wheel scrolls sideways where the system does not already turn it into deltaX.
      const sideways = event.shiftKey && !event.deltaX;
      const dx = (sideways ? event.deltaY : event.deltaX) * unit;
      const dy = (sideways ? 0 : event.deltaY) * unit;
      setView((current) => ({
        ...current,
        x: current.x - dx,
        y: current.y - dy,
      }));
    }
    // WebKit reports trackpad pinches as gesture events, not as Ctrl+wheel.
    function gesture(event: Event) {
      event.preventDefault();
      const { scale, clientX, clientY } = event as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      if (event.type === "gesturestart") pinch = 1;
      const ratio = scale / pinch;
      pinch = scale;
      const [px, py] = point(clientX, clientY);
      setView((current) =>
        designZoomAt(current, current.scale * ratio, px, py),
      );
    }
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gesture);
    element.addEventListener("gesturechange", gesture);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gesture);
      element.removeEventListener("gesturechange", gesture);
    };
  }, []);

  useEffect(() => {
    function key(event: globalThis.KeyboardEvent) {
      if (event.code !== "Space") return;
      if (event.type === "keyup") setSpaceHeld(false);
      else if (!isTextFieldTarget(event.target)) setSpaceHeld(true);
    }
    const release = () => setSpaceHeld(false);
    addEventListener("keydown", key);
    addEventListener("keyup", key);
    addEventListener("blur", release);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("keyup", key);
      removeEventListener("blur", release);
    };
  }, []);

  useEffect(() => {
    function listen(event: MessageEvent) {
      // Only a frame's picker speaks, and its word is checked: frames are agent-written.
      const frameId = [...iframes.current].find(
        ([, iframe]) => iframe.contentWindow === event.source,
      )?.[0];
      if (!frameId) return;
      const pick = designFramePick(event.data);
      if (pick?.type === "zoom") {
        const frame = iframes.current.get(frameId)!.getBoundingClientRect();
        const box = viewport.current!.getBoundingClientRect();
        setView((current) =>
          designZoomAt(
            current,
            designWheelScale(current.scale, pick.deltaY),
            frame.left - box.left + pick.x * current.scale,
            frame.top - box.top + pick.y * current.scale,
          ),
        );
      }
      if (pick?.type !== "pick") return;
      // Out of the frame first: the keyboard shortcuts listen here. Before the pick, or focusing would select the frame back.
      frameElements.current.get(frameId)?.focus({ preventScroll: true });
      onTargetChange(
        pick.target
          ? { kind: "element", frameId, ...pick.target }
          : { kind: "frame", frameId },
      );
    }
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  });

  // The picker outlines the targeted element in its frame; other frames forget theirs.
  const targetFrame = target.kind === "element" ? target.frameId : null;
  useEffect(() => {
    for (const [id, iframe] of iframes.current)
      if (id !== targetFrame)
        iframe.contentWindow?.postMessage("soreno-frame-clear", "*");
  }, [targetFrame]);

  function select(frame: DesignFrame) {
    if (selectedId !== frame.id)
      onTargetChange({ kind: "frame", frameId: frame.id });
  }

  function zoomTo(scale: number) {
    setView((current) =>
      designZoomAt(current, scale, size.width / 2, size.height / 2),
    );
  }

  function fit(fitted: readonly DesignFrame[]) {
    if (fitted.length) setView(designFitView(fitted, size.width, size.height));
  }

  /** Runs the board shortcut of `event`, if any; selection and targeting keys need an editor. */
  function runShortcut(event: globalThis.KeyboardEvent) {
    if (
      event.altKey ||
      isImeComposing(event) ||
      isTextFieldTarget(event.target) ||
      document.querySelector('[aria-modal="true"]')
    )
      return;
    const command = event.ctrlKey || event.metaKey;
    let action: (() => void) | null = null;
    if (command) {
      // Shift is allowed: "+" needs it on most layouts.
      if (
        event.key === "=" ||
        event.key === "+" ||
        event.code === "Equal" ||
        event.code === "NumpadAdd"
      )
        action = () => zoomTo(view.scale * DESIGN_ZOOM_STEP);
      else if (
        event.key === "-" ||
        event.code === "Minus" ||
        event.code === "NumpadSubtract"
      )
        action = () => zoomTo(view.scale / DESIGN_ZOOM_STEP);
    } else if (event.shiftKey) {
      // Physical digits: Shift+1 is "!" on QWERTY and "1" on AZERTY.
      if (event.code === "Digit1") action = () => fit(shown);
      else if (event.code === "Digit0") action = () => zoomTo(1);
      else if (event.code === "Digit2" && editor)
        action = () => fit(selected ? [selected] : []);
    } else if (
      event.key.toLowerCase() === "t" &&
      // A held T toggles once; zoom keys keep repeating.
      !event.repeat &&
      editor &&
      frames.length
    )
      action = () => setTargeting(!targeting);
    if (!action) return;
    event.preventDefault();
    action();
  }

  // shortcut: keys typed while focus is inside a frame's iframe (Tab in targeting mode) never reach this document listener; relay them through framePicker.js if keyboard users hit it.
  const shortcuts = !!editor?.shortcuts;
  useEffect(() => {
    if (!shortcuts) return;
    document.addEventListener("keydown", runShortcut);
    return () => document.removeEventListener("keydown", runShortcut);
  });

  function startPan(event: PointerEvent, background: boolean) {
    gesture.current = {
      kind: "pan",
      pointerX: event.clientX,
      pointerY: event.clientY,
      moved: false,
      view,
      background,
    };
    viewport.current!.setPointerCapture(event.pointerId);
  }

  function frameDown(
    event: PointerEvent,
    frame: DesignFrame,
    handle: DesignHandle | null,
  ) {
    // Events of the context menu's portal bubble here through React.
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.stopPropagation();
    if (event.button === 1 || spaceHeld || !editor)
      return startPan(event, false);
    select(frame);
    if (event.button !== 0) return;
    const start = designBringToFront(shown, frame);
    gesture.current = {
      kind: "frame",
      pointerX: event.clientX,
      pointerY: event.clientY,
      moved: false,
      handle,
      start,
      raised: start.z !== frame.z,
      current: start,
    };
    setLive(start);
    // On the frame, not the viewport: a viewport capture retargets the dblclick away from the frame.
    // Captured moves and ups still bubble to the viewport's handlers.
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent) {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.pointerX;
    const dy = event.clientY - current.pointerY;
    if (!current.moved && Math.hypot(dx, dy) < 3) return;
    current.moved = true;
    if (current.kind === "pan") {
      setView({
        ...current.view,
        x: current.view.x + dx,
        y: current.view.y + dy,
      });
      return;
    }
    const { start, handle } = current;
    const bx = dx / view.scale;
    const by = dy / view.scale;
    const moved = {
      ...start,
      ...(handle
        ? designResize(start, handle, bx, by)
        : { x: Math.round(start.x + bx), y: Math.round(start.y + by) }),
    };
    // Alt turns snapping off for as long as it is held.
    const snap = event.altKey
      ? { rect: moved, guides: [] }
      : designSnap(
          moved,
          frames.filter((frame) => frame.id !== start.id),
          SNAP_DISTANCE / view.scale,
          handle,
        );
    current.current = { ...moved, ...snap.rect };
    setLive(current.current);
    setGuides(snap.guides);
  }

  function pointerUp() {
    const current = gesture.current;
    gesture.current = null;
    setGuides([]);
    if (current?.kind === "pan" && !current.moved && current.background)
      onTargetChange({ kind: "board" });
    if (current?.kind === "frame" && (current.moved || current.raised))
      onFrameChange(current.current);
  }

  function keyDown(event: KeyboardEvent) {
    if (
      !editor ||
      !event.currentTarget.contains(event.target as Node) ||
      isTextFieldTarget(event.target) ||
      isImeComposing(event.nativeEvent)
    )
      return;
    if (event.key === "Escape") {
      if (target.kind === "board" && !targeting) return;
      event.preventDefault();
      if (target.kind !== "element") setTargeting(false);
      onTargetChange(designEscapeTarget(target));
      return;
    }
    if (!selected) return;
    const command = event.ctrlKey || event.metaKey;
    if ((event.key === "Delete" || event.key === "Backspace") && !command) {
      event.preventDefault();
      onTargetChange({ kind: "board" });
      onDelete(selected.id);
    } else if (command && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      onDuplicate(selected.id);
    } else if (NUDGES[event.key] && !command && !event.altKey) {
      event.preventDefault();
      const [dx, dy] = NUDGES[event.key];
      const step = event.shiftKey ? 10 : 1;
      // Another frame's pending nudge is saved first, never used as this frame's base.
      if (nudged.current?.id !== selected.id) commitNudge();
      const base = nudged.current ?? selected;
      nudged.current = {
        ...base,
        x: base.x + dx * step,
        y: base.y + dy * step,
      };
      setLive(nudged.current);
    }
  }

  function commitNudge() {
    if (!nudged.current) return;
    onFrameChange(nudged.current);
    nudged.current = null;
  }

  // Dots at least 12px apart, whatever the zoom.
  let grid = 24 * view.scale;
  while (grid < 12) grid *= 2;
  const panning = gesture.current?.kind === "pan" && gesture.current.moved;
  return (
    <div
      className="design-canvas"
      // Space/arrows after a click would turn on Chromium's :focus-visible; only Tab shows the ring.
      onPointerDownCapture={(event) => {
        event.currentTarget.dataset.pointer = "";
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") delete event.currentTarget.dataset.pointer;
        keyDown(event);
        // A read-only preview sits beside a terminal: its keys stay within the canvas.
        if (!editor) runShortcut(event.nativeEvent);
      }}
      onKeyUp={(event) => {
        if (NUDGES[event.key]) commitNudge();
      }}
      // The arrow's keyup lands elsewhere once focus leaves the canvas.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        commitNudge();
        // Tabbing back in starts outside the canvas, where the Tab keydown is not seen.
        delete event.currentTarget.dataset.pointer;
      }}
    >
      <div
        ref={viewport}
        className={`design-canvas-viewport${spaceHeld ? " is-grabbing" : ""}${panning ? " is-panning" : ""}`}
        role="region"
        tabIndex={0}
        aria-label={t("design.canvas.label")}
        style={{
          backgroundSize: `${grid}px ${grid}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={(event) => {
          if (
            event.button === 2 ||
            !event.currentTarget.contains(event.target as Node)
          )
            return;
          startPan(event, event.button === 0 && !spaceHeld);
        }}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div
          className="design-canvas-world"
          style={
            {
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              "--design-scale": view.scale,
              "--design-inverse": 1 / view.scale,
            } as CSSProperties
          }
        >
          {shown.map((frame) => {
            const isSelected = frame.id === selectedId;
            const busy = !!editor?.busyFrameIds?.has(frame.id);
            return (
              <ContextMenu.Root
                key={frame.id}
                disabled={!editor}
                onOpenChange={(open) => {
                  if (open) select(frame);
                }}
              >
                <ContextMenu.Trigger
                  ref={(element: HTMLDivElement | null) => {
                    if (element) frameElements.current.set(frame.id, element);
                    else frameElements.current.delete(frame.id);
                  }}
                  className={`design-canvas-frame${isSelected ? " is-selected" : ""}${busy ? " is-busy" : ""}`}
                  style={{
                    left: frame.x,
                    top: frame.y,
                    width: frame.width,
                    height: frame.height,
                    zIndex: frame.z,
                  }}
                  role="group"
                  tabIndex={0}
                  aria-label={frame.title}
                  aria-describedby={hintId}
                  aria-busy={busy || undefined}
                  onPointerDown={(event) => frameDown(event, frame, null)}
                  onDoubleClick={() => setTargeting(true)}
                  onFocus={() => select(frame)}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event))
                      openContextMenuFromKeyboard(event, event.currentTarget);
                  }}
                >
                  <div
                    className="design-canvas-frame-label"
                    title={frame.title}
                  >
                    {busy ? (
                      <LoaderCircle
                        size={12}
                        className="app-loading-spinner"
                        aria-hidden="true"
                      />
                    ) : null}
                    {frame.title}
                  </div>
                  <iframe
                    ref={(element) => {
                      if (element) iframes.current.set(frame.id, element);
                      else iframes.current.delete(frame.id);
                    }}
                    title={frame.title}
                    sandbox="allow-scripts"
                    srcDoc={designFrameDocument(frame.html, PICKER, theme)}
                    tabIndex={targeting ? undefined : -1}
                    style={{
                      pointerEvents:
                        targeting && !spaceHeld ? undefined : "none",
                    }}
                  />
                  {isSelected
                    ? HANDLES.map((handle) => (
                        <span
                          key={handle}
                          className={`design-canvas-handle is-${handle}`}
                          aria-hidden="true"
                          onPointerDown={(event) =>
                            frameDown(event, frame, handle)
                          }
                        />
                      ))
                    : null}
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Positioner
                    className="design-canvas-menu-positioner"
                    collisionPadding={8}
                  >
                    <ContextMenu.Popup
                      render={<MenuSurface className="design-canvas-menu" />}
                    >
                      <ContextMenu.Item
                        nativeButton
                        render={<MenuItem leading={<Copy />} />}
                        onClick={() => onDuplicate(frame.id)}
                      >
                        {t("design.canvas.duplicate")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        nativeButton
                        render={<MenuItem danger leading={<Trash2 />} />}
                        onClick={() => {
                          onTargetChange({ kind: "board" });
                          onDelete(frame.id);
                        }}
                      >
                        {t("design.canvas.delete")}
                      </ContextMenu.Item>
                    </ContextMenu.Popup>
                  </ContextMenu.Positioner>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
          {guides.map((guide) => (
            <span
              key={`${guide.axis}${guide.position}`}
              className={`design-canvas-guide is-${guide.axis}`}
              aria-hidden="true"
              style={
                guide.axis === "x"
                  ? {
                      left: guide.position,
                      top: guide.start,
                      height: guide.end - guide.start,
                    }
                  : {
                      top: guide.position,
                      left: guide.start,
                      width: guide.end - guide.start,
                    }
              }
            />
          ))}
        </div>
      </div>
      <span id={hintId} hidden>
        {t("design.canvas.frameHint")}
      </span>
      {frames.length ? null : (
        <div className="design-canvas-empty">{empty}</div>
      )}
      <div
        className="design-canvas-toolbar"
        role="toolbar"
        aria-label={t("design.canvas.controls")}
      >
        <IconButton
          size="small"
          aria-label={t("design.canvas.zoomOut")}
          title={t("design.canvas.zoomOut")}
          onClick={() => zoomTo(view.scale / DESIGN_ZOOM_STEP)}
        >
          <ZoomOut />
        </IconButton>
        <Button
          size="small"
          aria-label={t("design.canvas.zoomReset")}
          title={t("design.canvas.zoomReset")}
          onClick={() => zoomTo(1)}
        >
          {t("design.canvas.zoomLevel", {
            percent: Math.round(view.scale * 100),
          })}
        </Button>
        <IconButton
          size="small"
          aria-label={t("design.canvas.zoomIn")}
          title={t("design.canvas.zoomIn")}
          onClick={() => zoomTo(view.scale * DESIGN_ZOOM_STEP)}
        >
          <ZoomIn />
        </IconButton>
        <span className="design-canvas-toolbar-separator" aria-hidden="true" />
        <IconButton
          size="small"
          aria-label={t("design.canvas.fit")}
          title={t("design.canvas.fit")}
          disabled={!frames.length}
          onClick={() => fit(shown)}
        >
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}
