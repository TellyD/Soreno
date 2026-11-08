import type {
  AgentGridCursorShape,
  AgentGridFrame,
  AgentGridSelection,
  AgentGridSpan,
} from "../../domain/agentSessions";
import {
  GRID_DEFAULT_BACKGROUND,
  GRID_DEFAULT_FOREGROUND,
  resolveGridColor,
  type AgentGridPalette,
} from "./agentGridPalette";

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const INVERSE = 8;
const DIM = 16;
const STRIKEOUT = 32;
const HIDDEN = 64;
// Px per character; below a device pixel over 50 cells at DPR 1.
const DRIFT_TOLERANCE = 0.02;
const URL_START = /https?:\/\//gi;
const URL_STOP = /[\s<>"']/;
const URL_TRAILING = ".,;:!?";
const URL_CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

type AgentGridRendererOptions = {
  // Receives only http(s) URLs.
  openLink: (url: string) => void;
  // Follows the cursor so IME popups open at the insertion point.
  caret?: HTMLElement;
};

type AgentGridPaintStats = {
  frames: number;
  // From applying a frame to the next animation frame: includes style, layout and paint.
  paintMsAvg: number;
  paintMsMax: number;
  boxes: number;
};

export type AgentGridCalibration = {
  // Measured px per character, one per attempt.
  drifts: number[];
  letterSpacing: number;
  perCell: boolean;
};

type Cursor = AgentGridFrame["cursor"];

// Per UTF-16 unit of `text`: the cells it covers.
type RowText = {
  text: string;
  starts: number[];
  ends: number[];
  cells: number;
};

type GridLink = {
  url: string;
  segments: { row: number; start: number; end: number }[];
};

type GridCell = { row: number; col: number };

function flagClasses(flags: number) {
  let classes = "";
  if (flags & BOLD) classes += " is-bold";
  if (flags & ITALIC) classes += " is-italic";
  if (flags & UNDERLINE) classes += " is-underline";
  if (flags & STRIKEOUT) classes += " is-strike";
  return classes;
}

// One character per cell: safe to index and split by UTF-16 unit.
function isCellRun(span: AgentGridSpan) {
  return !span.g && span.t.length === span.c;
}

function cellText(spans: readonly AgentGridSpan[], col: number) {
  let start = 0;
  for (const span of spans) {
    if (col < start + span.c)
      return isCellRun(span) ? span.t[col - start] : span.t;
    start += span.c;
  }
  return "";
}

function rowText(spans: readonly AgentGridSpan[]): RowText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let col = 0;
  for (const span of spans) {
    const perUnit = isCellRun(span);
    for (let i = 0; i < span.t.length; i++) {
      starts.push(perUnit ? col + i : col);
      ends.push(perUnit ? col + i + 1 : col + span.c);
    }
    text += span.t;
    col += span.c;
  }
  return { text, starts, ends, cells: col };
}

function count(text: string, char: string) {
  let found = 0;
  for (const c of text) if (c === char) found++;
  return found;
}

// Stops at whitespace or quotes, drops trailing punctuation and unbalanced closers.
function urlEnd(text: string, start: number) {
  let end = start;
  while (end < text.length && !URL_STOP.test(text[end])) end++;
  while (end > start) {
    const last = text[end - 1];
    const opener = URL_CLOSERS[last];
    if (
      !URL_TRAILING.includes(last) &&
      !(
        opener &&
        count(text.slice(start, end), opener) <
          count(text.slice(start, end), last)
      )
    )
      break;
    end--;
  }
  return end;
}

function httpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.host
    ? url.href
    : null;
}

export class AgentGridRenderer {
  private readonly screen: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private lines: (readonly AgentGridSpan[])[] = [];
  // Row continues on the next one (soft wrap).
  private wrapped: boolean[] = [];
  private texts: (RowText | undefined)[] = [];
  private cols = 0;
  private readonly linkLayer: HTMLDivElement;
  private readonly selectionLayer: HTMLDivElement;
  private selection: AgentGridSelection | null = null;
  private paintedSelection = "";
  private pointer: GridCell | null = null;
  private pressed: GridCell | null = null;
  private link: GridLink | null = null;
  private cursorState: Cursor = { row: 0, col: 0, shape: "hidden" };
  private blinkSince = "";
  private cellWidth = 8;
  private cellHeight = 17;
  private letterSpacing = 0;
  private perCell = false;
  private readonly glyphFits = new Map<string, boolean>();
  private measure: CanvasRenderingContext2D | null | undefined;
  private calibration = { settled: false, drifts: [] as number[] };
  private paint = { frames: 0, total: 0, max: 0 };
  private focused = false;
  private pending: { frame: AgentGridFrame; resolve: (ms: number) => void }[] =
    [];
  private frameRequest = 0;

