import { expect, it } from "vitest";
import {
  encodeGridKey,
  encodeGridMouse,
  encodeGridPaste,
  GridMode,
  type GridKeyEvent,
  type GridMouseEvent,
} from "./agentGridKeys";

function key(
  value: string,
  modifiers: Partial<Omit<GridKeyEvent, "key">> = {},
  { modes = 0, platform = "linux" } = {},
) {
  return encodeGridKey(
    {
      key: value,
      code: "",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...modifiers,
    },
    modes,
    platform,
  );
}

it("sends cursor keys in normal or application mode, with xterm modifier parameters", () => {
  expect(key("ArrowUp")).toBe("\x1b[A");
  expect(key("ArrowLeft", {}, { modes: GridMode.appCursor })).toBe("\x1bOD");
  expect(key("ArrowUp", { ctrlKey: true })).toBe("\x1b[1;5A");
  expect(
    key("ArrowRight", { shiftKey: true }, { modes: GridMode.appCursor }),
  ).toBe("\x1b[1;2C");
  expect(key("ArrowDown", { altKey: true, ctrlKey: true })).toBe("\x1b[1;7B");
  expect(key("Home")).toBe("\x1b[H");
  expect(key("End", {}, { modes: GridMode.appCursor })).toBe("\x1bOF");
  expect(key("End", { shiftKey: true })).toBe("\x1b[1;2F");
  const mac = { platform: "darwin" };
  expect(key("ArrowLeft", { metaKey: true }, mac)).toBe("\x01");
  expect(key("ArrowRight", { metaKey: true }, mac)).toBe("\x05");
  expect(key("ArrowLeft", { altKey: true }, mac)).toBe("\x1bb");
  expect(key("ArrowRight", { altKey: true }, mac)).toBe("\x1bf");
  expect(key("ArrowLeft", { altKey: true })).toBe("\x1b[1;3D");
  expect(key("ArrowLeft", { metaKey: true, shiftKey: true }, mac)).toBeNull();
});

it("sends editing and function keys in their tilde or SS3 forms", () => {
  expect(key("PageUp")).toBe("\x1b[5~");
  expect(key("PageDown", { ctrlKey: true })).toBe("\x1b[6;5~");
  expect(key("Delete")).toBe("\x1b[3~");
  expect(key("Insert")).toBe("\x1b[2~");
  expect(key("Insert", { altKey: true })).toBe("\x1b[2;3~");
  expect(key("F1")).toBe("\x1bOP");
  expect(key("F4", { shiftKey: true })).toBe("\x1b[1;2S");
  expect(key("F5")).toBe("\x1b[15~");
  expect(key("F12", { ctrlKey: true })).toBe("\x1b[24;5~");
  expect(
    ["F6", "F7", "F8", "F9", "F10", "F11"].map((name) => key(name)),
  ).toEqual([
    "\x1b[17~",
    "\x1b[18~",
    "\x1b[19~",
    "\x1b[20~",
    "\x1b[21~",
    "\x1b[23~",
  ]);
});

it("leaves Shift+Insert and Ctrl+Insert to the native paste and copy", () => {
  expect(key("Insert", { shiftKey: true })).toBeNull();
  expect(key("Insert", { ctrlKey: true })).toBeNull();
  expect(key("Insert", { ctrlKey: true, shiftKey: true })).toBeNull();
});

it("maps Ctrl combinations to C0 controls and leaves AltGr text to the input event", () => {
  expect(key("c", { ctrlKey: true })).toBe("\x03");
  expect(key("A", { ctrlKey: true, shiftKey: true })).toBe("\x01");
  expect(key(" ", { ctrlKey: true })).toBe("\x00");
  expect(key("[", { ctrlKey: true })).toBe("\x1b");
  expect(key("\\", { ctrlKey: true })).toBe("\x1c");
  expect(key("]", { ctrlKey: true })).toBe("\x1d");
  expect(key("^", { ctrlKey: true, shiftKey: true })).toBe("\x1e");
  expect(key("_", { ctrlKey: true, shiftKey: true })).toBe("\x1f");
  // Cyrillic layout: the physical key decides.
  expect(key("с", { ctrlKey: true, code: "KeyC" })).toBe("\x03");
  expect(key("x", { ctrlKey: true, altKey: true })).toBe("\x1b\x18");
  expect(key("@", { ctrlKey: true, altKey: true })).toBeNull();
});

it("prefixes Alt with ESC except for macOS Option, which composes text", () => {
  expect(key("b", { altKey: true })).toBe("\x1bb");
  expect(key("b", { altKey: true }, { platform: "darwin" })).toBeNull();
  expect(key("a")).toBeNull();
  expect(key("v", { metaKey: true }, { platform: "darwin" })).toBeNull();
});

