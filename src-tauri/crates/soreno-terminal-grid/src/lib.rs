//! Terminal emulation for the grid engine: raw PTY bytes in, changed visible rows out.
//! A crate of its own so dev builds optimise alacritty's generic code: callers only use the
//! non-generic methods below, which are monomorphised here.
mod grouper;
mod skip;
mod spans;
mod theme;

use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point, Side},
    selection::{Selection, SelectionType},
    term::{
        cell::{Cell, Flags},
        color::COUNT as COLOR_COUNT,
        ClipboardType, Config, Osc52, TermMode,
    },
    vte::ansi::{CursorShape, Processor},
    Term,
};
use grouper::FrameGrouper;
#[cfg(test)]
use grouper::{BSU, ESU, SYNC_TIMEOUT};
use memchr::memmem;
use serde::{Deserialize, Serialize};
pub use skip::SkipRefusal;
use skip::{check_keyframe, GroundTracker, SkipScan};
use spans::{mode_bits, row_spans};
#[cfg(test)]
use spans::{DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, TRUECOLOR};
use std::{
    cell::RefCell,
    hash::{DefaultHasher, Hash, Hasher},
    mem,
    rc::Rc,
    time::Instant,
};
pub use theme::GridTheme;
#[cfg(test)]
use theme::PALETTE_LEN;

const SCROLLBACK: usize = 5000;
const CLIPBOARD_LIMIT: usize = 100_000;
const CLEAR_SCROLLBACK: &[u8] = b"\x1b[3J";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGridConfig {
    pub cell_width: u16,
    pub cell_height: u16,
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentGridScroll {
    Delta {
        lines: i32,
    },
    PageUp,
    PageDown,
    Bottom,
    /// Lines up from the bottom, clamped to the history.
    Offset {
        offset: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentGridSelectMode {
    Simple,
    Word,
    Line,
}

/// Rows are viewport rows; `right` when the pointer is on the right half of the cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentGridSelect {
    Start {
        row: i32,
        col: u32,
        right: bool,
        mode: AgentGridSelectMode,
    },
    /// A row outside the screen scrolls toward it by its distance first.
    Extend {
        row: i32,
        col: u32,
        right: bool,
    },
    All,
    Clear,
}

/// Inclusive cells in viewport rows; rows outside `0..rows` are scrolled out of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGridSelection {
    pub start_row: i32,
    pub start_col: u32,
    pub end_row: i32,
    pub end_col: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct AgentGridSpan {
    pub t: String,
    pub c: u32,
    pub fg: u32,
    pub bg: u32,
    pub f: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<String>,
    /// One glyph over `c` cells (wide, combining, astral or control): never split by UTF-16 unit.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub g: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AgentGridCursor {
    pub row: u32,
    pub col: u32,
    pub shape: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGridFrame {
    pub cols: u32,
    pub rows: u32,
    pub full: bool,
    /// Rows the content moved up (negative: down) before `lines` apply; vacated rows are blank.
    pub shift: i32,
    /// `(row, spans, wrapped)`: `wrapped` when the row's text continues on the next row.
    pub lines: Vec<(u32, Vec<AgentGridSpan>, bool)>,
    pub cursor: AgentGridCursor,
    pub display_offset: u32,
    pub history_size: u32,
    pub selection: Option<AgentGridSelection>,
    /// Select requests applied so far (wrapping): tells the webview its selection is current.
    pub select_count: u32,
    pub modes: u32,
    pub title: Option<String>,
    pub clipboard: Option<String>,
    pub state: &'static str,
    pub parsed_bytes: u64,
    pub parse_micros: u64,
}

impl AgentGridFrame {
    pub fn idle() -> Self {
        Self {
            cols: 0,
            rows: 0,
            full: true,
            shift: 0,
            lines: Vec::new(),
            cursor: AgentGridCursor {
                row: 0,
                col: 0,
                shape: "hidden",
            },
            display_offset: 0,
            history_size: 0,
            selection: None,
            select_count: 0,
            modes: 0,
            title: None,
            clipboard: None,
            state: "idle",
            parsed_bytes: 0,
            parse_micros: 0,
        }
    }
}

/// Engine work since the previous `take_stats`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GridStats {
    pub fed: u64,
    pub parse_micros: u64,
    pub parse_max_micros: u64,
    pub skipped: u64,
}

impl GridStats {
    pub fn merge(&mut self, other: GridStats) {
        self.fed += other.fed;
        self.parse_micros += other.parse_micros;
        self.parse_max_micros = self.parse_max_micros.max(other.parse_max_micros);
        self.skipped += other.skipped;
    }
    fn parsed(&mut self, micros: u64) {
        self.parse_micros += micros;
        self.parse_max_micros = self.parse_max_micros.max(micros);
    }
}

/// Columns, then screen lines.
struct GridSize(usize, usize);

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.1
    }
    fn screen_lines(&self) -> usize {
        self.1
    }
    fn columns(&self) -> usize {
        self.0
    }
}

