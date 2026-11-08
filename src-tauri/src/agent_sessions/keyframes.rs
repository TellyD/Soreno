//! Finds full redraws in the terminal stream: a synchronized frame that erases the scrollback
//! (Pi, OMP), or adjacent screen and scrollback erases (the same redraw before the CLI has
//! enabled synchronized output, or `clear`). Everything before one is obsolete for a replay.

const ESC: u8 = 0x1b;
const FRAME_START: &[u8] = b"\x1b[?2026h";
const FRAME_END: &[u8] = b"\x1b[?2026l";
const ERASE_SCREEN: &[u8] = b"\x1b[2J";
const ERASE_SCROLLBACK: &[u8] = b"\x1b[3J";

#[derive(Clone, Copy, PartialEq)]
enum Erase {
    Screen,
    Scrollback,
}

#[derive(Default)]
pub(super) struct KeyframeScan {
    start: usize,
    end: usize,
    screen: usize,
    scrollback: usize,
    frame: Option<u64>,
    /// Kind, start and end of the last erase sequence.
    erase: Option<(Erase, u64, u64)>,
}

fn advance(matched: usize, marker: &[u8], byte: u8) -> usize {
    if byte == marker[matched] {
        matched + 1
    } else if byte == ESC {
        1
    } else {
        0
    }
}

impl KeyframeScan {
    /// Start offset of the last full redraw seen in `bytes`, which begin at `offset`.
    pub(super) fn scan(&mut self, bytes: &[u8], offset: u64) -> Option<u64> {
        let mut found = None;
        for (index, &byte) in bytes.iter().enumerate() {
            self.start = advance(self.start, FRAME_START, byte);
            self.end = advance(self.end, FRAME_END, byte);
            self.screen = advance(self.screen, ERASE_SCREEN, byte);
            self.scrollback = advance(self.scrollback, ERASE_SCROLLBACK, byte);
            let next = offset + index as u64 + 1;
            if self.start == FRAME_START.len() {
                self.start = 0;
                self.frame.get_or_insert(next - FRAME_START.len() as u64);
            }
            if self.end == FRAME_END.len() {
                self.end = 0;
                self.frame = None;
            }
            let (erase, length) = if self.screen == ERASE_SCREEN.len() {
                self.screen = 0;
                (Erase::Screen, ERASE_SCREEN.len())
            } else if self.scrollback == ERASE_SCROLLBACK.len() {
                self.scrollback = 0;
                (Erase::Scrollback, ERASE_SCROLLBACK.len())
            } else {
                continue;
            };
            let start = next - length as u64;
            let adjacent = self
                .erase
                .filter(|&(kind, _, end)| kind != erase && end == start)
                .map(|(_, previous, _)| previous);
            if erase == Erase::Scrollback && self.frame.is_some() {
                found = self.frame;
            } else if self.frame.is_none() && adjacent.is_some() {
                found = adjacent;
            }
            self.erase = Some((erase, start, next));
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_in_pieces(stream: &[u8], piece: usize) -> Option<u64> {
        let mut scan = KeyframeScan::default();
        let mut found = None;
        for (index, bytes) in stream.chunks(piece).enumerate() {
            found = scan.scan(bytes, (index * piece) as u64).or(found);
        }
        found
    }

    fn position(stream: &[u8], marker: &[u8]) -> Option<u64> {
        stream
            .windows(marker.len())
            .rposition(|window| window == marker)
            .map(|index| index as u64)
    }

    #[test]
    fn full_redraw_starts_at_its_frame_even_when_markers_are_split() {
        let stream = b"diff\x1b[?2026h\x1b[1;1Hrow\x1b[?2026lold\x1b[?25l\x1b[?2026h\x1b[?7l\x1b[H\x1b[2J\x1b[3Jhistory\x1b[?2026ldiff";
        for piece in [1, 3, stream.len()] {
            assert_eq!(scan_in_pieces(stream, piece), position(stream, FRAME_START));
        }
    }

    #[test]
    fn unsynchronized_redraw_starts_at_its_adjacent_erases() {
        for clear in [b"\x1b[2J\x1b[3J", b"\x1b[3J\x1b[2J"] {
            let stream = [b"old\x1b[H".as_slice(), clear, b"history"].concat();
            assert_eq!(scan_in_pieces(&stream, 1), position(&stream, clear));
        }
    }

    #[test]
    fn partial_erases_are_not_full_redraws() {
        let stream = b"\x1b[3J\x1b[H\x1b[2J\x1b[?2026h\x1b[2Jrow\x1b[?2026l\x1b[3J";
        assert_eq!(scan_in_pieces(stream, 2), None);
    }

    #[test]
    fn nested_frame_start_keeps_the_open_frame() {
        let stream = b"\x1b[?2026h\x1b[2J\x1b[HHEADER\x1b[?2026h\x1b[3J\x1b[2;1HBODY\x1b[?2026l";
        for piece in [1, 3, stream.len()] {
            assert_eq!(scan_in_pieces(stream, piece), Some(0));
        }
    }
}