  constructor(
    host: HTMLElement,
    private palette: AgentGridPalette,
    private readonly options: AgentGridRendererOptions,
  ) {
    this.screen = document.createElement("div");
    this.screen.className = "agent-grid-screen";
    this.cursor = document.createElement("div");
    this.cursor.className = "agent-grid-cursor";
    this.cursor.setAttribute("aria-hidden", "true");
    this.linkLayer = document.createElement("div");
    this.linkLayer.className = "agent-grid-link-layer";
    this.linkLayer.setAttribute("aria-hidden", "true");
    this.selectionLayer = document.createElement("div");
    this.selectionLayer.className = "agent-grid-selection-layer";
    this.selectionLayer.setAttribute("aria-hidden", "true");
    this.screen.append(this.cursor, this.linkLayer, this.selectionLayer);
    this.screen.addEventListener("click", this.handleClick);
    this.screen.addEventListener("mousedown", this.handleMouseDown);
    this.screen.addEventListener("mousemove", this.handleMouseMove);
    this.screen.addEventListener("mouseleave", this.handleMouseLeave);
    this.applyScreenStyle();
    host.prepend(this.screen);
  }

  get element() {
    return this.screen;
  }

  setPalette(palette: AgentGridPalette) {
    this.palette = palette;
    this.applyScreenStyle();
    this.repaint();
  }

  /** `letterSpacing` stretches each glyph advance to exactly `width` */
  setCellSize(width: number, height: number, letterSpacing = 0) {
    if (
      width === this.cellWidth &&
      height === this.cellHeight &&
      letterSpacing === this.letterSpacing
    )
      return;
    this.cellWidth = width;
    this.cellHeight = height;
    this.letterSpacing = letterSpacing;
    this.perCell = false;
    this.calibration = { settled: false, drifts: [] };
    this.applyScreenStyle();
    this.repaint();
    this.paintLink();
    this.paintSelection();
  }

  setFocused(focused: boolean) {
    if (focused === this.focused) return;
    this.focused = focused;
    this.paintCursor();
  }

  /**
   * Checks painted ASCII text against its cells, since some text stacks round fractional letter spacing:
   * corrects the spacing twice at most, then falls back to one box per character. Returns the outcome once, when settled.
   */
  calibrate(): AgentGridCalibration | null {
    const state = this.calibration;
    if (state.settled) return null;
    const range = document.createRange();
    let chars = 0;
    let overrun = 0;
    for (const span of this.screen.querySelectorAll<HTMLElement>(
      ".agent-grid-span:not(.is-glyph)",
    )) {
      const length = span.textContent?.length ?? 0;
      if (length < 8) continue;
      range.selectNodeContents(span);
      overrun +=
        range.getBoundingClientRect().width -
        span.getBoundingClientRect().width;
      chars += length;
      if (chars >= 2000) break;
    }
    if (!chars) return null;
    const drift = overrun / chars;
    state.drifts.push(Math.round(drift * 1000) / 1000);
    if (Math.abs(drift) > DRIFT_TOLERANCE && state.drifts.length < 3) {
      this.letterSpacing -= drift;
      this.applyScreenStyle();
      this.repaint();
      return null;
    }
    if (Math.abs(drift) > DRIFT_TOLERANCE) {
      this.perCell = true;
      this.repaint();
    }
    state.settled = true;
    return {
      drifts: [...state.drifts],
      letterSpacing: this.letterSpacing,
      perCell: this.perCell,
    };
  }

