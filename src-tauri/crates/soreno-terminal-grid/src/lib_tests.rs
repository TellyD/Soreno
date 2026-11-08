use super::*;
use std::time::Duration;

const TANGO: [&str; PALETTE_LEN] = [
    "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
    "#ffffff", "#000000", "#ffffff",
];

fn config() -> AgentGridConfig {
    AgentGridConfig {
        cell_width: 8,
        cell_height: 16,
        palette: TANGO.iter().map(|color| color.to_string()).collect(),
    }
}

fn core(cols: u16, rows: u16) -> GridEngineCore {
    GridEngineCore::new(cols, rows, GridTheme::parse(&config()).unwrap(), 0, 0)
}

fn frame(core: &mut GridEngineCore, bytes: &[u8]) -> AgentGridFrame {
    core.feed(bytes, Instant::now());
    core.frame().expect("frame")
}

fn row(frame: &AgentGridFrame, index: u32) -> &[AgentGridSpan] {
    &frame
        .lines
        .iter()
        .find(|(row, _, _)| *row == index)
        .expect("row sent")
        .1
}

fn text(spans: &[AgentGridSpan]) -> String {
    spans.iter().map(|span| span.t.as_str()).collect()
}

/// Front-side model: frames only carry changed rows.
fn paint(screen: &mut Vec<String>, frame: &AgentGridFrame) {
    screen.resize(frame.rows as usize, String::new());
    let moved = frame.shift.unsigned_abs() as usize;
    if frame.shift > 0 {
        screen.rotate_left(moved);
        let rows = screen.len();
        screen[rows - moved..].fill(String::new());
    } else if frame.shift < 0 {
        screen.rotate_right(moved);
        screen[..moved].fill(String::new());
    }
    for (row, spans, _) in &frame.lines {
        screen[*row as usize] = text(spans);
    }
}

/// The rows a full repaint would show now.
fn repainted(core: &mut GridEngineCore) -> Vec<String> {
    core.configure(GridTheme::parse(&config()).unwrap());
    let mut screen = Vec::new();
    paint(&mut screen, &core.frame().expect("frame"));
    screen
}

fn span(t: &str, c: u32, fg: u32, bg: u32, f: u32) -> AgentGridSpan {
    AgentGridSpan {
        t: t.into(),
        c,
        fg,
        bg,
        f,
        l: None,
        g: false,
    }
}

fn plain(t: &str, c: u32) -> AgentGridSpan {
    span(t, c, DEFAULT_FOREGROUND, DEFAULT_BACKGROUND, 0)
}

fn glyph(t: &str, c: u32) -> AgentGridSpan {
    AgentGridSpan {
        g: true,
        ..plain(t, c)
    }
}

fn framed(body: &[u8]) -> Vec<u8> {
    [BSU.as_slice(), body, ESU.as_slice()].concat()
}

#[test]
fn grouper_emits_a_split_frame_once_complete_at_every_boundary() {
    let input = [b"ab".as_slice(), &framed(b"\x1b[2Jframe"), b"cd"].concat();
    let frame_start = 2;
    let frame_end = input.len() - 2;
    let now = Instant::now();
    for split in 0..=input.len() {
        let mut grouper = FrameGrouper::default();
        let mut first = Vec::new();
        grouper.push(&input[..split], now, &mut first);
        let expected = if split >= frame_end {
            &input[..split]
        } else {
            &input[..split.min(frame_start)]
        };
        assert_eq!(first, expected, "split at {split}");
        let mut second = Vec::new();
        grouper.push(&input[split..], now, &mut second);
        assert_eq!([first, second].concat(), input, "split at {split}");
        assert!(grouper.deadline().is_none());
    }
}

#[test]
fn grouper_holds_an_incomplete_frame_until_its_timeout() {
    let now = Instant::now();
    let mut grouper = FrameGrouper::default();
    let mut out = Vec::new();
    grouper.push(b"x", now, &mut out);
    grouper.push(&[BSU.as_slice(), b"partial"].concat(), now, &mut out);
    assert_eq!(out, b"x");
    assert_eq!(grouper.deadline(), Some(now + SYNC_TIMEOUT));
    grouper.flush_expired(now + SYNC_TIMEOUT - Duration::from_millis(1), &mut out);
    assert_eq!(out, b"x");
    grouper.flush_expired(now + SYNC_TIMEOUT, &mut out);
    assert_eq!(out, [b"x".as_slice(), BSU, b"partial"].concat());
    assert!(grouper.deadline().is_none());
}

