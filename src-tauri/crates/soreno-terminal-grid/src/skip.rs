//! Lightweight pass over bytes an obsolete redraw makes invisible: keeps the state a later
//! full redraw does not repaint and refuses the skip when the bytes must really be parsed.
//! Allowlist: a sequence is accepted only when the redraw replaces its effect, when it is
//! carried into the replay, or when alacritty ignores it.
use alacritty_terminal::vte::{Params, Parser, Perform};
use std::io::Write;

const LIMIT: usize = 4096;
const ESC: u8 = 0x1b;
const SHIFT_OUT: u8 = 0x0e;
const SHIFT_IN: u8 = 0x0f;
const SYNC_UPDATE: u16 = 2026;

/// Why skipped bytes must be parsed after all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipRefusal {
    /// A live query expects a reply.
    Query,
    /// RIS or DECSTR resets state the scan cannot replay.
    Reset,
    /// The bytes switch between the main and alternate screens.
    AltScreen,
    /// OSC palette changes survive redraws.
    Colors,
    /// A live OSC 52 copy must reach the clipboard.
    Clipboard,
    /// The carried SGR or title sequences would exceed their limit.
    Limit,
    /// A sequence whose state the scan does not carry.
    Unsupported,
    /// The parser is inside a sequence where the skip starts or ends.
    Boundary,
    /// The redraw draws before it erases the screen and scrollback and places the cursor.
    Keyframe,
    /// The redraw's retained bytes end before its first character.
    KeyframePending,
}

impl SkipRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Reset => "reset",
            Self::AltScreen => "alt-screen",
            Self::Colors => "colors",
            Self::Clipboard => "clipboard",
            Self::Limit => "limit",
            Self::Unsupported => "unsupported",
            Self::Boundary => "boundary",
            Self::Keyframe => "keyframe",
            Self::KeyframePending => "keyframe-pending",
        }
    }
    /// More bytes, parsed or received, may turn this refusal into an accepted skip.
    pub fn is_transient(self) -> bool {
        matches!(self, Self::Boundary | Self::KeyframePending)
    }
}

/// Terminal-wide settings replayed in the order they were last changed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Setting {
    /// Private flag, mode number.
    Mode(bool, u16),
    /// 1000/1002/1003: setting one clears the others.
    MouseProtocol,
    /// 1005/1006: setting one clears the other.
    MouseEncoding,
    Keypad,
    CursorStyle,
}

#[derive(Default)]
struct Carry {
    settings: Vec<(Setting, Vec<u8>)>,
    charsets: [Option<u8>; 4],
    shift: Option<u8>,
    /// SGR sequences since the last reset, in order.
    sgr: Vec<u8>,
    hyperlink: Option<Vec<u8>>,
    /// Title sets and title stack pushes and pops in order; a set replaces a set before it.
    titles: Vec<u8>,
    /// Start of the set that ends `titles`.
    last_title: Option<usize>,
    refusal: Option<SkipRefusal>,
    live: bool,
}

#[derive(Default)]
pub(crate) struct SkipScan {
    parser: Parser,
    carry: Carry,
}

impl SkipScan {
    /// Scans `bytes` that start at stream `offset`; queries before `live_from` are history.
    pub(crate) fn feed(&mut self, bytes: &[u8], offset: u64, live_from: u64) {
        let replayed = live_from.saturating_sub(offset).min(bytes.len() as u64) as usize;
        for (part, live) in [(&bytes[..replayed], false), (&bytes[replayed..], true)] {
            self.carry.live = live;
            if self.carry.refusal.is_none() {
                let _ = self.parser.advance_until_terminated(&mut self.carry, part);
            }
        }
    }
    /// Bytes that restore the carried state into a terminal.
    pub(crate) fn finish(mut self) -> Result<Vec<u8>, SkipRefusal> {
        let mut probe = GroundProbe::default();
        if self.carry.refusal.is_none() {
            self.parser.advance(&mut probe, b"X");
        }
        let carry = self.carry;
        if let Some(refusal) = carry.refusal {
            return Err(refusal);
        }
        if probe.0 != Some(true) {
            return Err(SkipRefusal::Boundary);
        }
        let mut out = Vec::new();
        for (index, charset) in carry.charsets.iter().enumerate() {
            if let Some(charset) = charset {
                out.extend_from_slice(&[ESC, b"()*+"[index], *charset]);
            }
        }
        out.extend(carry.shift);
        for (_, bytes) in &carry.settings {
            out.extend_from_slice(bytes);
        }
        out.extend_from_slice(&carry.sgr);
        out.extend(carry.hyperlink.into_iter().flatten());
        out.extend_from_slice(&carry.titles);
        Ok(out)
    }
}