  /** Applies on the next animation frame; resolves with the milliseconds that animation frame spent applying, or 0 on dispose. */
  render(frame: AgentGridFrame) {
    return new Promise<number>((resolve) => {
      this.pending.push({ frame, resolve });
      if (!this.frameRequest)
        this.frameRequest = requestAnimationFrame(() => {
          this.frameRequest = 0;
          const pending = this.pending;
          this.pending = [];
          const start = performance.now();
          for (const { frame } of pending) this.apply(frame);
          const elapsed = performance.now() - start;
          for (const { resolve } of pending) resolve(elapsed);
          // The next animation frame starts once style, layout and paint of this one are done.
          requestAnimationFrame(() => {
            const painted = performance.now() - start;
            this.paint.frames++;
            this.paint.total += painted;
            this.paint.max = Math.max(this.paint.max, painted);
          });
        });
    });
  }

  /** Painted frames since the previous call, and the boxes on screen now. */
  takePaintStats(): AgentGridPaintStats {
    const { frames, total, max } = this.paint;
    this.paint = { frames: 0, total: 0, max: 0 };
    return {
      frames,
      paintMsAvg: frames ? total / frames : 0,
      paintMsMax: max,
      boxes: this.screen.getElementsByClassName("agent-grid-span").length,
    };
  }

  apply(frame: AgentGridFrame) {
    this.cols = frame.cols;
    if (frame.full) {
      this.lines = Array.from({ length: frame.rows }, () => []);
      this.wrapped = Array.from({ length: frame.rows }, () => false);
      this.texts = [];
      for (const [index, spans, wrapped] of frame.lines)
        if (index < frame.rows) {
          this.lines[index] = spans;
          this.wrapped[index] = wrapped;
        }
      this.rows = this.lines.map((spans) => this.createRow(spans));
      this.screen.replaceChildren(
        ...this.rows,
        this.cursor,
        this.linkLayer,
        this.selectionLayer,
      );
    } else {
      if (frame.shift) this.shiftRows(frame.shift);
      for (const [index, spans, wrapped] of frame.lines) {
        if (index >= this.lines.length) continue;
        this.lines[index] = spans;
        this.wrapped[index] = wrapped;
        this.texts[index] = undefined;
        const row = this.rows[index];
        if (!row) continue;
        row.replaceChildren(...spans.flatMap((span) => this.createSpans(span)));
      }
    }
    this.cursorState = frame.cursor;
    this.paintCursor();
    this.selection = frame.selection;
    this.paintSelection();
    if (this.pointer && (frame.full || frame.shift || frame.lines.length))
      this.hover();
  }

  /** Moves rows up (`shift` > 0) or down, reusing their elements: scrolling rebuilds only the rows that come in. */
  private shiftRows(shift: number) {
    const length = this.lines.length;
    const count = Math.min(Math.abs(shift), length);
    const moved = <T>(items: readonly T[], blank: T) =>
      Array.from({ length }, (_, index) => {
        const from = index + shift;
        return from >= 0 && from < length ? items[from] : blank;
      });
    this.lines = moved(this.lines, []);
    this.wrapped = moved(this.wrapped, false);
    this.texts = moved(this.texts, undefined);
    if (this.rows.length !== length) return;
    const rows = this.rows;
    const vacated =
      shift > 0 ? rows.slice(0, count) : rows.slice(length - count);
    for (const row of vacated) row.replaceChildren();
    if (shift > 0) {
      this.cursor.before(...vacated);
      this.rows = [...rows.slice(count), ...vacated];
    } else {
      this.screen.prepend(...vacated);
      this.rows = [...vacated, ...rows.slice(0, length - count)];
    }
  }

  dispose() {
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    for (const { resolve } of this.pending) resolve(0);
    this.pending = [];
    this.screen.removeEventListener("click", this.handleClick);
    this.screen.removeEventListener("mousedown", this.handleMouseDown);
    this.screen.removeEventListener("mousemove", this.handleMouseMove);
    this.screen.removeEventListener("mouseleave", this.handleMouseLeave);
    this.screen.remove();
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    this.pressed = event.button === 0 ? this.cellAt(event) : null;
  };

  private readonly handleMouseMove = (event: MouseEvent) => {
    const at = this.cellAt(event);
    if (at.row === this.pointer?.row && at.col === this.pointer.col) return;
    this.pointer = at;
    this.hover();
  };

  private readonly handleMouseLeave = () => {
    this.pointer = null;
    this.hover();
  };

