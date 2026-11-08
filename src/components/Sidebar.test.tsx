// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createEmptyViewCounts } from "../domain/library";
import { Sidebar } from "./Sidebar";

vi.mock("../i18n", () => ({
  useI18n: () => ({ locale: "fr-FR", t: (key: string) => key }),
}));

it("keeps notes navigation without a duplicate Agents entry", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  let root = createRoot(container);
  const onSelectView = vi.fn();
  const savedSections = localStorage.getItem("soreno:sidebar-sections");
  localStorage.setItem(
    "soreno:sidebar-sections",
    JSON.stringify({ assistant: false, sessionsX: true }),
  );
  try {
    const sidebar = (
      <Sidebar
        activeView="all"
        counts={createEmptyViewCounts()}
        noteTypes={[]}
        onCreateNoteType={vi.fn()}
        onDeleteNoteType={vi.fn()}
        onDropNote={vi.fn()}
        onReorderNoteTypes={vi.fn()}
        onSelectView={onSelectView}
        onUpdateNoteType={vi.fn()}
      />
    );
    await act(async () => root.render(sidebar));
    const items = [
      ...container.querySelectorAll<HTMLButtonElement>(".nav-item"),
    ];
    expect(
      items.map((item) => item.querySelector("span:nth-child(2)")?.textContent),
    ).toEqual(["views.all", "views.archive", "views.favorites"]);
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("views.all");
    for (const [index, view] of ["all", "archive", "favorites"].entries()) {
      act(() => items[index].click());
      expect(onSelectView).toHaveBeenLastCalledWith(view);
    }
    expect(
      JSON.parse(localStorage.getItem("soreno:sidebar-sections")!),
    ).toEqual({ types: true });

    const toggles = [
      ...container.querySelectorAll<HTMLButtonElement>(".section-toggle"),
    ];
    expect(toggles).toHaveLength(1);
    const [toggle] = toggles;
    const content = container.querySelector<HTMLElement>(
      `[id="${toggle.getAttribute("aria-controls")}"]`,
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content.hidden).toBe(false);
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("soreno:sidebar-sections")!),
    ).toEqual({ types: false });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(sidebar));
    const restored = container.querySelector(".section-toggle")!;
    expect(restored.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelector<HTMLElement>(
        `[id="${restored.getAttribute("aria-controls")}"]`,
      )!.hidden,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    if (savedSections === null)
      localStorage.removeItem("soreno:sidebar-sections");
    else localStorage.setItem("soreno:sidebar-sections", savedSections);
  }
});
