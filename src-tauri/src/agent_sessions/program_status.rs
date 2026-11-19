//! Program Status Protocol (OSC 7501): the root record's state and the feature query.
//! Spec: https://www.superlogical.com/rex/docs/build/program-status
//! Also reads the working directory a shell reports with OSC 7.

use base64::{
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};

const ESC: u8 = 0x1b;
const PREFIX: &[u8] = b"7501;";
/// OSC 133 `A`, a new shell prompt. Other OSC bodies are cut to the length of `PREFIX`.
const PROMPT: &[u8] = b"133;A";
const DIRECTORY: &[u8] = b"7;";
/// `ESC ]` through `ESC \` is capped at 4096 bytes.
const BODY_LIMIT: usize = 4096 - 4;
/// Encoded and decoded byte limits of `msg`.
const MSG_LIMIT: (usize, usize) = (2732, 2048);
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);
pub(super) const QUERY_REPLY: &[u8] = b"\x1b]7501;?\x1b\\";

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum ProgramState {
    Idle,
    Working,
    /// With its `kind` when known: `permission`, `question` or `auth`.
    Blocked(Option<&'static str>),
    /// Claude Code reports `done` while its background agents still run.
    Done,
    Error,
}

#[derive(Debug, PartialEq)]
pub(super) enum Event {
    Query,
    /// New root state, with the `msg` of a `blocked` or `error` one; `None` when the records are cleared.
    Root(Option<ProgramState>, Option<String>),
    Prompt,
    /// Path of an OSC 7 `file://` report.
    Directory(String),
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
                        || ((self.body.starts_with(PREFIX) || self.body.starts_with(DIRECTORY))
                            && self.body.len() <= BODY_LIMIT)
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
                    events.push(Event::Root(None, None));
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
        if self.body == PROMPT {
            return Some(Event::Prompt);
        }
        if let Some(uri) = self.body.strip_prefix(DIRECTORY) {
            return directory(uri).map(Event::Directory);
        }
        let pairs = self.body.strip_prefix(PREFIX)?;
        if pairs == b"?" {
            return Some(Event::Query);
        }
        let (mut state, mut kind, mut message) = (None, None, None);
        for pair in pairs.split(|&byte| byte == b':') {
            let Some(split) = pair.iter().position(|&byte| byte == b'=') else {
                continue;
            };
            let value = pair[split + 1..].trim_ascii();
            match pair[..split].trim_ascii() {
                // Child records, and malformed ids, never address the root.
                b"id" => return None,
                b"state" => state = Some(value),
                b"kind" => kind = Some(value),
                b"msg" => message = Some(value),
                _ => {}
            }
        }
        let state = match state? {
            b"idle" => ProgramState::Idle,
            b"done" => ProgramState::Done,
            b"error" => ProgramState::Error,
            b"working" => ProgramState::Working,
            b"blocked" => ProgramState::Blocked(kind.and_then(|kind| {
                ["permission", "question", "auth"]
                    .into_iter()
                    .find(|known| known.as_bytes() == kind)
            })),
            b"clear" => return Some(Event::Root(None, None)),
            _ => return None,
        };
        let message =
            message.filter(|_| matches!(state, ProgramState::Blocked(_) | ProgramState::Error));
        Some(Event::Root(Some(state), message.and_then(text)))
    }
}

/// Decoded path of `file://host/path`; a drive path `/C:/…` becomes `C:\…`.
// shortcut: the host is dropped, so a Windows UNC location falls back to the default directory;
// rebuild `\\host\path` if PowerShell users start from network shares.
fn directory(uri: &[u8]) -> Option<String> {
    let rest = uri.strip_prefix(b"file://")?;
    let mut path = &rest[rest.iter().position(|&byte| byte == b'/')?..];
    let mut decoded = Vec::with_capacity(path.len());
    while let Some((&byte, rest)) = path.split_first() {
        path = rest;
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }
        let hex = path
            .get(..2)
            .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))?;
        decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
        path = &path[2..];
    }
    let path = String::from_utf8(decoded).ok()?;
    if path.chars().any(char::is_control) {
        return None;
    }
    match path.as_bytes() {
        // A UNC or device path would make Windows contact the share when it is validated.
        [b'/', b'/' | b'\\', ..] => None,
        [b'/', drive, b':', b'/', ..] if drive.is_ascii_alphabetic() => {
            Some(path[1..].replace('/', "\\"))
        }
        _ => Some(path),
    }
}