struct GridListener(Rc<RefCell<Vec<Event>>>);

impl EventListener for GridListener {
    fn send_event(&self, event: Event) {
        self.0.borrow_mut().push(event);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FrameMeta {
    cursor: AgentGridCursor,
    display_offset: u32,
    history_size: u32,
    selection: Option<AgentGridSelection>,
    select_count: u32,
    modes: u32,
    state: &'static str,
}

/// Terminal state fed with raw PTY bytes; produces frames without Tauri.
pub struct GridEngineCore {
    term: Term<GridListener>,
    processor: Processor,
    grouper: FrameGrouper,
    events: Rc<RefCell<Vec<Event>>>,
    theme: GridTheme,
    /// Stream offset after the last byte given to the grouper.
    fed: u64,
    /// Stream offset after the last byte parsed.
    applied: u64,
    /// Bytes before this offset replay history: their queries are not answered.
    live_from: u64,
    /// Parser state at `applied`: a skip must start between sequences.
    ground: GroundTracker,
    sent: Vec<SentRow>,
    sent_meta: Option<FrameMeta>,
    full: bool,
    dirty: bool,
    first: bool,
    title: Option<String>,
    current_title: Option<String>,
    clipboard: Option<String>,
    replies: Vec<u8>,
    state: &'static str,
    parsed_bytes: u64,
    parse_micros: u64,
    stats: GridStats,
    ready: Vec<u8>,
    select_count: u32,
}

impl GridEngineCore {
    pub fn new(cols: u16, rows: u16, theme: GridTheme, start: u64, live_from: u64) -> Self {
        let events = Rc::new(RefCell::new(Vec::new()));
        let config = Config {
            scrolling_history: SCROLLBACK,
            kitty_keyboard: false,
            osc52: Osc52::OnlyCopy,
            ..Config::default()
        };
        let term = Term::new(
            config,
            &GridSize(cols.max(1) as usize, rows.max(1) as usize),
            GridListener(events.clone()),
        );
        Self {
            term,
            processor: Processor::new(),
            grouper: FrameGrouper::default(),
            events,
            theme,
            fed: start,
            applied: start,
            live_from,
            ground: GroundTracker::default(),
            sent: Vec::new(),
            sent_meta: None,
            full: true,
            dirty: true,
            first: true,
            title: None,
            current_title: None,
            clipboard: None,
            replies: Vec::new(),
            state: "running",
            parsed_bytes: 0,
            parse_micros: 0,
            stats: GridStats::default(),
            ready: Vec::new(),
            select_count: 0,
        }
    }
    pub fn fed(&self) -> u64 {
        self.fed
    }
    /// Offset after the last parsed byte; the grouper holds `[applied, fed)`.
    pub fn applied(&self) -> u64 {
        self.applied
    }
    pub fn set_live_from(&mut self, offset: u64) {
        self.live_from = offset;
    }
    pub fn select_count(&self) -> u32 {
        self.select_count
    }
    /// A replacement engine continues the count the webview compares frames against.
    pub fn set_select_count(&mut self, count: u32) {
        self.select_count = count;
    }
    pub fn set_state(&mut self, state: &'static str) {
        if self.state != state {
            self.state = state;
            self.dirty = true;
        }
    }
    /// Bytes are taken as the stream continuation at `fed()`.
    pub fn feed(&mut self, bytes: &[u8], now: Instant) {
        self.fed += bytes.len() as u64;
        self.stats.fed += bytes.len() as u64;
        self.release(|grouper, ready| grouper.push(bytes, now, ready));
    }
    pub fn flush_expired(&mut self, now: Instant) {
        self.release(|grouper, ready| grouper.flush_expired(now, ready));
    }
    /// Parses every held byte now, as if its frame had timed out: `applied() == fed()` after.
    pub fn release_held(&mut self) {
        self.release(FrameGrouper::release);
    }
    pub fn sync_deadline(&self) -> Option<Instant> {
        self.grouper.deadline()
    }
    /// Jumps to the full redraw at `target` (> `applied()`) without parsing what it hides.
    /// `tail` holds the stream bytes that end at `target` and follow the held ones (after a
    /// gap when they were evicted); `keyframe` the retained bytes from `target`. On refusal
    /// nothing changes.
    pub fn skip_to(
        &mut self,
        target: u64,
        tail: &[u8],
        keyframe: &[u8],
    ) -> Result<(), SkipRefusal> {
        if !self.ground.ground() {
            return Err(SkipRefusal::Boundary);
        }
        let started = Instant::now();
        let held = self.grouper.held();
        let held = &held[..held.len().min(target.saturating_sub(self.applied) as usize)];
        let mut scan = SkipScan::default();
        scan.feed(held, self.applied, self.live_from);
        scan.feed(tail, target - tail.len() as u64, self.live_from);
        let replay = scan
            .finish()
            .and_then(|replay| check_keyframe(keyframe).map(|()| replay));
        self.stats.parsed(started.elapsed().as_micros() as u64);
        let replay = replay?;
        self.processor.advance(&mut self.term, &replay);
        self.drain_events(true);
        self.stats.skipped += target.saturating_sub(self.applied);
        self.grouper = FrameGrouper::default();
        self.ground = GroundTracker::default();
        self.fed = target;
        self.applied = target;
        self.dirty = true;
        Ok(())
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(1) as usize, rows.max(1) as usize);
        if cols != self.term.columns() || rows != self.term.screen_lines() {
            self.term.resize(GridSize(cols, rows));
            self.events.borrow_mut().clear();
            self.full = true;
            self.dirty = true;
        }
    }
    pub fn scroll(&mut self, scroll: AgentGridScroll) {
        self.term.scroll_display(match scroll {
            AgentGridScroll::Delta { lines } => Scroll::Delta(lines),
            AgentGridScroll::PageUp => Scroll::PageUp,
            AgentGridScroll::PageDown => Scroll::PageDown,
            AgentGridScroll::Bottom => Scroll::Bottom,
            AgentGridScroll::Offset { offset } => {
                let target = (offset as usize).min(self.term.history_size());
                Scroll::Delta(target as i32 - self.term.grid().display_offset() as i32)
            }
        });
        self.events.borrow_mut().clear();
        self.dirty = true;
    }
    pub fn select(&mut self, select: AgentGridSelect) {
        let anchor = |core: &Self, row: i32, col: u32, right: bool| {
            core.viewport_anchor(row, col, if right { Side::Right } else { Side::Left })
        };
        match select {
            AgentGridSelect::Start {
                row,
                col,
                right,
                mode,
            } => {
                let ty = match mode {
                    AgentGridSelectMode::Simple => SelectionType::Simple,
                    AgentGridSelectMode::Word => SelectionType::Semantic,
                    AgentGridSelectMode::Line => SelectionType::Lines,
                };
                let (point, side) = anchor(self, row, col, right);
                self.term.selection = Some(Selection::new(ty, point, side));
            }
            AgentGridSelect::Extend { row, col, right } => {
                let last = self.term.screen_lines() as i32 - 1;
                if row < 0 || row > last {
                    let toward = if row < 0 { -row } else { last - row };
                    self.term.scroll_display(Scroll::Delta(toward));
                }
                let (point, side) = anchor(self, row, col, right);
                match self.term.selection.as_mut() {
                    Some(selection) => selection.update(point, side),
                    None => {
                        self.term.selection =
                            Some(Selection::new(SelectionType::Simple, point, side))
                    }
                }
            }
            AgentGridSelect::All => {
                let top = Point::new(self.term.topmost_line(), Column(0));
                let bottom = Point::new(self.term.bottommost_line(), self.term.last_column());
                let mut selection = Selection::new(SelectionType::Simple, top, Side::Left);
                selection.update(bottom, Side::Right);
                self.term.selection = Some(selection);
            }
            AgentGridSelect::Clear => self.term.selection = None,
        }
        self.select_count = self.select_count.wrapping_add(1);
        self.events.borrow_mut().clear();
        self.dirty = true;
    }
    // shortcut: rows resolve against the engine's current view, not the frame on screen; output
    // parsed while that frame awaits its ack shifts a selection made at the bottom by those lines.
    fn viewport_anchor(&self, row: i32, col: u32, side: Side) -> (Point, Side) {
        let row = row.clamp(0, self.term.screen_lines() as i32 - 1);
        let offset = self.term.grid().display_offset() as i32;
        let col = (col as usize).min(self.term.last_column().0);
        (Point::new(Line(row - offset), Column(col)), side)
    }
    pub fn configure(&mut self, theme: GridTheme) {
        self.theme = theme;
        self.full = true;
        self.dirty = true;
    }
    pub fn take_replies(&mut self) -> Vec<u8> {
        mem::take(&mut self.replies)
    }
    pub fn take_stats(&mut self) -> GridStats {
        mem::take(&mut self.stats)
    }
    fn release(&mut self, take: impl FnOnce(&mut FrameGrouper, &mut Vec<u8>)) {
        let mut ready = mem::take(&mut self.ready);
        take(&mut self.grouper, &mut ready);
        self.apply(&ready);
        ready.clear();
        self.ready = ready;
    }
    fn apply(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let started = Instant::now();
        let replayed = self
            .live_from
            .saturating_sub(self.applied)
            .min(bytes.len() as u64);
        let (replayed, live) = bytes.split_at(replayed as usize);
        self.advance(replayed, true);
        self.advance(live, false);
        let micros = started.elapsed().as_micros() as u64;
        self.parsed_bytes += bytes.len() as u64;
        self.parse_micros += micros;
        self.stats.parsed(micros);
        self.dirty = true;
    }
    fn advance(&mut self, bytes: &[u8], replay: bool) {
        if bytes.is_empty() {
            return;
        }
        let offset = self.term.grid().display_offset();
        let history = self.term.history_size();
        let selection = self.term.selection.clone();
        let alt_screen = self.term.mode().contains(TermMode::ALT_SCREEN);
        self.processor.advance(&mut self.term, bytes);
        self.ground.advance(bytes);
        // The grouper already delivered whole frames: never let vte hold bytes back.
        if self.processor.sync_timeout().sync_timeout().is_some() {
            self.processor.stop_sync(&mut self.term);
        }
        self.applied += bytes.len() as u64;
        let new_history = self.term.history_size();
        if offset > 0 && (new_history < history || memmem::find(bytes, CLEAR_SCROLLBACK).is_some())
        {
            let top = history - offset;
            let target = new_history.saturating_sub(top);
            let current = self.term.grid().display_offset();
            self.term
                .scroll_display(Scroll::Delta(target as i32 - current as i32));
        }
        // Output never drops the user's selection: like the reading position, it keeps its
        // distance from the top through erases and full redraws.
        // shortcut: an unsynchronized redraw split across reads clamps the selection to the emptied
        // buffer and loses it; keep unclamped anchors pending if such CLIs show up.
        if self.term.selection.is_none()
            && alt_screen == self.term.mode().contains(TermMode::ALT_SCREEN)
        {
            let delta = new_history as i32 - history as i32;
            self.term.selection = selection.and_then(|selection| {
                selection.rotate(&self.term, &(Line(i32::MIN)..Line(i32::MAX)), delta)
            });
        }
        self.drain_events(replay);
    }
    fn drain_events(&mut self, replay: bool) {
        let events = mem::take(&mut *self.events.borrow_mut());
        for event in events {
            match event {
                Event::Title(title) => {
                    self.current_title = Some(title.clone());
                    self.title = Some(title);
                }
                Event::ResetTitle => {
                    self.current_title = None;
                    self.title = Some(String::new());
                }
                _ if replay => {}
                Event::PtyWrite(text) => self.replies.extend_from_slice(text.as_bytes()),
                Event::ColorRequest(index, format) if index < COLOR_COUNT => {
                    let rgb = self.term.colors()[index].unwrap_or_else(|| self.theme.color(index));
                    self.replies.extend_from_slice(format(rgb).as_bytes());
                }
                Event::TextAreaSizeRequest(format) => {
                    let size = WindowSize {
                        num_lines: self.term.screen_lines() as u16,
                        num_cols: self.term.columns() as u16,
                        cell_width: self.theme.cell_width,
                        cell_height: self.theme.cell_height,
                    };
                    self.replies.extend_from_slice(format(size).as_bytes());
                }
                Event::ClipboardStore(ClipboardType::Clipboard, text)
                    if text.chars().count() <= CLIPBOARD_LIMIT =>
                {
                    self.clipboard = Some(text);
                }
                _ => {}
            }
        }
    }
    /// Changes since the previous frame; `None` when nothing visible changed.
    pub fn frame(&mut self) -> Option<AgentGridFrame> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let grid = self.term.grid();
        let (cols, rows) = (grid.columns(), grid.screen_lines());
        let display_offset = grid.display_offset();
        let full = mem::take(&mut self.full) || self.sent.len() != rows;
        if full {
            self.sent = vec![(Vec::new(), false); rows];
        }
        let colors = self.term.colors();
        let screen: Vec<SentRow> = (0..rows)
            .map(|row| {
                let cells = &grid[Line(row as i32 - display_offset as i32)][..];
                (row_spans(cells, colors), is_wrapped(cells))
            })
            .collect();
        let shift = if full {
            0
        } else {
            screen_shift(&self.sent, &screen)
        };
        let moved = shift.unsigned_abs() as usize;
        if shift > 0 {
            self.sent.rotate_left(moved);
            self.sent[rows - moved..].fill_with(SentRow::default);
        } else if shift < 0 {
            self.sent.rotate_right(moved);
            self.sent[..moved].fill_with(SentRow::default);
        }
        let mut lines = Vec::new();
        for (row, (now, sent)) in screen.into_iter().zip(&mut self.sent).enumerate() {
            if full || *sent != now {
                lines.push((row as u32, now.0.clone(), now.1));
                *sent = now;
            }
        }
        let cursor = self.term.renderable_content().cursor;
        let shape = match cursor.shape {
            _ if display_offset > 0 => "hidden",
            CursorShape::Block | CursorShape::HollowBlock => "block",
            CursorShape::Underline => "underline",
            CursorShape::Beam => "beam",
            CursorShape::Hidden => "hidden",
        };
        let meta = FrameMeta {
            cursor: AgentGridCursor {
                row: cursor.point.line.0.max(0) as u32,
                col: cursor.point.column.0 as u32,
                shape,
            },
            display_offset: display_offset as u32,
            history_size: grid.history_size() as u32,
            selection: self
                .term
                .selection
                .as_ref()
                .and_then(|selection| selection.to_range(&self.term))
                .map(|range| {
                    let grid = self.term.grid();
                    // Paint whole wide chars; the copied text already includes them.
                    // A spacer can sit in column 0 (e.g. after DCH shifts it left).
                    let start_col = range.start.column.0.saturating_sub(
                        grid[range.start].flags.contains(Flags::WIDE_CHAR_SPACER) as usize,
                    );
                    let end_col = range.end.column.0
                        + grid[range.end].flags.contains(Flags::WIDE_CHAR) as usize;
                    AgentGridSelection {
                        start_row: range.start.line.0 + display_offset as i32,
                        start_col: start_col as u32,
                        end_row: range.end.line.0 + display_offset as i32,
                        end_col: end_col as u32,
                    }
                }),
            select_count: self.select_count,
            modes: mode_bits(*self.term.mode()),
            state: self.state,
        };
        let title = if mem::take(&mut self.first) {
            self.title = None;
            self.current_title.clone()
        } else {
            self.title.take()
        };
        let clipboard = self.clipboard.take();
        if !full
            && shift == 0
            && lines.is_empty()
            && title.is_none()
            && clipboard.is_none()
            && self.sent_meta == Some(meta)
        {
            return None;
        }
        self.sent_meta = Some(meta);
        Some(AgentGridFrame {
            cols: cols as u32,
            rows: rows as u32,
            full,
            shift,
            lines,
            cursor: meta.cursor,
            display_offset: meta.display_offset,
            history_size: meta.history_size,
            selection: meta.selection,
            select_count: meta.select_count,
            modes: meta.modes,
            title,
            clipboard,
            state: meta.state,
            parsed_bytes: mem::take(&mut self.parsed_bytes),
            parse_micros: mem::take(&mut self.parse_micros),
        })
    }
    /// Selected text, scrollback included; wrapped rows join, blanks ending a line are dropped.
    pub fn selection_text(&self) -> String {
        let Some(range) = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
        else {
            return String::new();
        };
        let mut end = range.end;
        let last = self.term.last_column();
        // alacritty appends the previous row's first char when the end cell is a wrapped spacer.
        if end.column == last
            && last.0 > 0
            && self.term.grid()[end]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
        {
            end.column = last - 1;
        }
        let text = self.term.bounds_to_string(range.start, end);
        let lines: Vec<&str> = text
            .split('\n')
            .map(|line| line.trim_end_matches(' '))
            .collect();
        lines.join("\n").trim_end_matches('\n').to_owned()
    }
}