#[test]
fn grouper_passes_plain_bytes_through_in_order() {
    let now = Instant::now();
    let mut grouper = FrameGrouper::default();
    let mut out = Vec::new();
    for chunk in [b"one ".as_slice(), b"\x1b[31mtwo ", b"three"] {
        grouper.push(chunk, now, &mut out);
    }
    assert_eq!(out, b"one \x1b[31mtwo three");
    let two_frames = [framed(b"A"), b"mid".to_vec(), framed(b"B")].concat();
    grouper.push(&two_frames, now, &mut out);
    assert_eq!(
        out,
        [b"one \x1b[31mtwo three".as_slice(), &two_frames].concat()
    );
}

#[test]
fn spans_merge_ascii_runs_and_trim_trailing_blanks() {
    let mut core = core(20, 2);
    let frame = frame(&mut core, b"ab\x1b[1mcd\x1b[0m   ");
    assert_eq!(row(&frame, 0), [plain("ab", 2), span("cd", 2, 256, 257, 1)]);
    assert!(row(&frame, 1).is_empty());
}

#[test]
fn spans_keep_colored_trailing_blanks() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, b"a\x1b[41m  \x1b[0m   ");
    assert_eq!(row(&frame, 0), [plain("a", 1), span("  ", 2, 256, 1, 0)]);
}

#[test]
fn blanks_join_runs_of_another_foreground_unless_they_paint_it() {
    let mut core = core(20, 2);
    let frame = frame(
        &mut core,
        b"  \x1b[31mif\x1b[39m \x1b[32mx\r\n\x1b[4;31ma\x1b[32m b",
    );
    assert_eq!(
        row(&frame, 0),
        [span("  if ", 5, 1, 257, 0), span("x", 1, 2, 257, 0)]
    );
    assert_eq!(
        row(&frame, 1),
        [span("a", 1, 1, 257, 4), span(" b", 2, 2, 257, 4)]
    );
}

#[test]
fn wide_chars_cover_two_cells_and_combining_chars_stay_attached() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, "a漢be\u{301}x".as_bytes());
    assert_eq!(
        row(&frame, 0),
        [
            plain("a", 1),
            glyph("漢", 2),
            plain("b", 1),
            glyph("e\u{301}", 1),
            plain("x", 1),
        ]
    );
}

#[test]
fn single_width_characters_merge_but_astral_ones_stay_alone() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, "╭──é─╮𝐀x".as_bytes());
    assert_eq!(
        row(&frame, 0),
        [plain("╭──é─╮", 6), glyph("𝐀", 1), plain("x", 1)]
    );
}

#[test]
fn a_wide_char_with_a_combining_mark_is_one_glyph_between_merged_runs() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, "ab漢\u{301}cd".as_bytes());
    assert_eq!(
        row(&frame, 0),
        [plain("ab", 2), glyph("漢\u{301}", 2), plain("cd", 2)]
    );
}

#[test]
fn colors_map_to_palette_default_and_truecolor_codes() {
    let mut core = core(20, 1);
    let frame = frame(
        &mut core,
        b"\x1b[38;2;1;2;3mA\x1b[38;5;200mB\x1b[31mC\x1b[91mD\x1b[39;44mE",
    );
    assert_eq!(
        row(&frame, 0),
        [
            span("A", 1, TRUECOLOR | 0x010203, 257, 0),
            span("B", 1, 200, 257, 0),
            span("C", 1, 1, 257, 0),
            span("D", 1, 9, 257, 0),
            span("E", 1, 256, 4, 0),
        ]
    );
}

#[test]
fn osc_color_overrides_are_emitted_as_truecolor() {
    let mut core = core(20, 1);
    let frame = frame(
        &mut core,
        b"\x1b]4;1;rgb:ff/00/00\x07\x1b]10;rgb:10/20/30\x07\x1b[31mA\x1b[39mB",
    );
    assert_eq!(
        row(&frame, 0),
        [
            span("A", 1, TRUECOLOR | 0xff0000, 257, 0),
            span("B", 1, TRUECOLOR | 0x102030, 257, 0),
        ]
    );
}

#[test]
fn inverse_is_flagged_without_swapping_colors() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, b"\x1b[31;7mA");
    assert_eq!(row(&frame, 0), [span("A", 1, 1, 257, 8)]);
}

