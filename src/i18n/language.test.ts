import { describe, expect, it } from "vitest";
import { resolveAppLanguage, resolveSystemLanguage } from "./language";
import { translations } from "./translations";

describe("resolveSystemLanguage", () => {
  it("uses a supported system language", () => {
    expect(resolveSystemLanguage("en-US")).toBe("en");
    expect(resolveSystemLanguage("fr-FR")).toBe("fr");
  });

  it("falls back to French for unsupported system languages", () => {
    expect(resolveSystemLanguage("de-DE")).toBe("fr");
    expect(resolveSystemLanguage(undefined)).toBe("fr");
  });
});

describe("resolveAppLanguage", () => {
  it("uses the explicit language preference first", () => {
    expect(resolveAppLanguage("en", "fr-FR")).toBe("en");
  });

  it("uses the system language for the system preference", () => {
    expect(resolveAppLanguage("system", "en-GB")).toBe("en");
  });
});

describe("translations", () => {
  it("keeps English and French dictionaries aligned", () => {
    const frenchKeys = Object.keys(translations.fr).sort();
    const englishKeys = Object.keys(translations.en).sort();

    expect(englishKeys).toEqual(frenchKeys);
  });
});
