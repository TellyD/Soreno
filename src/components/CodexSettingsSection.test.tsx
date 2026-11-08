// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkCodexUpdate,
  getCodexStatus,
  listCodexModels,
  updateCodexCli,
  type CodexStatus,
  type CodexUpdateStatus,
} from "../data/codexApi";
import { defaultAppSettings, type AppSettings } from "../data/settingsApi";
import { I18nProvider } from "../i18n";
import { clearNotifications, getNotifications } from "../notifications";
import { deferred } from "../testing/deferred";
import { CodexSettingsSection } from "./CodexSettingsSection";

vi.mock("../data/codexApi", () => ({
  checkCodexUpdate: vi.fn(),
  getCodexStatus: vi.fn(),
  listCodexModels: vi.fn(),
  updateCodexCli: vi.fn(),
}));
const i18nSettings = vi.hoisted(() => ({ languagePreference: "fr" }));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: i18nSettings,
    updateSettings: vi.fn(),
  }),
}));

let root: Root;
let container: HTMLDivElement;
const save = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  i18nSettings.languagePreference = "fr";
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(getCodexStatus).mockResolvedValue({
    installed: true,
    version: "codex-cli 1.0.0",
  });
  vi.mocked(checkCodexUpdate).mockResolvedValue({
    status: "available",
    latestVersion: "2.0.0",
  });
  vi.mocked(listCodexModels).mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

async function renderSettings(initial: Partial<AppSettings> = {}) {
  function Harness() {
    const [settings, setSettings] = useState<AppSettings>({
      ...defaultAppSettings,
      ...initial,
    });
    return (
      <I18nProvider>
        <CodexSettingsSection
          settings={settings}
          onUpdateSettings={async (patch) => {
            save(patch);
            const updated = { ...settings, ...patch };
            setSettings((current) => ({ ...current, ...patch }));
            return updated;
          }}
        />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Harness />));
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  vi.unstubAllGlobals();
});

function notificationMessages() {
  return getNotifications().map(({ message, tone }) => ({ message, tone }));
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
}

it("checks installation and updates automatically", async () => {
  await renderSettings();
  expect(getCodexStatus).toHaveBeenCalledTimes(1);
  expect(checkCodexUpdate).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Installé · 1.0.0");
  expect(button("Mettre à jour vers 2.0.0").disabled).toBe(false);
  expect(updateCodexCli).not.toHaveBeenCalled();
});

it("waits for the installation check before looking for updates", async () => {
  const finish = deferred<CodexStatus>();
  vi.mocked(getCodexStatus).mockReturnValue(finish.promise);
  await renderSettings();
  expect(container.textContent).toContain("Vérification de l’installation…");
  expect(checkCodexUpdate).not.toHaveBeenCalled();
  await act(async () => finish.resolve({ installed: false, version: null }));
  expect(container.textContent).toContain("Non installé");
  expect(checkCodexUpdate).not.toHaveBeenCalled();
  expect(button("Mettre à jour vers 2.0.0")).toBeUndefined();
});

it("does not claim to be up to date until the remote check finishes", async () => {
  const finish = deferred<CodexUpdateStatus>();
  vi.mocked(checkCodexUpdate).mockReturnValue(finish.promise);
  await renderSettings();
  expect(container.textContent).toContain("Recherche de mises à jour…");
  expect(container.textContent).not.toContain("À jour");
  expect(button("Mettre à jour vers 2.0.0")).toBeUndefined();
  await act(async () =>
    finish.resolve({ status: "upToDate", latestVersion: "1.0.0" }),
  );
  expect(container.textContent).toContain("À jour");
  expect(container.textContent).not.toContain("Recherche de mises à jour…");
  expect(button("Mettre à jour vers 1.0.0")).toBeUndefined();
});

it.each([
  [new Error("offline"), "Impossible de vérifier les mises à jour."],
  [
    "Command check_codex_update not found",
    "Le composant de bureau ne prend pas encore en charge cette vérification. Recompilez puis relancez Soreno.",
  ],
])(
  "localizes an update check failure (%s) without claiming freshness",
  async (error, message) => {
    vi.mocked(checkCodexUpdate).mockRejectedValue(error);
    await renderSettings();
    expect(container.textContent).toContain("Installé · 1.0.0");
    expect(notificationMessages()).toEqual([{ message, tone: "error" }]);
    expect(container.textContent).not.toContain("À jour");
    expect(button("Mettre à jour vers 2.0.0")).toBeUndefined();
  },
);

