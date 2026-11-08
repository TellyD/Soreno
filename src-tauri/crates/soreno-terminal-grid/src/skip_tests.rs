use super::*;

fn scan(bytes: &[u8], live_from: u64) -> Result<Vec<u8>, SkipRefusal> {
    let mut scan = SkipScan::default();
    scan.feed(bytes, 0, live_from);
    scan.finish()
}

#[test]
fn live_queries_refuse_and_replayed_ones_do_not() {
    let queries: [&[u8]; 13] = [
        b"\x1b[6n",
        b"\x1b[?6n",
        b"\x1b[c",
        b"\x1b[>c",
        b"\x1b[14t",
        b"\x1b[18t",
        b"\x1b[?2026$p",
        b"\x1b[?u",
        b"\x1b]11;?\x07",
        b"\x1b]4;1;?\x1b\\",
        b"\x1bP+q544e\x1b\\",
        b"\x1bZ",
        b"\x1b]52;c;?\x07",
    ];
    for query in queries {
        let bytes = [b"text".as_slice(), query, b"more"].concat();
        let name = String::from_utf8_lossy(query);
        assert_eq!(scan(&bytes, 0), Err(SkipRefusal::Query), "{name}");
        assert!(scan(&bytes, bytes.len() as u64).is_ok(), "{name}");
    }
    let split = b"\x1b[6n\x1b[5n";
    assert!(scan(split, 4).is_err(), "a live query after replayed ones");
    assert!(scan(b"\x1b[8;40;120t", 0).is_ok());
}

#[test]
fn live_clipboard_copies_refuse_and_replayed_ones_do_not() {
    let copy = b"\x1b]52;c;aGk=\x07";
    assert_eq!(scan(copy, 0), Err(SkipRefusal::Clipboard));
    assert!(scan(copy, u64::MAX).is_ok());
}

#[test]
fn resets_alt_screen_and_palette_changes_refuse_even_in_history() {
    let cases: [(&[u8], SkipRefusal); 8] = [
        (b"\x1bc", SkipRefusal::Reset),
        (b"\x1b[!p", SkipRefusal::Reset),
        (b"\x1b[?1049h", SkipRefusal::AltScreen),
        (
            b"\x1b[?1049h\x1b[?1049l\x1b[?25;1049h",
            SkipRefusal::AltScreen,
        ),
        (b"\x1b]4;1;rgb:ff/00/00\x07", SkipRefusal::Colors),
        (b"\x1b]11;#000000\x07", SkipRefusal::Colors),
        (b"\x1b]104\x07", SkipRefusal::Colors),
        (b"\x1b]112\x07", SkipRefusal::Colors),
    ];
    for (bytes, refusal) in cases {
        let name = String::from_utf8_lossy(bytes);
        assert_eq!(scan(bytes, u64::MAX), Err(refusal), "{name}");
    }
}

#[test]
fn state_the_scan_does_not_carry_refuses_even_in_history() {
    let sequences: [&[u8]; 12] = [
        b"\x1b7",
        b"\x1b8",
        b"\x1b[s",
        b"\x1b[u",
        b"\x1bH",
        b"\x1b[g",
        b"\x1b[3g",
        b"\x1b]50;CursorShape=1\x07",
        b"\x1b#8",
        b"\x1bPq#0;2;0;0;0\x1b\\",
        // DECSTBM, including margins alacritty ignores.
        b"\x1b[2;5r",
        b"\x1b[5;2r",
    ];
    for sequence in sequences {
        let bytes = [b"text".as_slice(), sequence, b"more"].concat();
        let name = String::from_utf8_lossy(sequence);
        assert_eq!(
            scan(&bytes, u64::MAX),
            Err(SkipRefusal::Unsupported),
            "{name}"
        );
    }
}

#[test]
fn carried_attributes_are_never_dropped_past_the_limit() {
    let colors = b"\x1b[31m".repeat(820);
    let bold_then_colors = [b"\x1b[1m".as_slice(), &colors].concat();
    assert_eq!(scan(&bold_then_colors, 0), Err(SkipRefusal::Limit));
    let half = &colors[..colors.len() / 2];
    let reset = [b"\x1b[1m".as_slice(), half, b"\x1b[0m", half].concat();
    assert!(
        scan(&reset, 0).is_ok(),
        "a reset starts the carried SGR over"
    );
}

#[test]
fn bytes_ending_inside_a_sequence_refuse() {
    for bytes in [
        b"text\x1b[3".as_slice(),
        b"text\x1b]2;title",
        b"text\x1b",
        "é".as_bytes().split_at(1).0,
    ] {
        let name = String::from_utf8_lossy(bytes);
        assert_eq!(scan(bytes, 0), Err(SkipRefusal::Boundary), "{name}");
    }
}

#[test]
fn every_alternate_screen_switch_refuses_even_a_balanced_visit() {
    for visit in [
        b"\x1b[?1049h\x1b[31mfull screen\x1b[?1049l".as_slice(),
        b"\x1b[?1047h\x1b[?1047l",
        b"\x1b[?47h\x1b[?47l",
    ] {
        let name = String::from_utf8_lossy(visit);
        assert_eq!(scan(visit, 0), Err(SkipRefusal::AltScreen), "{name}");
    }
}

#[test]
fn the_ground_tracker_follows_the_parser_across_chunks() {
    let cases: [(&[&[u8]], bool); 11] = [
        (&[b"text"], true),
        (&[b"\x1b[31", b"m"], true),
        (&[b"\x1b[31m\x1b[?25h"], true),
        (&[b"\x1b[3"], false),
        (&[b"\x1b[3\n"], false),
        (&[b"\x1b]2;title", b" more"], false),
        (&[b"\x1b]2;title", b"\x07"], true),
        (&[b"\x1b]2;title\x1b\\"], true),
        (&[b"\x1b[3", b"\x18"], true),
        (&[b"a\xe2\x82"], false),
        (&[b"a\xe2", b"\x82", b"\xac"], true),
    ];
    for (chunks, ground) in cases {
        let mut tracker = GroundTracker::default();
        for chunk in chunks {
            tracker.advance(chunk);
        }
        assert_eq!(tracker.ground(), ground, "{chunks:?}");
    }
}
