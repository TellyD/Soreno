import { describe, expect, it } from "vitest";
import { isThemePreference, resolveAppTheme } from "./theme";

describe("isThemePreference", () => {
  it("accepts stored theme names and rejects anything else", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference("Dark")).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe("resolveAppTheme", () => {
  it("uses the system dark preference when automatic", () => {
    expect(resolveAppTheme("system", true)).toBe("dark");
  });

  it("uses the system light preference when automatic", () => {
    expect(resolveAppTheme("system", false)).toBe("light");
    expect(resolveAppTheme("system", undefined)).toBe("light");
  });

  it("uses explicit theme preferences before the system preference", () => {
    expect(resolveAppTheme("light", true)).toBe("light");
    expect(resolveAppTheme("dark", false)).toBe("dark");
  });
});
