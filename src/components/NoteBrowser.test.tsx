// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Note } from "../domain/notes";
import type { NoteType } from "../domain/noteTypes";
import * as dates from "../domain/dateTime";
import { I18nProvider } from "../i18n/I18nProvider";
import { NoteBrowser } from "./NoteBrowser";

const settings = vi.hoisted(() => ({ languagePreference: "en" }));
vi.mock("../settings", () => {
  const updateSettings = async () => {};
  return { useAppSettings: () => ({ settings, updateSettings }) };
});

it("memoizes unchanged rows while preserving note, selection, callback and locale updates", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T18:00:00"));
  const date = vi.spyOn(dates, "formatCompactDate");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noteTypes: NoteType[] = [];
  let note: Note = {
    archived: false,
    favorite: false,
    pinned: false,
    id: "note",
    kind: "notes",
    title: "Original",
    content: "",
    createdAt: "2026-06-29T10:00:00",
    updatedAt: "2026-06-30T14:05:00",
  };
  let select = vi.fn();
  async function render(query = "", selected: string | null = null) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <NoteBrowser
            activeView="all"
            isCreateNoteDisabled={false}
            isLoading={false}
            notes={[note]}
            noteTypes={noteTypes}
            onChangeSortOrder={() => {}}
            onCreateNote={() => {}}
            onSearchChange={() => {}}
            onSelectNote={select}
            searchQuery={query}
            selectedNoteId={selected}
            sortOrder="updated-desc"
          />
        </I18nProvider>,
      );
    });
  }
  try {
    await render();
    expect(date).toHaveBeenCalledTimes(1);
    select = vi.fn();
    await render("query");
    expect(date).toHaveBeenCalledTimes(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".note-list-item")!.click(),
    );
    expect(select).toHaveBeenCalledWith(note);
    await render("query", "note");
    expect(container.querySelector(".note-list-item.selected")).not.toBeNull();
    note = { ...note, title: "Changed", pinned: true };
    await render("query", "note");
    expect(container.textContent).toContain("Changed");
    settings.languagePreference = "fr";
    await render("query", "note");
    expect(container.textContent).toContain("juin");
    expect(date).toHaveBeenLastCalledWith(note.updatedAt, "fr-FR");
    expect(container.querySelector(".note-item-meta")?.textContent).toBe(
      "Modifiée le 30 juin",
    );
    for (const [updatedAt, label] of [
      ["2026-09-08T14:32:00", "Modifiée à 14:32"],
      ["2026-09-07T14:32:00", "Modifiée hier"],
    ]) {
      note = { ...note, updatedAt };
      await render();
      expect(container.querySelector(".note-item-meta")?.textContent).toBe(
        label,
      );
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    date.mockRestore();
    vi.useRealTimers();
    settings.languagePreference = "en";
  }
});
