import { expect, it } from "vitest";
import {
  agentGridConfigPalette,
  agentGridPalette,
  GRID_DEFAULT_BACKGROUND,
  GRID_DEFAULT_FOREGROUND,
  resolveGridColor,
} from "./agentGridPalette";
import { agentTerminalThemes } from "./agentTerminalThemes";

const dark = agentGridPalette(agentTerminalThemes.dark);
const light = agentGridPalette(agentTerminalThemes.light);

it("derives the xterm 6×6×6 cube and gray ramp", () => {
  expect(resolveGridColor(dark, 16)).toBe("#000000");
  expect(resolveGridColor(dark, 17)).toBe("#00005f");
  expect(resolveGridColor(dark, 196)).toBe("#ff0000");
  expect(resolveGridColor(dark, 231)).toBe("#ffffff");
  expect(resolveGridColor(dark, 232)).toBe("#080808");
  expect(resolveGridColor(dark, 255)).toBe("#eeeeee");
});

it("decodes truecolor codes", () => {
  expect(resolveGridColor(dark, 0x1000000 | 0x0a0b0c)).toBe("#0a0b0c");
  expect(resolveGridColor(dark, 0x1000000)).toBe("#000000");
});

it("uses theme colors and falls back to the Tango ANSI defaults", () => {
  expect(resolveGridColor(dark, 1)).toBe("#cc0000");
  expect(resolveGridColor(light, 1)).toBe("#c24135");
  expect(resolveGridColor(dark, GRID_DEFAULT_FOREGROUND)).toBe("#d7dae0");
  expect(resolveGridColor(dark, GRID_DEFAULT_BACKGROUND)).toBe("#282c34");
  expect(resolveGridColor(light, GRID_DEFAULT_BACKGROUND)).toBe("#ffffff");
  expect(agentGridPalette({}).cursor).toBe("#ffffff");
});

it("sends ANSI, foreground, background and cursor to the backend", () => {
  const palette = agentGridConfigPalette(light);
  expect(palette).toHaveLength(19);
  expect(palette.slice(0, 2)).toEqual(["#363832", "#c24135"]);
  expect(palette[15]).toBe("#ffffff");
  expect(palette.slice(16)).toEqual(["#363832", "#ffffff", "#363832"]);
  expect(palette.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
});