/// Records whether a lone printable byte is printed as is, which only happens in the ground state.
#[derive(Default)]
struct GroundProbe(Option<bool>);

impl GroundProbe {
    fn saw(&mut self, printed: bool) {
        self.0.get_or_insert(printed);
    }
}

impl Perform for GroundProbe {
    fn print(&mut self, c: char) {
        self.saw(c == 'X');
    }
    fn execute(&mut self, _byte: u8) {
        self.saw(false);
    }
    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        self.saw(false);
    }
    fn put(&mut self, _byte: u8) {
        self.saw(false);
    }
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {
        self.saw(false);
    }
    fn csi_dispatch(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _c: char) {
        self.saw(false);
    }
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        self.saw(false);
    }
}

/// Follows whether a parser fed the same bytes sits in the ground state, parsing only what
/// follows the last ESC: from any state, ESC starts a fresh escape sequence.
pub(crate) struct GroundTracker {
    parser: Parser,
    ground: bool,
}

impl Default for GroundTracker {
    fn default() -> Self {
        Self {
            parser: Parser::new(),
            ground: true,
        }
    }
}

impl GroundTracker {
    pub(crate) fn advance(&mut self, bytes: &[u8]) {
        let rest = match memchr::memrchr(ESC, bytes) {
            Some(index) => {
                self.parser = Parser::new();
                self.ground = false;
                &bytes[index..]
            }
            None => bytes,
        };
        let mut ground = ReachesGround(self.ground);
        self.parser.advance(&mut ground, rest);
        self.ground = ground.0 && !ends_in_partial_char(rest);
    }
    pub(crate) fn ground(&self) -> bool {
        self.ground
    }
}

/// Set by every action that leaves the parser in the ground state, given no ESC follows.
struct ReachesGround(bool);

impl Perform for ReachesGround {
    fn print(&mut self, _c: char) {
        self.0 = true;
    }
    fn execute(&mut self, byte: u8) {
        // CAN and SUB abort any sequence; other controls leave the state unchanged.
        if matches!(byte, 0x18 | 0x1a) {
            self.0 = true;
        }
    }
    fn unhook(&mut self) {
        self.0 = true;
    }
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {
        self.0 = true;
    }
    fn csi_dispatch(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _c: char) {
        self.0 = true;
    }
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        self.0 = true;
    }
}

/// Ground text ending with the start of a UTF-8 character that vte holds back.
fn ends_in_partial_char(bytes: &[u8]) -> bool {
    let tail = &bytes[bytes.len().saturating_sub(3)..];
    tail.iter()
        .rposition(|byte| byte & 0xc0 != 0x80)
        .is_some_and(|start| {
            std::str::from_utf8(&tail[start..]).is_err_and(|error| error.error_len().is_none())
        })
}

/// What a full redraw establishes before its first character, which the skip relies on: the
/// skipped path reaches it with another cursor, screen, history and preceding character.
#[derive(Default)]
struct KeyframeStart {
    positioned: bool,
    erased: bool,
    /// The scrollback was erased after the last screen erase, which pushes rows into it.
    cleared: bool,
    printed: bool,
    refused: bool,
}

impl KeyframeStart {
    /// For effects that depend on the cursor or on what the screen showed.
    fn needs_blank_screen(&mut self) {
        if !(self.positioned && self.erased) {
            self.refused = true;
        }
    }
}