type SentRow = (Vec<AgentGridSpan>, bool);

/// How far the content moved since `sent`, matched on non-blank rows so a scroll or new output
/// moves the webview's rows instead of rebuilding them all; ties keep 0.
fn screen_shift(sent: &[SentRow], screen: &[SentRow]) -> i32 {
    let hashes = |rows: &[SentRow]| {
        rows.iter()
            .map(|row| {
                (!row.0.is_empty()).then(|| {
                    let mut hasher = DefaultHasher::new();
                    row.hash(&mut hasher);
                    hasher.finish()
                })
            })
            .collect::<Vec<_>>()
    };
    let (sent, screen) = (hashes(sent), hashes(screen));
    let rows = screen.len();
    let matches = |shift: isize| {
        (0..rows)
            .filter(|&row| {
                screen[row].is_some()
                    && row
                        .checked_add_signed(shift)
                        .and_then(|from| sent.get(from))
                        .is_some_and(|from| *from == screen[row])
            })
            .count()
    };
    let mut best = (matches(0), 0);
    for distance in 1..rows {
        // A shift by `distance` keeps at most `rows - distance` rows.
        if rows - distance <= best.0 {
            break;
        }
        for shift in [distance as isize, -(distance as isize)] {
            let count = matches(shift);
            if count > best.0 {
                best = (count, shift);
            }
        }
    }
    best.1 as i32
}

fn is_wrapped(cells: &[Cell]) -> bool {
    cells
        .last()
        .is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE))
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
