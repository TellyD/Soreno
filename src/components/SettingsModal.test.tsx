// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../data/settingsApi";
import { I18nProvider } from "../i18n";
import { clearNotifications, getNotifications } from "../notifications";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { SettingsModal } from "./SettingsModal";
import { writeClipboardText } from "../data/clipboard";
import { recordChatCommandCatalog } from "../domain/agentConversationCommands";
import { deferred } from "../testing/deferred";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../data/clipboard", () => ({ writeClipboardText: vi.fn() }));
const runtime = vi.hoisted(() => ({
  terminalLogEnabled: false,
  updateSettings: (() => {}) as (patch: unknown) => unknown,
}));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: {
      ...defaultAppSettings,
      languagePreference: "fr",
      terminalLogEnabled: runtime.terminalLogEnabled,
    },
    updateSettings: runtime.updateSettings,
  }),
}));

let root: Root;
let container: HTMLDivElement;
const savedWidths = { sidebar: 400, browser: 450, git: 520 };

beforeEach(() => {
  vi.resetAllMocks();
  runtime.terminalLogEnabled = false;
  runtime.updateSettings = vi.fn();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("innerWidth", 1800);
  // jsdom lacks PointerEvent, which the Base UI switch dispatches on click.
  vi.stubGlobal("PointerEvent", MouseEvent);
  localStorage.clear();
  localStorage.setItem("soreno:layout-widths", JSON.stringify(savedWidths));
  localStorage.setItem("unrelated-preference", "keep");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function Harness({
  rightPanelVisible = false,
}: {
  rightPanelVisible?: boolean;
}) {
  const [layoutResetRequest, setLayoutResetRequest] = useState(0);
  return (
    <I18nProvider>
      <ResizableWorkspace
        sidebar={<div>Navigation</div>}
        browser={<div>Notes</div>}
        editor={<textarea defaultValue="Brouillon non enregistré" />}
        rightPanel={<div>Panneau</div>}
        rightPanelId="workspace-side-panel"
        rightPanelResizeLabel="Redimensionner le panneau"
        rightPanelVisible={rightPanelVisible}
        layoutResetRequest={layoutResetRequest}
      />
      <SettingsModal
        onClose={() => {}}
        onResetLayout={() => setLayoutResetRequest((value) => value + 1)}
      />
    </I18nProvider>
  );
}

function resetButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Réinitialis"),
  )!;
}

function persistedWidths() {
  return JSON.parse(localStorage.getItem("soreno:layout-widths")!);
}

function renderSettingsModal() {
  return act(async () =>
    root.render(
      <I18nProvider>
        <SettingsModal onClose={() => {}} onResetLayout={() => {}} />
      </I18nProvider>,
    ),
  );
}

it("resets and persists all panel widths repeatedly without remounting the editor or clearing preferences", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await act(async () => root.render(<Harness />));
  const editor = container.querySelector("textarea")!;
  await act(async () => resetButton().click());
  expect(invoke).toHaveBeenCalledWith("reset_window_sizes");
  expect(persistedWidths()).toEqual({
    sidebar: 280,
    browser: 310,
    git: 520,
  });
  expect(container.querySelector("textarea")).toBe(editor);
  expect(editor.value).toBe("Brouillon non enregistré");
  expect(localStorage.getItem("unrelated-preference")).toBe("keep");

  await act(async () => {
    container
      .querySelector('[role="separator"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
  });
  expect(persistedWidths().sidebar).toBe(292);
  await act(async () => resetButton().click());
  expect(persistedWidths().sidebar).toBe(280);

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(persistedWidths()).toEqual({
    sidebar: 280,
    browser: 310,
    git: 520,
  });
  expect(
    container
      .querySelector('[role="separator"]')
      ?.getAttribute("aria-valuenow"),
  ).toBe("280");
});

it("keeps the editor usable by clamping the visible right panel to the reset window size", async () => {
  vi.mocked(invoke).mockImplementation(async () => {
    vi.stubGlobal("innerWidth", 1180);
  });
  await act(async () => root.render(<Harness rightPanelVisible />));
  await act(async () => resetButton().click());
  expect(persistedWidths()).toEqual({
    sidebar: 280,
    browser: 310,
    git: 520,
  });
  expect(
    container
      .querySelector<HTMLElement>(".workspace")
      ?.style.getPropertyValue("--right-panel-width"),
  ).toBe("367px");
});

