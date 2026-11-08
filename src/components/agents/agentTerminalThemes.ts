import type { AppTheme } from "../../domain/theme";
import type { AgentTerminalTheme } from "./agentGridPalette";

// background/foreground mirror --terminal-bg/--terminal-text in App.css.
export const agentTerminalThemes: Record<AppTheme, AgentTerminalTheme> = {
  dark: {
    background: "#282c34",
    foreground: "#d7dae0",
    cursor: "#d7dae0",
  },
  light: {
    background: "#ffffff",
    foreground: "#363832",
    cursor: "#363832",
    black: "#363832",
    red: "#c24135",
    green: "#3d7a37",
    yellow: "#98680a",
    blue: "#2f5ec4",
    magenta: "#8b3fa8",
    cyan: "#16758a",
    white: "#d9d8d3",
    brightBlack: "#777f8e",
    brightRed: "#d4574b",
    brightGreen: "#4a8f43",
    brightYellow: "#b07c12",
    brightBlue: "#4273d8",
    brightMagenta: "#a24fc1",
    brightCyan: "#1f8aa1",
    brightWhite: "#ffffff",
  },
};