it("distinguishes Backspace, Tab and Enter variants", () => {
  expect(key("Backspace")).toBe("\x7f");
  expect(key("Backspace", { ctrlKey: true })).toBe("\x08");
  expect(key("Backspace", { ctrlKey: true }, { platform: "windows" })).toBe(
    "\x1b\x7f",
  );
  expect(key("Backspace", { altKey: true })).toBe("\x1b\x7f");
  expect(key("Backspace", { altKey: true }, { platform: "darwin" })).toBe(
    "\x1b\x7f",
  );
  expect(key("Backspace", { metaKey: true }, { platform: "darwin" })).toBe(
    "\x15",
  );
  expect(key("Delete", { metaKey: true }, { platform: "darwin" })).toBe("\x0b");
  expect(key("Delete", { altKey: true }, { platform: "darwin" })).toBe("\x1bd");
  expect(key("Delete", { ctrlKey: true })).toBe("\x1b[3;5~");
  expect(key("Delete", { ctrlKey: true }, { platform: "windows" })).toBe(
    "\x1bd",
  );
  expect(key("Tab")).toBe("\t");
  expect(key("Tab", { shiftKey: true })).toBe("\x1b[Z");
  expect(key("Enter")).toBe("\r");
  expect(key("Enter", { shiftKey: true })).toBe("\x1b[13;2u");
  expect(key("Enter", { altKey: true })).toBe("\x1b\r");
  expect(key("Escape")).toBe("\x1b");
});

it("normalises pasted newlines and brackets them only when the application asked", () => {
  expect(encodeGridPaste("a\r\nb\nc", 0)).toBe("a\rb\rc");
  expect(encodeGridPaste("a\nb", GridMode.bracketedPaste)).toBe(
    "\x1b[200~a\rb\x1b[201~",
  );
  expect(encodeGridPaste("x\x1b[201~rm -rf\n", GridMode.bracketedPaste)).toBe(
    "\x1b[200~x\u241b[201~rm -rf\r\x1b[201~",
  );
  // A marker split by another marker must not reassemble into a real one.
  const nested = encodeGridPaste(
    "\x1b[20\x1b[201~1~echo injected\n",
    GridMode.bracketedPaste,
  );
  expect(nested).toBe(
    "\x1b[200~\u241b[20\u241b[201~1~echo injected\r\x1b[201~",
  );
  expect(nested.slice(0, -6)).not.toContain("\x1b[201~");
});

function mouse(
  event: Partial<GridMouseEvent>,
  modes = GridMode.mouseClick | GridMode.sgrMouse,
) {
  return encodeGridMouse(
    {
      button: 0,
      action: "press",
      col: 0,
      row: 0,
      shift: false,
      alt: false,
      ctrl: false,
      ...event,
    },
    modes,
  );
}

it("encodes SGR mouse presses, releases, wheel and modifiers", () => {
  expect(mouse({ col: 9, row: 4 })).toBe("\x1b[<0;10;5M");
  expect(mouse({ button: 2, action: "release", col: 9, row: 4 })).toBe(
    "\x1b[<2;10;5m",
  );
  expect(mouse({ button: 64 })).toBe("\x1b[<64;1;1M");
  expect(mouse({ button: 65, ctrl: true })).toBe("\x1b[<81;1;1M");
  expect(mouse({ col: 300, row: 200 })).toBe("\x1b[<0;301;201M");
});

it("encodes X10 mouse reports with a generic release and drops unencodable cells", () => {
  const x10 = GridMode.mouseClick;
  expect(mouse({ col: 0, row: 0 }, x10)).toBe("\x1b[M\x20\x21\x21");
  expect(mouse({ button: 1, action: "release", col: 2, row: 3 }, x10)).toBe(
    "\x1b[M\x23\x23\x24",
  );
  expect(mouse({ button: 65 }, x10)).toBe("\x1b[M\x61\x21\x21");
  expect(mouse({ col: 200 }, x10)).toBeNull();
  expect(mouse({ col: 200 }, x10 | GridMode.utf8Mouse)).toBe(
    `\x1b[M\x20${String.fromCharCode(233)}\x21`,
  );
});

it("reports motion only in the tracking modes that asked for it", () => {
  const move = { action: "move" as const, col: 1, row: 1 };
  expect(mouse(move)).toBeNull();
  expect(mouse(move, GridMode.mouseDrag | GridMode.sgrMouse)).toBe(
    "\x1b[<32;2;2M",
  );
  expect(
    mouse({ ...move, button: null }, GridMode.mouseDrag | GridMode.sgrMouse),
  ).toBeNull();
  expect(
    mouse({ ...move, button: null }, GridMode.mouseMotion | GridMode.sgrMouse),
  ).toBe("\x1b[<35;2;2M");
  expect(mouse({}, 0)).toBeNull();
});