it("explains unsupported installations instead of offering an update", async () => {
  vi.mocked(checkCodexUpdate).mockResolvedValue({
    status: "unsupported",
    latestVersion: null,
  });
  await renderSettings();
  expect(notificationMessages()).toEqual([
    {
      message: expect.stringContaining("gestionnaire d’origine"),
      tone: "warning",
    },
  ]);
  expect(container.textContent).not.toContain("À jour");
  expect(button("Mettre à jour vers 2.0.0")).toBeUndefined();
});

it("disables updates while running, shows the verified version and rechecks freshness", async () => {
  await renderSettings();
  const finish = deferred<CodexStatus>();
  vi.mocked(updateCodexCli).mockReturnValue(finish.promise);
  await act(async () => button("Mettre à jour vers 2.0.0").click());
  expect(button("Mise à jour…").disabled).toBe(true);
  expect(updateCodexCli).toHaveBeenCalledTimes(1);
  const finishCheck = deferred<CodexUpdateStatus>();
  vi.mocked(checkCodexUpdate).mockReturnValue(finishCheck.promise);
  await act(async () =>
    finish.resolve({ installed: true, version: "codex-cli 2.0.0" }),
  );
  expect(container.textContent).toContain("Installé · 2.0.0");
  expect(container.textContent).toContain("Codex a été mis à jour.");
  expect(container.textContent).toContain("Recherche de mises à jour…");
  expect(container.textContent).not.toContain("À jour");
  await act(async () =>
    finishCheck.resolve({ status: "upToDate", latestVersion: "2.0.0" }),
  );
  expect(container.textContent).toContain("À jour");
  expect(button("Mettre à jour vers 2.0.0")).toBeUndefined();
  expect(checkCodexUpdate).toHaveBeenCalledTimes(2);
  expect(listCodexModels).toHaveBeenCalledTimes(2);
});

it("names Codex's first model as the Git default until one is chosen, and keeps a chosen model missing from the list", async () => {
  vi.mocked(listCodexModels).mockResolvedValue([
    { id: "gpt-6", displayName: "GPT-6" },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
  ]);
  const gitModelSelect = () =>
    container.querySelector("#codex-git-model-select");
  await renderSettings();
  expect(gitModelSelect()?.textContent).toBe("Par défaut (gpt-6)");
  await renderSettings({ codexGitModel: "gpt-retired" });
  expect(gitModelSelect()?.textContent).toBe("gpt-retired");
});

it("turns Git fast mode off and keeps the switch in sync", async () => {
  // jsdom lacks PointerEvent, which the Base UI switch dispatches on click.
  vi.stubGlobal("PointerEvent", MouseEvent);
  await renderSettings();
  const fastMode = container.querySelector<HTMLElement>('[role="switch"]')!;
  expect(fastMode.getAttribute("aria-checked")).toBe("true");
  await act(async () => fastMode.click());
  expect(save).toHaveBeenCalledWith({ codexGitFastMode: false });
  expect(fastMode.getAttribute("aria-checked")).toBe("false");
});

it("reports an update failure without claiming success or replacing settings", async () => {
  await renderSettings();
  vi.mocked(updateCodexCli).mockRejectedValue("CODEX_UPDATE_UNSUPPORTED");
  await act(async () => button("Mettre à jour vers 2.0.0").click());
  expect(notificationMessages()).toEqual([
    {
      message: expect.stringContaining("gestionnaire d’origine"),
      tone: "error",
    },
  ]);
  expect(container.textContent).toContain("Installé · 1.0.0");
  expect(container.textContent).not.toContain("Codex a été mis à jour.");
  expect(container.textContent).not.toContain("À jour");
  expect(save).not.toHaveBeenCalled();
  expect(button("Mettre à jour vers 2.0.0").disabled).toBe(false);
});