  private readonly handleClick = (event: MouseEvent) => {
    const pressed = this.pressed;
    this.pressed = null;
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const at = this.cellAt(event);
    // shortcut: a drag that stays inside one cell selects half of it yet still counts as a click.
    if (pressed && (pressed.row !== at.row || pressed.col !== at.col)) return;
    // Shift-click extends the shown selection instead.
    // shortcut: a Shift-click that collapses the selection opens the link if its frame lands before
    // the click; remember the Shift press at mousedown if that matters.
    if (event.shiftKey && this.selection) return;
    const osc8 = event.target.closest<HTMLElement>("[data-link]")?.dataset.link;
    const url = osc8 ? httpUrl(osc8) : this.linkAt(at)?.url;
    if (url) this.options.openLink(url);
  };

  private cellAt(event: MouseEvent): GridCell {
    const bounds = this.screen.getBoundingClientRect();
    return {
      row: Math.floor((event.clientY - bounds.top) / this.cellHeight),
      col: Math.floor((event.clientX - bounds.left) / this.cellWidth),
    };
  }

  private rowText(row: number) {
    return (this.texts[row] ??= rowText(this.lines[row]));
  }

  // Only the hovered row and its wrapped neighbours are scanned.
  private linkAt({ row, col }: GridCell): GridLink | null {
    if (row < 0 || row >= this.lines.length || col < 0 || col >= this.cols)
      return null;
    // OSC 8 links take precedence over detected URLs.
    if (this.spanAt(row, col)?.l) return null;
    let first = row;
    while (first > 0 && this.wrapped[first - 1]) first--;
    let last = row;
    while (last < this.lines.length - 1 && this.wrapped[last]) last++;
    let text = "";
    const units: { row: number; start: number; end: number }[] = [];
    let hovered = -1;
    for (let r = first; r <= last; r++) {
      const line = this.rowText(r);
      for (let i = 0; i < line.text.length; i++) {
        if (r === row && line.starts[i] <= col && col < line.ends[i])
          hovered = units.length;
        units.push({ row: r, start: line.starts[i], end: line.ends[i] });
      }
      text += line.text;
      // Trimmed trailing blanks still separate words from the next row.
      if (this.wrapped[r] && line.cells < this.cols && r < last) {
        text += " ";
        units.push({ row: r, start: line.cells, end: line.cells });
      }
    }
    if (hovered < 0) return null;
    URL_START.lastIndex = 0;
    for (let match; (match = URL_START.exec(text));) {
      const end = urlEnd(text, match.index);
      URL_START.lastIndex = Math.max(end, match.index + 1);
      if (hovered < match.index) return null;
      if (hovered >= end) continue;
      const url = httpUrl(text.slice(match.index, end));
      if (!url) return null;
      const segments: GridLink["segments"] = [];
      for (const unit of units.slice(match.index, end)) {
        const segment = segments[segments.length - 1];
        if (segment?.row === unit.row)
          segment.end = Math.max(segment.end, unit.end);
        else segments.push({ ...unit });
      }
      return { url, segments };
    }
    return null;
  }

  private spanAt(row: number, col: number) {
    let start = 0;
    for (const span of this.lines[row]) {
      if (col < start + span.c) return span;
      start += span.c;
    }
    return undefined;
  }

  private hover() {
    const link = this.pointer ? this.linkAt(this.pointer) : null;
    const same =
      link?.url === this.link?.url &&
      JSON.stringify(link?.segments) === JSON.stringify(this.link?.segments);
    this.link = link;
    if (!same) this.paintLink();
  }

  private paintLink() {
    const segments = this.link?.segments ?? [];
    this.screen.classList.toggle("is-link-hover", segments.length > 0);
    this.linkLayer.replaceChildren(
      ...segments.map(({ row, start, end }) => {
        const underline = document.createElement("div");
        underline.className = "agent-grid-link-underline";
        underline.style.left = `${start * this.cellWidth}px`;
        underline.style.top = `${row * this.cellHeight}px`;
        underline.style.width = `${(end - start) * this.cellWidth}px`;
        underline.style.height = `${this.cellHeight}px`;
        return underline;
      }),
    );
  }

