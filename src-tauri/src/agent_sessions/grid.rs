//! Prototype: terminal emulation in Rust, the webview only paints the visible rows.
use super::{grid_log, lock, output::Output, Result, Runtime};
use portable_pty::PtySize;
pub(super) use soreno_terminal_grid::GridTheme;
pub use soreno_terminal_grid::{AgentGridConfig, AgentGridFrame, AgentGridScroll, AgentGridSelect};
use soreno_terminal_grid::{GridEngineCore, GridStats, SkipRefusal};
use std::{
    collections::VecDeque,
    io::Write,
    mem,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError},
        Arc, Weak,
    },
    thread,
    time::{Duration, Instant},
};

/// Catch-up still shows progress at about 30 frames per second.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Bounded reads keep acks and scrolls responsive during a long catch-up.
const READ_LIMIT: usize = 256 * 1024;
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// Retained bytes from a keyframe that must reach its first character.
const KEYFRAME_PREFIX: usize = 64 * 1024;
const GRID_GONE: &str = "Terminal Rust indisponible.";

pub(super) enum GridCommand {
    Wake,
    Ack { apply_micros: u64 },
    Configure(GridTheme),
    Scroll(AgentGridScroll),
    Select(AgentGridSelect),
    Visibility(bool),
    Text(Sender<String>),
    Close,
}

pub(super) struct GridHandle {
    channel_id: u32,
    commands: Sender<GridCommand>,
}

/// Lets `Output::publish` wake the engine, at most one queued wake at a time.
pub(super) struct GridWaker {
    pending: Arc<AtomicBool>,
    commands: Sender<GridCommand>,
}

impl GridWaker {
    pub(super) fn wake(&self) {
        if !self.pending.swap(true, Ordering::AcqRel) {
            let _ = self.commands.send(GridCommand::Wake);
        }
    }
}

impl Runtime {
    pub(super) fn grid_subscribe(
        self: &Arc<Self>,
        session_id: &str,
        theme: GridTheme,
        visible: bool,
        channel: tauri::ipc::Channel<AgentGridFrame>,
        log: Option<PathBuf>,
    ) -> Result<()> {
        let (commands, receiver) = mpsc::channel();
        let pending = Arc::new(AtomicBool::new(false));
        let channel_id = channel.id();
        // Lock order: grid slot, then size, then output; `Runtime::resize` takes size, then output.
        let mut slot = lock(&self.grid)?;
        // Held until the resize queue is reset, so a concurrent resize lands in `size` or the queue.
        let size_guard = lock(&self.size)?;
        let size = *size_guard;
        let (live_from, generation, replies) = {
            let mut output = lock(&self.output)?;
            output.grid_waker = Some(GridWaker {
                pending: pending.clone(),
                commands: commands.clone(),
            });
            // Resizes queued before now are already in `size`.
            output.grid_resizes.clear();
            output.grid_generation += 1;
            (
                output.grid_live_from(),
                output.grid_generation,
                self.grid_replies(&mut output)?,
            )
        };
        drop(size_guard);
        let engine = GridEngine {
            runtime: Arc::downgrade(self),
            channel,
            pending,
            theme,
            size,
            live_from,
            in_flight: false,
            visible,
            behind: true,
            last_frame: None,
            repaint_requested_for_loss: false,
            exited: false,
            refused_keyframe: None,
            deferred_skip_end: None,
            session_id: session_id.into(),
            log,
            stats: EngineStats::default(),
            stats_since: Instant::now(),
            sent_at: None,
            resizes: VecDeque::new(),
            generation,
            replies,
        };
        thread::Builder::new()
            .name("agent-grid".into())
            .spawn(move || engine.run(receiver))
            .map_err(|error| error.to_string())?;
        if let Some(previous) = slot.replace(GridHandle {
            channel_id,
            commands,
        }) {
            let _ = previous.commands.send(GridCommand::Close);
        }
        Ok(())
    }
    /// The reply writer shared by successive engines and the output pipeline, started on first use.
    pub(super) fn grid_replies(
        self: &Arc<Self>,
        output: &mut Output,
    ) -> Result<Sender<(u64, Vec<u8>)>> {
        if let Some(replies) = &output.grid_replies {
            return Ok(replies.clone());
        }
        let (replies, receiver) = mpsc::channel();
        let runtime = Arc::downgrade(self);
        thread::Builder::new()
            .name("agent-grid-replies".into())
            .spawn(move || write_replies(runtime, receiver))
            .map_err(|error| error.to_string())?;
        output.grid_replies = Some(replies.clone());
        Ok(replies)
    }
    pub(super) fn grid_command(&self, channel_id: u32, command: GridCommand) -> Result<()> {
        if let Some(handle) = lock(&self.grid)?
            .as_ref()
            .filter(|handle| handle.channel_id == channel_id)
        {
            let _ = handle.commands.send(command);
        }
        Ok(())
    }
    /// Selected text of the engine's buffer, built on its own thread.
    pub(super) fn grid_text(&self, channel_id: u32) -> Result<String> {
        let (reply, text) = mpsc::channel();
        let sent = lock(&self.grid)?
            .as_ref()
            .filter(|handle| handle.channel_id == channel_id)
            .is_some_and(|handle| handle.commands.send(GridCommand::Text(reply)).is_ok());
        if !sent {
            return Err(GRID_GONE.into());
        }
        text.recv().map_err(|_| GRID_GONE.into())
    }
    pub(super) fn grid_unsubscribe(&self, channel_id: u32) -> Result<()> {
        let mut slot = lock(&self.grid)?;
        if slot
            .as_ref()
            .is_some_and(|handle| handle.channel_id == channel_id)
        {
            if let Some(handle) = slot.take() {
                let _ = handle.commands.send(GridCommand::Close);
            }
            let mut output = lock(&self.output)?;
            output.grid_waker = None;
            output.grid_resizes.clear();
            output.grid_generation += 1;
        }
        Ok(())
    }
}

