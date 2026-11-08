use crate::AgentGridConfig;
use alacritty_terminal::vte::ansi::Rgb;

pub(crate) const PALETTE_LEN: usize = 19;

/// Validated `AgentGridConfig`: colors answer OSC 4/10/11/12 queries, cells CSI 14/16 t.
#[derive(Debug, Clone, Copy)]
pub struct GridTheme {
    palette: [Rgb; PALETTE_LEN],
    pub(crate) cell_width: u16,
    pub(crate) cell_height: u16,
}

impl GridTheme {
    pub fn parse(config: &AgentGridConfig) -> Result<Self, String> {
        if config.cell_width == 0 || config.cell_height == 0 {
            return Err("Taille de cellule du terminal invalide.".into());
        }
        let colors = config
            .palette
            .iter()
            .map(|color| hex_color(color))
            .collect::<Option<Vec<_>>>()
            .filter(|colors| colors.len() == PALETTE_LEN)
            .ok_or("Palette du terminal invalide : 19 couleurs #rrggbb attendues.")?;
        let mut palette = [Rgb::default(); PALETTE_LEN];
        palette.copy_from_slice(&colors);
        Ok(Self {
            palette,
            cell_width: config.cell_width,
            cell_height: config.cell_height,
        })
    }
    pub(crate) fn color(&self, index: usize) -> Rgb {
        let dim = |rgb: Rgb| Rgb {
            r: (rgb.r as u16 * 2 / 3) as u8,
            g: (rgb.g as u16 * 2 / 3) as u8,
            b: (rgb.b as u16 * 2 / 3) as u8,
        };
        match index {
            0..=15 => self.palette[index],
            16..=231 => {
                let level = |value: usize| [0, 95, 135, 175, 215, 255][value];
                let cube = index - 16;
                Rgb {
                    r: level(cube / 36),
                    g: level(cube / 6 % 6),
                    b: level(cube % 6),
                }
            }
            232..=255 => {
                let gray = (8 + 10 * (index - 232)) as u8;
                Rgb {
                    r: gray,
                    g: gray,
                    b: gray,
                }
            }
            257 => self.palette[17],
            258 => self.palette[18],
            259..=266 => dim(self.palette[index - 259]),
            268 => dim(self.palette[16]),
            _ => self.palette[16],
        }
    }
}

fn hex_color(color: &str) -> Option<Rgb> {
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some(Rgb {
        r: (value >> 16) as u8,
        g: (value >> 8) as u8,
        b: value as u8,
    })
}
