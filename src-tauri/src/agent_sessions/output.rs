use super::{
    conversations, dtach_history, grid::GridWaker, keyframes, program_status, AgentSessionStatus,
    Runtime, BUFFER_LIMIT, KEYFRAME_LIMIT,
};
use program_status::ProgramState;
use std::{
    collections::VecDeque,
    sync::{mpsc::Sender, Arc},
    time::{Duration, Instant},
};

/// A query left unread longer was likely given up on: a late reply would reach the program as input.
const LATE_REPLY_WINDOW: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct Output {
    pub(super) bytes: VecDeque<u8>,
    pub(super) end: u64,
    pub(super) exited: bool,
    pub(super) exit_code: Option<u32>,
    /// The user typed into the program since their last Enter: a message line would join it.
    pub(super) draft: bool,
    /// End of the output dtach replayed from before this client attached.
    pub(super) restored_end: u64,
    /// Root record of the Program Status Protocol, once the program reports one.
    pub(super) program_state: Option<ProgramState>,
    /// The program has reported a root state: a CLI too old for the protocol never does.
    pub(super) reports_program_status: bool,
    /// Start of the latest retained full redraw; bytes before it may be evicted.
    pub(super) keyframe: Option<u64>,
    pub(super) keyframe_scan: keyframes::KeyframeScan,
    pub(super) grid_waker: Option<GridWaker>,
    /// PTY resizes the grid engine has not taken yet: `(offset, cols, rows)`, bytes before
    /// the offset were drawn for the old size.
    pub(super) grid_resizes: VecDeque<(u64, u16, u16)>,
    /// Replies of successive grid engines, written in order by one thread: `(generation, bytes)`.
    pub(super) grid_replies: Option<Sender<(u64, Vec<u8>)>>,
    /// Incremented by each grid subscription and unsubscription.
    pub(super) grid_generation: u64,
    /// End of the output a grid engine has taken to parse: its queries were handled once.
    pub(super) grid_claimed: u64,
    /// Arrival of the oldest output no grid engine has taken yet.
    pub(super) grid_unclaimed_since: Option<Instant>,
}
impl Output {
    pub(super) fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.extend(bytes);
        self.publish();
    }
    pub(super) fn append_history(&mut self, bytes: &[u8]) {
        self.extend(bytes);
        self.restored_end = self.end;
        self.publish();
    }
    fn extend(&mut self, bytes: &[u8]) {
        let offset = self.end;
        self.end += bytes.len() as u64;
        self.bytes.extend(bytes);
        self.grid_unclaimed_since.get_or_insert_with(Instant::now);
        if let Some(keyframe) = self.keyframe_scan.scan(bytes, offset) {
            self.keyframe = Some(keyframe);
        }
        let base = self.end - self.bytes.len() as u64;
        let mut keep = self.end.saturating_sub(BUFFER_LIMIT as u64);
        if let Some(keyframe) = self.keyframe {
            if keyframe < base || self.end - keyframe > KEYFRAME_LIMIT as u64 {
                self.keyframe = None;
            } else {
                keep = keep.min(keyframe);
            }
        }
        self.bytes.drain(..keep.saturating_sub(base) as usize);
        if self.bytes.len() <= BUFFER_LIMIT && self.bytes.capacity() > 2 * BUFFER_LIMIT {
            self.bytes.shrink_to(BUFFER_LIMIT);
        }
    }
    /// Queues a PTY resize at the current end for the subscribed grid engine.
    pub(super) fn resize_grid(&mut self, cols: u16, rows: u16) {
        if let Some(waker) = &self.grid_waker {
            self.grid_resizes.push_back((self.end, cols, rows));
            waker.wake();
        }
    }
    pub(super) fn claim_for_grid(&mut self, end: u64) {
        self.grid_claimed = self.grid_claimed.max(end);
        if self.grid_claimed == self.end {
            self.grid_unclaimed_since = None;
        }
    }
    /// Where a new grid engine starts answering queries: output emitted before any engine
    /// subscribed, such as a CLI's startup queries, still gets its replies.
    pub(super) fn grid_live_from(&self) -> u64 {
        if self
            .grid_unclaimed_since
            .is_some_and(|since| since.elapsed() > LATE_REPLY_WINDOW)
        {
            self.end
        } else {
            self.grid_claimed
        }
    }
    /// The program status comes first. Without it, the Pi/OMP extension still reports the
    /// activity, but Claude Code and Codex hooks miss interrupted turns and answered prompts.
    pub(super) fn report_activity(
        &self,
        provider: conversations::Provider,
        reported: &conversations::Activity,
        status: &mut AgentSessionStatus,
    ) {
        let hooks = provider.uses_hooks();
        // The Pi/OMP extension also reports its question tools.
        let extension_awaiting = !hooks && reported.awaiting;
        (status.working, status.awaiting) = match self.program_state {
            Some(ProgramState::Idle) => (Some(false), extension_awaiting),
            Some(ProgramState::Working) => (Some(true), extension_awaiting),
            Some(ProgramState::Blocked) => (Some(true), true),
            Some(ProgramState::Finished) => (reported.working, extension_awaiting),
            None if hooks => (None, false),
            None => (reported.working, reported.awaiting),
        };
        // shortcut: an SSH reattach only sees the root state still in dtach's 1 MiB replay, so a
        // state followed by more output reads as unknown and outdated until the next report;
        // keep the state beside dtach's restored modes if long silent turns hit this.
        status.outdated_cli = hooks && !self.reports_program_status && reported.working.is_some();
    }
    pub(super) fn status(&self, session_id: &str) -> AgentSessionStatus {
        AgentSessionStatus {
            session_id: session_id.into(),
            state: if self.exited { "exited" } else { "running" }.into(),
            exit_code: self.exit_code,
            working: None,
            awaiting: false,
            conversation: None,
            resume: "unsupported".into(),
            conversation_error: None,
            issue_summary: None,
            last_message: None,
            missing_executable: false,
            outdated_cli: false,
        }
    }
    pub(super) fn publish(&self) {
        if let Some(waker) = &self.grid_waker {
            waker.wake();
        }
    }
}
/// Turns PTY bytes into terminal output: dtach history first, then private metadata frames;
/// program status reports pass through to the terminal.
pub(super) struct OutputPipeline {
    pub(super) history: Option<dtach_history::HistoryFraming>,
    pub(super) metadata: Option<conversations::RemoteMetadataParser>,
    pub(super) program_status: program_status::ProgramStatusScan,
}
impl OutputPipeline {
    pub(super) fn push(&mut self, bytes: &[u8], runtime: &Arc<Runtime>) {
        let segments = match self.history.as_mut() {
            Some(history) => history.push(bytes),
            None => vec![dtach_history::Segment::Live(bytes.to_vec())],
        };
        self.deliver(segments, runtime);
    }
    pub(super) fn finish(&mut self, runtime: &Arc<Runtime>) {
        let segments = self
            .history
            .as_mut()
            .map(dtach_history::HistoryFraming::finish)
            .unwrap_or_default();
        self.deliver(segments, runtime);
        let rest = self
            .metadata
            .as_mut()
            .map(conversations::RemoteMetadataParser::finish)
            .unwrap_or_default();
        if let Ok(mut output) = runtime.output.lock() {
            output.append(&rest);
        }
    }
    fn deliver(&mut self, segments: Vec<dtach_history::Segment>, runtime: &Arc<Runtime>) {
        use dtach_history::Segment;
        // Metadata frames update files: parse before taking the output lock.
        let segments: Vec<Segment> = segments
            .into_iter()
            .map(|segment| match (segment, self.metadata.as_mut()) {
                (Segment::Live(bytes), Some(metadata)) => Segment::Live(metadata.push(&bytes)),
                (Segment::History(bytes), Some(metadata)) => {
                    Segment::History(metadata.push_history(&bytes))
                }
                (segment, None) => segment,
            })
            .collect();
        let Ok(mut output) = runtime.output.lock() else {
            return;
        };
        for segment in segments {
            let (Segment::Live(bytes) | Segment::History(bytes)) = &segment;
            for event in self.program_status.scan(bytes) {
                match event {
                    program_status::Event::Root(state) => {
                        output.reports_program_status |= state.is_some();
                        output.program_state = state;
                    }
                    // A replayed query was answered when it was live. Replying before the output
                    // reaches a grid engine puts this reply ahead of a following `CSI c`.
                    program_status::Event::Query if matches!(segment, Segment::Live(_)) => {
                        // shortcut: this reply advances the generation watermark, so a reply a
                        // superseded engine has not queued yet is dropped; separate the pipeline's
                        // replies from engine generations if startup queries go unanswered.
                        if let Ok(replies) = runtime.grid_replies(&mut output) {
                            let _ = replies
                                .send((output.grid_generation, program_status::QUERY_REPLY.into()));
                        }
                    }
                    program_status::Event::Query => {}
                }
            }
            match segment {
                Segment::Live(bytes) => output.append(&bytes),
                Segment::History(bytes) => output.append_history(&bytes),
            }
        }
    }
}
