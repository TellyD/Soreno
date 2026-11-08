use crate::AgentGridSpan;
use alacritty_terminal::{
    term::{
        cell::{Cell, Flags},
        color::Colors,
        TermMode,
    },
    vte::ansi::{Color, NamedColor, Rgb},
};

pub(crate) const DEFAULT_FOREGROUND: u32 = 256;
pub(crate) const DEFAULT_BACKGROUND: u32 = 257;
pub(crate) const TRUECOLOR: u32 = 0x100_0000;

pub(crate) fn mode_bits(mode: TermMode) -> u32 {
    [
        (TermMode::APP_CURSOR, 1),
        (TermMode::BRACKETED_PASTE, 2),
        (TermMode::MOUSE_REPORT_CLICK, 4),
        (TermMode::MOUSE_DRAG, 8),
        (TermMode::MOUSE_MOTION, 16),
        (TermMode::SGR_MOUSE, 32),
        (TermMode::ALT_SCREEN, 64),
        (TermMode::ALTERNATE_SCROLL, 128),
        (TermMode::FOCUS_IN_OUT, 256),
        (TermMode::APP_KEYPAD, 512),
        (TermMode::UTF8_MOUSE, 1024),
    ]
    .into_iter()
    .filter(|(flag, _)| mode.contains(*flag))
    .fold(0, |bits, (_, bit)| bits | bit)
}

fn flag_bits(flags: Flags) -> u32 {
    [
        (Flags::BOLD, 1),
        (Flags::ITALIC, 2),
        (Flags::ALL_UNDERLINES, 4),
        (Flags::INVERSE, 8),
        (Flags::DIM, 16),
        (Flags::STRIKEOUT, 32),
        (Flags::HIDDEN, 64),
    ]
    .into_iter()
    .filter(|(flag, _)| flags.intersects(*flag))
    .fold(0, |bits, (_, bit)| bits | bit)
}

fn truecolor(rgb: Rgb) -> u32 {
    TRUECOLOR | ((rgb.r as u32) << 16) | ((rgb.g as u32) << 8) | rgb.b as u32
}

pub(crate) fn color_code(color: Color, colors: &Colors) -> u32 {
    let code = match color {
        Color::Spec(rgb) => return truecolor(rgb),
        Color::Indexed(index) => index as u32,
        Color::Named(named) => match named {
            NamedColor::Foreground
            | NamedColor::BrightForeground
            | NamedColor::DimForeground
            | NamedColor::Cursor => DEFAULT_FOREGROUND,
            NamedColor::Background => DEFAULT_BACKGROUND,
            NamedColor::DimBlack => 0,
            NamedColor::DimRed => 1,
            NamedColor::DimGreen => 2,
            NamedColor::DimYellow => 3,
            NamedColor::DimBlue => 4,
            NamedColor::DimMagenta => 5,
            NamedColor::DimCyan => 6,
            NamedColor::DimWhite => 7,
            base => base as u32,
        },
    };
    colors[code as usize].map_or(code, truecolor)
}

fn cell_text(cell: &Cell) -> char {
    if cell.c == '\t' {
        ' '
    } else {
        cell.c
    }
}

/// Only raw default-background cells trim: an OSC 11 override keeps its blanks unpainted.
fn is_trailing_blank(cell: &Cell) -> bool {
    cell_text(cell) == ' '
        && cell.bg == Color::Named(NamedColor::Background)
        && cell.zerowidth().is_none_or(<[char]>::is_empty)
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        && cell.hyperlink().is_none()
}

/// Spans of one row: runs of single-width BMP characters merge (one UTF-16 unit per cell);
/// wide chars, surrogate pairs and cells with combining marks are their own `g` span. Blanks
/// show no foreground, so they join a run of another foreground (syntax-highlighted code).
pub(crate) fn row_spans(cells: &[Cell], colors: &Colors) -> Vec<AgentGridSpan> {
    let end = cells
        .iter()
        .rposition(|cell| !is_trailing_blank(cell))
        .map_or(0, |index| index + 1);
    let mut spans: Vec<AgentGridSpan> = Vec::new();
    // The last span holds only blanks.
    let mut blank_run = false;
    for cell in &cells[..end] {
        // A leading spacer is a real blank cell left where a wide char wrapped.
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let character = cell_text(cell);
        let zerowidth = cell.zerowidth().filter(|chars| !chars.is_empty());
        let wide = cell.flags.contains(Flags::WIDE_CHAR);
        let single =
            zerowidth.is_none() && !wide && (character as u32) <= 0xFFFF && !character.is_control();
        let fg = color_code(cell.fg, colors);
        let bg = color_code(cell.bg, colors);
        let f = flag_bits(cell.flags);
        let l = cell.hyperlink().map(|link| link.uri().to_owned());
        let blank = single && character == ' ';
        if single {
            if let Some(last) = spans.last_mut().filter(|last| !last.g) {
                if last.bg == bg && last.f == f && last.l == l {
                    // Inverse, underline and strikeout paint blanks with the foreground.
                    let colorless = !cell
                        .flags
                        .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
                    if last.fg == fg || (colorless && blank) {
                        last.t.push(character);
                        last.c += 1;
                        blank_run &= blank;
                        continue;
                    }
                    if colorless && blank_run {
                        last.fg = fg;
                        last.t.push(character);
                        last.c += 1;
                        blank_run = false;
                        continue;
                    }
                }
            }
        }
        let mut t = String::from(character);
        t.extend(zerowidth.into_iter().flatten());
        spans.push(AgentGridSpan {
            t,
            c: if wide { 2 } else { 1 },
            fg,
            bg,
            f,
            l,
            g: !single,
        });
        blank_run = blank;
    }
    spans
}
