//! Separates the history Soreno's dtach replays on attach (see
//! `src-tauri/dtach/soreno-history.patch`) from live terminal output.

const BEGIN: &[u8] = b"\x1b]5379;dtach-history-begin\x07";
const END: &[u8] = b"\x1b]5379;dtach-history-end\x07";
/// The replay precedes any program output; only the ssh/dtach preamble comes first.
const PREAMBLE_LIMIT: usize = 64 * 1024;
/// dtach retains 1 MiB plus a short mode sequence.
const HISTORY_LIMIT: usize = 1024 * 1024 + 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Segment {
    Live(Vec<u8>),
    /// Output produced before this client attached, already seen by nobody or a previous client.
    History(Vec<u8>),
}

enum State {
    Preamble { seen: usize },
    History(Vec<u8>),
    Done,
}

pub(super) struct HistoryFraming {
    state: State,
    /// Bytes that may begin the marker the current state waits for.
    pending: Vec<u8>,
    /// A new session has no previous client: its first output stays live.
    attached: bool,
}

impl HistoryFraming {
    pub(super) fn new(attached: bool) -> Self {
        Self {
            state: State::Preamble { seen: 0 },
            pending: Vec::new(),
            attached,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Vec<Segment> {
        let mut segments = Vec::new();
        let mut live = Vec::new();
        for (index, &byte) in bytes.iter().enumerate() {
            let mut ended = None;
            match &mut self.state {
                State::Done => {
                    live.extend_from_slice(&bytes[index..]);
                    break;
                }
                State::Preamble { seen } => {
                    self.pending.push(byte);
                    while !BEGIN.starts_with(&self.pending) {
                        live.push(self.pending.remove(0));
                        *seen += 1;
                    }
                    if self.pending == BEGIN {
                        self.pending.clear();
                        self.state = State::History(Vec::new());
                    } else if *seen > PREAMBLE_LIMIT {
                        // A dtach built before history replay: everything is live.
                        live.append(&mut self.pending);
                        self.state = State::Done;
                    }
                }
                State::History(history) => {
                    self.pending.push(byte);
                    while !END.starts_with(&self.pending) {
                        history.push(self.pending.remove(0));
                    }
                    if self.pending == END || history.len() > HISTORY_LIMIT {
                        self.pending.clear();
                        ended = Some(std::mem::take(history));
                    }
                }
            }
            if let Some(history) = ended {
                self.state = State::Done;
                if !live.is_empty() {
                    segments.push(Segment::Live(std::mem::take(&mut live)));
                }
                segments.push(self.history_segment(history));
            }
        }
        if !live.is_empty() {
            segments.push(Segment::Live(live));
        }
        segments
    }

    /// Releases held bytes when the stream ends.
    pub(super) fn finish(&mut self) -> Vec<Segment> {
        let pending = std::mem::take(&mut self.pending);
        match std::mem::replace(&mut self.state, State::Done) {
            State::History(mut history) => {
                history.extend(pending);
                vec![self.history_segment(history)]
            }
            _ if pending.is_empty() => Vec::new(),
            _ => vec![Segment::Live(pending)],
        }
    }

    /// Whether the replay is over: what follows comes from the running program.
    pub(super) fn replayed(&self) -> bool {
        matches!(self.state, State::Done)
    }

    fn history_segment(&self, history: Vec<u8>) -> Segment {
        if self.attached {
            Segment::History(history)
        } else {
            Segment::Live(history)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merged(framing: &mut HistoryFraming, stream: &[u8], chunk: usize) -> Vec<Segment> {
        let mut segments: Vec<Segment> = Vec::new();
        let pushed: Vec<Segment> = stream
            .chunks(chunk)
            .flat_map(|bytes| framing.push(bytes))
            .collect();
        for segment in pushed.into_iter().chain(framing.finish()) {
            match (segments.last_mut(), segment) {
                (Some(Segment::Live(last)), Segment::Live(bytes))
                | (Some(Segment::History(last)), Segment::History(bytes)) => last.extend(bytes),
                (_, segment) => segments.push(segment),
            }
        }
        segments
    }

    #[test]
    fn attach_separates_split_history_markers_from_live_output() {
        let stream = [
            b"Warning\r\n\x1b[H\x1b[J",
            BEGIN,
            b"\x1b[?2004hold\x1b]0;t\x07",
            END,
            b"\x1b]5live",
        ]
        .concat();
        for chunk in [1, 3, stream.len()] {
            assert_eq!(
                merged(&mut HistoryFraming::new(true), &stream, chunk),
                [
                    Segment::Live(b"Warning\r\n\x1b[H\x1b[J".to_vec()),
                    Segment::History(b"\x1b[?2004hold\x1b]0;t\x07".to_vec()),
                    Segment::Live(b"\x1b]5live".to_vec()),
                ],
                "chunk {chunk}"
            );
        }
    }

    #[test]
    fn new_sessions_keep_first_output_live_and_legacy_dtach_streams_through() {
        let stream = [BEGIN, b"prompt$ ", END, b"typed"].concat();
        assert_eq!(
            merged(&mut HistoryFraming::new(false), &stream, 2),
            [Segment::Live(b"prompt$ typed".to_vec())]
        );

        let mut legacy = HistoryFraming::new(true);
        let preamble = vec![b'x'; PREAMBLE_LIMIT + 1];
        assert_eq!(legacy.push(&preamble), [Segment::Live(preamble)]);
        assert_eq!(legacy.push(BEGIN), [Segment::Live(BEGIN.to_vec())]);
    }

    #[test]
    fn a_stream_ending_inside_history_keeps_it_as_history() {
        let stream = [BEGIN, b"partial\x1b]53"].concat();
        assert_eq!(
            merged(&mut HistoryFraming::new(true), &stream, 4),
            [Segment::History(b"partial\x1b]53".to_vec())]
        );
    }
}