/// Engine and webview work since the previous stats line.
#[derive(Default)]
struct EngineStats {
    core: GridStats,
    frames: u64,
    lines: u64,
    /// Retained bytes not yet given to the engine at the last read.
    backlog: u64,
    ack_wait_max: Duration,
    applies: u64,
    apply_micros: u64,
    apply_max_micros: u64,
}

impl EngineStats {
    fn active(&self) -> bool {
        self.core != GridStats::default() || self.frames > 0 || self.applies > 0
    }
    fn line(&self) -> String {
        let ms = |micros: u64| micros as f64 / 1000.0;
        format!(
            "stats fed={} parse_ms={:.1} parse_max_ms={:.1} skipped={} frames={} lines={} backlog={} ack_wait_max_ms={:.1} apply_ms_avg={:.1} apply_ms_max={:.1}",
            self.core.fed,
            ms(self.core.parse_micros),
            ms(self.core.parse_max_micros),
            self.core.skipped,
            self.frames,
            self.lines,
            self.backlog,
            ms(self.ack_wait_max.as_micros() as u64),
            ms(self.apply_micros.checked_div(self.applies).unwrap_or(0)),
            ms(self.apply_max_micros),
        )
    }
}

struct GridEngine {
    runtime: Weak<Runtime>,
    channel: tauri::ipc::Channel<AgentGridFrame>,
    pending: Arc<AtomicBool>,
    theme: GridTheme,
    size: PtySize,
    /// Queries before this offset were handled by an earlier engine, or are too old to answer.
    live_from: u64,
    in_flight: bool,
    /// Hidden engines keep parsing and replying but send no frames.
    visible: bool,
    /// Retained output remains to be parsed.
    behind: bool,
    last_frame: Option<Instant>,
    repaint_requested_for_loss: bool,
    exited: bool,
    /// Keyframe whose skip was refused for good: its bytes are parsed normally.
    refused_keyframe: Option<u64>,
    /// Output end at the last transient refusal: the skip is retried once more bytes arrive.
    deferred_skip_end: Option<u64>,
    session_id: String,
    log: Option<PathBuf>,
    stats: EngineStats,
    stats_since: Instant,
    sent_at: Option<Instant>,
    /// PTY resizes taken from the output, not yet reached by the parsed stream:
    /// `(offset, cols, rows)`.
    resizes: VecDeque<(u64, u16, u16)>,
    /// Subscription generation: a superseded engine stops reading and its replies are dropped.
    generation: u64,
    /// Terminal replies for the writer thread, so a blocked PTY never stalls the engine.
    replies: Sender<(u64, Vec<u8>)>,
}

