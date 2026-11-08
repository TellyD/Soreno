import { describe, expect, it } from "vitest";
import { formatCodexError } from "./codexErrors";
import { translations } from "./translations";

describe("Codex errors", () => {
  it.each([
    ["en", "message en français"],
    ["fr", "English backend message"],
  ] as const)(
    "localizes unknown %s errors instead of exposing them",
    (language, raw) => {
      const t = (key: keyof typeof translations.fr) =>
        translations[language][key];

      for (const error of [
        new Error(raw),
        raw,
        `{"error":{"message":"${raw}"}}`,
      ]) {
        expect(formatCodexError(error, t, "settings.codex.updateError")).toBe(
          t("settings.codex.updateError"),
        );
      }
    },
  );

  it("explains recognized update failures", () => {
    const t = (key: keyof typeof translations.fr) => translations.fr[key];
    expect(
      formatCodexError(
        "CODEX_UPDATE_UNSUPPORTED",
        t,
        "settings.codex.updateError",
      ),
    ).toBe(t("settings.codex.updateUnsupported"));
    expect(
      formatCodexError("CODEX_UPDATE_ACTIVE", t, "settings.codex.updateError"),
    ).toBe(t("settings.codex.updateActive"));
    expect(
      formatCodexError(
        "CODEX_UPDATE_FAILED: permission denied",
        t,
        "settings.codex.updateError",
      ),
    ).toBe(t("settings.codex.updateError"));
  });
});
