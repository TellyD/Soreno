import type {
  AgentGridFrame,
  AgentGridScroll,
} from "../../domain/agentSessions";
import { GridMode } from "./agentGridKeys";

// The grid reserves this width when fitting columns.
export const GRID_SCROLLBAR_WIDTH = 14;
const MIN_THUMB = 20;

type AgentGridScrollbarOptions = {
  scroll: (request: AgentGridScroll) => Promise<void>;
  // Keeps keyboard focus in the terminal input.
  focus: () => void;
};

type Drag = { pointerId: number; y: number; offset: number };

/** Thumb geometry in pixels for a track `track` px tall; `offset` counts lines up from the bottom. */
function gridScrollbarThumb(
  rows: number,
  history: number,
  offset: number,
  track: number,
) {
  const size = Math.min(
    track,
    Math.max(MIN_THUMB, (rows / (rows + history)) * track),
  );
  const clamped = Math.min(history, Math.max(0, offset));
  return { size, top: ((track - size) * (history - clamped)) / history };
}

export class AgentGridScrollbar {
  private readonly track: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private rows = 0;
  private history = 0;
  private offset = 0;
  private trackHeight = 0;
  private drag: Drag | null = null;
  private wanted: number | null = null;
  private requested = -1;
  private inFlight = false;
  private disposed = false;

  constructor(
    host: HTMLElement,
    private readonly options: AgentGridScrollbarOptions,
  ) {
    this.track = document.createElement("div");
    this.track.className = "agent-grid-scrollbar";
    this.track.setAttribute("aria-hidden", "true");
    this.track.hidden = true;
    this.thumb = document.createElement("div");
    this.thumb.className = "agent-grid-scrollbar-thumb";
    this.track.append(this.thumb);
    this.track.addEventListener("pointerdown", this.pointerDown);
    this.track.addEventListener("pointermove", this.pointerMove);
    this.track.addEventListener("pointerup", this.pointerUp);
    this.track.addEventListener("pointercancel", this.pointerUp);
    this.track.addEventListener("lostpointercapture", this.pointerUp);
    for (const type of ["mousedown", "mousemove", "mouseup"] as const)
      this.track.addEventListener(type, this.isolateMouse);
    host.append(this.track);
  }

  setForeground(color: string) {
    this.track.style.color = color;
  }

  setTrackHeight(height: number) {
    if (height === this.trackHeight) return;
    this.trackHeight = height;
    this.paint();
  }

  update(frame: AgentGridFrame) {
    this.rows = frame.rows;
    this.history = frame.historySize;
    this.track.hidden =
      frame.historySize === 0 ||
      frame.rows === 0 ||
      (frame.modes & GridMode.altScreen) !== 0;
    if (this.track.hidden) this.endDrag();
    // A pending drag shows its own target until the backend has caught up.
    if (!this.drag && !this.inFlight) this.offset = frame.displayOffset;
    this.paint();
  }

  dispose() {
    this.disposed = true;
    this.track.remove();
  }

  private paint() {
    if (this.track.hidden || !this.trackHeight) return;
    const { size, top } = this.geometry();
    this.thumb.style.height = `${size}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
  }

  private geometry() {
    return gridScrollbarThumb(
      this.rows,
      this.history,
      this.offset,
      this.trackHeight,
    );
  }

  private readonly isolateMouse = (event: MouseEvent) => {
    // The host would report these to mouse-aware CLIs or move focus.
    event.stopPropagation();
    if (event.type === "mousedown") event.preventDefault();
  };

  private readonly pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.drag || this.track.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.focus();
    const bounds = this.track.getBoundingClientRect();
    if (bounds.height) this.trackHeight = bounds.height;
    const y = event.clientY - bounds.top;
    const { size, top } = this.geometry();
    if (y < top) {
      void this.options.scroll({ kind: "pageUp" }).catch(() => {});
    } else if (y > top + size) {
      void this.options.scroll({ kind: "pageDown" }).catch(() => {});
    } else {
      this.drag = {
        pointerId: event.pointerId,
        y: event.clientY,
        offset: this.offset,
      };
      this.requested = this.offset;
      this.thumb.classList.add("is-active");
      this.track.setPointerCapture?.(event.pointerId);
    }
  };

  private readonly pointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const travel = this.trackHeight - this.geometry().size;
    if (travel <= 0) return;
    const offset = Math.min(
      this.history,
      Math.max(
        0,
        Math.round(
          drag.offset - ((event.clientY - drag.y) * this.history) / travel,
        ),
      ),
    );
    if (offset === this.offset) return;
    this.offset = offset;
    this.paint();
    this.request(offset);
  };

  private readonly pointerUp = (event: PointerEvent) => {
    if (this.drag && event.pointerId === this.drag.pointerId) this.endDrag();
  };

  private endDrag() {
    if (!this.drag) return;
    const { pointerId } = this.drag;
    this.drag = null;
    this.thumb.classList.remove("is-active");
    if (this.track.hasPointerCapture?.(pointerId))
      this.track.releasePointerCapture(pointerId);
  }

  // One request in flight; newer drag positions replace the queued one.
  private request(offset: number) {
    this.wanted = offset;
    if (this.inFlight) return;
    this.inFlight = true;
    void (async () => {
      while (this.wanted !== null && !this.disposed) {
        const next = this.wanted;
        this.wanted = null;
        if (next === this.requested) continue;
        this.requested = next;
        await this.options
          .scroll({ kind: "offset", offset: next })
          .catch(() => {});
      }
      this.inFlight = false;
    })();
  }
}
