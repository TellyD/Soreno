// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyViewCounts } from "../../domain/library";
import type { NoteType } from "../../domain/noteTypes";
import { clearNotifications, getNotifications } from "../../notifications";
import { appearanceIconOptions } from "../appearanceIcons";
import { NoteTypeSection } from "./NoteTypeSection";
import { setInputValue } from "../ui/testInput";

const i18n = vi.hoisted(() => ({
  language: "en",
  emptyNameErrors: {
    en: "Type name is required.",
    fr: "Nom du type requis.",
  },
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({
    locale: i18n.language === "fr" ? "fr-FR" : "en-US",
    t: (key: string) =>
      key === "noteTypes.error.emptyName"
        ? i18n.emptyNameErrors[i18n.language as "en" | "fr"]
        : key,
  }),
}));

beforeEach(() => {
  i18n.language = "en";
});
afterEach(() => clearNotifications());

it("filters icons locally and preserves the query through saves, but not reopening", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noteType: NoteType = {
    id: "notes",
    name: "Notes",
    icon: "book-open",
    color: "#123456",
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
  };
  let finish!: (value: NoteType) => void;
  const onUpdateNoteType = vi.fn(
    () =>
      new Promise<NoteType>((resolve) => {
        finish = resolve;
      }),
  );
  function openCustomizer() {
    act(() =>
      container
        .querySelector(".type-nav-row")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".app-menu-item")]
        .find((button) => button.textContent === "noteTypes.customize")!
        .click(),
    );
  }
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const icons = () => [
    ...container.querySelectorAll<HTMLButtonElement>(".appearance-icon-option"),
  ];
  function search(value: string) {
    act(() => {
      setInputValue(input(), value);
    });
  }
  try {
    await act(async () =>
      root.render(
        <NoteTypeSection
          activeView="all"
          counts={createEmptyViewCounts()}
          isExpanded
          noteTypes={[noteType]}
          onCreateNoteType={vi.fn()}
          onDeleteNoteType={vi.fn()}
          onExpandedChange={vi.fn()}
          onDropNote={vi.fn()}
          onReorderNoteTypes={vi.fn()}
          onSelectView={vi.fn()}
          onUpdateNoteType={onUpdateNoteType}
        />,
      ),
    );
    openCustomizer();
    expect(icons()).toHaveLength(appearanceIconOptions.length);
    search("  TRAVAIL  ");
    expect(icons().map((button) => button.title)).toEqual(["Travail"]);
    search("  BRIEFCASE-BUSINESS  ");
    expect(icons().map((button) => button.title)).toEqual(["Travail"]);
    search("no-such-icon");
    expect(icons()).toHaveLength(0);
    search("   ");
    expect(icons()).toHaveLength(appearanceIconOptions.length);
    search("Travail");
    input().focus();
    await act(async () => icons()[0].click());
    expect(onUpdateNoteType).toHaveBeenCalledWith(
      "notes",
      "Notes",
      "briefcase-business",
      "#123456",
    );
    expect(input().value).toBe("Travail");
    expect(document.activeElement).toBe(input());
    expect(icons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(icons()[0].disabled).toBe(true);
    await act(async () => finish({ ...noteType, icon: "briefcase-business" }));
    expect(input().value).toBe("Travail");
    expect(icons()[0].disabled).toBe(false);
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(
      container.querySelector(".appearance-customizer-popover"),
    ).toBeNull();
    openCustomizer();
    expect(input().value).toBe("");
    expect(icons()).toHaveLength(appearanceIconOptions.length);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("notifies a rename validation error in the active language until the rename ends", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noteType: NoteType = {
    id: "notes",
    name: "Notes",
    icon: "book-open",
    color: "#123456",
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
  };
  const props = {
    activeView: "all" as const,
    counts: createEmptyViewCounts(),
    isExpanded: true,
    noteTypes: [noteType],
    onCreateNoteType: vi.fn(),
    onDeleteNoteType: vi.fn(),
    onExpandedChange: vi.fn(),
    onDropNote: vi.fn(),
    onReorderNoteTypes: vi.fn(),
    onSelectView: vi.fn(),
    onUpdateNoteType: vi.fn(),
  };
  const renameInput = () =>
    container.querySelector<HTMLInputElement>(".type-nav-name-input input")!;

  try {
    await act(async () => root.render(<NoteTypeSection {...props} />));
    act(() =>
      container
        .querySelector(".type-nav-row")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".app-menu-item")]
        .find((button) => button.textContent === "noteTypes.renameContext")!
        .click(),
    );
    act(() => {
      setInputValue(renameInput(), " ");
    });
    await act(async () =>
      renameInput().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );

    expect(props.onUpdateNoteType).not.toHaveBeenCalled();
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        message: i18n.emptyNameErrors.en,
        tone: "error",
      }),
    ]);
    expect(container.textContent).not.toContain(i18n.emptyNameErrors.en);

    i18n.language = "fr";
    await act(async () => root.render(<NoteTypeSection {...props} />));
    expect(getNotifications()).toEqual([
      expect.objectContaining({ message: i18n.emptyNameErrors.fr }),
    ]);

    await act(async () =>
      renameInput().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
    );
    expect(getNotifications()).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