  // At most three boxes: the first row's tail, the full rows between, the last row's head.
  private paintSelection() {
    const rows = this.lines.length;
    const painted = `${JSON.stringify(this.selection)}:${this.cols}x${rows}:${this.cellWidth}x${this.cellHeight}`;
    if (painted === this.paintedSelection) return;
    this.paintedSelection = painted;
    const boxes: HTMLDivElement[] = [];
    const box = (top: number, bottom: number, left: number, right: number) => {
      top = Math.max(0, top);
      bottom = Math.min(rows - 1, bottom);
      if (top > bottom || right <= left) return;
      const element = document.createElement("div");
      element.className = "agent-grid-selection";
      element.style.left = `${left * this.cellWidth}px`;
      element.style.top = `${top * this.cellHeight}px`;
      element.style.width = `${(right - left) * this.cellWidth}px`;
      element.style.height = `${(bottom - top + 1) * this.cellHeight}px`;
      boxes.push(element);
    };
    if (this.selection) {
      const { startRow, startCol, endRow, endCol } = this.selection;
      if (startRow === endRow) box(startRow, startRow, startCol, endCol + 1);
      else {
        box(startRow, startRow, startCol, this.cols);
        box(startRow + 1, endRow - 1, 0, this.cols);
        box(endRow, endRow, 0, endCol + 1);
      }
    }
    this.selectionLayer.replaceChildren(...boxes);
  }

  private applyScreenStyle() {
    const style = this.screen.style;
    style.setProperty("--agent-grid-cell-width", `${this.cellWidth}px`);
    style.setProperty("--agent-grid-cell-height", `${this.cellHeight}px`);
    style.letterSpacing = `${this.letterSpacing}px`;
    style.color = this.palette.foreground;
    style.backgroundColor = this.palette.background;
    style.setProperty("--agent-grid-cursor", this.palette.cursor);
  }

  private repaint() {
    if (this.lines.length === 0) return;
    this.rows = this.lines.map((spans) => this.createRow(spans));
    this.screen.replaceChildren(
      ...this.rows,
      this.cursor,
      this.linkLayer,
      this.selectionLayer,
    );
    this.paintCursor();
    if (this.pointer) this.hover();
  }

  private createRow(spans: readonly AgentGridSpan[]) {
    const row = document.createElement("div");
    row.className = "agent-grid-row";
    row.append(...spans.flatMap((span) => this.createSpans(span)));
    return row;
  }

  private createSpans(span: AgentGridSpan) {
    if (!isCellRun(span)) return [this.createSpan(span, true)];
    if (this.perCell)
      return Array.from(span.t, (t) =>
        this.createSpan({ ...span, t, c: 1 }, true),
      );
    // Few boxes keep layout cheap; only characters the font draws off the cell grid get their own.
    const elements: HTMLSpanElement[] = [];
    let start = 0;
    const flush = (end: number) => {
      if (end > start)
        elements.push(
          this.createSpan(
            { ...span, t: span.t.slice(start, end), c: end - start },
            false,
          ),
        );
    };
    for (let i = 0; i < span.t.length; i++) {
      if (this.fitsCell(span.t[i])) continue;
      flush(i);
      elements.push(this.createSpan({ ...span, t: span.t[i], c: 1 }, true));
      start = i + 1;
    }
    flush(span.t.length);
    return elements;
  }

