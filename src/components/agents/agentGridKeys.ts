export const GridMode = {
  appCursor: 1,
  bracketedPaste: 2,
  mouseClick: 4,
  mouseDrag: 8,
  mouseMotion: 16,
  sgrMouse: 32,
  altScreen: 64,
  alternateScroll: 128,
  focusInOut: 256,
  appKeypad: 512,
  utf8Mouse: 1024,
} as const;

export const GRID_MOUSE_MODES =
  GridMode.mouseClick | GridMode.mouseDrag | GridMode.mouseMotion;

export type GridKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

const CURSOR_KEYS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
const TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
const SS3_FUNCTION_KEYS: Record<string, string> = {
  F1: "P",
  F2: "Q",
  F3: "R",
  F4: "S",
};
// Ctrl with these keys yields the C0 control of the same position as xterm.
const CTRL_SYMBOLS: Record<string, string> = {
  " ": "\x00",
  "@": "\x00",
  "2": "\x00",
  "[": "\x1b",
  "3": "\x1b",
  "\\": "\x1c",
  "4": "\x1c",
  "]": "\x1d",
  "5": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  _: "\x1f",
  "-": "\x1f",
  "7": "\x1f",
  "/": "\x1f",
  "8": "\x7f",
  "?": "\x7f",
};
// macOS text editing (Terminal, iTerm2, VS Code) as readline controls; Delete is fn+Backspace.
const MAC_COMMAND_KEYS: Record<string, string> = {
  ArrowLeft: "\x01",
  ArrowRight: "\x05",
  Backspace: "\x15",
  Delete: "\x0b",
};
const MAC_OPTION_KEYS: Record<string, string> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
  Delete: "\x1bd",
};

/**
 * Encodes a key press the terminal must receive as a control sequence;
 * `null` leaves printable text to the textarea `input` event (IME, dead keys, AltGr, macOS Option).
 */
export function encodeGridKey(
  event: GridKeyEvent,
  modes: number,
  platform: string,
): string | null {
  const { key, ctrlKey: ctrl, shiftKey: shift, metaKey: meta } = event;
  // macOS Option composes characters; it is never Meta here.
  const alt = event.altKey && platform !== "darwin";
  if (platform === "darwin" && !ctrl && !shift && meta !== event.altKey) {
    const mac = (meta ? MAC_COMMAND_KEYS : MAC_OPTION_KEYS)[key];
    if (mac) return mac;
  }
  if (meta) return null;
  const modifier =
    1 + (shift ? 1 : 0) + (event.altKey ? 2 : 0) + (ctrl ? 4 : 0);
  const escape = alt ? "\x1b" : "";

  const cursor = CURSOR_KEYS[key];
  if (cursor) {
    if (modifier > 1) return `\x1b[1;${modifier}${cursor}`;
    return `${modes & GridMode.appCursor ? "\x1bO" : "\x1b["}${cursor}`;
  }
  // Shift+Insert / Ctrl+Insert are the native paste / copy shortcuts.
  if (key === "Insert" && (shift || ctrl)) return null;
  // Same as Ctrl+Backspace below: readline and agent CLIs know ESC d, not CSI 3;5~.
  if (key === "Delete" && ctrl && !shift && platform === "windows")
    return "\x1bd";
  const tilde = TILDE_KEYS[key];
  if (tilde)
    return modifier > 1 ? `\x1b[${tilde};${modifier}~` : `\x1b[${tilde}~`;
  const ss3 = SS3_FUNCTION_KEYS[key];
  if (ss3) return modifier > 1 ? `\x1b[1;${modifier}${ss3}` : `\x1bO${ss3}`;

  switch (key) {
    case "Enter":
      if (shift && !ctrl && !event.altKey) return "\x1b[13;2u";
      return `${escape}\r`;
    case "Tab":
      if (ctrl) return null;
      return shift ? "\x1b[Z" : `${escape}\t`;
    case "Escape":
      return `${escape}\x1b`;
    case "Backspace":
      // ConPTY turns ^H into Ctrl+H; Windows users expect Ctrl+Backspace to kill a word.
      if (ctrl && platform === "windows") return "\x1b\x7f";
      // Option+Backspace composes nothing: it is the macOS word delete.
      return `${event.altKey ? "\x1b" : ""}${ctrl ? "\x08" : "\x7f"}`;
  }
  if ([...key].length !== 1) return null;

  if (ctrl) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z")
      return `${escape}${String.fromCharCode(lower.charCodeAt(0) - 96)}`;
    // Ctrl+Alt on anything else is AltGr on Windows/Linux layouts: let it type.
    if (alt) return null;
    // Non-Latin layouts: fall back to the physical key.
    if (event.code.startsWith("Key") && key > "\x7e")
      return String.fromCharCode(event.code.charCodeAt(3) - 64);
    return CTRL_SYMBOLS[key] ?? null;
  }
  return alt ? `\x1b${key}` : null;
}

/** Pasted text as xterm sends it: CR line endings, optionally bracketed. */
export function encodeGridPaste(text: string, modes: number) {
  const normalized = text.replace(/\r?\n/g, "\r");
  if (!(modes & GridMode.bracketedPaste)) return normalized;
  // Neutralise every ESC like xterm so pasted text can never leave the bracket.
  const safe = normalized.replace(/\x1b/g, "\u241b");
  return `\x1b[200~${safe}\x1b[201~`;
}

export type GridMouseEvent = {
  // 0 left, 1 middle, 2 right, 64 wheel up, 65 wheel down, null for motion without button.
  button: number | null;
  action: "press" | "release" | "move";
  col: number;
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
};

/** Whether the application asked for this mouse event, per DEC 1000/1002/1003. */
function gridMouseWanted(event: GridMouseEvent, modes: number) {
  if (event.action !== "move") return (modes & GRID_MOUSE_MODES) !== 0;
  if (modes & GridMode.mouseMotion) return true;
  return event.button !== null && (modes & GridMode.mouseDrag) !== 0;
}

export function encodeGridMouse(
  event: GridMouseEvent,
  modes: number,
): string | null {
  if (!gridMouseWanted(event, modes)) return null;
  const sgr = (modes & GridMode.sgrMouse) !== 0;
  let code = event.button ?? 3;
  if (event.action === "release" && !sgr) code = 3;
  if (event.action === "move") code += 32;
  if (event.shift) code += 4;
  if (event.alt) code += 8;
  if (event.ctrl) code += 16;
  const col = event.col + 1;
  const row = event.row + 1;
  if (sgr)
    return `\x1b[<${code};${col};${row}${event.action === "release" ? "m" : "M"}`;
  // Strings are sent UTF-8 encoded, so X10 bytes above 127 only survive as DEC 1005 characters.
  const limit = modes & GridMode.utf8Mouse ? 2047 : 127;
  if (code + 32 > limit || col + 32 > limit || row + 32 > limit) return null;
  return `\x1b[M${String.fromCharCode(code + 32, col + 32, row + 32)}`;
}
