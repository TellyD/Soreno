//! Program Status Protocol (OSC 7501): the root record's state and the feature query.
//! Spec: https://www.superlogical.com/rex/docs/build/program-status

const ESC: u8 = 0x1b;
const PREFIX: &[u8] = b"7501;";
/// `ESC ]` through `ESC \` is capped at 4096 bytes.
const BODY_LIMIT: usize = 4096 - 4;
pub(super) const QUERY_REPLY: &[u8] = b"\x1b]7501;?\x1b\\";

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum ProgramState {
    Idle,
    Working,
    Blocked,
    /// `done` or `error`: Claude Code reports `done` while its background agents still run.
    Finished,
}

#[derive(Debug, PartialEq)]
pub(super) enum Event {
    Query,
    /// New root state; `None` when the records are cleared.
    Root(Option<ProgramState>),
}

#[derive(Clone, Copy, Default)]
enum Scan {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
}

#[derive(Default)]
pub(super) struct ProgramStatusScan {
    scan: Scan,
    body: Vec<u8>,
}

impl ProgramStatusScan {
    pub(super) fn scan(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut events = Vec::new();
        for &byte in bytes {
            self.scan = match (self.scan, byte) {
                (Scan::Osc, 0x07) | (Scan::OscEscape, b'\\') => {
                    events.extend(self.event());
                    Scan::Ground
                }
                (Scan::Osc, ESC) => Scan::OscEscape,
                // CAN and SUB abort the sequence.
                (Scan::Osc, 0x18 | 0x1a) => Scan::Ground,
                (Scan::Osc, _) => {
                    // Other OSCs are only skipped: keep just enough to tell them apart.
                    if self.body.len() < PREFIX.len()
                        || (self.body.starts_with(PREFIX) && self.body.len() <= BODY_LIMIT)
                    {
                        self.body.push(byte);
                    }
                    Scan::Osc
                }
                (Scan::Escape | Scan::OscEscape, b']') => {
                    self.body.clear();
                    Scan::Osc
                }
                // RIS removes every record.
                (Scan::Escape | Scan::OscEscape, b'c') => {
                    events.push(Event::Root(None));
                    Scan::Ground
                }
                (_, ESC) => Scan::Escape,
                _ => Scan::Ground,
            };
        }
        events
    }

    fn event(&self) -> Option<Event> {
        if self.body.len() > BODY_LIMIT {
            return None;
        }
        let pairs = self.body.strip_prefix(PREFIX)?;
        if pairs == b"?" {
            return Some(Event::Query);
        }
        // shortcut: `msg`, `title` and other fields are not validated, so a report the spec
        // discards (bad base64, control characters, oversized field) still applies its state;
        // validate them if a CLI emits malformed reports.
        let mut state = None;
        for pair in pairs.split(|&byte| byte == b':') {
            let Some(split) = pair.iter().position(|&byte| byte == b'=') else {
                continue;
            };
            match pair[..split].trim_ascii() {
                // Child records, and malformed ids, never address the root.
                b"id" => return None,
                b"state" => state = Some(pair[split + 1..].trim_ascii()),
                _ => {}
            }
        }
        let state = match state? {
            b"idle" => ProgramState::Idle,
            b"done" | b"error" => ProgramState::Finished,
            b"working" => ProgramState::Working,
            b"blocked" => ProgramState::Blocked,
            b"clear" => return Some(Event::Root(None)),
            _ => return None,
        };
        Some(Event::Root(Some(state)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_in_pieces(stream: &[u8], piece: usize) -> Vec<Event> {
        let mut scan = ProgramStatusScan::default();
        stream
            .chunks(piece)
            .flat_map(|bytes| scan.scan(bytes))
            .collect()
    }

    #[test]
    fn reports_root_states_and_queries_even_when_split() {
        let stream = b"\x1b]0;title\x07\x1b]7501;state=working:app=claude-code\x1b\\text\
            \x1b]7501;?\x07\x1b[c\x1b]7501; state = blocked :kind=permission:msg=QQ==\x07\
            \x1b]7501;state=done\x1b\\\x1b]7501;state=idle\x07\x1b]7501;state=clear\x07";
        let expected = vec![
            Event::Root(Some(ProgramState::Working)),
            Event::Query,
            Event::Root(Some(ProgramState::Blocked)),
            Event::Root(Some(ProgramState::Finished)),
            Event::Root(Some(ProgramState::Idle)),
            Event::Root(None),
        ];
        for piece in [1, 3, stream.len()] {
            assert_eq!(scan_in_pieces(stream, piece), expected, "pieces of {piece}");
        }
    }

    #[test]
    fn ignores_child_records_unknown_states_and_oversized_reports() {
        let oversized = format!("\x1b]7501;state=working:msg={}\x07", "A".repeat(BODY_LIMIT));
        for report in [
            "\x1b]7501;state=working:id=task\x07",
            "\x1b]7501;id=:state=working\x07",
            "\x1b]7501;state=paused\x07",
            "\x1b]7501;kind=question\x07",
            "\x1b]7501;state=working\x18\x07",
            "\x1b]75011;state=working\x07",
            &oversized,
        ] {
            assert_eq!(scan_in_pieces(report.as_bytes(), 7), vec![], "{report:?}");
        }
    }

    #[test]
    fn a_full_reset_clears_the_root_record() {
        assert_eq!(scan_in_pieces(b"\x1bc", 1), vec![Event::Root(None)]);
    }
}
