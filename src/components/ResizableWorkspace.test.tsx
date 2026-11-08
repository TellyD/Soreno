// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResizableWorkspace } from "./ResizableWorkspace";

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;
const storageKey = "soreno:layout-widths";
const preferred = { sidebar: 280, browser: 310, git: 520 };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("innerWidth", 1180);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(
  props: Partial<ComponentProps<typeof ResizableWorkspace>> = {},
) {
  await act(async () =>
    root.render(
      <ResizableWorkspace
        sidebar={<button>Navigation</button>}
        browser={<input aria-label="Browser" defaultValue="Search" />}
        editor={
          <>
            <button aria-controls="workspace-note-browser">
              Browser toggle
            </button>
            <button aria-controls="workspace-side-panel">Panel toggle</button>
            <textarea defaultValue="Draft" />
          </>
        }
        rightPanel={<input aria-label="Panel" defaultValue="Prompt" />}
        rightPanelId="workspace-side-panel"
        rightPanelResizeLabel="Resize side panel"
        {...props}
      />,
    ),
  );
}

function workspace() {
  return container.querySelector<HTMLElement>(".workspace")!;
}
function width() {
  return workspace().style.getPropertyValue("--right-panel-width");
}
function saved() {
  return JSON.parse(localStorage.getItem(storageKey)!);
}
const paneIds = {
  browser: "workspace-note-browser",
  panel: "workspace-side-panel",
};
function pane(name: keyof typeof paneIds) {
  return container.querySelector<HTMLElement>(`#${paneIds[name]}`)!;
}
function resizer(index: number) {
  return container.querySelectorAll<HTMLElement>('[role="separator"]')[index];
}
function button(name: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === name || item.textContent === name,
  )!;
}
async function key(index: number, key: string) {
  await act(async () =>
    resizer(index).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    ),
  );
}

it("keeps children and draft mounted while both panels close and reopen", async () => {
  await render();
  const browser = pane("browser").firstChild;
  const panel = pane("panel").firstChild;
  const editor = container.querySelector("textarea")!;
  editor.value = "Unsaved";
  await render({ browserVisible: false, rightPanelVisible: false });
  expect(workspace().classList.contains("browser-hidden")).toBe(true);
  expect(workspace().classList.contains("right-panel-visible")).toBe(false);
  for (const name of ["browser", "panel"] as const) {
    expect(pane(name).getAttribute("aria-hidden")).toBe("true");
    expect(pane(name).hasAttribute("inert")).toBe(true);
    expect(pane(name).hidden).toBe(false);
  }
  expect(resizer(1).tabIndex).toBe(-1);
  expect(resizer(2).tabIndex).toBe(-1);
  await render();
  expect(pane("browser").firstChild).toBe(browser);
  expect(pane("panel").firstChild).toBe(panel);
  expect(container.querySelector("textarea")).toBe(editor);
  expect(editor.value).toBe("Unsaved");
  expect(pane("panel").hasAttribute("inert")).toBe(false);
  expect(resizer(2).tabIndex).toBe(0);
  expect(workspace().classList.contains("right-panel-expanded")).toBe(false);
});

it("does not treat transient accessibility hiding as layout visibility", async () => {
  await render();
  const panel = pane("panel");
  panel.setAttribute("aria-hidden", "true");

  expect(panel.hasAttribute("data-hidden")).toBe(false);

  await render({ rightPanelVisible: false });
  expect(panel.hasAttribute("data-hidden")).toBe(true);
});

