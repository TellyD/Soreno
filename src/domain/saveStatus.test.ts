import { describe, expect, it } from "vitest";
import {
  formatSaveStateText,
  selectStatusBarSaveStateText,
  type SaveStatusLabels,
} from "./saveStatus";

const labels: SaveStatusLabels = {
  error: "Erreur",
  saved: "Enregistré",
  savedAtDate: (date) => `Enregistré le ${date}`,
  savedAtTime: (time) => `Enregistré à ${time}`,
  saving: "Sauvegarde...",
};

describe("formatSaveStateText", () => {
  it("keeps the ready fallback available for idle state", () => {
    expect(
      formatSaveStateText(
        "idle",
        null,
        "fr-FR",
        labels,
        new Date("2026-06-30T12:00:00"),
      ),
    ).toBe("");
  });

  it("formats an in-progress save", () => {
    expect(
      formatSaveStateText(
        "saving",
        null,
        "fr-FR",
        labels,
        new Date("2026-06-30T12:00:00"),
      ),
    ).toBe("Sauvegarde...");
  });

  it("formats a same-day save with the local time", () => {
    expect(
      formatSaveStateText(
        "saved",
        "2026-06-30T09:30:00",
        "fr-FR",
        labels,
        new Date("2026-06-30T12:00:00"),
      ),
    ).toBe("Enregistré à 09:30");
  });

  it("formats an older save with the local date", () => {
    expect(
      formatSaveStateText(
        "saved",
        "2026-06-29T09:30:00",
        "fr-FR",
        labels,
        new Date("2026-06-30T12:00:00"),
      ),
    ).toBe("Enregistré le 29/06/2026 09:30");
  });
});

describe("selectStatusBarSaveStateText", () => {
  it("returns an empty value when every status is idle", () => {
    expect(
      selectStatusBarSaveStateText([
        { lastSavedAt: null, saveState: "idle", saveStateText: "" },
      ]),
    ).toBe("");
  });

  it("shows saving before saved statuses", () => {
    expect(
      selectStatusBarSaveStateText([
        {
          lastSavedAt: "2026-06-30T09:00:00",
          saveState: "saved",
          saveStateText: "Enregistré à 09:00",
        },
        {
          lastSavedAt: null,
          saveState: "saving",
          saveStateText: "Sauvegarde...",
        },
      ]),
    ).toBe("Sauvegarde...");
  });

  it("shows the latest saved status when nothing is active", () => {
    expect(
      selectStatusBarSaveStateText([
        {
          lastSavedAt: "2026-06-30T09:00:00",
          saveState: "saved",
          saveStateText: "Enregistré à 09:00",
        },
        {
          lastSavedAt: "2026-06-30T10:00:00",
          saveState: "saved",
          saveStateText: "Enregistré à 10:00",
        },
      ]),
    ).toBe("Enregistré à 10:00");
  });
});
