export const GRID_DEFAULT_FOREGROUND = 256;
export const GRID_DEFAULT_BACKGROUND = 257;
const TRUECOLOR = 0x1000000;

// Tango defaults, which the dark theme relies on.
const TANGO_ANSI = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type AgentTerminalTheme = Partial<
  Record<
    "background" | "foreground" | "cursor" | (typeof ANSI_KEYS)[number],
    string
  >
>;
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

export type AgentGridPalette = {
  // 256 indexed colors.
  indexed: string[];
  foreground: string;
  background: string;
  cursor: string;
};

function hex(value: number) {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function themeColor(value: string | undefined, fallback: string) {
  return value && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

export function agentGridPalette(theme: AgentTerminalTheme): AgentGridPalette {
  const indexed = ANSI_KEYS.map((key, index) =>
    themeColor(theme[key], TANGO_ANSI[index]),
  );
  for (let index = 16; index < 232; index++) {
    const cube = index - 16;
    const r = CUBE_LEVELS[Math.floor(cube / 36)];
    const g = CUBE_LEVELS[Math.floor(cube / 6) % 6];
    indexed.push(hex((r << 16) | (g << 8) | CUBE_LEVELS[cube % 6]));
  }
  for (let index = 0; index < 24; index++)
    indexed.push(hex((8 + 10 * index) * 0x010101));
  const foreground = themeColor(theme.foreground, "#ffffff");
  return {
    indexed,
    foreground,
    background: themeColor(theme.background, "#000000"),
    cursor: themeColor(theme.cursor, foreground),
  };
}

export function resolveGridColor(palette: AgentGridPalette, code: number) {
  if (code >= TRUECOLOR) return hex(code & 0xffffff);
  if (code === GRID_DEFAULT_BACKGROUND) return palette.background;
  return palette.indexed[code] ?? palette.foreground;
}

/** The 19 entries the backend answers OSC 4/10/11/12 queries with. */
export function agentGridConfigPalette(palette: AgentGridPalette) {
  return [
    ...palette.indexed.slice(0, 16),
    palette.foreground,
    palette.background,
    palette.cursor,
  ];
}