/// Decoded `msg`, without invisible formatting that could disguise it outside the grid.
/// Unlike the spec, invalid text is dropped alone: its report's state still applies.
fn text(value: &[u8]) -> Option<String> {
    let (encoded, decoded) = MSG_LIMIT;
    if value.len() > encoded {
        return None;
    }
    let text = String::from_utf8(BASE64.decode(value).ok()?).ok()?;
    if text.len() > decoded || text.chars().any(char::is_control) {
        return None;
    }
    Some(
        text.chars()
            .filter(|c| {
                !matches!(c, '\u{61c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{2069}' | '\u{feff}')
            })
            .collect(),
    )
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
    fn reports_root_states_prompts_and_queries_even_when_split() {
        let stream = b"\x1b]0;title\x07\x1b]7501;state=working:app=claude-code\x1b\\text\
            \x1b]7501;?\x07\x1b[c\x1b]7501; state = blocked :kind=permission:msg=QQ==\x07\
            \x1b]133;A;cl=m\x07\x1b]7501;state=done\x1b\\\x1b]7501;state=idle\x07\
            \x1b]7501;state=blocked:kind=other\x07\x1b]7501;state=error:msg=QQ\x07\
            \x1b]7501;state=clear\x07";
        let expected = vec![
            Event::Root(Some(ProgramState::Working), None),
            Event::Query,
            Event::Root(
                Some(ProgramState::Blocked(Some("permission"))),
                Some("A".into()),
            ),
            Event::Prompt,
            Event::Root(Some(ProgramState::Done), None),
            Event::Root(Some(ProgramState::Idle), None),
            Event::Root(Some(ProgramState::Blocked(None)), None),
            Event::Root(Some(ProgramState::Error), Some("A".into())),
            Event::Root(None, None),
        ];
        for piece in [1, 3, stream.len()] {
            assert_eq!(scan_in_pieces(stream, piece), expected, "pieces of {piece}");
        }
    }

    #[test]
    fn keeps_only_a_valid_visible_blocked_message() {
        let encoded = |text: &str| BASE64.encode(text);
        for (report, message) in [
            (
                format!("blocked:msg={}", encoded("Run bash?")),
                Some("Run bash?"),
            ),
            ("blocked:msg=QQ".into(), Some("A")),
            (
                format!("blocked:msg={}", encoded("a\u{202e}b\u{200b}c")),
                Some("abc"),
            ),
            (format!("blocked:msg={}", encoded("a\nb")), None),
            (format!("blocked:msg={}", encoded("a\u{85}b")), None),
            ("blocked:msg=!!".into(), None),
            ("blocked:msg=/w==".into(), None),
            (format!("blocked:msg={}", encoded(&"a".repeat(2049))), None),
            (format!("working:msg={}", encoded("Listing files")), None),
        ] {
            let state = if report.starts_with("blocked") {
                ProgramState::Blocked(None)
            } else {
                ProgramState::Working
            };
            assert_eq!(
                scan_in_pieces(format!("\x1b]7501;state={report}\x07").as_bytes(), 5),
                vec![Event::Root(Some(state), message.map(Into::into))],
                "{report}"
            );
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
        assert_eq!(scan_in_pieces(b"\x1bc", 1), vec![Event::Root(None, None)]);
    }

    #[test]
    fn reads_osc_7_directories() {
        for (report, directory) in [
            ("file://host/home/me/my%20dir", Some("/home/me/my dir")),
            ("file:///C:/Users/me/a%23b", Some("C:\\Users\\me\\a#b")),
            ("file://host/caf%C3%A9", Some("/café")),
            ("file://host/a%2", None),
            ("file://host/a%+1", None),
            ("file://host/a%0Ab", None),
            ("file://host/a%FF", None),
            ("https://host/a", None),
            ("file://host", None),
            ("file:////attacker/share", None),
            ("file://host//attacker/share", None),
            ("file://host/%5Cattacker/share", None),
            ("file:////?/C:/x", None),
        ] {
            assert_eq!(
                scan_in_pieces(format!("\x1b]7;{report}\x1b\\").as_bytes(), 3),
                directory
                    .map(|directory| Event::Directory(directory.into()))
                    .into_iter()
                    .collect::<Vec<_>>(),
                "{report}"
            );
        }
    }
}