it("disables reset while pending, reports failure without resetting panels, and retries from the notification", async () => {
  const reset = deferred<unknown>();
  vi.mocked(invoke).mockReturnValue(reset.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => resetButton().click());
  expect(resetButton().disabled).toBe(true);
  expect(persistedWidths()).toEqual(savedWidths);
  await act(async () => reset.reject(new Error("Resize failed")));
  const [failure] = getNotifications();
  expect(failure).toMatchObject({
    message: "Impossible de réinitialiser les dimensions.",
    tone: "error",
    action: { label: "Réessayer" },
  });
  expect(container.textContent).not.toContain("Resize failed");
  expect(persistedWidths()).toEqual(savedWidths);
  expect(resetButton().disabled).toBe(false);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await act(async () => failure.action!.onAction());
  expect(getNotifications()).toEqual([]);
  expect(persistedWidths().sidebar).toBe(280);
});

it("enables the terminal log from its switch, then copies the log path and reports a failure", async () => {
  const updateSettings = vi.fn();
  runtime.updateSettings = updateSettings;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "agent_grid_log_path" ? "/logs/terminal-grid.log" : undefined,
  );
  vi.mocked(writeClipboardText).mockResolvedValue();
  await renderSettingsModal();
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
  const toggle = container.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Journal du terminal"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(button("Copier le chemin du journal")).toBeUndefined();
  await act(async () => toggle.click());
  expect(updateSettings).toHaveBeenCalledWith({ terminalLogEnabled: true });

  runtime.terminalLogEnabled = true;
  await renderSettingsModal();
  await act(async () => button("Copier le chemin du journal")!.click());
  expect(writeClipboardText).toHaveBeenCalledWith("/logs/terminal-grid.log");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Chemin du journal copié dans le presse-papiers.",
  );
  vi.mocked(writeClipboardText).mockRejectedValue(new Error("denied"));
  await act(async () => button("Copier le chemin du journal")!.click());
  expect(getNotifications()).toMatchObject([
    { message: "Impossible de copier le chemin du journal.", tone: "error" },
  ]);
  expect(container.textContent).not.toContain("Chemin du journal copié");
});

it("lists the last chat's commands and the hidden ones it lacked, and shows one again", async () => {
  const updateSettings = vi.fn();
  runtime.updateSettings = updateSettings;
  recordChatCommandCatalog([{ name: "review", description: "Review" }]);
  await renderSettingsModal();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Agents")!
      .click(),
  );
  const toggle = (command: string) =>
    container.querySelector<HTMLElement>(
      `[role="switch"][aria-label="Afficher /${command}"]`,
    )!;
  expect(toggle("review")).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) =>
        button.textContent?.startsWith("Afficher les commandes"),
      )!
      .click(),
  );
  expect(toggle("review").getAttribute("aria-checked")).toBe("true");
  expect(toggle("green").getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle("green").click());
  const patch = updateSettings.mock.calls[0][0];
  expect(
    patch({ ...defaultAppSettings, hiddenChatCommands: ["green", "x"] }),
  ).toEqual({ hiddenChatCommands: ["x"] });
});

it("lights up only the exact key combination being held in the shortcuts list", async () => {
  await renderSettingsModal();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Raccourcis")!
      .click(),
  );
  const active = () =>
    [...container.querySelectorAll("kbd[data-active]")].map((chord) =>
      chord.getAttribute("aria-label"),
    );
  const key = (type: string, init: KeyboardEventInit) =>
    act(async () => document.dispatchEvent(new KeyboardEvent(type, init)));

  await key("keydown", { code: "KeyB", ctrlKey: true, altKey: true });
  expect(active()).toEqual(["Ctrl+Alt+B"]);
  await key("keyup", { code: "KeyB" });
  expect(active()).toEqual([]);
  await key("keydown", { code: "F3", shiftKey: true });
  expect(active()).toEqual(["Maj+F3"]);
});