#[test]
fn hyperlinks_split_spans() {
    let mut core = core(20, 1);
    let frame = frame(&mut core, b"a\x1b]8;;https://x.test\x07bc\x1b]8;;\x07d");
    let link = AgentGridSpan {
        l: Some("https://x.test".into()),
        ..plain("bc", 2)
    };
    assert_eq!(row(&frame, 0), [plain("a", 1), link, plain("d", 1)]);
}

#[test]
fn unchanged_rows_are_not_resent() {
    let mut core = core(10, 3);
    let first = frame(&mut core, b"a\r\nb");
    assert!(first.full);
    assert_eq!(first.lines.len(), 3);
    let second = frame(&mut core, b"\x1b[2;1Hc");
    assert!(!second.full);
    assert_eq!(second.lines, [(1, vec![plain("c", 1)], false)]);
    core.feed(b"\x1b[2;1Hc", Instant::now());
    assert!(core.frame().is_none());
}

#[test]
fn wrap_flag_is_sent_and_a_change_of_it_alone_is_diffed() {
    let mut core = core(4, 3);
    let first = frame(&mut core, b"abcdef");
    let wraps = |frame: &AgentGridFrame| {
        frame
            .lines
            .iter()
            .map(|(row, _, wrapped)| (*row, *wrapped))
            .collect::<Vec<_>>()
    };
    assert_eq!(wraps(&first), [(0, true), (1, false), (2, false)]);
    // Same text on row 0, but now a hard line end.
    let second = frame(&mut core, b"\x1b[1;1H\x1b[2Kabcd\r\n");
    assert_eq!(row(&second, 0), [plain("abcd", 4)]);
    assert!(wraps(&second).contains(&(0, false)));
}

#[test]
fn scrolled_content_moves_rows_and_sends_only_the_new_ones() {
    let mut core = core(10, 5);
    let lines = (0..30).map(|line| line.to_string()).collect::<Vec<_>>();
    let mut screen = Vec::new();
    paint(
        &mut screen,
        &frame(&mut core, lines.join("\r\n").as_bytes()),
    );
    let sent_rows =
        |frame: &AgentGridFrame| frame.lines.iter().map(|line| line.0).collect::<Vec<_>>();

    core.scroll(AgentGridScroll::Delta { lines: 2 });
    let back = core.frame().expect("frame");
    assert_eq!((back.shift, sent_rows(&back)), (-2, vec![0, 1]));
    paint(&mut screen, &back);
    assert_eq!(screen, repainted(&mut core));

    core.scroll(AgentGridScroll::Bottom);
    paint(&mut screen, &core.frame().expect("frame"));
    let output = frame(&mut core, b"\r\nnew");
    assert_eq!((output.shift, sent_rows(&output)), (1, vec![4]));
    paint(&mut screen, &output);
    assert_eq!(screen, repainted(&mut core));

    // Only a blank row comes in: the move alone is still a frame.
    let scrolled = frame(&mut core, b"\x1b[S");
    assert_eq!((scrolled.shift, sent_rows(&scrolled)), (1, vec![]));
    paint(&mut screen, &scrolled);
    assert_eq!(screen, repainted(&mut core));
}

#[test]
fn moved_frames_rebuild_the_screen_through_scrolls_and_rewrites() {
    let mut core = core(12, 6);
    let mut screen = Vec::new();
    paint(&mut screen, &core.frame().expect("frame"));
    let mut shifts = Vec::new();
    let steps: [&[u8]; 8] = [
        b"one\r\ntwo\r\none\r\ntwo\r\none\r\ntwo",
        b"\r\nthree\r\nfour",
        b"\x1b[3T",
        b"\x1b[2;5r\x1b[5;1H\r\nregion\x1b[r",
        b"\x1b[Htwo\r\none\r\ntwo",
        b"\x1b[2J\x1b[Hfresh",
        b"\r\n\r\n\r\n\r\n\r\n\r\n\r\nlast",
        b"\x1b[6;1H\x1b[M",
    ];
    for bytes in steps {
        core.feed(bytes, Instant::now());
        if let Some(frame) = core.frame() {
            shifts.push(frame.shift);
            paint(&mut screen, &frame);
        }
        assert_eq!(screen, repainted(&mut core), "after {bytes:?}");
    }
    for delta in [3, -1, 7, -9, 2] {
        core.scroll(AgentGridScroll::Delta { lines: delta });
        if let Some(frame) = core.frame() {
            shifts.push(frame.shift);
            paint(&mut screen, &frame);
        }
        assert_eq!(screen, repainted(&mut core), "after scroll {delta}");
    }
    assert!(shifts.iter().any(|&shift| shift > 0) && shifts.iter().any(|&shift| shift < 0));
}

