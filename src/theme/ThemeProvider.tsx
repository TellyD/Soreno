import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  resolveAppTheme,
  type AppTheme,
  type ThemePreference,
} from "../domain/theme";
import { useAppSettings } from "../settings";

type ThemeContextValue = {
  setThemePreference: (preference: ThemePreference) => Promise<void>;
  terminalTheme: AppTheme;
  theme: AppTheme;
  themePreference: ThemePreference;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeMediaQuery = "(prefers-color-scheme: dark)";

type ThemeProviderProps = {
  children: ReactNode;
};

function readSystemPrefersDark(): boolean {
  return window.matchMedia?.(themeMediaQuery).matches ?? false;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const { settings, updateSettings } = useAppSettings();
  const themePreference = settings.themePreference;
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    readSystemPrefersDark,
  );
  const theme = resolveAppTheme(themePreference, systemPrefersDark);
  const terminalTheme =
    settings.terminalThemePreference === "app"
      ? theme
      : settings.terminalThemePreference;

  useEffect(() => {
    const mediaQueryList = window.matchMedia?.(themeMediaQuery);

    if (!mediaQueryList) {
      return;
    }

    function handleThemeChange(event: MediaQueryListEvent) {
      setSystemPrefersDark(event.matches);
    }

    mediaQueryList.addEventListener("change", handleThemeChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleThemeChange);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // The native macOS title follows the window appearance, not the webview CSS.
  useEffect(() => {
    if (isTauri()) {
      void getCurrentWindow().setTheme(
        themePreference === "system" ? null : themePreference,
      );
    }
  }, [themePreference]);

  useEffect(() => {
    document.documentElement.dataset.terminalTheme = terminalTheme;
  }, [terminalTheme]);

  const setThemePreference = useCallback(
    async (preference: ThemePreference) => {
      await updateSettings({
        themePreference: preference,
      });
    },
    [updateSettings],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      setThemePreference,
      terminalTheme,
      theme,
      themePreference,
    }),
    [setThemePreference, terminalTheme, theme, themePreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