  /** Whether the screen font advances `char` exactly like ASCII, so it can share a box. */
  private fitsCell(char: string) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return true;
    let fits = this.glyphFits.get(char);
    if (fits === undefined) {
      const context = this.measureContext();
      fits =
        context !== null &&
        Math.abs(
          context.measureText(char).width - context.measureText("W").width,
        ) < 0.05;
      this.glyphFits.set(char, fits);
    }
    return fits;
  }

  private measureContext() {
    if (this.measure === undefined) {
      const context = document.createElement("canvas").getContext("2d");
      if (context) {
        const style = getComputedStyle(this.screen);
        context.font = `${style.fontSize} ${style.fontFamily}`;
      }
      this.measure = context;
    }
    return this.measure;
  }

  /** `glyph`: may be drawn by a fallback font wider than its cell. */
  private createSpan(span: AgentGridSpan, glyph: boolean) {
    const element = document.createElement("span");
    element.className = `agent-grid-span${flagClasses(span.f)}`;
    // Fallback-font glyphs may overflow their cell: keep them above the next cell's background.
    if (glyph && (span.c !== span.t.length || span.t.charCodeAt(0) > 0x7e))
      element.classList.add("is-glyph");
    element.style.width = `${span.c * this.cellWidth}px`;
    let fg = span.fg;
    let bg = span.bg;
    // Bold as bright, like xterm.
    if (span.f & BOLD && fg < 8) fg += 8;
    if (span.f & INVERSE) [fg, bg] = [bg, fg];
    if (span.f & HIDDEN) element.style.color = "transparent";
    else if (span.f & DIM)
      element.style.color = `color-mix(in srgb, ${resolveGridColor(this.palette, fg)} 50%, transparent)`;
    else if (fg !== GRID_DEFAULT_FOREGROUND)
      element.style.color = resolveGridColor(this.palette, fg);
    if (bg !== GRID_DEFAULT_BACKGROUND)
      element.style.backgroundColor = resolveGridColor(this.palette, bg);
    if (span.l) {
      element.dataset.link = span.l;
      element.classList.add("is-link");
    }
    element.textContent = span.t;
    return element;
  }

  private paintCursor() {
    const { row, col } = this.cursorState;
    const shape: AgentGridCursorShape =
      row < this.lines.length ? this.cursorState.shape : "hidden";
    const cursor = this.cursor;
    cursor.dataset.shape = shape;
    cursor.classList.toggle("is-focused", this.focused);
    const blinkSince = `${row}:${col}:${shape}`;
    if (blinkSince !== this.blinkSince) {
      this.blinkSince = blinkSince;
      cursor.classList.toggle("is-blink-restarted");
    }
    const x = col * this.cellWidth;
    const y = row * this.cellHeight;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.textContent =
      shape === "block" && this.focused ? cellText(this.lines[row], col) : "";
    const caret = this.options.caret;
    if (caret) {
      caret.style.left = `${x}px`;
      caret.style.top = `${y}px`;
    }
  }
}

const ANNOUNCE_DELAY_MS = 150;
const ANNOUNCE_MAX_WAIT_MS = 1000;
const ANNOUNCE_MAX_LINES = 20;

type AnnouncedView = Pick<AgentGridFrame, "cols" | "rows" | "displayOffset">;

/** Reads changed rows into an `aria-live` region for screen readers. */
export class AgentGridAnnouncer {
  private readonly rows = new Map<number, readonly AgentGridSpan[]>();
  private timer: number | undefined;
  private pendingSince: number | undefined;
  // Last received frame, not the optimistic input state.
  private last: AnnouncedView | null = null;

  constructor(
    private readonly region: HTMLElement,
    private readonly isFocused: () => boolean,
  ) {}

  /** `configured`: a configure was sent, so the next full frame redraws known content. */
  frame(frame: AgentGridFrame, configured: boolean) {
    const last = this.last;
    this.last = {
      cols: frame.cols,
      rows: frame.rows,
      displayOffset: frame.displayOffset,
    };
    const repaint =
      !last ||
      frame.displayOffset !== last.displayOffset ||
      (frame.full &&
        (configured || frame.cols !== last.cols || frame.rows !== last.rows));
    if (frame.shift && this.rows.size) {
      // Rows moved off the top keep a negative index: still announced, in order.
      const moved = [...this.rows].map(
        ([index, spans]) => [index - frame.shift, spans] as const,
      );
      this.rows.clear();
      for (const [index, spans] of moved) this.rows.set(index, spans);
    }
    if (repaint || frame.lines.length === 0 || !this.isFocused()) return;
    for (const [index, spans] of frame.lines) this.rows.set(index, spans);
    const now = performance.now();
    this.pendingSince ??= now;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(
      this.flush,
      Math.min(
        ANNOUNCE_DELAY_MS,
        this.pendingSince + ANNOUNCE_MAX_WAIT_MS - now,
      ),
    );
  }

  /** A new subscription starts: its first frame repaints the screen. */
  reset() {
    this.cancel();
    this.last = null;
  }

  clear() {
    this.cancel();
    this.region.textContent = "";
  }

  dispose() {
    this.cancel();
  }

  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingSince = undefined;
    this.rows.clear();
  }

  private readonly flush = () => {
    this.timer = undefined;
    this.pendingSince = undefined;
    const lines: string[] = [];
    if (this.isFocused())
      for (const index of [...this.rows.keys()].sort((a, b) => a - b)) {
        const text = this.rows
          .get(index)!
          .map((span) => span.t)
          .join("")
          .trimEnd();
        if (text) lines.push(text);
      }
    this.rows.clear();
    if (lines.length)
      this.region.textContent = lines.slice(-ANNOUNCE_MAX_LINES).join("\n");
  };
}