#[test]
fn select_all_text_joins_wrapped_rows_trims_blanks_and_includes_history() {
    let mut core = core(4, 2);
    core.feed(
        "one \r\nabcdefg\r\n中中x\r\nlast\r\n\r\n".as_bytes(),
        Instant::now(),
    );
    assert!(core.term.history_size() > 0);
    core.select(AgentGridSelect::All);
    assert_eq!(core.selection_text(), "one\nabcdefg\n中中x\nlast");

    // A wide char wrapped to the next row leaves a spacer that must not pull in the row above.
    let mut core = self::core(3, 3);
    core.feed("X\r\nab漢".as_bytes(), Instant::now());
    let count = core.frame().expect("frame").select_count;
    core.select(AgentGridSelect::Start {
        row: 1,
        col: 0,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    core.select(AgentGridSelect::Extend {
        row: 1,
        col: 2,
        right: true,
    });
    assert_eq!(core.selection_text(), "ab");
    // Ending at the start of the next row is the same boundary.
    core.select(AgentGridSelect::Extend {
        row: 2,
        col: 0,
        right: false,
    });
    assert_eq!(core.selection_text(), "ab");
    assert_eq!(core.frame().expect("frame").select_count, count + 3);
    // Every request emits a frame, even one that changes nothing visible.
    core.select(AgentGridSelect::Clear);
    core.frame().expect("frame");
    core.select(AgentGridSelect::Clear);
    assert_eq!(core.frame().expect("frame").select_count, count + 5);

    // A redraw that wraps a wide char under a kept selection end must not pull in the row above.
    let mut core = self::core(3, 3);
    core.feed(b"X\r\nabc", Instant::now());
    core.select(AgentGridSelect::Start {
        row: 1,
        col: 0,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    core.select(AgentGridSelect::Extend {
        row: 1,
        col: 2,
        right: true,
    });
    core.feed(&redraw("X\r\nab漢"), Instant::now());
    assert_eq!(core.selection_text(), "ab");

    // Dragging over half of a wide char copies and highlights all of it.
    let mut core = self::core(4, 1);
    core.feed("漢x".as_bytes(), Instant::now());
    core.select(AgentGridSelect::Start {
        row: 0,
        col: 1,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    core.select(AgentGridSelect::Extend {
        row: 0,
        col: 1,
        right: true,
    });
    assert_eq!(core.selection_text(), "漢");
    let selection = core.frame().expect("frame").selection.expect("selection");
    assert_eq!((selection.start_col, selection.end_col), (0, 1));
    core.select(AgentGridSelect::Start {
        row: 0,
        col: 0,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    core.select(AgentGridSelect::Extend {
        row: 0,
        col: 0,
        right: true,
    });
    let selection = core.frame().expect("frame").selection.expect("selection");
    assert_eq!((selection.start_col, selection.end_col), (0, 1));

    // DCH can shift a wide char's spacer into column 0; the highlight must not widen past it.
    let mut core = self::core(4, 1);
    core.feed("漢x\r\x1b[P\x1b[C".as_bytes(), Instant::now());
    core.select(AgentGridSelect::All);
    let selection = core.frame().expect("frame").selection.expect("selection");
    assert_eq!(selection.start_col, 0);

    // Word selection on a row-start wide char copies it, not the row above's first char.
    let mut core = self::core(3, 2);
    core.feed("a 漢".as_bytes(), Instant::now());
    core.select(AgentGridSelect::Start {
        row: 1,
        col: 0,
        right: false,
        mode: AgentGridSelectMode::Word,
    });
    assert_eq!(core.selection_text(), "漢");
}

#[test]
fn selection_spans_the_scrollback_and_survives_scrolls_and_full_redraws() {
    let transcript = |lines: usize| {
        (0..lines)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\r\n")
    };
    let mut core = core(20, 5);
    core.feed(transcript(30).as_bytes(), Instant::now());
    core.scroll(AgentGridScroll::Delta { lines: 20 });
    core.select(AgentGridSelect::Start {
        row: 0,
        col: 0,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    core.scroll(AgentGridScroll::Bottom);
    core.select(AgentGridSelect::Extend {
        row: 1,
        col: 19,
        right: true,
    });
    let expected = (5..=26)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(core.selection_text(), expected);
    let selection = core.frame().expect("frame").selection.expect("selection");
    assert_eq!((selection.start_row, selection.end_row), (-20, 1));

    core.feed(&redraw(&transcript(32)), Instant::now());
    assert_eq!(core.selection_text(), expected);

    // A drag past the top edge scrolls toward the pointer by its distance.
    core.select(AgentGridSelect::Extend {
        row: -3,
        col: 0,
        right: false,
    });
    assert_eq!(core.frame().expect("frame").display_offset, 3);

    core.select(AgentGridSelect::Start {
        row: 2,
        col: 3,
        right: false,
        mode: AgentGridSelectMode::Simple,
    });
    assert_eq!(core.frame().expect("frame").selection, None);
    assert_eq!(core.selection_text(), "");
}

#[test]
fn resize_sends_every_row() {
    let mut core = core(10, 3);
    frame(&mut core, b"a");
    core.resize(12, 4);
    let frame = core.frame().expect("frame");
    assert!(frame.full);
    assert_eq!((frame.cols, frame.rows), (12, 4));
    assert_eq!(
        frame
            .lines
            .iter()
            .map(|(row, _, _)| *row)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
}

#[test]
fn replayed_queries_are_not_answered() {
    let replay = b"hello\x1b[6n";
    let theme = GridTheme::parse(&config()).unwrap();
    let mut core = GridEngineCore::new(20, 5, theme, 0, replay.len() as u64);
    core.feed(replay, Instant::now());
    assert!(core.take_replies().is_empty());
    core.feed(b"\x1b[6n", Instant::now());
    assert_eq!(core.take_replies(), b"\x1b[1;6R");

    let mut core = GridEngineCore::new(20, 5, theme, 0, replay.len() as u64);
    core.feed(&[replay.as_slice(), b"\x1b[6n"].concat(), Instant::now());
    assert_eq!(core.take_replies(), b"\x1b[1;6R");
}

#[test]
fn full_redraw_keeps_the_reading_position_anchored_from_the_top() {
    let transcript = |lines: usize| {
        (0..lines)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\r\n")
    };
    let mut core = core(20, 10);
    core.feed(transcript(300).as_bytes(), Instant::now());
    core.scroll(AgentGridScroll::Delta { lines: 200 });
    let mut screen = Vec::new();
    paint(&mut screen, &core.frame().expect("frame"));
    let before = screen.clone();
    assert_eq!(before[0], "line 90");

    let redraw = framed(
        [
            b"\x1b[2J\x1b[H\x1b[3J".as_slice(),
            transcript(350).as_bytes(),
        ]
        .concat()
        .as_slice(),
    );
    let now = Instant::now();
    for chunk in redraw.chunks(4096) {
        core.feed(chunk, now);
    }
    assert!(core.sync_deadline().is_none());
    let after = core.frame().expect("frame");
    paint(&mut screen, &after);
    assert_eq!(after.history_size, 340);
    assert_eq!(after.display_offset, 250);
    assert_eq!(screen, before);
    assert_eq!(after.cursor.shape, "hidden");
}

#[test]
fn config_requires_nineteen_hex_colors_and_positive_cells() {
    assert!(GridTheme::parse(&config()).is_ok());
    let mut short = config();
    short.palette.pop();
    assert!(GridTheme::parse(&short).is_err());
    let mut malformed = config();
    malformed.palette[3] = "#12345g".into();
    assert!(GridTheme::parse(&malformed).is_err());
    let mut empty_cell = config();
    empty_cell.cell_height = 0;
    assert!(GridTheme::parse(&empty_cell).is_err());
}

#[test]
fn offset_scroll_is_absolute_and_clamped_to_the_history() {
    let mut core = core(10, 5);
    let lines = (0..30).map(|line| line.to_string()).collect::<Vec<_>>();
    core.feed(lines.join("\r\n").as_bytes(), Instant::now());
    core.scroll(AgentGridScroll::Offset { offset: 7 });
    core.scroll(AgentGridScroll::Offset { offset: 3 });
    assert_eq!(core.frame().expect("frame").display_offset, 3);
    core.scroll(AgentGridScroll::Offset { offset: 1000 });
    assert_eq!(core.frame().expect("frame").display_offset, 25);
    core.scroll(AgentGridScroll::Offset { offset: 0 });
    assert_eq!(core.frame().expect("frame").display_offset, 0);
}

fn redraw(body: &str) -> Vec<u8> {
    framed(format!("\x1b[2J\x1b[H\x1b[3J{body}").as_bytes())
}

/// Visible rows, cursor, modes, title and history: what the webview can observe.
fn screen(core: &GridEngineCore) -> String {
    let grid = core.term.grid();
    let mut out = String::new();
    for row in 0..grid.screen_lines() {
        let line = Line(row as i32 - grid.display_offset() as i32);
        out += &format!("{:?}\n", row_spans(&grid[line][..], core.term.colors()));
    }
    let cursor = core.term.renderable_content().cursor;
    out + &format!(
        "cursor={:?} {:?} modes={} title={:?} history={}",
        cursor.point,
        cursor.shape,
        mode_bits(*core.term.mode()),
        core.current_title,
        grid.history_size()
    )
}

fn parsed(stream: &[u8], live_from: u64) -> GridEngineCore {
    let theme = GridTheme::parse(&config()).unwrap();
    let mut core = GridEngineCore::new(40, 6, theme, 0, live_from);
    for chunk in stream.chunks(7) {
        core.feed(chunk, Instant::now());
    }
    core
}

/// Bytes before `fed` and after `keyframe` go through the parser, the ones between only
/// through the skip scan.
fn skipped(stream: &[u8], fed: usize, keyframe: usize, live_from: u64) -> GridEngineCore {
    let theme = GridTheme::parse(&config()).unwrap();
    let mut core = GridEngineCore::new(40, 6, theme, 0, live_from);
    core.feed(&stream[..fed], Instant::now());
    core.skip_to(keyframe as u64, &stream[fed..keyframe], &stream[keyframe..])
        .expect("skip");
    for chunk in stream[keyframe..].chunks(7) {
        core.feed(chunk, Instant::now());
    }
    core
}

fn obsolete_then_final(obsolete: &[u8]) -> (Vec<u8>, usize) {
    let head = [
        b"\x1b[?1h\x1b[?2004h\x1b=\x1b]2;agent\x07\x1b[4 q".as_slice(),
        &redraw("old one\r\nold two"),
        obsolete,
        &redraw("\x1b[?2004lolder\r\n\x1b]8;;https://x.test\x07link"),
        b"\x1b[1;31m\x1b(0",
    ]
    .concat();
    let keyframe = head.len();
    let stream = [head, redraw("new\r\nqqq\x1b(B plain\r\n")].concat();
    (stream, keyframe)
}

#[test]
fn skipping_obsolete_redraws_ends_on_the_same_screen_as_parsing_them() {
    let (stream, keyframe) = obsolete_then_final(b"");
    let full = parsed(&stream, 0);
    let mut jumped = skipped(&stream, 0, keyframe, 0);
    assert_eq!(screen(&jumped), screen(&full));
    assert_eq!(jumped.fed(), stream.len() as u64);
    let frame = jumped.frame().expect("frame");
    assert_eq!(frame.title.as_deref(), Some("agent"));
    assert_eq!(frame.modes & (1 | 2 | 512), 1 | 512);
    assert_eq!(frame.cursor.shape, "underline");
    let rows = frame
        .lines
        .iter()
        .map(|(_, spans, _)| text(spans))
        .collect::<Vec<_>>();
    assert_eq!(rows[1], "─── plain");
    assert_eq!(row(&frame, 1)[0].fg, 1);
    assert_eq!(row(&frame, 1)[0].l.as_deref(), Some("https://x.test"));
    assert_eq!(jumped.take_stats().skipped, keyframe as u64);
}

#[test]
fn a_live_query_in_the_skipped_bytes_refuses_the_skip_and_is_answered_once() {
    let (stream, keyframe) = obsolete_then_final(b"abc\x1b[6n");
    let theme = GridTheme::parse(&config()).unwrap();
    let mut core = GridEngineCore::new(40, 6, theme, 0, 0);
    assert_eq!(
        core.skip_to(keyframe as u64, &stream[..keyframe], &stream[keyframe..]),
        Err(SkipRefusal::Query)
    );
    assert_eq!((core.fed(), core.applied()), (0, 0));
    core.feed(&stream, Instant::now());
    assert_eq!(core.take_replies(), b"\x1b[2;11R");
    assert_eq!(screen(&core), screen(&parsed(&stream, 0)));
}

#[test]
fn a_replayed_query_does_not_block_the_skip() {
    let (stream, keyframe) = obsolete_then_final(b"abc\x1b[6n");
    let mut core = skipped(&stream, 0, keyframe, keyframe as u64);
    assert!(core.take_replies().is_empty());
    assert_eq!(screen(&core), screen(&parsed(&stream, keyframe as u64)));
}

#[test]
fn skip_scans_the_frame_the_grouper_still_holds() {
    let (stream, keyframe) = obsolete_then_final(b"");
    let theme = GridTheme::parse(&config()).unwrap();
    let mut core = GridEngineCore::new(40, 6, theme, 0, 0);
    let fed = keyframe - 20;
    core.feed(&stream[..fed], Instant::now());
    assert!(core.applied() < fed as u64);
    core.skip_to(keyframe as u64, &stream[fed..keyframe], &stream[keyframe..])
        .expect("skip");
    core.feed(&stream[keyframe..], Instant::now());
    assert_eq!(screen(&core), screen(&parsed(&stream, 0)));
}

#[test]
fn a_skip_starts_only_where_the_parser_is_between_sequences() {
    let tail = redraw("x");
    for (applied, rest) in [
        (b"\x1b[3".as_slice(), b"1mred\r\n".as_slice()),
        (b"\x1b[6", b"nabc"),
        (b"\x1b]2;ti", b"tle\x07"),
    ] {
        let name = String::from_utf8_lossy(applied);
        let stream = [applied, rest, &tail].concat();
        let keyframe = applied.len() + rest.len();
        let mut core = core(40, 6);
        core.feed(applied, Instant::now());
        assert_eq!(
            core.skip_to(keyframe as u64, rest, &tail),
            Err(SkipRefusal::Boundary),
            "{name}"
        );
        core.feed(&stream[applied.len()..], Instant::now());
        let mut full = parsed(&stream, 0);
        assert_eq!(screen(&core), screen(&full), "{name}");
        assert_eq!(core.take_replies(), full.take_replies(), "{name}");
    }

    let (stream, keyframe) = obsolete_then_final(b"");
    let frame_end = memmem::find(&stream, ESU).unwrap() + ESU.len();
    let jumped = skipped(&stream, frame_end, keyframe, 0);
    assert_eq!(screen(&jumped), screen(&parsed(&stream, 0)));
}

#[test]
fn a_skip_starts_after_a_frame_followed_by_plain_sequences() {
    let before = [framed(b"\x1b[?25l"), b"\x1b[?25h".to_vec()].concat();
    let obsolete = redraw("old");
    let stream = [before.as_slice(), &obsolete, &redraw("new")].concat();
    let keyframe = before.len() + obsolete.len();
    let mut core = core(40, 6);
    core.feed(&before, Instant::now());
    // The next frame is held: the grouper releases nothing.
    core.feed(&obsolete[..10], Instant::now());
    let tail = &stream[before.len() + 10..keyframe];
    core.skip_to(keyframe as u64, tail, &stream[keyframe..])
        .expect("skip");
    core.feed(&stream[keyframe..], Instant::now());
    assert_eq!(screen(&core), screen(&parsed(&stream, 0)));
}

#[test]
fn a_redraw_that_does_not_place_the_cursor_or_repeats_refuses_the_skip() {
    let cases: [(&str, &[u8], SkipRefusal); 5] = [
        ("erase only", b"\x1b[2J\x1b[3JX", SkipRefusal::Keyframe),
        (
            "repeat",
            b"\x1b[2J\x1b[H\x1b[3J\x1b[3bX",
            SkipRefusal::Keyframe,
        ),
        (
            "scrollback erased first",
            b"\x1b[H\x1b[3J\x1b[2JX",
            SkipRefusal::Keyframe,
        ),
        (
            "line erased before",
            b"\x1b[K\x1b[2J\x1b[H\x1b[3JX",
            SkipRefusal::Keyframe,
        ),
        (
            "not drawn yet",
            b"\x1b[2J\x1b[H\x1b[3J",
            SkipRefusal::KeyframePending,
        ),
    ];
    for (name, start, refusal) in cases {
        let before = b"ab\r\ncd\x1b[31m";
        let obsolete = redraw("old\r\n\r\nline");
        let stream = [before.as_slice(), &obsolete, &framed(start)].concat();
        let keyframe = before.len() + obsolete.len();
        let mut core = core(40, 6);
        core.feed(before, Instant::now());
        let keyframe_bytes = &stream[keyframe..keyframe + BSU.len() + start.len()];
        assert_eq!(
            core.skip_to(keyframe as u64, &obsolete, keyframe_bytes),
            Err(refusal),
            "{name}"
        );
        assert_eq!(refusal.is_transient(), name == "not drawn yet", "{name}");
        core.feed(&stream[before.len()..], Instant::now());
        assert_eq!(screen(&core), screen(&parsed(&stream, 0)), "{name}");
    }
}

#[test]
fn release_held_parses_the_incomplete_frame() {
    let mut core = core(20, 2);
    core.feed(&[BSU.as_slice(), b"\x1b[2Jabc"].concat(), Instant::now());
    assert!(core.applied() < core.fed());
    core.release_held();
    assert_eq!(core.applied(), core.fed());
    assert!(core.sync_deadline().is_none());
    assert_eq!(text(row(&core.frame().expect("frame"), 0)), "abc");
}

#[test]
fn skipped_state_matches_a_full_parse() {
    let cases: [(&str, &[u8]); 5] = [
        ("mouse protocol", b"\x1b[?1000h\x1b[?1002h\x1b[?1000h"),
        ("mouse protocol reset", b"\x1b[?1002h\x1b[?1002l"),
        ("mouse encoding", b"\x1b[?1005h\x1b[?1006h\x1b[?1005h"),
        ("sgr zero with sub-parameters", b"\x1b[1m\x1b[0:4m"),
        ("title stack", b"\x1b]2;one\x07\x1b[22t\x1b]2;two\x07"),
    ];
    let before = framed(b"\x1b[?1003h\x1b[?1006h\x1b]2;zero\x07\x1b[22t");
    for (name, obsolete) in cases {
        let skipped_part = [obsolete, &redraw("old")].concat();
        let stream = [
            before.as_slice(),
            &skipped_part,
            &redraw("new\r\nqqq\x1b[23t"),
        ]
        .concat();
        let keyframe = before.len() + skipped_part.len();
        let jumped = skipped(&stream, before.len(), keyframe, 0);
        assert_eq!(screen(&jumped), screen(&parsed(&stream, 0)), "{name}");
    }
}

#[test]
fn a_wide_char_wrapped_to_the_next_row_leaves_a_blank_cell() {
    let mut core = core(3, 2);
    let frame = frame(&mut core, "\x1b[41mab漢".as_bytes());
    assert_eq!(row(&frame, 0), [span("ab ", 3, 256, 1, 0)]);
    assert_eq!(
        row(&frame, 1),
        [AgentGridSpan {
            g: true,
            ..span("漢", 2, 256, 1, 0)
        }]
    );
}

fn last_keyframe(stream: &[u8]) -> usize {
    memmem::find_iter(stream, BSU)
        .filter(|&start| {
            let end = memmem::find(&stream[start..], ESU).map_or(stream.len(), |end| start + end);
            memmem::find(&stream[start..end], b"\x1b[3J").is_some()
        })
        .last()
        .expect("keyframe")
}

#[test]
#[ignore = "needs /tmp/soreno-terminal-perf captures"]
fn skipping_real_redraws_ends_on_the_same_screen() {
    for (first, replay) in [
        ("omp-large-first", "omp-large-replay"),
        ("pi-first", "pi-replay"),
    ] {
        let [first, replay] = [first, replay]
            .map(|name| std::fs::read(format!("/tmp/soreno-terminal-perf/{name}.ansi")).unwrap());
        let stream = [first.as_slice(), &replay].concat();
        let keyframe = last_keyframe(&stream);
        // The skip refuses alternate screen switches: start after the last one.
        let fed = memmem::rfind(&stream[..keyframe], b"\x1b[?1049")
            .map_or(0, |at| at + b"\x1b[?1049h".len())
            .max(first.len() / 3);
        assert!(keyframe > fed);
        let theme = GridTheme::parse(&config()).unwrap();
        let live_from = stream.len() as u64;
        let mut full = GridEngineCore::new(120, 40, theme, 0, live_from);
        let mut jumped = GridEngineCore::new(120, 40, theme, 0, live_from);
        for chunk in stream.chunks(64 * 1024) {
            full.feed(chunk, Instant::now());
        }
        jumped.feed(&stream[..fed], Instant::now());
        let prefix = &stream[keyframe..stream.len().min(keyframe + 64 * 1024)];
        jumped
            .skip_to(keyframe as u64, &stream[fed..keyframe], prefix)
            .unwrap();
        for chunk in stream[keyframe..].chunks(64 * 1024) {
            jumped.feed(chunk, Instant::now());
        }
        assert_eq!(screen(&jumped), screen(&full));
    }
}