/// Writes terminal replies in order until the runtime drops its sender and every engine exits.
/// Replies of an engine older than one already written would reach the PTY out of order.
fn write_replies(runtime: Weak<Runtime>, replies: Receiver<(u64, Vec<u8>)>) {
    let mut newest = 0;
    for (generation, bytes) in replies {
        if generation < newest {
            continue;
        }
        newest = generation;
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        if let Ok(mut writer) = runtime.writer.lock() {
            if let Some(writer) = writer.as_mut() {
                let _ = writer.write_all(&bytes).and_then(|_| writer.flush());
            }
        };
    }
}

/// Copies retained bytes `[start, end)`, as indexes into `bytes`.
fn copy_retained(output: &Output, start: usize, end: usize, out: &mut Vec<u8>) {
    let (front, back) = output.bytes.as_slices();
    let split = front.len();
    if start < split {
        out.extend_from_slice(&front[start..end.min(split)]);
    }
    if end > split {
        out.extend_from_slice(&back[start.max(split) - split..end - split]);
    }
}

impl GridEngine {
    fn run(mut self, commands: Receiver<GridCommand>) {
        self.log(&format!(
            "subscribe cols={} rows={} live_from={} visible={}",
            self.size.cols, self.size.rows, self.live_from, self.visible
        ));
        let mut core = self.core(0);
        let reason = self.serve(&mut core, &commands);
        self.stats.core.merge(core.take_stats());
        if self.stats.active() {
            self.write_stats(Instant::now());
        }
        self.log(&format!("unsubscribe reason={reason}"));
    }
    /// Runs until the engine must stop; returns why.
    fn serve(
        &mut self,
        core: &mut GridEngineCore,
        commands: &Receiver<GridCommand>,
    ) -> &'static str {
        loop {
            let deadline = core
                .sync_deadline()
                .into_iter()
                .chain(self.stats_deadline())
                .min();
            let first = if self.behind {
                commands.try_recv().map_err(|error| match error {
                    TryRecvError::Empty => RecvTimeoutError::Timeout,
                    TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
                })
            } else if let Some(deadline) = deadline {
                commands.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            } else {
                commands.recv().map_err(|_| RecvTimeoutError::Disconnected)
            };
            let mut next = match first {
                Ok(command) => Some(command),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return "dropped",
            };
            while let Some(command) = next {
                if !self.handle(command, core) {
                    return "closed";
                }
                next = match commands.try_recv() {
                    Ok(command) => Some(command),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => return "dropped",
                };
            }
            let now = Instant::now();
            if self.behind {
                if let Err(reason) = self.read(core, now) {
                    return reason;
                }
            }
            core.flush_expired(now);
            let replies = core.take_replies();
            if !replies.is_empty() && !self.exited {
                let _ = self.replies.send((self.generation, replies));
            }
            let paced = !self.behind
                || self
                    .last_frame
                    .is_none_or(|time| now.duration_since(time) >= FRAME_INTERVAL);
            // The grouper keeps partial frames out of the terminal, so a pending one never blocks.
            if self.visible && !self.in_flight && paced {
                if let Some(frame) = core.frame() {
                    let lines = frame.lines.len() as u64;
                    if self.channel.send(frame).is_err() {
                        self.detach();
                        return "channel-closed";
                    }
                    self.in_flight = true;
                    self.last_frame = Some(now);
                    self.sent_at = Some(now);
                    self.stats.frames += 1;
                    self.stats.lines += lines;
                }
            }
            self.stats.core.merge(core.take_stats());
            if self
                .stats_deadline()
                .is_some_and(|deadline| now >= deadline)
            {
                self.write_stats(now);
            }
        }
    }
    fn stats_deadline(&self) -> Option<Instant> {
        self.stats
            .active()
            .then_some(self.stats_since + STATS_INTERVAL)
    }
    fn write_stats(&mut self, now: Instant) {
        let pty = self
            .runtime
            .upgrade()
            .and_then(|runtime| runtime.size.lock().ok().map(|size| *size));
        let sizes = match pty {
            Some(pty) => format!(
                " term={}x{} pty={}x{}",
                self.size.cols, self.size.rows, pty.cols, pty.rows
            ),
            None => String::new(),
        };
        self.log(&format!("{}{sizes}", self.stats.line()));
        self.stats = EngineStats {
            backlog: self.stats.backlog,
            ..EngineStats::default()
        };
        self.stats_since = now;
    }
    fn log(&self, message: &str) {
        if let Some(path) = &self.log {
            grid_log::append(path, &self.session_id, message);
        }
    }
    fn core(&self, start: u64) -> GridEngineCore {
        GridEngineCore::new(
            self.size.cols,
            self.size.rows,
            self.theme,
            start,
            self.live_from,
        )
    }
    fn handle(&mut self, command: GridCommand, core: &mut GridEngineCore) -> bool {
        match command {
            GridCommand::Wake => {
                self.pending.store(false, Ordering::Release);
                self.behind = true;
            }
            GridCommand::Ack { apply_micros } => {
                self.in_flight = false;
                if let Some(sent) = self.sent_at.take() {
                    self.stats.ack_wait_max = self.stats.ack_wait_max.max(sent.elapsed());
                }
                self.stats.applies += 1;
                self.stats.apply_micros += apply_micros;
                self.stats.apply_max_micros = self.stats.apply_max_micros.max(apply_micros);
            }
            GridCommand::Configure(theme) => {
                self.theme = theme;
                core.configure(theme);
            }
            GridCommand::Scroll(scroll) => core.scroll(scroll),
            GridCommand::Select(select) => core.select(select),
            GridCommand::Visibility(visible) => {
                if self.visible != visible {
                    self.visible = visible;
                    self.log(&format!("visible={visible}"));
                    // Rows changed while hidden were never sent.
                    if visible {
                        core.configure(self.theme);
                    }
                }
            }
            GridCommand::Text(reply) => {
                let _ = reply.send(core.selection_text());
            }
            GridCommand::Close => return false,
        }
        true
    }
    /// Resizes the terminal once the parsed stream reaches each PTY resize.
    fn apply_resizes(&mut self, core: &mut GridEngineCore, upto: u64) {
        while let Some(&(at, cols, rows)) = self.resizes.front() {
            if at > upto {
                break;
            }
            self.resizes.pop_front();
            // Bytes the grouper still holds were written for the old size.
            core.release_held();
            self.size.cols = cols;
            self.size.rows = rows;
            core.resize(cols, rows);
            self.log(&format!("resize cols={cols} rows={rows} at={at}"));
        }
    }
    /// Copies the next retained bytes and the resizes queued among them in one output lock,
    /// then parses them, or jumps to the latest full redraw when the bytes before it are
    /// unparsed and cross no resize. Errs with the stop reason once the runtime is gone or superseded.
    fn read(
        &mut self,
        core: &mut GridEngineCore,
        now: Instant,
    ) -> std::result::Result<(), &'static str> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Err("session-ended");
        };
        let mut chunk = Vec::new();
        let mut prefix = Vec::new();
        let (lost, eviction, skip) = {
            let Ok(mut output) = runtime.output.lock() else {
                return Err("session-ended");
            };
            // A newer subscription owns the bytes from its own start onward.
            if output.grid_generation != self.generation {
                return Err("superseded");
            }
            self.resizes.extend(output.grid_resizes.drain(..));
            let base = output.end - output.bytes.len() as u64;
            self.exited = output.exited;
            let live_from = self.live_from.max(output.restored_end);
            let state = if output.exited { "exited" } else { "running" };
            core.set_live_from(live_from);
            core.set_state(state);
            let skip = output.keyframe.filter(|&keyframe| {
                keyframe > core.applied()
                    && core.fed() <= output.end
                    && self.refused_keyframe != Some(keyframe)
                    && self.deferred_skip_end != Some(output.end)
                    && !self
                        .resizes
                        .iter()
                        .any(|&(at, ..)| at > core.applied() && at <= keyframe)
            });
            if let Some(keyframe) = skip {
                let start = core.fed().max(base).min(keyframe);
                copy_retained(
                    &output,
                    (start - base) as usize,
                    (keyframe - base) as usize,
                    &mut chunk,
                );
                let from = (keyframe - base) as usize;
                let to = output.bytes.len().min(from + KEYFRAME_PREFIX);
                copy_retained(&output, from, to, &mut prefix);
                self.behind = true;
                self.stats.backlog = output.end - keyframe;
                let complete = to == output.bytes.len();
                (
                    false,
                    None,
                    Some((keyframe, core.fed() < base, output.end, complete)),
                )
            } else {
                let evicted = core.fed() < base || core.fed() > output.end;
                let eviction = evicted.then_some((core.fed(), base));
                if evicted {
                    self.apply_resizes(core, base);
                    self.stats.core.merge(core.take_stats());
                    let selects = core.select_count();
                    *core = self.core(base);
                    core.set_live_from(live_from);
                    core.set_state(state);
                    core.set_select_count(selects);
                }
                let start = (core.fed() - base) as usize;
                // Parsing stops at the next resize, applied before the bytes that follow it.
                let limit = self
                    .resizes
                    .iter()
                    .find(|&&(at, ..)| at > core.fed())
                    .map_or(usize::MAX, |&(at, ..)| at.saturating_sub(base) as usize);
                let end = output
                    .bytes
                    .len()
                    .min(start + READ_LIMIT)
                    .min(limit.max(start));
                copy_retained(&output, start, end, &mut chunk);
                output.claim_for_grid(base + end as u64);
                self.behind = end < output.bytes.len();
                self.stats.backlog = (output.bytes.len() - end) as u64;
                // A replay cut mid-stream lacks the frames that painted the screen, unless it
                // includes a full redraw.
                let lost = evicted && base > 0 && output.keyframe.is_none() && !output.exited;
                if !evicted && !self.behind {
                    self.repaint_requested_for_loss = false;
                }
                (lost, eviction, None)
            }
        };
        // Resizes queued at the end of the bytes already fed.
        self.apply_resizes(core, core.fed());
        if let Some((keyframe, evicted, end, complete)) = skip {
            let from = core.applied();
            match core.skip_to(keyframe, &chunk, &prefix) {
                Ok(()) => {
                    self.log(&format!(
                        "skip from={from} to={keyframe} bytes={} evicted={evicted}",
                        keyframe - from
                    ));
                }
                Err(refusal) => {
                    // A redraw longer than the copied prefix never reaches its first character.
                    let transient = refusal.is_transient()
                        && (complete || refusal != SkipRefusal::KeyframePending);
                    if transient {
                        self.deferred_skip_end = Some(end);
                    } else {
                        self.refused_keyframe = Some(keyframe);
                    }
                    self.log(&format!(
                        "refused-skip from={from} to={keyframe} reason={} transient={transient} evicted={evicted}",
                        refusal.as_str()
                    ));
                }
            }
            return Ok(());
        }
        if let Some((fed, base)) = eviction {
            self.log(&format!("eviction fed={fed} base={base} lost={lost}"));
        }
        if lost && !mem::replace(&mut self.repaint_requested_for_loss, true) {
            self.log("repaint");
            runtime.repaint();
        }
        core.feed(&chunk, now);
        self.apply_resizes(core, core.fed());
        Ok(())
    }
    /// The webview dropped the channel: free the slot unless a newer subscription owns it.
    fn detach(&self) {
        if let Some(runtime) = self.runtime.upgrade() {
            let _ = runtime.grid_unsubscribe(self.channel.id());
        }
    }
}

#[cfg(test)]
#[path = "grid_tests.rs"]
mod tests;