it("expands the right panel into real workspace space and reduces it without remounting the editor", async () => {
  const panel = <button aria-label="Reduce panel">Reduce</button>;
  await render({ rightPanel: panel, rightPanelExpanded: true });
  const editor = container.querySelector("textarea")!;
  const expansionButton = button("Reduce panel");
  editor.value = "Unsaved while reviewing";
  expansionButton.focus();

  expect(workspace().classList.contains("right-panel-expanded")).toBe(true);
  expect(
    container.querySelector(".workspace-editor")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(
    container.querySelector(".workspace-editor")?.hasAttribute("inert"),
  ).toBe(true);
  expect(pane("panel").getAttribute("aria-hidden")).toBe("false");
  expect(resizer(2).tabIndex).toBe(-1);

  await render({ rightPanel: panel, rightPanelExpanded: false });
  expect(container.querySelector("textarea")).toBe(editor);
  expect(editor.value).toBe("Unsaved while reviewing");
  expect(
    container.querySelector(".workspace-editor")?.getAttribute("aria-hidden"),
  ).toBe("false");
  expect(resizer(2).tabIndex).toBe(0);
  expect(document.activeElement).toBe(expansionButton);
});

it("moves focus from the terminal into Git when the panel opens expanded", async () => {
  const editor = (
    <>
      <button aria-controls="workspace-agent-git">Changes</button>
      <textarea defaultValue="Terminal" />
    </>
  );
  const panel = (
    <>
      <button>Refresh</button>
      <button data-git-expand>Reduce Git</button>
    </>
  );
  await render({
    browserVisible: false,
    editor,
    rightPanel: panel,
    rightPanelExpanded: true,
    rightPanelId: "workspace-agent-git",
    rightPanelVisible: false,
  });
  button("Changes").focus();
  const expansionButton = button("Reduce Git");

  await render({
    browserVisible: false,
    editor,
    rightPanel: panel,
    rightPanelExpanded: true,
    rightPanelId: "workspace-agent-git",
  });
  expect(document.activeElement).toBe(expansionButton);
  expect(
    container.querySelector(".workspace-editor")?.hasAttribute("inert"),
  ).toBe(true);

  await render({
    browserVisible: false,
    editor,
    rightPanel: panel,
    rightPanelExpanded: false,
    rightPanelId: "workspace-agent-git",
  });
  expect(document.activeElement).toBe(expansionButton);
});

it("restores the terminal trigger when an expanded Git panel closes", async () => {
  await render({
    browserVisible: false,
    editor: (
      <>
        <button aria-controls="workspace-agent-git">Changes</button>
        <textarea defaultValue="Terminal" />
      </>
    ),
    rightPanel: <button>Close Git</button>,
    rightPanelExpanded: true,
    rightPanelId: "workspace-agent-git",
  });
  button("Close Git").focus();
  const editor = container.querySelector("textarea")!;

  await render({
    browserVisible: false,
    editor: (
      <>
        <button aria-controls="workspace-agent-git">Changes</button>
        <textarea defaultValue="Terminal" />
      </>
    ),
    rightPanel: <button>Close Git</button>,
    rightPanelExpanded: true,
    rightPanelId: "workspace-agent-git",
    rightPanelVisible: false,
  });

  expect(container.querySelector("textarea")).toBe(editor);
  expect(document.activeElement).toBe(
    container.querySelector('[aria-controls="workspace-agent-git"]'),
  );
  expect(
    container.querySelector(".workspace-editor")?.getAttribute("aria-hidden"),
  ).toBe("false");
});

it.each(["browser", "panel"] as const)(
  "returns focus from the closing %s only when focus is inside",
  async (name) => {
    await render();
    pane(name).querySelector("input")!.focus();
    const closing =
      name === "browser"
        ? { browserVisible: false }
        : { rightPanelVisible: false };
    await render(closing);
    expect(document.activeElement).toBe(
      container.querySelector(`[aria-controls="${paneIds[name]}"]`),
    );
    await render();
    const editor = container.querySelector("textarea")!;
    editor.focus();
    await render(closing);
    expect(document.activeElement).toBe(editor);
  },
);

it("clamps the effective right panel only, reclaiming browser space without overwriting preferences", async () => {
  await render();
  expect(width()).toBe("367px");
  expect(saved()).toEqual(preferred);
  await render({ browserVisible: false });
  expect(width()).toBe("520px");
  await render({ browserVisible: false, rightPanelVisible: false });
  expect(width()).toBe("520px");
  await act(async () => {
    vi.stubGlobal("innerWidth", 900);
    window.dispatchEvent(new Event("resize"));
  });
  expect(width()).toBe("520px"); // Keep outgoing content width until the next opening.
  expect(saved()).toEqual(preferred);
  await render();
  expect(width()).toBe("87px");
  await act(async () => {
    vi.stubGlobal("innerWidth", 1800);
    window.dispatchEvent(new Event("resize"));
  });
  expect(width()).toBe("520px");
  expect(saved()).toEqual(preferred);
});

it("resizes by keyboard from effective widths and keeps other preferences intact", async () => {
  await render();
  await key(2, "ArrowRight");
  expect(width()).toBe("355px");
  expect(saved().git).toBe(355);
  await key(0, "ArrowRight");
  expect(saved().sidebar).toBe(292);
  await key(1, "ArrowRight");
  expect(saved().browser).toBe(322);
  expect(saved().git).toBe(355);
  expect(width()).toBe("343px");
});

it("lets the right panel use all available workspace width", async () => {
  vi.stubGlobal("innerWidth", 1800);
  localStorage.setItem(storageKey, JSON.stringify({ ...preferred, git: 1200 }));
  await render({ browserVisible: false });
  expect(width()).toBe("1200px");
  expect(resizer(2).getAttribute("aria-valuemax")).toBe("1298");
});

it("preserves slots in non-editor views and hides the right panel", async () => {
  await render({ editorVisible: false });
  expect(workspace().classList.contains("editor-hidden")).toBe(true);
  expect(pane("browser").hasAttribute("inert")).toBe(false);
  expect(pane("panel").hasAttribute("inert")).toBe(true);
  expect(resizer(1).tabIndex).toBe(-1);
  expect(resizer(2).tabIndex).toBe(-1);
  expect(
    container.querySelector(".workspace-editor")?.getAttribute("aria-hidden"),
  ).toBe("true");
});

it("switches Notes/Agents and expanded layouts without remounting the editor", async () => {
  const git = {
    browserVisible: false,
    rightPanelId: "workspace-agent-git",
  };
  await render();
  const editor = container.querySelector("textarea")!;
  editor.value = "Keep terminal and draft";
  for (const layout of [git, { ...git, rightPanelExpanded: true }, git, {}]) {
    await render(layout);
    expect(container.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("Keep terminal and draft");
  }
  await render({ rightPanelVisible: false });
  expect(container.querySelector("textarea")).toBe(editor);
  await render({ rightPanelVisible: true });
  expect(container.querySelector("textarea")).toBe(editor);
});

it("resizes by pointer without animation and cleans up drag listeners on unmount", async () => {
  await render();
  await act(async () => {
    resizer(0).dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 280, button: 0, bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }));
  });
  expect(saved().sidebar).toBe(300);
  expect(document.body.classList.contains("is-resizing-workspace")).toBe(true);
  await act(async () => document.dispatchEvent(new Event("pointerup")));
  expect(document.body.classList.contains("is-resizing-workspace")).toBe(false);
  await act(async () =>
    resizer(0).dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 300, bubbles: true }),
    ),
  );
  await act(async () => root.unmount());
  expect(document.body.classList.contains("is-resizing-workspace")).toBe(false);
  const persisted = saved();
  document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
  expect(saved()).toEqual(persisted);
  root = createRoot(container);
});