impl Perform for KeyframeStart {
    fn print(&mut self, _c: char) {
        self.printed = true;
    }
    fn execute(&mut self, byte: u8) {
        // Bell, backspace, tab, carriage return and charset shifts never scroll.
        if !matches!(byte, 0x07..=0x09 | 0x0d..=0x0f) {
            self.needs_blank_screen();
        }
    }
    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        self.refused = true;
    }
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        // alacritty drops these whole.
        if ignore || intermediates.len() > 2 {
            return;
        }
        let first = params.iter().next().map_or(0, |param| param[0]);
        match (action, intermediates) {
            ('H' | 'f', []) => self.positioned = true,
            ('J', []) if first == 2 => {
                self.erased = true;
                self.cleared = false;
            }
            ('J', []) if first == 3 => self.cleared = true,
            // Moves, which the next absolute position overrides.
            ('A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'I' | 'Z' | '`' | 'a' | 'd' | 'e', []) => {}
            ('J' | 'K' | 'X' | '@' | 'P' | 'L' | 'M' | 'S' | 'T', []) => self.needs_blank_screen(),
            ('h' | 'l', [b'?'])
                if params
                    .iter()
                    .any(|param| matches!(param[0], 3 | 6 | 47 | 1047 | 1049)) =>
            {
                self.refused = true;
            }
            ('h' | 'l', [] | [b'?']) | ('m', []) | ('q', [b' ']) | ('t', []) => {}
            // REP included: it repeats the character printed before the redraw.
            _ => self.refused = true,
        }
    }
    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates, byte) {
            ([], b'=' | b'>' | b'\\') | ([b'(' | b')' | b'*' | b'+'], _) => {}
            ([], b'D' | b'E' | b'M') => self.needs_blank_screen(),
            _ => self.refused = true,
        }
    }
    fn terminated(&self) -> bool {
        self.printed || self.refused
    }
}

/// Checks that the full redraw starting `bytes` repaints everything the skip changes.
pub(crate) fn check_keyframe(bytes: &[u8]) -> Result<(), SkipRefusal> {
    let mut start = KeyframeStart::default();
    let _ = Parser::new().advance_until_terminated(&mut start, bytes);
    if start.refused {
        Err(SkipRefusal::Keyframe)
    } else if !start.printed {
        Err(SkipRefusal::KeyframePending)
    } else if start.positioned && start.erased && start.cleared {
        Ok(())
    } else {
        Err(SkipRefusal::Keyframe)
    }
}

fn push_params(out: &mut Vec<u8>, params: &Params) {
    for (index, param) in params.iter().enumerate() {
        if index > 0 {
            out.push(b';');
        }
        for (sub, value) in param.iter().enumerate() {
            if sub > 0 {
                out.push(b':');
            }
            let _ = write!(out, "{value}");
        }
    }
}

fn csi(params: &Params, intermediates: &[u8], action: u8) -> Vec<u8> {
    let mut out = b"\x1b[".to_vec();
    push_params(&mut out, params);
    out.extend_from_slice(intermediates);
    out.push(action);
    out
}

fn push_osc(out: &mut Vec<u8>, params: &[&[u8]]) {
    out.extend_from_slice(b"\x1b]");
    for (index, param) in params.iter().enumerate() {
        if index > 0 {
            out.push(b';');
        }
        out.extend_from_slice(param);
    }
    out.extend_from_slice(b"\x1b\\");
}

impl Carry {
    fn refuse(&mut self, refusal: SkipRefusal) {
        self.refusal.get_or_insert(refusal);
    }
    fn query(&mut self) {
        if self.live {
            self.refuse(SkipRefusal::Query);
        }
    }
    fn set(&mut self, setting: Setting, bytes: Vec<u8>) {
        self.settings.retain(|(kept, _)| *kept != setting);
        self.settings.push((setting, bytes));
    }
    fn set_mode(&mut self, private: bool, mode: u16, set: bool) {
        let action = if set { 'h' } else { 'l' };
        let marker = if private { "?" } else { "" };
        let bytes = format!("\x1b[{marker}{mode}{action}").into_bytes();
        let group = match (private, mode) {
            // alacritty also saves the main screen cursor on entry.
            (true, 47 | 1047 | 1049) => return self.refuse(SkipRefusal::AltScreen),
            (true, SYNC_UPDATE) => return,
            (true, 1000 | 1002 | 1003) => Setting::MouseProtocol,
            (true, 1005 | 1006) => Setting::MouseEncoding,
            _ => return self.set(Setting::Mode(private, mode), bytes),
        };
        // Setting a member replaces the group; resetting one only clears that member.
        let mut replay = match self.settings.iter().position(|(kept, _)| *kept == group) {
            Some(index) if !set => self.settings.remove(index).1,
            _ => Vec::new(),
        };
        if memchr::memmem::find(&replay, &bytes).is_none() {
            replay.extend_from_slice(&bytes);
        }
        self.set(group, replay);
    }
    fn sgr(&mut self, params: &Params) {
        // vte resets on a lone 0, not on a 0 with sub-parameters.
        let mut all = params.iter();
        let reset = match (all.next(), all.next()) {
            (None, _) => true,
            (Some(param), None) => param == [0],
            _ => false,
        };
        if reset {
            self.sgr.clear();
        }
        let sgr = csi(params, &[], b'm');
        if self.sgr.len() + sgr.len() > LIMIT {
            return self.refuse(SkipRefusal::Limit);
        }
        self.sgr.extend_from_slice(&sgr);
    }
    /// A lone title set is always kept; a stack history must stay small.
    fn limit_titles(&mut self) {
        if self.titles.len() > LIMIT && self.last_title != Some(0) {
            self.refuse(SkipRefusal::Limit);
        }
    }
    /// OSC 4 and 10–12 take (index, spec) or spec lists where `?` queries.
    fn color_specs<'a>(&mut self, specs: impl Iterator<Item = &'a [u8]>) {
        for spec in specs {
            if spec == b"?" {
                self.query();
            } else {
                self.refuse(SkipRefusal::Colors);
            }
        }
    }
}

impl Perform for Carry {
    fn execute(&mut self, byte: u8) {
        // Other C0 controls move the cursor, ring or are ignored by alacritty.
        if matches!(byte, SHIFT_OUT | SHIFT_IN) {
            self.shift = Some(byte);
        }
    }
    fn hook(&mut self, _params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        match (intermediates, action) {
            ([b'+' | b'$'], 'q') => self.query(),
            _ => self.refuse(SkipRefusal::Unsupported),
        }
    }
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some(&command) = params.first() else {
            return;
        };
        match command {
            b"" => {}
            b"0" | b"2" if params.len() >= 2 => {
                let start = self.last_title.map_or(self.titles.len(), |start| {
                    self.titles.truncate(start);
                    start
                });
                push_osc(
                    &mut self.titles,
                    &[b"2", params[1..].join(&b';').as_slice()],
                );
                self.last_title = Some(start);
                self.limit_titles();
            }
            b"8" if params.len() > 2 => {
                let mut link = Vec::new();
                push_osc(&mut link, params);
                self.hyperlink = Some(link);
            }
            b"0" | b"2" | b"8" => {}
            b"4" => self.color_specs(params[1..].iter().skip(1).step_by(2).copied()),
            b"10" | b"11" | b"12" => self.color_specs(params[1..].iter().copied()),
            b"104" | b"110" | b"111" | b"112" => self.refuse(SkipRefusal::Colors),
            b"52" if params.len() >= 3 => {
                if params[2] == b"?" {
                    self.query();
                } else if self.live {
                    self.refuse(SkipRefusal::Clipboard);
                }
            }
            b"52" => {}
            b"50" => self.refuse(SkipRefusal::Unsupported),
            // alacritty ignores every other command (shell integration marks, notifications…).
            _ => {}
        }
    }
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        // alacritty drops these whole.
        if ignore || intermediates.len() > 2 {
            return;
        }
        let first = params.iter().next().map_or(0, |param| param[0]);
        match (action, intermediates) {
            (
                '@' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
                | 'P' | 'S' | 'T' | 'X' | 'Z' | '`' | 'a' | 'b' | 'd' | 'e' | 'f',
                [],
            ) => {}
            ('h' | 'l', [] | [b'?']) => {
                for param in params.iter() {
                    self.set_mode(!intermediates.is_empty(), param[0], action == 'h');
                }
            }
            ('m', []) => self.sgr(params),
            ('q', [b' ']) if first <= 6 => {
                self.set(Setting::CursorStyle, csi(params, b" ", b'q'));
            }
            ('q', [b' ']) => {}
            ('p', [b'!']) => self.refuse(SkipRefusal::Reset),
            ('n', _)
            | ('c', _)
            | ('p', [b'$'] | [b'?', b'$'])
            | ('u', [b'?'])
            | ('q', [b'>'])
            | ('m', [b'?'])
            | ('S', [b'?']) => self.query(),
            ('t', []) => match first {
                14 | 16 | 18 => self.query(),
                22 | 23 => {
                    let _ = write!(self.titles, "\x1b[{first}t");
                    self.last_title = None;
                    self.limit_titles();
                }
                _ => {}
            },
            // alacritty 0.26 does not implement XTMODKEYS.
            ('m', [b'>']) => {}
            // The engine disables the kitty keyboard protocol.
            ('u', [b'=' | b'>' | b'<']) => {}
            _ => self.refuse(SkipRefusal::Unsupported),
        }
    }
    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates, byte) {
            ([], b'D' | b'E' | b'M' | b'\\') => {}
            ([], b'=' | b'>') => self.set(Setting::Keypad, vec![ESC, byte]),
            ([], b'Z') => self.query(),
            ([], b'c') => self.refuse(SkipRefusal::Reset),
            ([designator @ (b'(' | b')' | b'*' | b'+')], b'B' | b'0') => {
                if let Some(index) = b"()*+".iter().position(|d| d == designator) {
                    self.charsets[index] = Some(byte);
                }
            }
            // Charsets alacritty does not know leave the designation unchanged.
            ([b'(' | b')' | b'*' | b'+'], _) | (_, b'B' | b'0') => {}
            _ => self.refuse(SkipRefusal::Unsupported),
        }
    }
    fn terminated(&self) -> bool {
        self.refusal.is_some()
    }
}

#[cfg(test)]
#[path = "skip_tests.rs"]
mod tests;
